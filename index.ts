import "dotenv/config";

import { TypeSafeClient } from "@typesafe-ai/sdk";
import { desktop } from "./utils/desktop";
import { Terminator } from "./utils/terminator";

import { findRelevantElements } from "./utils/find-relevant-elements";
import { writeFile } from "node:fs/promises";

const client = new TypeSafeClient({
  baseURL: "https://api.codiv.ai",
});

const tree = await desktop.getWindowTreeResult("Code", undefined, {
  formatOutput: true,
  treeOutputFormat: Terminator.TreeOutputFormat.ClusteredYaml,
  propertyMode: Terminator.PropertyLoadingMode.Complete,
  includeWindowScreenshot: false,
  includeBrowserDom: true,
});

const candidates = await findRelevantElements(
  JSON.stringify(tree),
  "Open Vs code manage settings",
  "./screenshots/screenshot.png",
  10,
);

console.log(candidates);
