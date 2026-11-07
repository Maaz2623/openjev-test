import robot from "robotjs";

// ============================================================
// VANGREX - ROBOTJS COORDINATE TEST
//
// Origin: TOP LEFT (0, 0)
//
// X: increases -> RIGHT
// X: decreases -> LEFT
// Y: increases -> DOWN
// Y: decreases -> UP
//
// Screenshot: 1920 x 1080
// RobotJS:    1536 x 864 (typically at 125% Windows scaling)
// ============================================================

const CONFIG = {
  screenshotWidth: 1920,
  screenshotHeight: 1080,
  mouseSpeed: 3,
};

// ------------------------------------------------------------
// READ ARGUMENTS
// Usage:
// bun run robotjs-coordinate-test.ts 100 200
// bun run robotjs-coordinate-test.ts 9 773 47 47
// ------------------------------------------------------------

const args = process.argv.slice(2).map(Number);

if (args.length !== 2 && args.length !== 4) {
  console.log(`
Usage:

bun run robotjs-coordinate-test.ts <x> <y>

OR

bun run robotjs-coordinate-test.ts <x> <y> <width> <height>

Examples:

bun run robotjs-coordinate-test.ts 100 200
bun run robotjs-coordinate-test.ts 9 773 47 47
`);
  process.exit(1);
}

const [x, y, width, height] = args;

if (
  !Number.isFinite(x) ||
  !Number.isFinite(y) ||
  (args.length === 4 &&
    (!Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0))
) {
  throw new Error("Invalid coordinates or bounding box dimensions.");
}

// ------------------------------------------------------------
// SCREEN DIMENSIONS
// ------------------------------------------------------------

const screen = robot.getScreenSize();

const robotScreenWidth = screen.width;
const robotScreenHeight = screen.height;

console.log("\n==========================================");
console.log(" VANGREX - ROBOTJS COORDINATE TEST");
console.log("==========================================");

console.log("\n[SCREEN]");
console.log(
  `Screenshot: ${CONFIG.screenshotWidth} x ${CONFIG.screenshotHeight}`,
);
console.log(`RobotJS:    ${robotScreenWidth} x ${robotScreenHeight}`);

// ------------------------------------------------------------
// COORDINATE CONVERSION
// ------------------------------------------------------------

// Screenshot coordinates use top-left origin.
// X increases toward the right.
// Y increases toward the bottom.

const scaleX = robotScreenWidth / CONFIG.screenshotWidth;
const scaleY = robotScreenHeight / CONFIG.screenshotHeight;

// If a bounding box was provided, move to its center.
// Otherwise, use the supplied X/Y directly.

const screenshotX = args.length === 4 ? x + width / 2 : x;

const screenshotY = args.length === 4 ? y + height / 2 : y;

// Direct proportional scaling. No axis inversion.

const robotX = Math.round(screenshotX * scaleX);
const robotY = Math.round(screenshotY * scaleY);

// ------------------------------------------------------------
// VALIDATION
// ------------------------------------------------------------

if (
  screenshotX < 0 ||
  screenshotY < 0 ||
  screenshotX >= CONFIG.screenshotWidth ||
  screenshotY >= CONFIG.screenshotHeight
) {
  throw new Error("Target is outside screenshot boundaries.");
}

if (
  robotX < 0 ||
  robotY < 0 ||
  robotX >= robotScreenWidth ||
  robotY >= robotScreenHeight
) {
  throw new Error("Converted target is outside RobotJS screen boundaries.");
}

// ------------------------------------------------------------
// OUTPUT
// ------------------------------------------------------------

console.log("\n[COORDINATES]");
console.log(`Screenshot target: (${screenshotX}, ${screenshotY})`);
console.log(`Scale X: ${scaleX.toFixed(4)}`);
console.log(`Scale Y: ${scaleY.toFixed(4)}`);
console.log(`RobotJS target:   (${robotX}, ${robotY})`);

// ------------------------------------------------------------
// MOVE MOUSE
// ------------------------------------------------------------

console.log("\n[MOUSE]");
console.log("Moving mouse...");

robot.setMouseDelay(10);
robot.moveMouseSmooth(robotX, robotY, CONFIG.mouseSpeed);

// ------------------------------------------------------------
// VERIFY
// ------------------------------------------------------------

const actual = robot.getMousePos();

console.log("\n[VERIFICATION]");
console.log(`Expected: (${robotX}, ${robotY})`);
console.log(`Actual:   (${actual.x}, ${actual.y})`);

console.log(`Difference: X=${actual.x - robotX}, Y=${actual.y - robotY}`);

console.log("\n==========================================");
console.log(" TEST COMPLETE");
console.log("==========================================\n");
