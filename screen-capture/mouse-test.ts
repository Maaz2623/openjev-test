import robot from "robotjs";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("Starting mouse movement test...");
  console.log("Initial:", robot.getMousePos());

  const positions = [
    { x: 500, y: 400 },
    { x: 800, y: 400 },
    { x: 800, y: 600 },
    { x: 500, y: 600 },
    { x: 500, y: 400 },
  ];

  for (const position of positions) {
    robot.moveMouseSmooth(position.x, position.y);

    await sleep(1000);

    console.log({
      requested: position,
      actual: robot.getMousePos(),
    });
  }

  console.log("Test complete.");
}

main();
