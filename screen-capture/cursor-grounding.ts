import {
  ScreenCapture,
  ImageFormat,
  isSupported,
  ColorFormat,
} from "@screen-capture/node";

import robot from "robotjs";
import sharp from "sharp";

import { mkdir } from "node:fs/promises";

const CONFIG = {
  monitorIndex: 1,

  cropSize: 512,
  outputSize: 1024,

  interval: 100,

  outputDir: "./cursor-live",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

async function main() {
  console.log("==================================");
  console.log("   VANGREX LIVE CURSOR CAPTURE");
  console.log("==================================");

  if (!isSupported()) {
    throw new Error("Screen capture is not supported.");
  }

  await mkdir(CONFIG.outputDir, { recursive: true });

  const capture = new ScreenCapture({
    monitorIndex: CONFIG.monitorIndex,
    cursorCapture: true,
    colorFormat: ColorFormat.Bgra8,
  });

  try {
    await capture.start();

    console.log("[CAPTURE] Running...");
    console.log("[CAPTURE] Press Ctrl+C to stop.");

    let frameCount = 0;

    while (true) {
      const frame = await capture.nextFrame();

      if (!frame) {
        continue;
      }

      // Get mouse coordinates.
      const mouse = robot.getMousePos();
      const screen = robot.getScreenSize();

      // Convert mouse coordinates to captured frame coordinates.
      const x = Math.round((mouse.x * frame.width) / screen.width);

      const y = Math.round((mouse.y * frame.height) / screen.height);

      // Calculate crop.
      const cropWidth = Math.min(CONFIG.cropSize, frame.width);

      const cropHeight = Math.min(CONFIG.cropSize, frame.height);

      const left = Math.round(
        clamp(x - cropWidth / 2, 0, frame.width - cropWidth),
      );

      const top = Math.round(
        clamp(y - cropHeight / 2, 0, frame.height - cropHeight),
      );

      // Convert captured frame into an image buffer.
      const buffer = frame.buffer;

      // Crop and enlarge latest frame.
      const cropped = await sharp(buffer, {
        raw: {
          width: frame.width,
          height: frame.height,
          channels: 4,
        },
      })
        .extract({
          left,
          top,
          width: cropWidth,
          height: cropHeight,
        })
        .resize(CONFIG.outputSize, CONFIG.outputSize, {
          fit: "fill",
          kernel: "lanczos3",
        })
        .png()
        .toBuffer();

      // Continuously overwrite latest image.
      await sharp(cropped).toFile(`${CONFIG.outputDir}/latest.png`);

      frameCount++;

      console.log(
        `[FRAME ${frameCount}] Cursor: (${x}, ${y}) | Crop: (${left}, ${top})`,
      );

      await sleep(CONFIG.interval);
    }
  } finally {
    await capture.stop();
  }
}

main().catch(console.error);
