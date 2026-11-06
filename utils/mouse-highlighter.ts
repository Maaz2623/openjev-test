import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

// ============================================================
// VANGREX - LIVE MOUSE HIGHLIGHTER
// ============================================================

const CONFIG = {
  size: 90,
  color: "#00D9FF",
  opacity: 0.85,
  borderWidth: 3,
  glow: 18,
  updateInterval: 8,
};

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

const appDir = await mkdtemp(path.join(tmpdir(), "vangrex-mouse-"));

// ============================================================
// ELECTRON MAIN PROCESS
// ============================================================

const mainCode = `
const {
  app,
  BrowserWindow,
  screen,
  globalShortcut
} = require("electron");

const path = require("node:path");

let overlay;
let timer;

const SIZE = ${CONFIG.size};
const UPDATE_INTERVAL = ${CONFIG.updateInterval};

function createOverlay() {
  overlay = new BrowserWindow({
    width: SIZE,
    height: SIZE,

    frame: false,
    transparent: true,
    backgroundColor: "#00000000",

    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,

    hasShadow: false,
    focusable: false,
    skipTaskbar: true,

    alwaysOnTop: true,

    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  overlay.setAlwaysOnTop(true, "screen-saver");

  overlay.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true
  });

  // Allow all mouse events to pass through.
  overlay.setIgnoreMouseEvents(true, {
    forward: true
  });

  overlay.loadFile(path.join(__dirname, "index.html"));

  overlay.once("ready-to-show", () => {
    overlay.showInactive();
    startTracking();
  });

  overlay.on("closed", () => {
    overlay = null;
  });
}

// ============================================================
// CURSOR TRACKING
// ============================================================

function startTracking() {
  if (timer) clearInterval(timer);

  timer = setInterval(() => {
    if (!overlay || overlay.isDestroyed()) return;

    const cursor = screen.getCursorScreenPoint();

    const x = Math.round(cursor.x - SIZE / 2);
    const y = Math.round(cursor.y - SIZE / 2);

    overlay.setPosition(x, y, false);
  }, UPDATE_INTERVAL);
}

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================

app.whenReady().then(() => {
  createOverlay();

  // Ctrl + Shift + H: toggle highlight
  globalShortcut.register("Control+Shift+H", () => {
    if (!overlay) return;

    if (overlay.isVisible()) {
      overlay.hide();
    } else {
      overlay.showInactive();
    }
  });

  // Escape: exit application
  globalShortcut.register("Escape", () => {
    app.quit();
  });
});

app.on("will-quit", () => {
  if (timer) clearInterval(timer);
  globalShortcut.unregisterAll();
});
`;

// ============================================================
// OVERLAY HTML
// ============================================================

const htmlCode = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
}

#highlight {
  position: absolute;

  width: ${CONFIG.size}px;
  height: ${CONFIG.size}px;

  top: 0;
  left: 0;

  border-radius: 50%;

  border: ${CONFIG.borderWidth}px solid ${CONFIG.color};

  background: radial-gradient(
    circle,
    ${CONFIG.color} 0%,
    transparent 70%
  );

  opacity: ${CONFIG.opacity};

  box-shadow:
    0 0 ${CONFIG.glow}px ${CONFIG.color},
    inset 0 0 ${CONFIG.glow / 2}px ${CONFIG.color};

  animation: pulse 2s ease-in-out infinite;

  pointer-events: none;
}

@keyframes pulse {
  0%, 100% {
    transform: scale(1);
    opacity: ${CONFIG.opacity};
  }

  50% {
    transform: scale(0.94);
    opacity: ${CONFIG.opacity * 0.65};
  }
}
</style>
</head>

<body>
  <div id="highlight"></div>
</body>
</html>
`;

// ============================================================
// WRITE AND LAUNCH
// ============================================================

await writeFile(path.join(appDir, "main.cjs"), mainCode);

await writeFile(path.join(appDir, "index.html"), htmlCode);

await writeFile(
  path.join(appDir, "package.json"),
  JSON.stringify(
    {
      name: "vangrex-mouse-highlighter",
      version: "1.0.0",
      main: "main.cjs",
    },
    null,
    2,
  ),
);

console.log("");
console.log("========================================");
console.log(" VANGREX MOUSE HIGHLIGHTER");
console.log("========================================");
console.log("Starting cursor tracking...");
console.log("");
console.log("Ctrl + Shift + H : Toggle highlight");
console.log("Escape           : Exit");
console.log("");
console.log("Highlight size:", CONFIG.size);
console.log("Color:", CONFIG.color);
console.log("Update interval:", CONFIG.updateInterval, "ms");
console.log("========================================");

const child = spawn(electronPath, [appDir], {
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error("Electron launch failed:", error);
});

const exitCode = await new Promise<number>((resolve) => {
  child.on("exit", (code) => resolve(code ?? 0));
});

console.log("Highlighter stopped. Exit code:", exitCode);
