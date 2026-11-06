import "dotenv/config";
import OpenAI from "openai";
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
// VANGREX - DUAL IMAGE VISUAL PERCEPTION
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

const SCREENSHOT_DIR = "./screenshots";

// Cursor-centered crop dimensions
const CROP_WIDTH = 480;
const CROP_HEIGHT = 360;

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

bun run temp.ts "Find the Extensions icon"
bun run temp.ts "Find the cursor" enhanced
bun run temp.ts "Identify the hovered element" high

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

  return pipeline.png({ compressionLevel: 6 }).toBuffer();
}

// ============================================================
// CAPTURE DESKTOP
// ============================================================

async function captureDesktop(): Promise<{
  imageBuffer: Buffer;
  width: number;
  height: number;
}> {
  console.log("\n[1] Initializing screen capture...");

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

  // Convert RobotJS coordinates into screenshot coordinates.
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
): Promise<{
  image: Buffer;
  left: number;
  top: number;
  width: number;
  height: number;
}> {
  // Keep crop dimensions within screenshot dimensions.
  const width = Math.min(CROP_WIDTH, screenshotWidth);
  const height = Math.min(CROP_HEIGHT, screenshotHeight);

  // Center crop around cursor.
  let left = Math.round(cursorX - width / 2);
  let top = Math.round(cursorY - height / 2);

  // Prevent crop from going outside screen boundaries.
  left = Math.max(0, Math.min(left, screenshotWidth - width));
  top = Math.max(0, Math.min(top, screenshotHeight - height));

  console.log("\n[CROP] Creating cursor-centered crop...");

  console.log({
    cursor: { x: cursorX, y: cursorY },
    crop: {
      left,
      top,
      width,
      height,
    },
  });

  const image = await sharp(screenshot)
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
    left,
    top,
    width,
    height,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("==========================================");
  console.log(" VANGREX - DUAL IMAGE PERCEPTION");
  console.log("==========================================");

  console.log("[PROMPT]", userPrompt);
  console.log("[MODEL]", MODEL);
  console.log("[MODE]", enhancementMode);

  await mkdir(SCREENSHOT_DIR, { recursive: true });

  // ----------------------------------------------------------
  // 1. CAPTURE FULL SCREENSHOT
  // ----------------------------------------------------------

  const captureStart = Date.now();

  const { imageBuffer: originalImage, width, height } = await captureDesktop();

  const captureTime = Date.now() - captureStart;

  console.log("\n[CAPTURE] Full screenshot:", {
    resolution: `${width}x${height}`,
    sizeMB: (originalImage.length / 1024 / 1024).toFixed(3),
    captureTimeMs: captureTime,
  });

  await writeFile(`${SCREENSHOT_DIR}/original.png`, originalImage);

  // ----------------------------------------------------------
  // 2. GET CURRENT CURSOR POSITION
  // ----------------------------------------------------------

  console.log("\n[2] Reading mouse coordinates...");

  const cursor = getCursorPosition(width, height);

  console.log("[CURSOR]", cursor);

  // ----------------------------------------------------------
  // 3. CREATE SECOND IMAGE AROUND CURSOR
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // 4. ENHANCE BOTH IMAGES INDEPENDENTLY
  // ----------------------------------------------------------

  console.log("\n[3] Enhancing both images...");

  const enhancementStart = Date.now();

  // Image 1: Entire desktop
  const enhancedFullImage = await enhanceImage(originalImage, enhancementMode);

  // Image 2: Local cursor region
  // Enhanced independently, without resizing.
  const enhancedCrop = await enhanceImage(crop.image, enhancementMode);

  const enhancementTime = Date.now() - enhancementStart;

  await writeFile(`${SCREENSHOT_DIR}/enhanced-full.png`, enhancedFullImage);

  await writeFile(`${SCREENSHOT_DIR}/enhanced-cursor-crop.png`, enhancedCrop);

  console.log("[ENHANCEMENT]", {
    mode: enhancementMode,
    fullResolution: `${width}x${height}`,
    cropResolution: `${crop.width}x${crop.height}`,
    enhancementTimeMs: enhancementTime,
    resizing: false,
  });

  // ----------------------------------------------------------
  // 5. ENCODE BOTH IMAGES
  // ----------------------------------------------------------

  console.log("\n[4] Encoding dual images...");

  const fullBase64 = enhancedFullImage.toString("base64");
  const cropBase64 = enhancedCrop.toString("base64");

  console.log("[IMAGES] Ready:", {
    image1: "Full desktop screenshot",
    image2: "Enhanced cursor-centered crop",
    fullSizeMB: (enhancedFullImage.length / 1024 / 1024).toFixed(3),
    cropSizeMB: (enhancedCrop.length / 1024 / 1024).toFixed(3),
  });

  // ----------------------------------------------------------
  // 6. SYSTEM PROMPT
  // ----------------------------------------------------------

  const systemPrompt = `
You are VANGREX, a general-purpose desktop visual perception system.

You receive TWO images of the SAME desktop capture.

IMPORTANT: BOTH IMAGES MUST BE ANALYZED TOGETHER.

============================================================
IMAGE 1 - FULL DESKTOP SCREENSHOT
============================================================

The first image shows the entire desktop.

Use it to understand:

- Overall desktop layout.
- Which application is open.
- Window arrangement.
- Application context.
- UI hierarchy.
- Mouse cursor position.
- Where the cursor is located relative to the entire screen.

============================================================
IMAGE 2 - HOVERED REGION / CURSOR CROP
============================================================

The second image is a crop extracted from IMAGE 1.

It is centered around the CURRENT MOUSE CURSOR POSITION.

It shows a magnified local view of the region surrounding the cursor.

This image has been independently enhanced using image sharpening,
contrast and brightness adjustments.

IMPORTANT:

1. IMAGE 2 is NOT a separate screenshot.
2. IMAGE 2 is NOT an independently detected UI element.
3. It is a local crop of IMAGE 1.
4. The mouse cursor may be visible inside this crop.
5. The UI element under or near the cursor should be identified
   by visually examining IMAGE 2.
6. Use IMAGE 1 to understand the broader context.
7. Use IMAGE 2 to inspect small icons, text, buttons and UI details.

============================================================
IMAGE 2 COORDINATE MAPPING
============================================================

The crop represents this rectangle in IMAGE 1:

Left: ${crop.left}
Top: ${crop.top}
Width: ${crop.width}
Height: ${crop.height}

The cursor position in IMAGE 1 is:

X: ${cursor.x}
Y: ${cursor.y}

To convert a coordinate from IMAGE 2 into IMAGE 1:

FullScreenX = CropX + ${crop.left}
FullScreenY = CropY + ${crop.top}

All coordinates returned in your answer MUST refer to IMAGE 1,
not the cropped image.

============================================================
SCREEN INFORMATION
============================================================

Full screenshot resolution:

Width: ${width}
Height: ${height}

Cursor coordinates:

X: ${cursor.x}
Y: ${cursor.y}

Screen coordinate origin is the top-left corner.

X increases towards the right.
Y increases towards the bottom.

============================================================
VISUAL ANALYSIS RULES
============================================================

1. Analyze BOTH images together.
2. Never ignore IMAGE 1.
3. Never ignore IMAGE 2.
4. Use IMAGE 1 for global context.
5. Use IMAGE 2 for local visual detail.
6. Never invent UI elements, labels or coordinates.
7. Read visible text accurately.
8. Distinguish visual evidence from assumptions.
9. Do not confuse the mouse cursor with a UI element.
10. If the cursor overlaps an element, identify that element.
11. If the cursor is between elements, say so.
12. If the crop does not contain enough information, say so.
13. Do not assume the cursor is hovering over an element
    merely because the element is nearby.

============================================================
ELEMENT DETECTION OUTPUT
============================================================

For location requests, return:

- Element name.
- Element type.
- Whether visible.
- Approximate bounding box (x, y, width, height).
- Center coordinates.
- Whether the cursor is inside the element.
- Confidence.
- Visual evidence.

All bounding boxes and coordinates must use IMAGE 1 coordinates.

============================================================
IMPORTANT
============================================================

You are only performing visual analysis.

Never claim to have clicked or interacted with the desktop.

Use the full screenshot and cursor crop as complementary
visual sources. The second image provides additional detail,
not a replacement for the first image.

`.trim();

  // ----------------------------------------------------------
  // 7. SEND TWO IMAGES TO MODEL
  // ----------------------------------------------------------

  console.log("\n[5] Sending TWO images to DiffusionGemma...");

  const requestStart = Date.now();

  const response = await client.chat.completions.create({
    model: MODEL,

    messages: [
      {
        role: "system",
        content: systemPrompt,
      },

      {
        role: "user",

        content: [
          {
            type: "text",
            text: `
USER REQUEST:

${userPrompt}

Analyze the two supplied images.

IMAGE 1: Full desktop screenshot.
IMAGE 2: Enhanced crop surrounding the current mouse cursor.

First understand the overall desktop from IMAGE 1.

Then inspect IMAGE 2 carefully to identify the UI element
under or closest to the cursor.

Return coordinates relative to IMAGE 1.
            `.trim(),
          },

          // IMAGE 1: FULL DESKTOP
          {
            type: "image_url",

            image_url: {
              url: `data:image/png;base64,${fullBase64}`,
              detail: "high",
            },
          },

          // IMAGE 2: ENHANCED CURSOR CROP
          {
            type: "image_url",

            image_url: {
              url: `data:image/png;base64,${cropBase64}`,
              detail: "high",
            },
          },
        ],
      },
    ],

    max_tokens: MAX_TOKENS,
  });

  const responseTime = Date.now() - requestStart;

  // ----------------------------------------------------------
  // 8. OUTPUT
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
  // 9. PERFORMANCE
  // ----------------------------------------------------------

  console.log("\n==========================================");
  console.log(" PERFORMANCE");
  console.log("==========================================");

  console.log({
    model: response.model,

    mode: enhancementMode,

    imageCount: 2,

    fullResolution: `${width}x${height}`,

    cropResolution: `${crop.width}x${crop.height}`,

    cursor: {
      x: cursor.x,
      y: cursor.y,
    },

    cropOrigin: {
      x: crop.left,
      y: crop.top,
    },

    originalSizeMB: (originalImage.length / 1024 / 1024).toFixed(3),

    enhancedFullSizeMB: (enhancedFullImage.length / 1024 / 1024).toFixed(3),

    enhancedCropSizeMB: (enhancedCrop.length / 1024 / 1024).toFixed(3),

    captureTimeMs: captureTime,

    cropTimeMs: cropTime,

    enhancementTimeMs: enhancementTime,

    responseTimeMs: responseTime,

    promptTokens: response.usage?.prompt_tokens,

    completionTokens: response.usage?.completion_tokens,

    totalTokens: response.usage?.total_tokens,
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
