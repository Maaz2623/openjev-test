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

// ============================================================
// VANGREX - CONTINUOUS OPENJEV HOVER DETECTOR
// ============================================================

const API_KEY = process.env.TYPESAFE_API_KEY;

if (!API_KEY) {
  throw new Error("TYPESAFE_API_KEY is missing from .env");
}

const API_URL = "https://api.codiv.ai/v1/systemone";
const MODEL = "openjev-latest";

const SCREENSHOT_DIR = "./screenshots";

// Target element
const TARGET = process.argv
  .slice(2)
  .filter(
    (arg) => !["original", "enhanced", "high"].includes(arg.toLowerCase()),
  )
  .join(" ")
  .trim();

const MODE =
  process.argv
    .slice(2)
    .find((arg) => ["original", "enhanced", "high"].includes(arg.toLowerCase()))
    ?.toLowerCase() ?? "enhanced";

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  monitorIndex: 1,

  cropWidth: 480,
  cropHeight: 360,

  // Time between AI detection requests
  detectionIntervalMs: 500,

  // Minimum probability to consider hovered
  yesThreshold: 0.5,

  // Save latest screenshots
  saveScreenshots: true,

  // Print cursor coordinates during detection
  showCursorPosition: false,
};

// ============================================================
// STATE
// ============================================================

let running = true;

let latestScreenshot: Buffer | null = null;

let screenWidth = 0;
let screenHeight = 0;

let captureError: Error | null = null;

let previousHovered = false;

let totalChecks = 0;
let totalDetections = 0;

// ============================================================
// HELPERS
// ============================================================

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message: string) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
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

  return pipeline.png({ compressionLevel: 9 }).toBuffer();
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

  // Background capture loop.
  // This continues running while OpenJev processes requests.

  const captureLoop = async () => {
    while (running) {
      try {
        const frame = await capture.nextFrame();

        if (!frame) continue;

        // Keep the newest screenshot in memory.
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

  // Wait for first screenshot.
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
// CURSOR POSITION
// ============================================================

function getCursorPosition() {
  const mouse = robot.getMousePos();
  const screen = robot.getScreenSize();

  const scaleX = screenWidth / screen.width;
  const scaleY = screenHeight / screen.height;

  const x = Math.max(
    0,
    Math.min(Math.round(mouse.x * scaleX), screenWidth - 1),
  );

  const y = Math.max(
    0,
    Math.min(Math.round(mouse.y * scaleY), screenHeight - 1),
  );

  return {
    x,
    y,
    robotX: mouse.x,
    robotY: mouse.y,
    scaleX,
    scaleY,
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

  left = Math.max(0, Math.min(left, screenWidth - width));

  top = Math.max(0, Math.min(top, screenHeight - height));

  const image = await sharp(screenshot)
    .extract({
      left,
      top,
      width,
      height,
    })
    .png({ compressionLevel: 9 })
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
// OPENJEV SYSTEM ONE
// ============================================================

async function checkHover(
  fullImage: Buffer,
  cropImage: Buffer,
  metadata: {
    cursorX: number;
    cursorY: number;
    cropLeft: number;
    cropTop: number;
    cropWidth: number;
    cropHeight: number;
  },
) {
  const fullBase64 = fullImage.toString("base64");
  const cropBase64 = cropImage.toString("base64");

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
Cursor-centered crop from the same screenshot.

SCREEN RESOLUTION:
${screenWidth} x ${screenHeight}

MOUSE HOTSPOT:
X: ${metadata.cursorX}
Y: ${metadata.cursorY}

CROP ORIGIN:
Left: ${metadata.cropLeft}
Top: ${metadata.cropTop}

CROP DIMENSIONS:
${metadata.cropWidth} x ${metadata.cropHeight}

INSTRUCTIONS:

1. Identify the exact target element in IMAGE 1.
2. Inspect the cursor region using IMAGE 2.
3. Determine whether the actual mouse pointer hotspot
   overlaps the target element's interactive area.
4. Being close to the target does not count.
5. Being over a neighboring element does not count.
6. Do not infer hover from highlighting alone.
7. If uncertain, answer FALSE.
8. Use both images together.

Return TRUE only when the cursor hotspot is
physically inside the target element.
`;

  const requestBody = {
    model: MODEL,

    state,

    images: [
      {
        content_type: "image/png",
        base64: fullBase64,
      },
      {
        content_type: "image/png",
        base64: cropBase64,
      },
    ],

    questions: {
      isHovered: {
        type: "noul",

        instructions: `
Is the cursor hotspot physically inside the
interactive area of "${TARGET}"?

TRUE only with clear visual evidence.
FALSE if outside, nearby, or uncertain.
`,

        criteria: {
          true: "Cursor hotspot overlaps the target's interactive area.",
          false: "Cursor hotspot does not overlap the target.",
        },
      },
    },

    samples: 1,
  };

  const start = Date.now();

  const response = await fetch(API_URL, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },

    body: JSON.stringify(requestBody),
  });

  const responseTime = Date.now() - start;

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `System One API error (${response.status}): ${responseText}`,
    );
  }

  const data = JSON.parse(responseText);

  const answer = data.answers?.isHovered;

  if (answer?.type !== "noul" || typeof answer.noul !== "number") {
    throw new Error(`Unexpected response: ${responseText}`);
  }

  return {
    isHovered: answer.noul >= CONFIG.yesThreshold,
    probability: answer.noul,
    responseTime,
    model: data.model,
    usage: data.usage,
  };
}

// ============================================================
// DETECTION LOOP
// ============================================================

async function detectionLoop() {
  log("Starting continuous hover detection...");

  log(`Target: ${TARGET}`);

  log(`Model: ${MODEL}`);

  log(`Detection interval: ${CONFIG.detectionIntervalMs}ms`);

  log("Move your mouse around the desktop.");
  log("Press Ctrl+C to stop.");

  while (running) {
    try {
      // Always use the latest available screenshot.
      const screenshot = latestScreenshot;

      if (!screenshot) {
        await sleep(10);
        continue;
      }

      // Read current cursor position.
      const cursor = getCursorPosition();

      if (CONFIG.showCursorPosition) {
        console.log(`[CURSOR] X:${cursor.x} Y:${cursor.y}`);
      }

      // Create cursor-centered crop.
      const crop = await createCursorCrop(screenshot, cursor.x, cursor.y);

      // Enhance both images.
      const enhancedFull = await enhanceImage(screenshot, MODE);

      const enhancedCrop = await enhanceImage(crop.image, MODE);

      // Save latest images when enabled.
      if (CONFIG.saveScreenshots) {
        await Promise.all([
          writeFile(`${SCREENSHOT_DIR}/latest-full.png`, enhancedFull),

          writeFile(`${SCREENSHOT_DIR}/latest-crop.png`, enhancedCrop),
        ]);
      }

      // Send request to OpenJev.
      const result = await checkHover(enhancedFull, enhancedCrop, {
        cursorX: cursor.x,
        cursorY: cursor.y,
        cropLeft: crop.left,
        cropTop: crop.top,
        cropWidth: crop.width,
        cropHeight: crop.height,
      });

      totalChecks++;

      // ==========================================
      // HOVER ENTERED
      // ==========================================

      if (result.isHovered && !previousHovered) {
        totalDetections++;

        console.log("\n");
        console.log("==========================================");
        console.log("          HOVER DETECTED");
        console.log("==========================================");

        console.log("Target:", TARGET);

        console.log("Cursor:", `X=${cursor.x}, Y=${cursor.y}`);

        console.log(
          "Probability:",
          `${(result.probability * 100).toFixed(2)}%`,
        );

        console.log("Response time:", `${result.responseTime}ms`);

        console.log("Model:", result.model);

        console.log("==========================================");
        console.log("\n");

        previousHovered = true;
      }

      // ==========================================
      // HOVER EXITED
      // ==========================================
      else if (!result.isHovered && previousHovered) {
        log(`HOVER EXITED: ${TARGET}`);

        previousHovered = false;
      }

      // ==========================================
      // STILL HOVERING
      // ==========================================

      // No repeated log while remaining hovered.
    } catch (error) {
      log(
        `Detection error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Next detection cycle.
    await sleep(CONFIG.detectionIntervalMs);
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  if (!TARGET) {
    console.log(`
Usage:

bun run temp.ts "Settings button"

bun run temp.ts "VS Code Extensions icon"

bun run temp.ts "Start menu Settings button" enhanced

Modes:
original
enhanced
high
`);
    process.exit(1);
  }

  console.log("==========================================");
  console.log(" VANGREX - CONTINUOUS HOVER DETECTOR");
  console.log("==========================================");

  console.log("[TARGET]", TARGET);
  console.log("[MODEL]", MODEL);
  console.log("[MODE]", MODE);

  await mkdir(SCREENSHOT_DIR, {
    recursive: true,
  });

  const { capture, loopPromise } = await startContinuousCapture();

  try {
    await detectionLoop();
  } finally {
    running = false;

    log("Stopping screen capture...");

    await capture.stop();

    await loopPromise;

    console.log("\n==========================================");
    console.log(" SESSION STATISTICS");
    console.log("==========================================");

    console.log({
      target: TARGET,
      totalChecks,
      totalDetections,
      model: MODEL,
    });

    log("Stopped.");
  }
}

// ============================================================
// SHUTDOWN
// ============================================================

process.on("SIGINT", () => {
  console.log("\n");

  log("Ctrl+C received. Shutting down...");

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
