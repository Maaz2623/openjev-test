import "dotenv/config";
import sharp from "sharp";
import robot from "robotjs";

import {
  ScreenCapture,
  ImageFormat,
  isSupported,
  captureApiSupport,
  ColorFormat,
} from "@screen-capture/node";

import { mkdir, writeFile } from "node:fs/promises";
import { desktop } from "../utils/desktop";
import { Terminator } from "../utils/terminator";

// ============================================================
// VANGREX - AUTONOMOUS VISUAL GROUNDING
//
// SYSTEM ONE:
//   Verifies whether the cursor is hovering over the target.
//
// TERMINATOR:
//   Retrieves the live accessibility/UI tree.
//
// DIFFUSIONGEMMA:
//   Receives screenshot + tree.formatted.
//   Identifies the exact target and returns its bounds.
//
// ROBOTJS:
//   Calculates the bounding-box center.
//   Moves directly to the target.
//
// NEW ARCHITECTURE:
//   Screenshot + UI Tree -> Visual Grounding -> Bounding Box
//   -> Direct Mouse Movement -> System One Verification
//
// NO INTERMEDIATE WAYPOINTS.
// NO ITERATIVE COORDINATE GENERATION.
// ============================================================

// ============================================================
// API CONFIGURATION
// ============================================================

const API_KEY = process.env.TYPESAFE_API_KEY;
const TEXT_API_KEY = process.env.TEXT_MODEL_API_KEY || API_KEY;

if (!API_KEY) {
  throw new Error("TYPESAFE_API_KEY is missing from .env");
}

if (!TEXT_API_KEY) {
  throw new Error("TEXT_MODEL_API_KEY is missing from .env");
}

const SYSTEM_ONE_URL = "https://api.codiv.ai/v1/systemone";
const TEXT_GENERATION_URL = "https://api.codiv.ai/v1/chat/completions";

const HOVER_MODEL = "openjev-latest";
const GROUNDING_MODEL = "diffusiongemma-26b";

// Terminator application candidate.
const candidate = "Code";

// ============================================================
// ARGUMENTS
// ============================================================

const args = process.argv.slice(2);

const TARGET = args
  .filter(
    (arg) => !["original", "enhanced", "high"].includes(arg.toLowerCase()),
  )
  .join(" ")
  .trim();

const MODE =
  args
    .find((arg) => ["original", "enhanced", "high"].includes(arg.toLowerCase()))
    ?.toLowerCase() ?? "enhanced";

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  monitorIndex: 1,

  cropWidth: 480,
  cropHeight: 360,

  yesThreshold: 0.5,

  movementSettleMs: 350,

  iterationDelayMs: 250,

  maxIterations: 20,

  saveScreenshots: true,

  navigationImageMaxWidth: 1536,

  navigationImageQuality: 90,

  // Direct movement is intentional.
  // No intermediate movement limit.

  requestTimeoutMs: 45000,
};

const SCREENSHOT_DIR = "./screenshots";

// ============================================================
// STATE
// ============================================================

let running = true;
let found = false;

let latestScreenshot: Buffer | null = null;

let screenWidth = 0;
let screenHeight = 0;

let totalIterations = 0;
let totalHoverChecks = 0;
let totalGroundingCalls = 0;
let totalMovements = 0;

let captureError: Error | null = null;

// ============================================================
// HELPERS
// ============================================================

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message: string) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function getCursorPosition() {
  const mouse = robot.getMousePos();
  const screen = robot.getScreenSize();

  const scaleX = screenWidth / screen.width;
  const scaleY = screenHeight / screen.height;

  return {
    x: mouse.x,
    y: mouse.y,

    screenshotX: clamp(Math.round(mouse.x * scaleX), 0, screenWidth - 1),

    screenshotY: clamp(Math.round(mouse.y * scaleY), 0, screenHeight - 1),

    screenWidth: screen.width,
    screenHeight: screen.height,

    scaleX,
    scaleY,
  };
}

// ============================================================
// IMAGE ENHANCEMENT
// ============================================================

async function enhanceImage(input: Buffer, mode: string): Promise<Buffer> {
  if (mode === "original") {
    return input;
  }

  let pipeline = sharp(input);

  if (mode === "enhanced") {
    pipeline = pipeline
      .modulate({
        brightness: 1.04,
        saturation: 1.08,
      })
      .linear(1.08, -5)
      .gamma(1.03)
      .sharpen({
        sigma: 1.0,
        m1: 0.7,
        m2: 2.0,
        x1: 2,
        y2: 10,
        y3: 20,
      });
  }

  if (mode === "high") {
    pipeline = pipeline
      .modulate({
        brightness: 1.05,
        saturation: 1.12,
      })
      .linear(1.15, -10)
      .gamma(1.05)
      .sharpen({
        sigma: 1.5,
        m1: 1.0,
        m2: 3.0,
        x1: 2,
        y2: 10,
        y3: 20,
      });
  }

  return pipeline
    .png({
      compressionLevel: 9,
    })
    .toBuffer();
}

// ============================================================
// CONTINUOUS SCREEN CAPTURE
// ============================================================

async function startContinuousCapture() {
  if (!isSupported()) {
    throw new Error("Native screen capture is not supported.");
  }

  log("Initializing native screen capture...");

  console.log("[CAPTURE SUPPORT]", captureApiSupport());

  const capture = new ScreenCapture({
    monitorIndex: CONFIG.monitorIndex,
    cursorCapture: true,
    drawBorder: false,
    colorFormat: ColorFormat.Bgra8,
  });

  await capture.start();

  log("Screen capture started.");

  const captureLoop = async () => {
    while (running) {
      try {
        const frame = await capture.nextFrame();

        if (!frame) continue;

        latestScreenshot = Buffer.from(frame.encode(ImageFormat.Png));

        screenWidth = frame.width;
        screenHeight = frame.height;
      } catch (error) {
        captureError =
          error instanceof Error ? error : new Error(String(error));

        log(`Capture error: ${captureError.message}`);

        running = false;
        break;
      }
    }
  };

  const loopPromise = captureLoop();

  while (!latestScreenshot && running) {
    await sleep(10);
  }

  if (!latestScreenshot) {
    throw new Error("Failed to receive initial screenshot.");
  }

  log(`Capture resolution: ${screenWidth}x${screenHeight}`);

  return {
    capture,
    loopPromise,
  };
}

// ============================================================
// CURSOR-CENTERED CROP
// ============================================================

async function createCursorCrop(
  screenshot: Buffer,
  cursorX: number,
  cursorY: number,
) {
  const width = Math.min(CONFIG.cropWidth, screenWidth);
  const height = Math.min(CONFIG.cropHeight, screenHeight);

  let left = Math.round(cursorX - width / 2);
  let top = Math.round(cursorY - height / 2);

  left = clamp(left, 0, screenWidth - width);
  top = clamp(top, 0, screenHeight - height);

  const image = await sharp(screenshot)
    .extract({
      left,
      top,
      width,
      height,
    })
    .png({
      compressionLevel: 9,
    })
    .toBuffer();

  return {
    image,
    left,
    top,
    width,
    height,
  };
}

// ============================================================
// STAGE 1: SYSTEM ONE HOVER DETECTION
// ============================================================

async function checkHover(
  fullImage: Buffer,
  cropImage: Buffer,
  cursor: ReturnType<typeof getCursorPosition>,
  crop: {
    left: number;
    top: number;
    width: number;
    height: number;
  },
) {
  if (fullImage.length > 5 * 1024 * 1024) {
    throw new Error("Full screenshot exceeds 5 MB.");
  }

  if (cropImage.length > 5 * 1024 * 1024) {
    throw new Error("Cursor crop exceeds 5 MB.");
  }

  if (fullImage.length + cropImage.length > 7 * 1024 * 1024) {
    throw new Error("Combined images exceed request size limit.");
  }

  const state = `
You are a real-time desktop mouse hover detection system.

TARGET ELEMENT:
${TARGET}

IMAGE 1:
Complete desktop screenshot.

IMAGE 2:
Cursor-centered crop from IMAGE 1.

SCREEN RESOLUTION:
${screenWidth} x ${screenHeight}

MOUSE HOTSPOT IN SCREENSHOT:
X: ${cursor.screenshotX}
Y: ${cursor.screenshotY}

CROP ORIGIN:
Left: ${crop.left}
Top: ${crop.top}

CROP DIMENSIONS:
${crop.width} x ${crop.height}

RULES:

1. Identify the exact target element in IMAGE 1.
2. Inspect the cursor in IMAGE 2.
3. Determine whether the mouse hotspot physically
   overlaps the target interactive area.
4. Being near the target is NOT hovering.
5. Being over a neighboring element is NOT hovering.
6. Do not infer hover from highlighting alone.
7. If uncertain, return FALSE.
8. Use both images together.

Return TRUE only when the cursor hotspot
is physically inside the target element.
`;

  const requestBody = {
    model: HOVER_MODEL,

    state,

    images: [
      {
        content_type: "image/png",
        base64: fullImage.toString("base64"),
      },
      {
        content_type: "image/png",
        base64: cropImage.toString("base64"),
      },
    ],

    questions: {
      isHovered: {
        type: "noul",

        instructions: `
Is the mouse cursor hotspot physically inside
the interactive area of "${TARGET}"?

TRUE only with clear visual evidence.
FALSE if outside, nearby, or uncertain.
`,

        criteria: {
          true: "The cursor hotspot overlaps the target interactive area.",
          false: "The cursor hotspot does not overlap the target.",
        },
      },
    },

    samples: 1,
  };

  const start = Date.now();

  const response = await fetch(SYSTEM_ONE_URL, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },

    body: JSON.stringify(requestBody),

    signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
  });

  const responseTime = Date.now() - start;
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`System One error (${response.status}): ${responseText}`);
  }

  const data = JSON.parse(responseText);

  const answer = data.answers?.isHovered;

  if (answer?.type !== "noul" || typeof answer.noul !== "number") {
    throw new Error(`Unexpected System One response: ${responseText}`);
  }

  return {
    isHovered: answer.noul >= CONFIG.yesThreshold,

    probability: answer.noul,

    responseTime,

    model: data.model,
  };
}

// ============================================================
// STAGE 2: RETRIEVE LIVE TERMINATOR UI TREE
// ============================================================

async function getLiveUITree() {
  log("Retrieving live Terminator UI tree...");

  const start = Date.now();

  const treeResult = await desktop.getWindowTreeResult(candidate, undefined, {
    formatOutput: true,

    treeOutputFormat: Terminator.TreeOutputFormat.ClusteredYaml,

    propertyMode: Terminator.PropertyLoadingMode.Complete,

    includeWindowScreenshot: false,
  });

  const responseTime = Date.now() - start;

  // The formatted tree is the context supplied to DiffusionGemma.
  const formattedTree = (treeResult as { formatted?: string }).formatted;

  if (typeof formattedTree !== "string" || !formattedTree.trim()) {
    throw new Error(
      "Terminator returned an empty or invalid formatted UI tree.",
    );
  }

  log(
    `UI tree retrieved in ${responseTime}ms | ` +
      `${formattedTree.length} characters`,
  );

  return {
    formatted: formattedTree,
    responseTime,
  };
}

// ============================================================
// PREPARE NAVIGATION SCREENSHOT
// ============================================================

async function prepareNavigationImage(screenshot: Buffer) {
  const image = await sharp(screenshot)
    .resize({
      width: CONFIG.navigationImageMaxWidth,
      height: CONFIG.navigationImageMaxWidth,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({
      quality: CONFIG.navigationImageQuality,
    })
    .toBuffer();

  const metadata = await sharp(image).metadata();

  return {
    base64: image.toString("base64"),
    width: metadata.width!,
    height: metadata.height!,
  };
}

// ============================================================
// PARSE MODEL JSON
// ============================================================

function parseModelJSON(content: string) {
  let cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error(`Model did not return JSON: ${content}`);
  }

  cleaned = cleaned.slice(firstBrace, lastBrace + 1);

  return JSON.parse(cleaned);
}

// ============================================================
// STAGE 3: VISUAL GROUNDING
//
// INPUT:
//   1. Desktop screenshot.
//   2. tree.formatted.
//
// OUTPUT:
//   Exact target bounds from the UI tree.
//
// No waypoint generation.
// No coordinate estimation from image pixels.
// ============================================================

async function groundTarget(
  screenshot: Buffer,
  formattedTree: string,
  cursor: ReturnType<typeof getCursorPosition>,
) {
  log("Sending screenshot + UI tree to DiffusionGemma.");

  const prepared = await prepareNavigationImage(screenshot);

  const prompt = `
You are the visual grounding engine of VANGREX,
an autonomous desktop automation system.

Your task is to identify the exact requested UI element
by combining TWO sources of information:

1. The actual desktop screenshot.
2. The Terminator accessibility/UI tree.

============================================================
REQUESTED TARGET
============================================================

${TARGET}

============================================================
SOURCE 1: DESKTOP SCREENSHOT
============================================================

The attached image is the actual desktop screenshot.

Use it to understand:

- Visual appearance.
- Application layout.
- Icons and buttons.
- Text labels.
- Element relationships.
- Whether an element is visible.
- Which element corresponds to the requested target.

============================================================
SOURCE 2: TERMINATOR UI TREE
============================================================

The following is the live accessibility/UI tree.

It contains semantic information and actual element bounds.

TREE:

${formattedTree}

============================================================
CRITICAL: VISUAL GROUNDING RULES
============================================================

1. Find the exact requested element in the UI tree.

2. Use the screenshot to visually confirm its identity.

3. Match the element's semantic name, role and visual
   appearance.

4. Do not select an element just because its name
   resembles the requested target.

5. If multiple elements have similar names, use the
   screenshot and surrounding UI context to distinguish them.

6. Do not invent an element that is not present in the tree.

7. Do not estimate bounding boxes from screenshot pixels.

8. The UI tree is the authoritative source for bounds.

9. Copy the selected element's x, y, width and height
   EXACTLY from the UI tree.

10. Do not modify, resize, scale or reinterpret tree bounds.

11. Do not return the bounds of the parent window
    when the requested target is a child element.

12. Do not return the bounds of a neighboring element.

13. If the target is not represented in the tree,
    return target_found=false.

14. If the screenshot does not visually confirm the
    element, return target_found=false.

15. If uncertain, return target_found=false.

============================================================
COORDINATE SYSTEM
============================================================

The UI tree bounds are already in desktop coordinates.

RobotJS desktop resolution:

Width: ${cursor.screenWidth}
Height: ${cursor.screenHeight}

Current RobotJS cursor:

X: ${cursor.x}
Y: ${cursor.y}

The UI tree bounds must be returned unchanged.

Do not use screenshot coordinates.

Do not use resized image coordinates.

Do not perform screenshot-to-desktop scaling.

============================================================
BOUNDING BOX
============================================================

For the selected element:

x = left coordinate.

y = top coordinate.

width = element width.

height = element height.

The center is:

center_x = x + width / 2

center_y = y + height / 2

Calculate the center from the exact tree bounds.

============================================================
FINAL VALIDATION
============================================================

Before responding:

- Is this the exact requested target?
- Does it visually correspond to the screenshot?
- Does it exist in the UI tree?
- Did you copy its exact bounding box?
- Is the bounding box inside the RobotJS desktop?
- Is its width greater than zero?
- Is its height greater than zero?

============================================================
RESPONSE FORMAT
============================================================

Return ONLY valid JSON.

When the target is found:

{
  "target_found": true,
  "target_name": "Manage",
  "role": "Button",
  "bounds": {
    "x": 9,
    "y": 773,
    "width": 47,
    "height": 47
  },
  "reason": "The screenshot visually confirms that this is the requested Manage button, and the UI tree provides its exact bounds."
}

When the target is not found:

{
  "target_found": false,
  "target_name": null,
  "role": null,
  "bounds": null,
  "reason": "The requested target could not be confidently identified."
}

IMPORTANT:

The example coordinates are illustrative only.

Never copy example coordinates.

Return the actual coordinates from the supplied UI tree.

Return JSON only. No Markdown.
`;

  const requestBody = {
    model: GROUNDING_MODEL,

    messages: [
      {
        role: "user",

        content: [
          {
            type: "text",
            text: prompt,
          },

          {
            type: "image_url",

            image_url: {
              url: `data:image/jpeg;base64,${prepared.base64}`,
            },
          },
        ],
      },
    ],

    response_format: {
      type: "json_object",
    },

    max_tokens: 400,
  };

  const start = Date.now();

  const response = await fetch(TEXT_GENERATION_URL, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${TEXT_API_KEY}`,
      "Content-Type": "application/json",
    },

    body: JSON.stringify(requestBody),

    signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
  });

  const responseTime = Date.now() - start;

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Grounding error (${response.status}): ${responseText}`);
  }

  const data = JSON.parse(responseText);

  const content = data.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    throw new Error(`Invalid grounding response: ${responseText}`);
  }

  const result = parseModelJSON(content);

  totalGroundingCalls++;

  if (result.target_found !== true) {
    return {
      targetFound: false,
      targetName: null,
      role: null,
      bounds: null,
      reason:
        typeof result.reason === "string" ? result.reason : "Target not found.",
      responseTime,
      usage: data.usage,
    };
  }

  const bounds = result.bounds;

  if (!bounds || typeof bounds !== "object") {
    throw new Error(`Grounding response has no bounds: ${content}`);
  }

  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    throw new Error(`Invalid target bounding box: ${content}`);
  }

  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  ) {
    throw new Error(
      `Bounding box must contain integer coordinates: ${content}`,
    );
  }

  if (width <= 0 || height <= 0) {
    throw new Error(`Target has invalid dimensions: ${content}`);
  }

  // Tree bounds are expected to be in RobotJS desktop
  // coordinate space, so no scaling is applied.

  if (
    x < 0 ||
    y < 0 ||
    x + width > cursor.screenWidth ||
    y + height > cursor.screenHeight
  ) {
    throw new Error(
      `Target bounds are outside RobotJS desktop: ${JSON.stringify(bounds)}`,
    );
  }

  return {
    targetFound: true,

    targetName:
      typeof result.target_name === "string" ? result.target_name : TARGET,

    role: typeof result.role === "string" ? result.role : "Unknown",

    bounds: {
      x,
      y,
      width,
      height,
    },

    center: {
      x: Math.round(x + width / 2),
      y: Math.round(y + height / 2),
    },

    reason:
      typeof result.reason === "string"
        ? result.reason
        : "Target visually grounded.",

    responseTime,

    usage: data.usage,
  };
}

// ============================================================
// STAGE 4: DIRECT MOUSE MOVEMENT
// ============================================================

async function moveDirectlyToTarget(target: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const centerX = Math.round(target.x + target.width / 2);
  const centerY = Math.round(target.y + target.height / 2);

  const current = robot.getMousePos();

  const distance = Math.hypot(centerX - current.x, centerY - current.y);

  console.log("\n==========================================");
  console.log("          DIRECT TARGET MOVEMENT");
  console.log("==========================================");

  console.log("Target bounds:", target);

  console.log("Current cursor:", current);

  console.log("Target center:", {
    x: centerX,
    y: centerY,
  });

  console.log("Movement distance:", distance.toFixed(2));

  console.log("==========================================");

  log(`Moving directly to target center X:${centerX} Y:${centerY}`);

  robot.moveMouseSmooth(centerX, centerY);

  totalMovements++;

  await sleep(CONFIG.movementSettleMs);

  const finalPosition = robot.getMousePos();

  log(`Mouse movement completed: X:${finalPosition.x} Y:${finalPosition.y}`);

  return {
    x: centerX,
    y: centerY,
    actualPosition: finalPosition,
    distance,
  };
}

// ============================================================
// TARGET FOUND
// ============================================================

async function onTargetFound(
  cursor: ReturnType<typeof getCursorPosition>,
  result: {
    probability: number;
    responseTime: number;
    model: string;
  },
  screenshot: Buffer,
) {
  found = true;
  running = false;

  console.log("\n");

  console.log("==========================================");
  console.log("             TARGET FOUND");
  console.log("==========================================");

  console.log("Target:", TARGET);

  console.log("Final cursor:", {
    x: cursor.x,
    y: cursor.y,
  });

  console.log(
    "Hover probability:",
    `${(result.probability * 100).toFixed(2)}%`,
  );

  console.log("Detection time:", `${result.responseTime}ms`);

  console.log("Model:", result.model);

  console.log("==========================================");

  if (CONFIG.saveScreenshots) {
    const crop = await createCursorCrop(
      screenshot,
      cursor.screenshotX,
      cursor.screenshotY,
    );

    await Promise.all([
      writeFile(`${SCREENSHOT_DIR}/target-found-full.png`, screenshot),

      writeFile(`${SCREENSHOT_DIR}/target-found-crop.png`, crop.image),
    ]);

    log("Target screenshots saved.");
  }

  log("Visual grounding completed successfully.");
}

// ============================================================
// MAIN NAVIGATION LOOP
// ============================================================

async function navigationLoop() {
  log("Starting autonomous visual grounding.");

  log(`Target: ${TARGET}`);

  log(`Hover model: ${HOVER_MODEL}`);

  log(`Grounding model: ${GROUNDING_MODEL}`);

  console.log("\n");

  console.log("==========================================");
  console.log("       VANGREX VISUAL GROUNDING");
  console.log("==========================================");

  console.log("1. Native screen capture");

  console.log("2. Terminator live UI tree");

  console.log("3. DiffusionGemma visual grounding");

  console.log("4. Direct bounding-box movement");

  console.log("5. System One hover verification");

  console.log("------------------------------------------");

  console.log("Intermediate waypoints: DISABLED");

  console.log("Direct bounding-box targeting: ENABLED");

  console.log("Clicking: DISABLED");

  console.log("Keyboard input: DISABLED");

  console.log("==========================================");

  while (running && totalIterations < CONFIG.maxIterations) {
    totalIterations++;

    try {
      // ==========================================
      // 1. CHECK CAPTURE STATUS
      // ==========================================

      if (captureError) {
        throw captureError;
      }

      // ==========================================
      // 2. GET CURRENT SCREENSHOT
      // ==========================================

      let screenshot = latestScreenshot;

      if (!screenshot) {
        await sleep(20);
        continue;
      }

      // ==========================================
      // 3. GET CURRENT CURSOR POSITION
      // ==========================================

      let cursor = getCursorPosition();

      log(
        `[ITERATION ${totalIterations}] ` +
          `Cursor X:${cursor.x} Y:${cursor.y}`,
      );

      // ==========================================
      // 4. ENHANCE SCREENSHOT
      // ==========================================

      const enhancedFull = await enhanceImage(screenshot, MODE);

      // ==========================================
      // 5. SYSTEM ONE HOVER VERIFICATION
      // ==========================================

      log("Checking current hover state...");

      let crop = await createCursorCrop(
        screenshot,
        cursor.screenshotX,
        cursor.screenshotY,
      );

      const enhancedCrop = await enhanceImage(crop.image, MODE);

      const hoverResult = await checkHover(
        enhancedFull,
        enhancedCrop,
        cursor,
        crop,
      );

      totalHoverChecks++;

      log(
        `System One: ${hoverResult.isHovered ? "HOVERED" : "NOT HOVERED"} | ` +
          `${(hoverResult.probability * 100).toFixed(2)}% | ` +
          `${hoverResult.responseTime}ms`,
      );

      // ==========================================
      // 6. TARGET ALREADY REACHED
      // ==========================================

      if (hoverResult.isHovered) {
        await onTargetFound(cursor, hoverResult, enhancedFull);

        break;
      }

      if (!running) break;

      // ==========================================
      // 7. RETRIEVE FRESH TERMINATOR TREE
      // ==========================================

      const tree = await getLiveUITree();

      if (!running) break;

      // ==========================================
      // 8. GET FRESH SCREENSHOT
      //
      // Refresh after retrieving the tree so that
      // the visual input is as recent as possible.
      // ==========================================

      screenshot = latestScreenshot;

      if (!screenshot) {
        await sleep(20);
        continue;
      }

      cursor = getCursorPosition();

      const groundingImage = await enhanceImage(screenshot, MODE);

      // ==========================================
      // 9. VISUAL GROUNDING
      //
      // Screenshot + tree.formatted
      // ==========================================

      log("Starting visual grounding...");

      const grounding = await groundTarget(
        groundingImage,
        tree.formatted,
        cursor,
      );

      console.log("\n[GROUNDING RESULT]");

      console.log({
        targetFound: grounding.targetFound,

        targetName: grounding.targetName,

        role: grounding.role,

        bounds: grounding.bounds,

        center: grounding.center,

        reason: grounding.reason,

        treeResponseTime: `${tree.responseTime}ms`,

        groundingResponseTime: `${grounding.responseTime}ms`,

        usage: grounding.usage,
      });

      if (!running) break;

      // ==========================================
      // 10. TARGET NOT FOUND
      // ==========================================

      if (!grounding.targetFound || !grounding.bounds) {
        log(
          "Target could not be confidently grounded. Retrying with a fresh screenshot and UI tree.",
        );

        await sleep(CONFIG.iterationDelayMs);

        continue;
      }

      // ==========================================
      // 11. DIRECT MOVEMENT
      // ==========================================

      log("Target identified. Moving directly to bounding box.");

      const movement = await moveDirectlyToTarget(grounding.bounds);

      console.log("\n[DIRECT MOVEMENT RESULT]");

      console.log(movement);

      if (!running) break;

      // ==========================================
      // 12. NEXT ITERATION
      //
      // System One verifies whether the cursor
      // actually reached the target.
      // ==========================================

      log("Waiting for next hover verification...");

      await sleep(CONFIG.iterationDelayMs);
    } catch (error) {
      log(
        `Navigation error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      await sleep(1000);
    }
  }

  if (!found && running) {
    log(`Maximum iterations reached: ${CONFIG.maxIterations}`);
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  if (!TARGET) {
    console.log(`
Usage:

bun run autonomous-visual-grounding.ts "VS Code Settings button"

bun run autonomous-visual-grounding.ts "VS Code Extensions icon"

bun run autonomous-visual-grounding.ts "Start menu Settings button"

Modes:
original
enhanced
high

Examples:

bun run autonomous-visual-grounding.ts "VS Code Settings button" enhanced

bun run autonomous-visual-grounding.ts "VS Code Extensions icon" high
`);

    process.exit(1);
  }

  console.log("==========================================");

  console.log(" VANGREX - VISUAL GROUNDING");

  console.log("==========================================");

  console.log("[TARGET]", TARGET);

  console.log("[HOVER MODEL]", HOVER_MODEL);

  console.log("[GROUNDING MODEL]", GROUNDING_MODEL);

  console.log("[TERMINATOR PROCESS]", candidate);

  console.log("[MODE]", MODE);

  await mkdir(SCREENSHOT_DIR, {
    recursive: true,
  });

  const { capture, loopPromise } = await startContinuousCapture();

  try {
    await navigationLoop();
  } finally {
    running = false;

    log("Stopping screen capture...");

    await capture.stop();

    await loopPromise;

    console.log("\n");

    console.log("==========================================");

    console.log("         SESSION STATISTICS");

    console.log("==========================================");

    console.log({
      target: TARGET,

      found,

      totalIterations,

      totalHoverChecks,

      totalGroundingCalls,

      totalMovements,

      hoverModel: HOVER_MODEL,

      groundingModel: GROUNDING_MODEL,

      navigationMethod: "DIRECT_BOUNDING_BOX",
    });

    log("Stopped.");
  }
}

// ============================================================
// SHUTDOWN
// ============================================================

process.on("SIGINT", () => {
  console.log("\n");

  log("Ctrl+C received.");

  running = false;
});

// ============================================================
// START
// ============================================================

main().catch((error) => {
  console.error("\n[FATAL ERROR]");

  console.error(error instanceof Error ? error.stack : error);

  process.exit(1);
});
