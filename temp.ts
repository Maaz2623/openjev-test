import "dotenv/config";
import OpenAI from "openai";

import robot from "robotjs";
import { desktop } from "./utils/desktop";
import { Terminator } from "./utils/terminator";

const client = new OpenAI({
  baseURL: "https://api.codiv.ai/v1",
  apiKey: process.env.TYPESAFE_API_KEY!,
});

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "click_element",
      description: "Click the correct UI element based on the user's task.",
      parameters: {
        type: "object",
        properties: {
          elementName: {
            type: "string",
            description:
              "The name or identifying text of the UI element to click.",
          },
          elementRole: {
            type: "string",
            description: "Role of the element to click",
          },
        },
        required: ["elementName", "elementRole"],
        additionalProperties: false,
      },
    },
  },
];

async function executeTool(name: string, args: any) {
  switch (name) {
    case "click_element":
      const element = await desktop
        .locator(
          `process:Code >> role:${args.elementRole} && text:${args.elementName}`,
        )
        .first(1000);

      const { x, y, width, height } = element.bounds();

      const targetX = Math.round(x + width / 2);
      const targetY = Math.round(y + height / 2);

      robot.moveMouseSmooth(targetX, targetY);
      robot.mouseClick();

      return {
        success: true,
        message: "Element clicked",
      };

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
async function main() {
  const tree = desktop.getWindowTreeResult("Code", undefined, {
    formatOutput: true,
    treeOutputFormat: Terminator.TreeOutputFormat.ClusteredYaml,
    propertyMode: Terminator.PropertyLoadingMode.Complete,
    includeWindowScreenshot: false,
  });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "You are a helpful assistant. Use tools when necessary.",
    },
    {
      role: "user",
      content: `Open settings. UI Tree: ${tree.formatted}`,
    },
  ];

  for (let iteration = 0; iteration < 5; iteration++) {
    const response = await client.chat.completions.create({
      model: "diffusiongemma-26b",
      messages,
      tools,
      tool_choice: "auto",
      max_tokens: 1024,
    });

    const message = response.choices[0].message;

    // Preserve the assistant response, including tool calls.
    messages.push(message);

    if (!message.tool_calls?.length) {
      console.log("Assistant:", message.content);
      break;
    }

    // Execute each requested tool.
    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") continue;

      const name = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      console.log("Executing:", name, args);

      const result = await executeTool(name, args);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }
}

main().catch(console.error);
