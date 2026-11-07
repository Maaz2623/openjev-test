import "dotenv/config";
import screenshot from "screenshot-desktop";
import sharp from "sharp";

// ============================================================
// VANGREX - Openjev MULTI-IMAGE PERCEPTION
//
// 1 full screenshot + 6 overlapping crops
// 7 images -> 1 API request -> 1 answer
// ============================================================

const CONFIG = {
  endpoint: "https://api.codiv.ai/v1/systemone",
  model: "openjev-latest",

  fullImage: {
    width: 1024,
    height: 1024,
    quality: 90,
  },

  crops: {
    columns: 3,
    rows: 2,
    overlap: 32,
    quality: 92,
  },

  sharpen: {
    sigma: 1.2,
    m1: 1.5,
    m2: 2.5,
  },
};

interface SystemOneResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface CropRegion {
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

// ============================================================
// CREATE SIX OVERLAPPING CROP REGIONS
// ============================================================

function createCropRegions(width: number, height: number): CropRegion[] {
  const { columns, rows, overlap } = CONFIG.crops;

  const tileWidth = Math.ceil(width / columns);
  const tileHeight = Math.ceil(height / rows);

  const names = [
    "TOP LEFT",
    "TOP CENTER",
    "TOP RIGHT",
    "BOTTOM LEFT",
    "BOTTOM CENTER",
    "BOTTOM RIGHT",
  ];

  const regions: CropRegion[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const left = Math.max(0, col * tileWidth - (col > 0 ? overlap : 0));

      const top = Math.max(0, row * tileHeight - (row > 0 ? overlap : 0));

      const right = Math.min(
        width,
        (col + 1) * tileWidth + (col < columns - 1 ? overlap : 0),
      );

      const bottom = Math.min(
        height,
        (row + 1) * tileHeight + (row < rows - 1 ? overlap : 0),
      );

      regions.push({
        name: names[row * columns + col],
        left,
        top,
        width: right - left,
        height: bottom - top,
      });
    }
  }

  return regions;
}

// ============================================================
// IMAGE PROCESSING
// ============================================================

async function processFullScreenshot(
  screenshotBuffer: Buffer,
): Promise<Buffer> {
  return sharp(screenshotBuffer)
    .resize({
      width: CONFIG.fullImage.width,
      height: CONFIG.fullImage.height,
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    })
    .sharpen({
      sigma: CONFIG.sharpen.sigma,
      m1: CONFIG.sharpen.m1,
      m2: CONFIG.sharpen.m2,
    })
    .jpeg({
      quality: CONFIG.fullImage.quality,
      mozjpeg: true,
    })
    .toBuffer();
}

async function processCrop(
  screenshotBuffer: Buffer,
  region: CropRegion,
): Promise<Buffer> {
  return sharp(screenshotBuffer)
    .extract({
      left: region.left,
      top: region.top,
      width: region.width,
      height: region.height,
    })
    .sharpen({
      sigma: CONFIG.sharpen.sigma,
      m1: CONFIG.sharpen.m1,
      m2: CONFIG.sharpen.m2,
    })
    .jpeg({
      quality: CONFIG.crops.quality,
      mozjpeg: true,
    })
    .toBuffer();
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("==========================================");
  console.log(" VANGREX - OpenJev");
  console.log(" MULTI-IMAGE VISUAL PERCEPTION");
  console.log("==========================================");

  // ----------------------------------------------------------
  // 1. READ TERMINAL QUESTION
  // ----------------------------------------------------------

  const question = process.argv.slice(2).join(" ").trim();

  if (!question) {
    console.log('\nUsage: bun run temp.ts "Your question here"');
    process.exitCode = 1;
    return;
  }

  console.log("\n[QUESTION]", question);

  const apiKey = process.env.TYPESAFE_API_KEY;

  if (!apiKey) {
    throw new Error("TYPESAFE_API_KEY is missing from .env");
  }

  // ----------------------------------------------------------
  // 2. CAPTURE DESKTOP ONCE
  // ----------------------------------------------------------

  console.log("\n[1] Capturing desktop...");

  const screenshotBuffer = await screenshot({
    format: "jpg",
  });

  const metadata = await sharp(screenshotBuffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not determine screenshot dimensions.");
  }

  const screenWidth = metadata.width;
  const screenHeight = metadata.height;

  console.log(`[SCREEN] ${screenWidth}x${screenHeight}`);

  // ----------------------------------------------------------
  // 3. CREATE CROP REGIONS
  // ----------------------------------------------------------

  console.log("\n[2] Creating six overlapping regions...");

  const regions = createCropRegions(screenWidth, screenHeight);

  for (const region of regions) {
    console.log(
      `[REGION] ${region.name}: ` +
        `${region.width}x${region.height} ` +
        `at (${region.left}, ${region.top})`,
    );
  }

  // ----------------------------------------------------------
  // 4. PROCESS FULL SCREENSHOT
  // ----------------------------------------------------------

  console.log("\n[3] Processing full screenshot...");

  const fullImageBuffer = await processFullScreenshot(screenshotBuffer);

  const fullMetadata = await sharp(fullImageBuffer).metadata();

  console.log(`[FULL] ${fullMetadata.width}x${fullMetadata.height}`);

  // ----------------------------------------------------------
  // 5. PROCESS SIX CROPS
  // ----------------------------------------------------------

  console.log("\n[4] Processing six detailed crops...");

  const cropBuffers = await Promise.all(
    regions.map(async (region) => {
      return processCrop(screenshotBuffer, region);
    }),
  );

  // ----------------------------------------------------------
  // 6. BUILD SEVEN IMAGE DATA URLS
  // ----------------------------------------------------------

  console.log("\n[5] Preparing seven images...");

  // Image 1: Full desktop
  const imageDataUrls = [
    `data:image/jpeg;base64,${fullImageBuffer.toString("base64")}`,
  ];

  // Images 2-7: Six detailed regions
  for (let i = 0; i < cropBuffers.length; i++) {
    const buffer = cropBuffers[i];

    imageDataUrls.push(`data:image/jpeg;base64,${buffer.toString("base64")}`);

    console.log(
      `[IMAGE ${i + 2}] ${regions[i].name}: ` +
        `${(buffer.length / 1024).toFixed(2)} KB`,
    );
  }

  const totalSize = imageDataUrls.reduce(
    (total, image) => total + image.length,
    0,
  );

  console.log("\n[IMAGES] Total images: 7");
  console.log(
    `[IMAGES] Combined payload: ${(totalSize / 1024).toFixed(2)} KB (Base64 characters)`,
  );

  // ----------------------------------------------------------
  // 7. DESCRIBE IMAGE ORDER AND CONTEXT
  // ----------------------------------------------------------

  const imageContext = `
IMAGE REFERENCE GUIDE:

IMAGE 1:
Complete Windows desktop screenshot.
Downscaled version of the entire ${screenWidth}x${screenHeight} screen.
Use this image to understand the overall desktop layout,
application identity, window arrangement and context.

IMAGE 2:
TOP LEFT region of the desktop.
Original-resolution crop with additional overlap.
Inspect buttons, icons, menus and interface elements here.

IMAGE 3:
TOP CENTER region of the desktop.
Original-resolution crop with additional overlap.
Inspect buttons, icons, menus and interface elements here.

IMAGE 4:
TOP RIGHT region of the desktop.
Original-resolution crop with additional overlap.
Inspect buttons, icons, menus and interface elements here.

IMAGE 5:
BOTTOM LEFT region of the desktop.
Original-resolution crop with additional overlap.
Pay particular attention to application sidebars,
status bars, navigation icons and settings controls.

IMAGE 6:
BOTTOM CENTER region of the desktop.
Original-resolution crop with additional overlap.
Inspect taskbars, panels, status bars and interface elements.

IMAGE 7:
BOTTOM RIGHT region of the desktop.
Original-resolution crop with additional overlap.
Inspect buttons, panels, taskbars and interface elements.

IMPORTANT:
All seven images come from the SAME desktop screenshot.
Images 2-7 are detailed views of regions already visible
in image 1. They are not different screenshots.

Use image 1 for overall context and images 2-7
for detailed visual inspection.

If an element is difficult to identify in image 1,
inspect the corresponding detailed crop.

Do not conclude that an element is absent until
you have checked all seven images.
  `.trim();

  // ----------------------------------------------------------
  // 8. BUILD OpenJev REQUEST
  // ----------------------------------------------------------

  const requestBody = {
    model: CONFIG.model,

    state: `
You are VANGREX, an advanced Windows desktop
visual perception system.

You receive seven images representing one desktop:
one full-screen image and six detailed crops.

${imageContext}

VISUAL RECOGNITION INSTRUCTIONS:

1. Understand the overall desktop using image 1.

2. Inspect all six detailed crops individually.

3. Use the detailed crops to recognize small icons,
   buttons, tabs, filenames and interface controls.

4. Do not confuse visually similar controls.

5. A UI element is visible even if it is not hovered,
   selected, focused or clicked.

6. Pay attention to small interface elements.
   Do not ignore them because of their size.

7. If a requested element appears in any of the seven
   images, consider it visible.

8. The same element may appear in multiple images
   because the crops overlap.

9. Do not mistake a crop boundary for the edge
   of the actual application or desktop.

10. Answer using only evidence from these images.

Your task is to answer the user's visual question accurately.
    `.trim(),

    images: imageDataUrls,

    questions: {
      desktop_question: {
        type: "choice",

        instructions: `
USER QUESTION:
${question}

Inspect the full desktop and all six detailed crops.

Determine whether the exact requested UI element
is visibly present anywhere in these images.

The element does not need to be hovered, selected,
focused or active.

Use the detailed crops to verify small icons
and interface elements before deciding.

Select the most accurate answer.
        `.trim(),

        criteria: {
          YES: "The requested element is visibly present in at least one of the seven images.",
          NO: "The requested element is absent after inspecting the full desktop and all six detailed crops.",
        },
      },
    },
  };

  // ----------------------------------------------------------
  // 9. SINGLE API REQUEST
  // ----------------------------------------------------------

  console.log("\n[6] Sending seven images to OpenJev...");
  console.log(`[MODEL] ${CONFIG.model}`);

  const startTime = performance.now();

  const response = await fetch(CONFIG.endpoint, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },

    body: JSON.stringify(requestBody),
  });

  const elapsed = performance.now() - startTime;

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Codiv API error (${response.status}): ${responseText}`);
  }

  const result = JSON.parse(responseText) as SystemOneResponse;

  // ----------------------------------------------------------
  // 10. EXTRACT ANSWER
  // ----------------------------------------------------------

  const answers = result.answers ?? {};
  const rawAnswer = answers.desktop_question;

  let finalAnswer = "UNKNOWN";

  if (rawAnswer && typeof rawAnswer === "object") {
    const answerObject = rawAnswer as Record<string, unknown>;

    const selectedOption = String(
      answerObject.choice ?? answerObject.answer ?? answerObject.value ?? "",
    ).toUpperCase();

    if (selectedOption.includes("YES")) {
      finalAnswer = "YES";
    } else if (selectedOption.includes("NO")) {
      finalAnswer = "NO";
    } else {
      finalAnswer = JSON.stringify(rawAnswer);
    }
  } else if (typeof rawAnswer === "string") {
    finalAnswer = rawAnswer.toUpperCase();
  }

  // ----------------------------------------------------------
  // 11. DISPLAY RESULTS
  // ----------------------------------------------------------

  console.log("\n==========================================");
  console.log(" OpenJev RESULT");
  console.log("==========================================");

  console.log("\n[QUESTION]");
  console.log(question);

  console.log("\n[ANSWER]");
  console.log(finalAnswer);

  if (finalAnswer === "UNKNOWN") {
    console.log("\n[RAW RESPONSE]");
    console.log(JSON.stringify(result, null, 2));
  }

  console.log("\n[PERFORMANCE]");
  console.log(`API round trip: ${elapsed.toFixed(2)} ms`);

  if (result.usage) {
    console.log(`Input tokens: ${result.usage.input_tokens ?? "N/A"}`);

    console.log(`Output tokens: ${result.usage.output_tokens ?? "N/A"}`);
  }

  console.log("\n[PIPELINE]");
  console.log("Desktop captures: 1");
  console.log("Images sent: 7");
  console.log("API requests: 1");
  console.log("Agent loops: 0");

  console.log("\n==========================================");
  console.log(" VANGREX - COMPLETE");
  console.log("==========================================");
}

// ============================================================
// EXECUTION
// ============================================================

main().catch((error: unknown) => {
  console.error("\n[FATAL ERROR]", error);
  process.exitCode = 1;
});
