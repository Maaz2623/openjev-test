import "dotenv/config";
import OpenAI from "openai";
import screenshot from "screenshot-desktop";
import sharp from "sharp";

// ============================================================
// CONFIGURATION
// ============================================================

const API_KEY = process.env.TYPESAFE_API_KEY;

if (!API_KEY) {
  throw new Error("TYPESAFE_API_KEY is missing from .env");
}

const client = new OpenAI({
  baseURL: "https://api.codiv.ai/v1",
  apiKey: API_KEY,
});

const MODEL = "diffusiongemma-26b";
const MAX_TOKENS = 2048;

// ============================================================
// PROMPT
// ============================================================

const userPrompt = process.argv.slice(2).join(" ").trim();

if (!userPrompt) {
  console.error(`
==========================================
 VANGREX - VISUAL PERCEPTION
==========================================

Usage:

bun run temp.ts "Describe everything on screen"

bun run temp.ts "Find the VS Code Extensions icon"

bun run temp.ts "Locate the Thunder Client gear button"

bun run temp.ts "What application is currently active?"

bun run temp.ts "Identify all visible buttons and their positions"

==========================================
`);
  process.exit(1);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("==========================================");
  console.log(" VANGREX - GENERAL VISUAL PERCEPTION");
  console.log("==========================================");

  console.log("\n[PROMPT]", userPrompt);

  // ----------------------------------------------------------
  // 1. CAPTURE SCREENSHOT
  // ----------------------------------------------------------

  console.log("\n[1] Capturing desktop screenshot...");

  const imageBuffer = await screenshot({
    format: "png",
  });

  const metadata = await sharp(imageBuffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not determine screenshot dimensions");
  }

  console.log("[CAPTURE] Resolution:", {
    width: metadata.width,
    height: metadata.height,
  });

  console.log("[CAPTURE] Format:", metadata.format);

  console.log(
    "[CAPTURE] Original size:",
    (imageBuffer.length / 1024 / 1024).toFixed(2),
    "MB",
  );

  // ----------------------------------------------------------
  // 2. BASE64 ENCODING
  // ----------------------------------------------------------

  const base64Image = imageBuffer.toString("base64");

  console.log("\n[2] Preparing original screenshot...");
  console.log("[IMAGE] Encoding: PNG");
  console.log("[IMAGE] Resizing: DISABLED");
  console.log("[IMAGE] Cropping: DISABLED");
  console.log("[IMAGE] JPEG conversion: DISABLED");

  // ----------------------------------------------------------
  // 3. VISION REQUEST
  // ----------------------------------------------------------

  console.log("\n[3] Sending request to DiffusionGemma...");

  const startTime = Date.now();

  const response = await client.chat.completions.create({
    model: MODEL,

    messages: [
      {
        role: "system",
        content: `
You are VANGREX, a general-purpose desktop visual perception system.

You receive screenshots of a computer desktop and answer user
requests by analyzing the actual visual contents of the image.

GENERAL RULES:

1. Analyze the screenshot carefully before answering.
2. Only report information supported by visible evidence.
3. Never invent UI elements, labels, coordinates or states.
4. Distinguish visual observations from assumptions.
5. Read text accurately whenever possible.
6. Use the actual screenshot dimensions when estimating coordinates.
7. If an element cannot be identified confidently, say so.
8. Follow the user's specific request rather than performing
   unrelated analysis.

DESKTOP COORDINATES:

- Origin (0,0) is the top-left corner.
- X increases towards the right.
- Y increases towards the bottom.
- Screenshot resolution: ${metadata.width} x ${metadata.height}.

For element-location requests, provide:
- Element name
- Element type
- Visibility
- Approximate bounding box (x, y, width, height)
- Center coordinates
- Confidence level
- Visual evidence

For general analysis requests, provide a structured explanation.

IMPORTANT:
You are a visual analysis system, not an interface simulator.
Never claim to have clicked, moved the mouse or interacted with
the desktop. You only analyze the supplied screenshot.
        `.trim(),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: userPrompt,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${base64Image}`,
              detail: "high",
            },
          },
        ],
      },
    ],

    max_tokens: MAX_TOKENS,
  });

  const elapsed = Date.now() - startTime;

  // ----------------------------------------------------------
  // 4. OUTPUT
  // ----------------------------------------------------------

  const result = response.choices[0]?.message?.content;

  console.log("\n==========================================");
  console.log(" VANGREX VISUAL ANALYSIS");
  console.log("==========================================\n");

  if (typeof result === "string") {
    console.log(result);
  } else {
    console.dir(result, { depth: null });
  }

  // ----------------------------------------------------------
  // 5. USAGE
  // ----------------------------------------------------------

  console.log("\n==========================================");
  console.log(" PERFORMANCE");
  console.log("==========================================");

  console.log({
    model: response.model,
    resolution: `${metadata.width}x${metadata.height}`,
    imageFormat: metadata.format,
    imageSizeMB: (imageBuffer.length / 1024 / 1024).toFixed(2),
    promptTokens: response.usage?.prompt_tokens,
    completionTokens: response.usage?.completion_tokens,
    totalTokens: response.usage?.total_tokens,
    responseTimeMs: elapsed,
  });

  console.log("\n[DONE]");
}

// ============================================================
// ERROR HANDLING
// ============================================================

main().catch((error) => {
  console.error("\n[FATAL ERROR]");

  if (error instanceof OpenAI.APIError) {
    console.error("Status:", error.status);
    console.error("Message:", error.message);
    console.error("Response:", error.error);
  } else {
    console.error(error);
  }

  process.exit(1);
});
