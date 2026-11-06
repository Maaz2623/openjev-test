import "dotenv/config";

import { ScreenCapture, isSupported, ColorFormat } from "@screen-capture/node";

import robot from "robotjs";
import sharp from "sharp";

import { TypeSafeClient, noul } from "@typesafe-ai/sdk";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  model: "openjev-latest",

  monitorIndex: 1,

  // Smaller original-pixel crop.
  cropSize: 256,

  inferenceInterval: 1200,

  outputDir: "./cursor-live",

  confidenceThreshold: 0.5,

  stableFrames: 2,
};

// ============================================================
// CLIENT
// ============================================================

if (!process.env.TYPESAFE_API_KEY) {
  throw new Error("Missing TYPESAFE_API_KEY in .env");
}

const client = new TypeSafeClient({
  baseURL: "https://api.codiv.ai",
  apiKey: process.env.TYPESAFE_API_KEY,
  defaultHeaders: {
    "TypeSafe-Danger-Zone-Images": "true",
  },
});

// ============================================================
// TYPES
// ============================================================

type Point = {
  x: number;
  y: number;
};

type CropResult = {
  image: Buffer;
  width: number;
  height: number;
  origin: Point;
};

// ============================================================
// HELPERS
// ============================================================

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

// ============================================================
// CURSOR POSITION
// Used ONLY to select the screenshot crop.
// Coordinates are NEVER sent to OpenJEV.
// ============================================================

function getCursorPosition(
  frameWidth: number,
  frameHeight: number,
  screenWidth: number,
  screenHeight: number,
): Point {
  const mouse = robot.getMousePos();

  return {
    x: clamp(
      Math.round((mouse.x / screenWidth) * frameWidth),
      0,
      frameWidth - 1,
    ),

    y: clamp(
      Math.round((mouse.y / screenHeight) * frameHeight),
      0,
      frameHeight - 1,
    ),
  };
}

// ============================================================
// SCREENSHOT CROP
// ============================================================

async function createCrop(
  frameBuffer: Buffer,
  frameWidth: number,
  frameHeight: number,
  cursor: Point,
): Promise<CropResult> {
  const width = Math.min(CONFIG.cropSize, frameWidth);
  const height = Math.min(CONFIG.cropSize, frameHeight);

  const left = clamp(Math.round(cursor.x - width / 2), 0, frameWidth - width);

  const top = clamp(Math.round(cursor.y - height / 2), 0, frameHeight - height);

  // Extract original pixels. No resize or upscaling.
  const image = await sharp(frameBuffer, {
    raw: {
      width: frameWidth,
      height: frameHeight,
      channels: 4,
    },
  })
    .extract({
      left,
      top,
      width,
      height,
    })
    .png()
    .toBuffer();

  return {
    image,
    width,
    height,
    origin: {
      x: left,
      y: top,
    },
  };
}

// ============================================================
// OPENJEV VISUAL DETECTION
// ============================================================

async function detectHover(image: Buffer) {
  const imageDataUrl = `data:image/png;base64,${image.toString("base64")}`;

  console.log("\n========== OPENJEV REQUEST ==========");

  console.log("Image dimensions:", `${CONFIG.cropSize}x${CONFIG.cropSize}`);
  console.log("Image bytes:", image.length);

  const startedAt = Date.now();

  const response = await client.systemOne({
    model: CONFIG.model,

    // The screenshot is the only visual evidence.
    // No cursor coordinates or target bounding boxes.
    state: {
      images: [imageDataUrl],
    },

    questions: {
      is_hovering: noul(
        [
          "Is the extesions tab hovered?"
        ],
      ),
    },
  });

  const latency = Date.now() - startedAt;

  const probability = response.answers?.is_hovering?.noul ?? 0;

  const hovering = probability >= CONFIG.confidenceThreshold;

  console.log("\n========== MODEL RESULT ==========");

  console.log("Hovering:", hovering ? "YES" : "NO");
  console.log("YES probability:", probability);
  console.log("Latency:", `${latency}ms`);

  if (response.usage) {
    console.log("Usage:", response.usage);
  }

  console.log("==================================\n");

  return {
    hovering,
    probability,
    latency,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("======================================");
  console.log(" VANGREX OPENJEV VISUAL HOVER DETECTOR");
  console.log("======================================");

  console.log("Model:", CONFIG.model);
  console.log("Crop:", `${CONFIG.cropSize}x${CONFIG.cropSize}`);
  console.log("Detection: SCREENSHOT ONLY");
  console.log("Cursor metadata sent: NO");
  console.log("Target coordinates sent: NO");
  console.log("Image resizing: DISABLED");

  if (!(await isSupported())) {
    throw new Error("Screen capture is not supported.");
  }

  await mkdir(CONFIG.outputDir, {
    recursive: true,
  });

  const capture = new ScreenCapture({
    monitorIndex: CONFIG.monitorIndex,
    cursorCapture: true,
    colorFormat: ColorFormat.Bgra8,
  });

  const screenSize = robot.getScreenSize();

  let running = true;
  let inferenceRunning = false;

  let frameCount = 0;
  let inferenceCount = 0;
  let errorCount = 0;

  let lastInference = 0;

  let previousRawState: boolean | null = null;
  let stableCount = 0;
  let confirmedState: boolean | null = null;

  process.once("SIGINT", () => {
    console.log("\n[AGENT] Stop requested...");
    running = false;
  });

  console.log("\nStarting screen capture...");

  try {
    await capture.start();

    console.log("[CAPTURE] Ready");
    console.log("[AGENT] Monitoring cursor visually");
    console.log("[AGENT] Press Ctrl+C to stop\n");

    while (running) {
      const frame = await capture.nextFrame();

      if (!frame) {
        await sleep(5);
        continue;
      }

      frameCount++;

      const now = Date.now();

      if (inferenceRunning || now - lastInference < CONFIG.inferenceInterval) {
        continue;
      }

      inferenceRunning = true;
      lastInference = now;

      try {
        const frameBuffer = Buffer.from(frame.buffer);

        // Used only to position the crop.
        // Never passed to the model.
        const cursor = getCursorPosition(
          frame.width,
          frame.height,
          screenSize.width,
          screenSize.height,
        );

        const crop = await createCrop(
          frameBuffer,
          frame.width,
          frame.height,
          cursor,
        );

        await writeFile(path.join(CONFIG.outputDir, "latest.png"), crop.image);

        console.log("[AGENT] Cursor used for crop positioning:", cursor);
        console.log("[AGENT] Crop origin:", crop.origin);

        const result = await detectHover(crop.image);

        inferenceCount++;

        // ----------------------------------------------------
        // STABILITY FILTER
        // ----------------------------------------------------

        if (result.hovering === previousRawState) {
          stableCount++;
        } else {
          previousRawState = result.hovering;
          stableCount = 1;
        }

        if (
          stableCount >= CONFIG.stableFrames &&
          confirmedState !== result.hovering
        ) {
          confirmedState = result.hovering;

          console.log("\n========== VISUAL HOVER EVENT ==========");

          console.log(
            confirmedState
              ? "[HOVER ENTER] Extensions"
              : "[HOVER EXIT] Extensions",
          );

          console.log("Model probability:", result.probability);

          console.log("========================================\n");
        }

        console.log("[AGENT] Detection:", {
          hovering: result.hovering,
          probability: result.probability,
          latency: result.latency,
        });
      } catch (error) {
        errorCount++;

        console.error(
          "\n[OPENJEV ERROR]",
          error instanceof Error ? error.message : error,
        );

        await sleep(1000);
      } finally {
        inferenceRunning = false;
      }
    }
  } finally {
    try {
      await capture.stop();
    } catch {
      // Ignore capture shutdown errors.
    }

    console.log("\n======================================");
    console.log("[CAPTURE] Stopped");
    console.log("Frames:", frameCount);
    console.log("Inference requests:", inferenceCount);
    console.log("Errors:", errorCount);
    console.log("======================================");
  }
}

// ============================================================
// START
// ============================================================

main().catch((error) => {
  console.error("[FATAL ERROR]", error);
  process.exitCode = 1;
});
