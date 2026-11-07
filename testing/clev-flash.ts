import "dotenv/config";
import screenshot from "screenshot-desktop";
import sharp from "sharp";

// ============================================================
// VANGREX - CLEF FLASH VISUAL PERCEPTION
// Single screenshot -> Single API request -> Exit
// ============================================================

const CONFIG = {
  endpoint: "https://api.codiv.ai/v1/systemone",
  model: "clef-flash-1.0",
  jpegQuality: 80,
};

interface SystemOneResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

async function main() {
  console.log("==========================================");
  console.log(" VANGREX - CLEF FLASH");
  console.log("==========================================");

  const apiKey = process.env.TYPESAFE_API_KEY;

  if (!apiKey) {
    throw new Error("TYPESAFE_API_KEY is missing from .env");
  }

  // ----------------------------------------------------------
  // 1. CAPTURE DESKTOP ONCE
  // ----------------------------------------------------------

  console.log("\n[1] Capturing desktop screenshot...");

  const screenshotBuffer = await screenshot({
    format: "jpg",
  });

  console.log("[CAPTURE] Screenshot captured.");

  // ----------------------------------------------------------
  // 2. ENCODE SCREENSHOT
  // ----------------------------------------------------------

  console.log("\n[2] Preparing image...");

  const imageBuffer = await sharp(screenshotBuffer)
    .jpeg({
      quality: CONFIG.jpegQuality,
      mozjpeg: true,
    })
    .toBuffer();

  const metadata = await sharp(imageBuffer).metadata();

  const base64Image = imageBuffer.toString("base64");

  const imageDataUrl = `data:image/jpeg;base64,${base64Image}`;

  console.log(`[IMAGE] Resolution: ${metadata.width}x${metadata.height}`);
  console.log(`[IMAGE] Size: ${(imageBuffer.length / 1024).toFixed(2)} KB`);

  // ----------------------------------------------------------
  // 3. BUILD QUESTIONS
  // ----------------------------------------------------------

  const requestBody = {
    model: CONFIG.model,

    state: `
You are analyzing a live Windows desktop screenshot for VANGREX,
an autonomous desktop automation agent.

Analyze the supplied screenshot carefully.
Identify visible applications, dialogs and interface elements.
Only report what is visually supported by the screenshot.
    `.trim(),

    images: [imageDataUrl],

    questions: {
      vscode_visible: {
        type: "noul",
        instructions: "Is Visual Studio Code visibly present on the desktop?",
      },

      uac_visible: {
        type: "noul",
        instructions:
          "Is a Windows User Account Control (UAC) elevation or confirmation dialog currently visible?",
      },

      foreground_application: {
        type: "choice",
        instructions:
          "Which application or desktop environment is most prominently visible?",
        criteria: {
          vscode: "Visual Studio Code",
          browser: "A web browser such as Opera, Chrome or Edge",
          file_explorer: "Windows File Explorer",
          settings: "Windows Settings",
          terminal: "A terminal or command prompt",
          uac: "A Windows UAC confirmation dialog",
          desktop: "Windows desktop without a prominent application",
          other: "Another application",
        },
      },
    },
  };

  // ----------------------------------------------------------
  // 4. SINGLE API REQUEST
  // ----------------------------------------------------------

  console.log("\n[3] Sending screenshot to Clef-Flash...");
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
  // 5. DISPLAY RESULTS
  // ----------------------------------------------------------

  console.log("\n==========================================");
  console.log(" CLEF-FLASH RESULTS");
  console.log("==========================================");

  console.log("\n[MODEL]", result.model ?? CONFIG.model);

  console.log("\n[ANSWERS]");

  const answers = result.answers ?? {};

  for (const [question, answer] of Object.entries(answers)) {
    console.log(`\n${question}:`);
    console.log(JSON.stringify(answer, null, 2));
  }

  console.log("\n[PERFORMANCE]");
  console.log(`API round trip: ${elapsed.toFixed(2)} ms`);

  if (result.usage) {
    console.log(`Input tokens: ${result.usage.input_tokens ?? "N/A"}`);
  }

  console.log("\n==========================================");
  console.log(" VANGREX - COMPLETE");
  console.log("==========================================");
}

main().catch((error: unknown) => {
  console.error("\n[FATAL ERROR]", error);
  process.exitCode = 1;
});
