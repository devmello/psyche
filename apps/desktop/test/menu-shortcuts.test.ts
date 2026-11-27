import type { MenuItemConstructorOptions } from "electron";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
    toggleSidebar: noop,
    toggleCompactSidebar: noop,
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

describe("application menu language", () => {
  // The app loads the system language at startup (main-i18n.ts); the menu reads only what is loaded.
  beforeAll(async () => {
    const { createLoadedI18n } = await import("@psyche/ui/i18n-core");
    await createLoadedI18n({ locale: "de" });
  });
  const noop = () => {};
  const actions = {
    newSideChat: noop,
    palette: noop,
    toggleSidebar: noop,
    toggleCompactSidebar: noop,
    closeThreadView: noop,
    quitEntirely: noop,
    settings: noop,
    zoomIn: noop,
    zoomOut: noop,
    zoomReset: noop,
  };
  /** Every label and role the template names, flattened. */
  function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    const out: MenuItemConstructorOptions[] = [];
    const walk = (list: readonly MenuItemConstructorOptions[]) => {
      for (const item of list) {
        out.push(item);
        if (Array.isArray(item.submenu)) walk(item.submenu);
      }
    };
    walk(template);
    return out;
  }

  it("labels the menu in the system language, with the same commands", async () => {
    const { appMenuTemplate } = await import("../src/main/menu.ts");
    const german = items(appMenuTemplate(actions, "darwin", "de-DE"));
    const labels = german.map((i) => i.label).filter((l): l is string => typeof l === "string");
    expect(labels).toContain("Neuer Chat");
    expect(labels).toContain("Ablage");
    expect(labels).not.toContain("New Chat");
    expect(labels).not.toContain("File");
    // The commands are the same whatever the language: New Chat still runs newSideChat.
    const newChat = german.find((i) => i.label === "Neuer Chat");
    expect(newChat?.accelerator).toBe("CmdOrCtrl+N");
    expect(newChat?.click).toBe(actions.newSideChat);
  });

  it("keeps Electron's roles for Edit and Window, which macOS localizes itself", async () => {
    const { appMenuTemplate } = await import("../src/main/menu.ts");
    const roles = items(appMenuTemplate(actions, "darwin", "fr-FR")).map((i) => i.role);
    expect(roles).toContain("editMenu");
    expect(roles).toContain("windowMenu");
  });

  it("falls back to English for a language without a catalogue", async () => {
    const { appMenuTemplate } = await import("../src/main/menu.ts");
    const labels = items(appMenuTemplate(actions, "darwin", "xx-XX")).map((i) => i.label);
    expect(labels).toContain("New Chat");
  });
});

describe("View menu sidebar items", () => {
  beforeAll(async () => {
    const { createLoadedI18n } = await import("@psyche/ui/i18n-core");
    await createLoadedI18n({ locale: "en" });
  });
  const noop = () => {};
  const toggleSidebar = vi.fn();
  const toggleCompactSidebar = vi.fn();
  const actions = {
    newSideChat: noop,
    palette: noop,
    toggleSidebar,
    toggleCompactSidebar,
    closeThreadView: noop,
    quitEntirely: noop,
    settings: noop,
    zoomIn: noop,
    zoomOut: noop,
    zoomReset: noop,
  };

  async function viewItems(platform: NodeJS.Platform) {
    const { appMenuTemplate } = await import("../src/main/menu.ts");
    const view = appMenuTemplate(actions, platform, "en").find((m) => m.label === "View");
    return (view?.submenu ?? []) as MenuItemConstructorOptions[];
  }

  for (const platform of ["darwin", "win32"] as const) {
    it(`puts Toggle Sidebar and Compact Sidebar first in View on ${platform}, then a separator`, async () => {
      const [first, second, third] = await viewItems(platform);
      expect(first?.label).toBe("Toggle Sidebar");
      expect(second?.label).toBe("Compact Sidebar");
      expect(third?.type).toBe("separator");
    });

    it(`runs the same actions as the sidebar keys on ${platform}, once per click`, async () => {
      const items = await viewItems(platform);
      const toggle = items[0] as MenuItemConstructorOptions;
      const compact = items[1] as MenuItemConstructorOptions;
      // ⌘B and ⌘⌥B (Ctrl on Windows): the menu accelerator takes the key, the page never sees it.
      expect(toggle.accelerator).toBe("CmdOrCtrl+B");
      expect(compact.accelerator).toBe("CmdOrCtrl+Alt+B");
      toggleSidebar.mockClear();
      toggleCompactSidebar.mockClear();
      (toggle.click as () => void)();
      expect(toggleSidebar).toHaveBeenCalledTimes(1);
      expect(toggleCompactSidebar).not.toHaveBeenCalled();
      (compact.click as () => void)();
      expect(toggleCompactSidebar).toHaveBeenCalledTimes(1);
      expect(toggleSidebar).toHaveBeenCalledTimes(1);
    });
  }
});
