import "dotenv/config";

import { noul } from "@typesafe-ai/sdk";
import sharp from "sharp";

export interface UiElement {
  id: number;
  role: string;
  name: string;
  bounds?: number[];
  state: string[];
}

export interface RankedElement extends UiElement {
  probability: number;
}

const API_URL = "https://api.codiv.ai/v1/systemone";
const MODEL = "openjev-latest";

const INTERACTIVE_ROLES = new Set([
  "Button",
  "TabItem",
  "MenuItem",
  "Menu",
  "Edit",
  "TextBox",
  "ListItem",
  "TreeItem",
  "CheckBox",
  "RadioButton",
  "ComboBox",
  "Hyperlink",
  "SplitButton",
  "Slider",
  "Spinner",
]);

const TREE_BATCH_SIZE = 50;
const QUESTION_BATCH_SIZE = 25;
const TOP_CANDIDATES = 10;

// ============================================
// EXTRACT ELEMENTS
// ============================================

export function extractElements(tree: string): UiElement[] {
  const elements: UiElement[] = [];

  for (const line of tree.split("\n")) {
    const match = line.match(/^\s*#(\d+)\s+\[([^\]]+)\]\s*(.*)$/);

    if (!match) continue;

    const id = Number(match[1]);
    const role = match[2].trim();
    const raw = match[3].trim();

    if (!INTERACTIVE_ROLES.has(role)) continue;

    const boundsMatch = raw.match(/\(bounds:\s*\[([^\]]+)\][^)]*\)/);

    const bounds = boundsMatch
      ? boundsMatch[1].split(",").map(Number)
      : undefined;

    const state = ["disabled", "focusable", "focused", "selected"].filter(
      (flag) => new RegExp(`\\b${flag}\\b`, "i").test(raw),
    );

    const name = raw
      .replace(/\(bounds:[^)]*\)/, "")
      .replace(/\b(disabled|focusable|focused|selected)\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .replace(/,\s*$/, "")
      .trim();

    elements.push({
      id,
      role,
      name: name || "(unnamed)",
      bounds,
      state,
    });
  }

  return elements;
}

// ============================================
// PREPARE SCREENSHOT
// ============================================

async function prepareScreenshot(screenshotPath: string): Promise<string> {
  console.log("\n[IMAGE] Preparing screenshot...");

  const imageBuffer = await sharp(screenshotPath)
    .rotate()
    .resize({
      width: 1024,
      height: 1024,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({
      quality: 80,
    })
    .toBuffer();

  const base64 = imageBuffer.toString("base64");

  console.log("[IMAGE] Original path:", screenshotPath);
  console.log(
    "[IMAGE] Prepared size:",
    (imageBuffer.length / 1024).toFixed(1),
    "KB",
  );

  return `data:image/jpeg;base64,${base64}`;
}

// ============================================
// OPENJEV API REQUEST
// ============================================

async function askOpenJev(
  state: string,
  questions: Record<string, unknown>,
  screenshot: string,
) {
  const apiKey = process.env.TYPESAFE_API_KEY;

  if (!apiKey) {
    throw new Error("TYPESAFE_API_KEY is missing from .env");
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      state,
      images: [screenshot],
      questions,
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`OpenJev API error ${response.status}: ${responseText}`);
  }

  return JSON.parse(responseText);
}

// ============================================
// RELEVANCE SCORING
// ============================================

export async function findRelevantElements(
  tree: string,
  task: string,
  screenshotPath: string,
  topK = TOP_CANDIDATES,
): Promise<RankedElement[]> {
  const allElements = extractElements(tree);

  const usableElements = allElements.filter((element) => {
    if (element.state.includes("disabled")) return false;
    if (!element.bounds) return false;

    const [, , width, height] = element.bounds;

    return width > 5 && height > 5;
  });

  const screenshot = await prepareScreenshot(screenshotPath);

  const rankedCandidates: RankedElement[] = [];

  const totalBatches = Math.ceil(usableElements.length / TREE_BATCH_SIZE);

  console.log("\n========== OPENJEV MULTIMODAL ANALYSIS ==========");
  console.log("Extracted:", allElements.length);
  console.log("Usable:", usableElements.length);
  console.log("Batch size:", TREE_BATCH_SIZE);
  console.log("Question batch size:", QUESTION_BATCH_SIZE);
  console.log("Target candidates:", topK);
  console.log("Screenshot:", screenshotPath);

  // ==========================================
  // PROCESS COMPLETE TREE IN BATCHES OF 50
  // ==========================================

  for (
    let start = 0, batchNumber = 1;
    start < usableElements.length;
    start += TREE_BATCH_SIZE, batchNumber++
  ) {
    const batch = usableElements.slice(start, start + TREE_BATCH_SIZE);

    console.log(`\n[OPENJEV] Scanning batch ${batchNumber}/${totalBatches}`);

    // ========================================
    // SCORE ELEMENTS IN GROUPS OF 25
    // ========================================

    for (let qStart = 0; qStart < batch.length; qStart += QUESTION_BATCH_SIZE) {
      const questionElements = batch.slice(
        qStart,
        qStart + QUESTION_BATCH_SIZE,
      );

      // Structured UI information
      const uiState = {
        task,
        screenshot_context:
          "The attached image is the current desktop screenshot. Use it to understand the actual visual layout, visible controls, and application context.",
        elements: questionElements.map((element) => ({
          id: element.id,
          role: element.role,
          name: element.name,
          bounds: element.bounds,
          state: element.state,
        })),
      };

      const questions = Object.fromEntries(
        questionElements.map((element) => [
          `element_${element.id}`,
          noul(
            `Is UI element #${element.id}, "${element.name}", directly relevant and useful for accomplishing this task: "${task}"?

Evaluate using BOTH:
1. The attached screenshot and the element's visual location.
2. Its role, name, bounds, and state in the provided UI data.

Return a high score only if the element is genuinely useful for the next steps of the task.

Do not score an element highly merely because it is clickable.
Do not assume an element is visible just because it exists in the UI tree.
Consider whether its position and appearance in the screenshot match its described purpose.`,
          ),
        ]),
      );

      console.log(
        `[OPENJEV] Sending ${questionElements.length} elements + screenshot`,
      );

      const response = await askOpenJev(
        JSON.stringify(uiState),
        questions,
        screenshot,
      );

      const answers = response.answers as Record<string, { noul: number }>;

      for (const element of questionElements) {
        const key = `element_${element.id}`;
        const probability = answers?.[key]?.noul;

        if (typeof probability !== "number") continue;

        rankedCandidates.push({
          ...element,
          probability,
        });

        console.log(
          `[SCORE] #${element.id} ${element.name}: ${(probability * 100).toFixed(1)}%`,
        );
      }
    }
  }

  // ==========================================
  // GLOBAL RANKING
  // ==========================================

  const topCandidates = rankedCandidates
    .sort((a, b) => b.probability - a.probability)
    .slice(0, topK);

  console.log("\n========== TOP RELEVANT ELEMENTS ==========");

  topCandidates.forEach((element, index) => {
    console.log(
      `${index + 1}. #${element.id} [${element.role}] ${element.name} | ${(element.probability * 100).toFixed(1)}%`,
    );
  });

  return topCandidates;
}
