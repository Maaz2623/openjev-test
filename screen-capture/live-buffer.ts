import { ScreenCapture, ImageFormat, ColorFormat } from "@screen-capture/node";

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

// ============================================================
// CONFIG
// ============================================================

const MONITOR_INDEX = 1;
const TEST_DURATION_MS = 10_000;

// ============================================================
// TYPES
// ============================================================

type CapturedFrame = Awaited<ReturnType<ScreenCapture["nextFrame"]>>;

interface FrameSnapshot {
  sequence: number;
  frame: NonNullable<CapturedFrame>;
  capturedAt: number;
  receivedAt: number;
}

// ============================================================
// LIVE FRAME BUFFER
// ============================================================

class LiveFrameBuffer {
  private capture: ScreenCapture;

  private latest?: FrameSnapshot;

  private sequence = 0;

  private running = false;

  private reader?: Promise<void>;

  private captureError?: Error;

  constructor() {
    this.capture = new ScreenCapture({
      monitorIndex: MONITOR_INDEX,
      cursorCapture: true,
      colorFormat: ColorFormat.Bgra8,
    });
  }

  // Start native capture and background frame reader.
  async start() {
    if (this.running) {
      throw new Error("Capture already running");
    }

    console.log("[CAPTURE] Starting...");

    await this.capture.start();

    this.running = true;
    this.captureError = undefined;

    this.reader = this.readLoop();

    console.log("[CAPTURE] Started");
  }

  // Continuously consume frames.
  private async readLoop() {
    try {
      while (this.running) {
        const frame = await this.capture.nextFrame();

        if (!frame) break;

        this.sequence++;

        this.latest = {
          sequence: this.sequence,
          frame,
          capturedAt: Date.now(),
          receivedAt: performance.now(),
        };
      }
    } catch (error) {
      this.captureError =
        error instanceof Error ? error : new Error(String(error));

      console.error("[CAPTURE] Reader error:", error);
    }
  }

  // Wait until the first frame arrives.
  async waitForFirstFrame(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;

    while (!this.latest) {
      if (this.captureError) {
        throw this.captureError;
      }

      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for first frame");
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    return this.latest;
  }

  // Get newest available frame.
  getLatest(): FrameSnapshot {
    if (this.captureError) {
      throw this.captureError;
    }

    if (!this.latest) {
      throw new Error("No frame available yet");
    }

    return this.latest;
  }

  // Encode newest frame to PNG.
  getLatestPng(): Buffer {
    const snapshot = this.getLatest();

    return snapshot.frame.encode(ImageFormat.Png);
  }

  // Encode newest frame as Base64.
  getLatestBase64(): string {
    return this.getLatestPng().toString("base64");
  }

  // Useful metadata for the AI controller.
  getStats() {
    if (!this.latest) return null;

    return {
      sequence: this.latest.sequence,
      width: this.latest.frame.width,
      height: this.latest.frame.height,
      ageMs: Math.round(performance.now() - this.latest.receivedAt),
      capturedAt: this.latest.capturedAt,
    };
  }

  // Stop capture safely.
  async stop() {
    if (!this.running) return;

    console.log("[CAPTURE] Stopping...");

    this.running = false;

    await this.capture.stop();

    if (this.reader) {
      await this.reader;
    }

    console.log("[CAPTURE] Stopped");
  }
}

// ============================================================
// TEST
// ============================================================

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const live = new LiveFrameBuffer();

  try {
    await live.start();

    console.log("[TEST] Waiting for first frame...");

    await live.waitForFirstFrame();

    console.log("[TEST] Frame received!");

    const startedAt = Date.now();

    while (Date.now() - startedAt < TEST_DURATION_MS) {
      await delay(1000);

      console.log("[LIVE]", live.getStats());
    }

    // Save one final frame for visual inspection.
    const screenshot = live.getLatestPng();

    const output = path.join(process.cwd(), "screenshots", "latest-frame.png");

    await writeFile(output, screenshot);

    console.log("\n========== BUFFER TEST COMPLETE ==========");

    console.log({
      stats: live.getStats(),
      pngBytes: screenshot.length,
      output,
    });

    // Example: this is what OpenJEV will eventually receive.
    const base64 = live.getLatestBase64();

    console.log("Base64 length:", base64.length);
  } finally {
    await live.stop();
  }
}

main().catch(console.error);
