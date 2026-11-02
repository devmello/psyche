import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "Psyche", isPackaged: true, quit: () => {} },
  Menu: { buildFromTemplate: (t: MenuItemConstructorOptions[]) => t },
}));

const { buildAppMenu } = await import("../src/main/menu.ts");

/** Every accelerator the menu claims, flattened. */
function accelerators(): string[] {
  const noop = () => {};
  const template = buildAppMenu({
    newSideChat: noop,
    palette: noop,
    closeThreadView: noop,
    quitEntirely: noop,
    settings: noop,
    zoomIn: noop,
    zoomOut: noop,
    zoomReset: noop,
  }) as unknown as MenuItemConstructorOptions[];
  const out: string[] = [];
  const walk = (items: readonly MenuItemConstructorOptions[]) => {
    for (const item of items) {
      if (typeof item.accelerator === "string") out.push(item.accelerator);
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(template);
  return out;
}

describe("application menu", () => {
  it("leaves ⌘L to the search surface (a side chat about the highlighted result)", () => {
    // A menu accelerator takes the key before the page sees it.
    expect(accelerators().map((a) => a.toLowerCase())).not.toContain("cmdorctrl+l");
  });
});
