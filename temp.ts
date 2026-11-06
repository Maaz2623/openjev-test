import "dotenv/config";
import OpenAI from "openai";

import robot from "robotjs";
import { desktop } from "./utils/desktop";
import { Terminator } from "./utils/terminator";

// ============================================================
// CONFIGURATION
// ============================================================

const MODEL = "diffusiongemma-26b";
const PROCESS = "Opera";
const MAX_ITERATIONS = 10;
const CLICK_TIMEOUT = 3000;

// ============================================================
// OPENAI CLIENT
// ============================================================

const client = new OpenAI({
  baseURL: "https://api.codiv.ai/v1",
  apiKey: process.env.TYPESAFE_API_KEY!,
});

// ============================================================
// TOOLS
// ============================================================

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "click_element",
      description:
        "Click exactly one UI element identified from the latest UI tree.",
      parameters: {
        type: "object",
        properties: {
          elementName: {
            type: "string",
            description: "Exact visible name of the element.",
          },
          elementRole: {
            type: "string",
            description: "Exact UI role of the element.",
          },
        },
        required: ["elementName", "elementRole"],
        additionalProperties: false,
      },
    },
  },
];

// ============================================================
// GET CURRENT UI TREE
// ============================================================

async function getUITree(): Promise<string> {
  const tree = desktop.getWindowTreeResult(PROCESS, undefined, {
    formatOutput: true,
    treeOutputFormat: Terminator.TreeOutputFormat.ClusteredYaml,
    propertyMode: Terminator.PropertyLoadingMode.Complete,
    includeWindowScreenshot: false,
    includeBrowserDom: true,
  });

  return tree.formatted as string;
}

// ============================================================
// TOOL EXECUTOR
// ============================================================

async function executeTool(name: string, args: any) {
  switch (name) {
    case "click_element": {
      const elementName = args.elementName;
      const elementRole = args.elementRole;

      if (
        typeof elementName !== "string" ||
        typeof elementRole !== "string" ||
        !elementName.trim() ||
        !elementRole.trim()
      ) {
        return {
          success: false,
          error: "Invalid element name or role.",
        };
      }

      const selector = `process:${PROCESS} >> role:${elementRole} && text:${elementName}`;

      console.log("\nSelector:", selector);

      try {
        const element = await desktop.locator(selector).first(CLICK_TIMEOUT);

        const bounds = element.bounds();

        if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
          return {
            success: false,
            error: "Element has invalid bounds.",
          };
        }

        const targetX = Math.round(bounds.x + bounds.width / 2);

        const targetY = Math.round(bounds.y + bounds.height / 2);

        console.log("Click position:", {
          x: targetX,
          y: targetY,
        });

        robot.moveMouseSmooth(targetX, targetY);
        robot.mouseClick();

        return {
          success: true,
          message: `Clicked ${elementName}`,
          elementName,
          elementRole,
          position: {
            x: targetX,
            y: targetY,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          elementName,
          elementRole,
        };
      }
    }

    default:
      return {
        success: false,
        error: `Unknown tool: ${name}`,
      };
  }
}

// ============================================================
// AGENT
// ============================================================

async function main() {
  const task = "Search for chat";

  console.log("\n======================================");
  console.log("       VANGREX DESKTOP AGENT");
  console.log("======================================");
  console.log("Task:", task);
  console.log("Model:", MODEL);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `
You are Vangrex, an autonomous desktop UI agent.

Your task is to complete the user's desktop instruction
using the available tools and the provided UI tree.

RULES:

1. Carefully inspect the latest UI tree.
2. Identify the correct target element.
3. Use click_element to click the target.
4. Use exact element names and roles from the UI tree.
5. Perform only ONE click action per iteration.
6. Never guess element names or roles.
7. Never repeat an action that has already succeeded
   unless the latest UI tree proves it is necessary.
8. After every click, inspect the NEW UI tree.
9. Continue clicking through menus and dialogs as needed.
10. When the task is complete, respond with a concise
    confirmation instead of requesting another tool call.
11. If an action fails, inspect the latest UI tree and
    decide how to recover.
12. Do not claim success without evidence in the UI tree.

You must keep working until the task is completed
or you determine that it cannot be completed.
      `,
    },
    {
      role: "user",
      content: task,
    },
  ];

  // Initial observation
  let uiTree = await getUITree();

  console.log("\n========== INITIAL UI TREE ==========");
  console.log(uiTree);

  // ==========================================================
  // AGENT LOOP
  // ==========================================================

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log("\n======================================");
    console.log(`ITERATION ${iteration}/${MAX_ITERATIONS}`);
    console.log("======================================");

    // Give the model the latest observation.
    messages.push({
      role: "user",
      content: `
LATEST DESKTOP UI TREE:

${uiTree}

Choose the next action based on this current state.
If the task is complete, respond without calling a tool.
      `,
    });

    // Ask the model
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_tokens: 1024,
    });

    const message = response.choices[0].message;

    // Preserve assistant response and tool calls.
    messages.push(message);

    // ========================================================
    // CHECK IF MODEL IS FINISHED
    // ========================================================

    if (!message.tool_calls?.length) {
      console.log("\n========== AGENT RESPONSE ==========");
      console.log(message.content);

      console.log("\nTask finished.");
      break;
    }

    // ========================================================
    // EXECUTE TOOL CALLS
    // ========================================================

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") continue;

      const name = toolCall.function.name;
      let args: any;

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        const result = {
          success: false,
          error: "Invalid tool arguments JSON.",
        };

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });

        continue;
      }

      console.log("\n========== TOOL CALL ==========");
      console.log("Tool:", name);
      console.log("Arguments:", args);

      const result = await executeTool(name, args);

      console.log("\n========== TOOL RESULT ==========");
      console.log(result);

      // Return execution result to model.
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });

      // Wait briefly for the UI to update.
      await new Promise((resolve) => setTimeout(resolve, 700));
    }

    // ========================================================
    // REFRESH UI TREE AFTER ACTION
    // ========================================================

    uiTree = await getUITree();

    console.log("\n========== UPDATED UI TREE ==========");
    console.log(uiTree);
  }

  console.log("\n========== AGENT EXIT ==========");
}

main().catch((error) => {
  console.error("\nAgent error:", error);
});
