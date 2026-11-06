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
// VANGREX - OPENJEV SYSTEM ONE HOVER DETECTOR
// ============================================================

const API_KEY = process.env.TYPESAFE_API_KEY;

if (!API_KEY) {
  throw new Error("TYPESAFE_API_KEY is missing from .env");
}

const API_URL = "https://api.codiv.ai/v1/systemone";
const MODEL = "openjev-latest";

const SCREENSHOT_DIR = "./screenshots";

const CROP_WIDTH = 480;
const CROP_HEIGHT = 360;

// OpenJev noul probability threshold
const YES_THRESHOLD = 0.5;

// ============================================================
// ARGUMENTS
// ============================================================

const args = process.argv.slice(2);

const userPrompt = args
  .filter(
    (arg) => !["original", "enhanced", "high"].includes(arg.toLowerCase()),
  )
  .join(" ")
  .trim();

const enhancementMode =
  args
    .find((arg) => ["original", "enhanced", "high"].includes(arg.toLowerCase()))
    ?.toLowerCase() ?? "enhanced";

if (!userPrompt) {
  console.log(`
Usage:

bun run temp.ts "Settings button"
bun run temp.ts "VS Code Extensions icon" enhanced
bun run temp.ts "Start menu Settings button" high

Modes:
original  - No enhancement
enhanced  - Mild sharpening and contrast
high      - Strong sharpening and contrast
`);

  process.exit(1);
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
// CAPTURE DESKTOP
// ============================================================

async function captureDesktop(): Promise<{
  imageBuffer: Buffer;
  width: number;
  height: number;
}> {
  console.log("\n[1] Initializing native screen capture...");

  if (!isSupported()) {
    throw new Error("Native screen capture is not supported.");
  }

  console.log("[CAPTURE] API support:", captureApiSupport());

  const capture = new ScreenCapture({
    monitorIndex: 1,
    cursorCapture: true,
    drawBorder: false,
    colorFormat: ColorFormat.Bgra8,
  });

  let started = false;

  try {
    await capture.start();
    started = true;

    console.log("[CAPTURE] Waiting for frame...");

    const frame = await capture.nextFrame();

    if (!frame) {
      throw new Error("No screenshot frame received.");
    }

    const imageBuffer = frame.encode(ImageFormat.Png);

    return {
      imageBuffer,
      width: frame.width,
      height: frame.height,
    };
  } finally {
    if (started) {
      await capture.stop();
    }
  }
}

// ============================================================
// GET CURSOR POSITION
// ============================================================

function getCursorPosition(screenshotWidth: number, screenshotHeight: number) {
  const mouse = robot.getMousePos();
  const screen = robot.getScreenSize();

  const scaleX = screenshotWidth / screen.width;
  const scaleY = screenshotHeight / screen.height;

  const x = Math.round(mouse.x * scaleX);
  const y = Math.round(mouse.y * scaleY);

  return {
    x: Math.max(0, Math.min(x, screenshotWidth - 1)),
    y: Math.max(0, Math.min(y, screenshotHeight - 1)),
    robotX: mouse.x,
    robotY: mouse.y,
    screenWidth: screen.width,
    screenHeight: screen.height,
    scaleX,
    scaleY,
  };
}

// ============================================================
// CREATE CURSOR-CENTERED CROP
// ============================================================

async function createCursorCrop(
  screenshot: Buffer,
  screenshotWidth: number,
  screenshotHeight: number,
  cursorX: number,
  cursorY: number,
) {
  const width = Math.min(CROP_WIDTH, screenshotWidth);
  const height = Math.min(CROP_HEIGHT, screenshotHeight);

  let left = Math.round(cursorX - width / 2);
  let top = Math.round(cursorY - height / 2);

  left = Math.max(0, Math.min(left, screenshotWidth - width));
  top = Math.max(0, Math.min(top, screenshotHeight - height));

  console.log("\n[CROP] Cursor-centered region:", {
    left,
    top,
    width,
    height,
  });

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
// OPENJEV SYSTEM ONE API
// ============================================================

async function checkHoverWithOpenJev(
  fullImage: Buffer,
  cropImage: Buffer,
  metadata: {
    target: string;
    cursorX: number;
    cursorY: number;
    screenWidth: number;
    screenHeight: number;
    cropLeft: number;
    cropTop: number;
    cropWidth: number;
    cropHeight: number;
  },
) {
  console.log("\n[5] Sending dual images to OpenJev System One...");

  // Both images remain PNG and are not resized.
  const fullBase64 = fullImage.toString("base64");
  const cropBase64 = cropImage.toString("base64");

  const fullSize = fullImage.length;
  const cropSize = cropImage.length;

  console.log("[IMAGES]", {
    fullImageMB: (fullSize / 1024 / 1024).toFixed(3),
    cropImageMB: (cropSize / 1024 / 1024).toFixed(3),
    totalMB: ((fullSize + cropSize) / 1024 / 1024).toFixed(3),
    resizing: false,
    format: "PNG",
  });

  // Codiv limits:
  // 5 MB per decoded image.
  // 8 MB total request body.
  if (fullSize > 5 * 1024 * 1024) {
    throw new Error("Full screenshot exceeds the 5 MB image limit.");
  }

  if (cropSize > 5 * 1024 * 1024) {
    throw new Error("Cursor crop exceeds the 5 MB image limit.");
  }

  if (fullSize + cropSize > 7 * 1024 * 1024) {
    throw new Error(
      "Combined images are too large. Reduce PNG file sizes without resizing.",
    );
  }

  const state = `
You are analyzing a live desktop screenshot to determine whether
the mouse cursor is hovering over a specific target UI element.

TARGET ELEMENT:
${metadata.target}

TWO IMAGES ARE PROVIDED:

IMAGE 1:
The complete desktop screenshot.

IMAGE 2:
A cursor-centered crop extracted from IMAGE 1.
It provides additional detail around the mouse pointer.

SCREEN INFORMATION:
Resolution: ${metadata.screenWidth} x ${metadata.screenHeight}

MOUSE CURSOR POSITION IN IMAGE 1:
X: ${metadata.cursorX}
Y: ${metadata.cursorY}

IMAGE 2 CROP ORIGIN IN IMAGE 1:
Left: ${metadata.cropLeft}
Top: ${metadata.cropTop}

IMAGE 2 DIMENSIONS:
${metadata.cropWidth} x ${metadata.cropHeight}

HOVER DETECTION RULES:

1. Determine whether the mouse cursor is physically positioned
   over the TARGET ELEMENT.

2. Use IMAGE 1 to understand the desktop and identify the target.

3. Use IMAGE 2 to inspect the exact region around the cursor.

4. The cursor coordinates represent the mouse pointer hotspot.

5. YES means the pointer hotspot overlaps the visible target
   element's actual clickable or interactive area.

6. NO means the pointer is outside the target element.

7. Being near the target is NOT hovering.

8. Do not confuse a neighboring element with the target.

9. Do not assume hover merely because the target is visible.

10. If the cursor is between elements, answer NO.

11. If the target cannot be identified confidently, answer NO.

12. Do not infer hover from a highlighted appearance alone.
    Use the cursor position and visual overlap.

The decision must be based on both images together.
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
Is the mouse cursor hotspot physically inside the actual
interactive area of the specified target element?

Answer TRUE only when there is clear visual evidence
that the cursor overlaps the target element.

Answer FALSE when the cursor is outside, merely nearby,
over another element, or when identification is uncertain.
`,

        criteria: {
          true: "The cursor hotspot is inside the target element's interactive area.",
          false:
            "The cursor hotspot is not inside the target element's interactive area.",
        },
      },
    },

    // One read for fastest response.
    samples: 1,
  };

  const requestStart = Date.now();

  const response = await fetch(API_URL, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },

    body: JSON.stringify(requestBody),
  });

  const responseTime = Date.now() - requestStart;

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `System One API error (${response.status}): ${responseText}`,
    );
  }

  let data: any;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Invalid JSON response: ${responseText}`);
  }

  const answer = data.answers?.isHovered;

  if (answer?.type !== "noul" || typeof answer.noul !== "number") {
    throw new Error(`Unexpected System One response: ${responseText}`);
  }

  const probability = answer.noul;

  const isHovered = probability >= YES_THRESHOLD;

  return {
    isHovered,
    probability,
    responseTime,
    model: data.model,
    usage: data.usage,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("==========================================");
  console.log(" VANGREX - OPENJEV HOVER DETECTOR");
  console.log("==========================================");

  console.log("[TARGET]", userPrompt);
  console.log("[MODEL]", MODEL);
  console.log("[MODE]", enhancementMode);

  await mkdir(SCREENSHOT_DIR, { recursive: true });

  // 1. Capture desktop

  const captureStart = Date.now();

  const { imageBuffer: originalImage, width, height } = await captureDesktop();

  const captureTime = Date.now() - captureStart;

  console.log("[CAPTURE]", {
    resolution: `${width}x${height}`,
    sizeMB: (originalImage.length / 1024 / 1024).toFixed(3),
    captureTimeMs: captureTime,
  });

  await writeFile(`${SCREENSHOT_DIR}/original.png`, originalImage);

  // 2. Read cursor position

  console.log("\n[2] Reading cursor position...");

  const cursor = getCursorPosition(width, height);

  console.log("[CURSOR]", cursor);

  // 3. Create cursor crop

  const cropStart = Date.now();

  const crop = await createCursorCrop(
    originalImage,
    width,
    height,
    cursor.x,
    cursor.y,
  );

  const cropTime = Date.now() - cropStart;

  await writeFile(`${SCREENSHOT_DIR}/cursor-crop-original.png`, crop.image);

  // 4. Enhance images independently

  console.log("\n[3] Enhancing images...");

  const enhancementStart = Date.now();

  const enhancedFullImage = await enhanceImage(originalImage, enhancementMode);

  const enhancedCrop = await enhanceImage(crop.image, enhancementMode);

  const enhancementTime = Date.now() - enhancementStart;

  await writeFile(`${SCREENSHOT_DIR}/enhanced-full.png`, enhancedFullImage);

  await writeFile(`${SCREENSHOT_DIR}/enhanced-cursor-crop.png`, enhancedCrop);

  console.log("[ENHANCEMENT]", {
    mode: enhancementMode,
    fullResolution: `${width}x${height}`,
    cropResolution: `${crop.width}x${crop.height}`,
    resizing: false,
    enhancementTimeMs: enhancementTime,
  });

  // 5. Send images to OpenJev

  const result = await checkHoverWithOpenJev(enhancedFullImage, enhancedCrop, {
    target: userPrompt,

    cursorX: cursor.x,
    cursorY: cursor.y,

    screenWidth: width,
    screenHeight: height,

    cropLeft: crop.left,
    cropTop: crop.top,

    cropWidth: crop.width,
    cropHeight: crop.height,
  });

  // 6. Output

  console.log("\n==========================================");
  console.log(" VANGREX HOVER RESULT");
  console.log("==========================================");

  console.log(`isHovered: ${result.isHovered ? "YES" : "NO"}`);

  console.log(`Probability: ${(result.probability * 100).toFixed(2)}%`);

  // 7. Performance

  console.log("\n==========================================");
  console.log(" PERFORMANCE");
  console.log("==========================================");

  console.log({
    model: result.model,
    target: userPrompt,
    captureTimeMs: captureTime,
    cropTimeMs: cropTime,
    enhancementTimeMs: enhancementTime,
    apiResponseTimeMs: result.responseTime,
    inputTokens: result.usage?.input_tokens,
    outputTokens: result.usage?.output_tokens,
    totalImages: 2,
    fullResolution: `${width}x${height}`,
    cropResolution: `${crop.width}x${crop.height}`,
    threshold: YES_THRESHOLD,
  });

  console.log("\n[DONE]");
}

// ============================================================
// ERROR HANDLING
// ============================================================

main().catch((error) => {
  console.error("\n[FATAL ERROR]");

  console.error(error instanceof Error ? error.message : error);

  process.exit(1);
});
