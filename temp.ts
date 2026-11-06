import "dotenv/config";

import screenshotDesktop from "screenshot-desktop";
import sharp from "sharp";
import robot from "robotjs";

// ============================================
// CONFIGURATION
// ============================================

const API_KEY = process.env.TYPESAFE_API_KEY!;
const API_URL = "https://api.codiv.ai/v1/chat/completions";

const MODEL = "diffusiongemma-26b";

const TARGET_WIDTH = 1024;
const TARGET_HEIGHT = 1024;

const EXECUTE_CLICK = true;
const MIN_CONFIDENCE = 0.85;

// ============================================
// 1. CAPTURE CURRENT DESKTOP
// ============================================

console.log("\n========== DESKTOP CAPTURE ==========\n");

const originalScreenshot = await screenshotDesktop({
  format: "png",
});

const originalMetadata = await sharp(originalScreenshot).metadata();

const originalWidth = originalMetadata.width!;
const originalHeight = originalMetadata.height!;

console.log("Original width:", originalWidth);
console.log("Original height:", originalHeight);

// Save original screenshot for debugging
await sharp(originalScreenshot).png().toFile("./debug-desktop.png");

// ============================================
// 2. CROP RELEVANT DESKTOP REGION
// ============================================

// Extensions Marketplace is on the left side.
// Adjust these values if the target moves.

const CROP = {
  left: 0,
  top: 0,
  width: Math.min(600, originalWidth),
  height: Math.min(600, originalHeight),
};

console.log("\n========== IMAGE PROCESSING ==========\n");

console.log("Crop:", CROP);

// Crop and resize
const croppedScreenshot = await sharp(originalScreenshot)
  .extract(CROP)
  .resize({
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    fit: "fill",
  })
  .png()
  .toBuffer();

const resizedMetadata = await sharp(croppedScreenshot).metadata();

const imageWidth = resizedMetadata.width!;
const imageHeight = resizedMetadata.height!;

const base64 = croppedScreenshot.toString("base64");

// Save exact AI input for debugging
await sharp(croppedScreenshot).png().toFile("./debug-crop.png");

console.log("AI image width:", imageWidth);
console.log("AI image height:", imageHeight);

// ============================================
// 3. PREPARE PROMPT
// ============================================

const prompt = `
You are a pixel-accurate desktop GUI grounding agent.

IMAGE DIMENSIONS:
Width: ${imageWidth}
Height: ${imageHeight}

TASK:
Locate the small gear/manage button belonging specifically
to the installed Thunder Client extension card.

CONTEXT:
This image is a crop of the LEFT side of a Windows desktop.
Visual Studio Code Extensions Marketplace is open.

The Thunder Client extension card is visible.
Its management gear button is on the RIGHT side of its card.

IMPORTANT:
1. Inspect the entire screenshot.
2. Identify the Thunder Client extension card first.
3. Locate its own small gear icon.
4. Do not confuse it with other gear icons.
5. Do not confuse it with the VS Code Manage icon.
6. Return the center of the gear icon.
7. Coordinates must refer to this exact image.
8. Origin (0,0) is the top-left corner.
9. Do not return normalized coordinates.
10. If the target is not visible, return visible=false.

Return JSON only:

{
  "target": "Thunder Client manage button",
  "visible": true,
  "x": 0,
  "y": 0,
  "confidence": 0.0
}
`;

// ============================================
// 4. SEND IMAGE TO DIFFUSIONGEMMA
// ============================================

console.log("\n========== API REQUEST ==========\n");

const startTime = performance.now();

const response = await fetch(API_URL, {
  method: "POST",

  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },

  body: JSON.stringify({
    model: MODEL,

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
              url: `data:image/png;base64,${base64}`,
            },
          },
        ],
      },
    ],

    response_format: {
      type: "json_object",
    },

    max_tokens: 256,
  }),
});

const elapsed = performance.now() - startTime;

if (!response.ok) {
  throw new Error(`API Error ${response.status}: ${await response.text()}`);
}

const result = await response.json();

const content = result.choices?.[0]?.message?.content;

if (!content) {
  throw new Error("No generated content returned by API.");
}

// ============================================
// 5. PARSE PREDICTION
// ============================================

const prediction = JSON.parse(content);

console.log("\n========== MODEL PREDICTION ==========\n");

console.log(JSON.stringify(prediction, null, 2));

console.log("\nInference time:", Math.round(elapsed), "ms");

// ============================================
// 6. VALIDATE PREDICTION
// ============================================

if (prediction.visible !== true) {
  throw new Error("Target is not visible in the screenshot.");
}

if (
  !Number.isFinite(prediction.x) ||
  !Number.isFinite(prediction.y) ||
  prediction.x < 0 ||
  prediction.y < 0 ||
  prediction.x >= imageWidth ||
  prediction.y >= imageHeight
) {
  throw new Error("Invalid predicted coordinates.");
}

if (
  typeof prediction.confidence !== "number" ||
  prediction.confidence < MIN_CONFIDENCE
) {
  throw new Error(`Confidence too low: ${prediction.confidence}`);
}

// ============================================
// 7. CONVERT CROP COORDINATES TO DESKTOP
// ============================================

// AI coordinates -> original screenshot coordinates

const originalX = Math.round(
  CROP.left + prediction.x * (CROP.width / imageWidth),
);

const originalY = Math.round(
  CROP.top + prediction.y * (CROP.height / imageHeight),
);

// ============================================
// 8. ACCOUNT FOR DPI / SCREEN SCALING
// ============================================

const mouseScreen = robot.getScreenSize();

const mouseX = Math.round(originalX * (mouseScreen.width / originalWidth));

const mouseY = Math.round(originalY * (mouseScreen.height / originalHeight));

// ============================================
// 9. DISPLAY COORDINATES
// ============================================

console.log("\n========== COORDINATE MAPPING ==========\n");

console.log("AI coordinates:", {
  x: prediction.x,
  y: prediction.y,
});

console.log("Original screenshot coordinates:", {
  x: originalX,
  y: originalY,
});

console.log("Original desktop:", {
  width: originalWidth,
  height: originalHeight,
});

console.log("RobotJS screen:", {
  width: mouseScreen.width,
  height: mouseScreen.height,
});

console.log("Final mouse coordinates:", {
  x: mouseX,
  y: mouseY,
});

// ============================================
// 10. CLICK
// ============================================

if (EXECUTE_CLICK) {
  console.log("\n========== EXECUTING CLICK ==========\n");

  robot.moveMouseSmooth(mouseX, mouseY);

  robot.mouseClick("left");

  console.log("Click executed.");
} else {
  console.log("\n========== CLICK SKIPPED ==========\n");

  console.log("Set EXECUTE_CLICK = true to enable clicking.");
}

// ============================================
// COMPLETE
// ============================================

console.log("\n========== COMPLETE ==========\n");
