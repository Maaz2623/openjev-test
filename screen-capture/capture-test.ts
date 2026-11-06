import {
  ScreenCapture,
  ImageFormat,
  isSupported,
  captureApiSupport,
  ColorFormat,
} from "@screen-capture/node";

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const OUTPUT_DIR = path.join(process.cwd(), "screenshots");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "live-desktop.png");

async function main() {
  console.log("\n========== VANGREX LIVE CAPTURE ==========\n");

  if (!isSupported()) {
    throw new Error("Native screen capture is not supported");
  }

  console.log("Capture capabilities:", captureApiSupport());

  await mkdir(OUTPUT_DIR, { recursive: true });

  const capture = new ScreenCapture({
    monitorIndex: 1,
    cursorCapture: true,
    colorFormat: ColorFormat.Bgra8,
  });

  let frameCount = 0;
  let started = false;

  const startTime = performance.now();

  try {
    console.log("\nStarting desktop capture...");

    await capture.start();
    started = true;

    console.log("Capture started.");
    console.log("Move your mouse around the screen.\n");

    // Receive up to 180 fresh frames.
    while (frameCount < 180) {
      const frame = await capture.nextFrame();

      if (!frame) break;

      frameCount++;

      // Save first frame and periodically update screenshot.
      if (frameCount === 1 || frameCount % 30 === 0) {
        frame.saveAsImage(OUTPUT_FILE, ImageFormat.Png);

        const elapsed = (performance.now() - startTime) / 1000;

        console.log({
          frames: frameCount,
          width: frame.width,
          height: frame.height,
          timestamp: frame.timestamp,
          elapsed: `${elapsed.toFixed(2)}s`,
          screenshot: OUTPUT_FILE,
        });
      }
    }

    const elapsed = (performance.now() - startTime) / 1000;

    console.log("\n========== CAPTURE COMPLETE ==========");

    console.log({
      totalFrames: frameCount,
      elapsedSeconds: elapsed.toFixed(2),
      averageFps: (frameCount / elapsed).toFixed(2),
      output: OUTPUT_FILE,
    });
  } finally {
    if (started) {
      await capture.stop();
      console.log("\nCapture stopped.");
    }
  }
}

main().catch(console.error);
