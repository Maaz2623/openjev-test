export interface UiElement {
  id: number;
  role: string;
  name: string;
  bounds?: number[];
  state: string[];
}

const INTERACTIVE_ROLES = new Set([
  "Button",
  "TabItem",
  "MenuItem",
  "Menu",
  "Edit",
  "TextBox",
  "ListItem",
  "TreeItem",
  "CheckBox",
  "RadioButton",
  "ComboBox",
  "Hyperlink",
  "SplitButton",
  "Slider",
  "Spinner",
  "Tab",
]);

export function extractElements(tree: string): UiElement[] {
  const elements: UiElement[] = [];

  for (const line of tree.split("\n")) {
    const match = line.match(/^\s*#(\d+)\s+\[([^\]]+)\]\s*(.*)$/);

    if (!match) continue;

    const id = Number(match[1]);
    const role = match[2].trim();

    if (!INTERACTIVE_ROLES.has(role)) continue;

    let remaining = match[3].trim();

    // Extract bounds.
    let bounds: number[] | undefined;

    const boundsMatch = remaining.match(/\(bounds:\s*\[([^\]]+)\]\)/);

    if (boundsMatch) {
      bounds = boundsMatch[1].split(",").map(Number);

      remaining = remaining.replace(boundsMatch[0], "").trim();
    }

    // Extract element state.
    const state: string[] = [];

    for (const flag of ["disabled", "focusable", "focused", "selected"]) {
      const regex = new RegExp(`(?:^|,\\s*)${flag}(?=$|,\\s*)`, "i");

      if (regex.test(remaining)) {
        state.push(flag);
        remaining = remaining.replace(regex, "").trim();
      }
    }

    remaining = remaining.replace(/^,\s*|,\s*$/g, "").trim();

    elements.push({
      id,
      role,
      name: remaining || "(unnamed)",
      bounds,
      state,
    });
  }

  return elements;
}
