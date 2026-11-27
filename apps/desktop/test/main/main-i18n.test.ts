import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "Psyche", isPackaged: true, quit: () => {}, getLocale: () => "de-DE" },
  Menu: { buildFromTemplate: (t: unknown) => t },
  nativeImage: { createEmpty: () => ({}) },
  Tray: class {},
}));

type TrayModule = typeof import("../../src/main/tray.ts");
type MenuModule = typeof import("../../src/main/menu.ts");
type MainI18nModule = typeof import("../../src/main/main-i18n.ts");

let tray: TrayModule;
let menu: MenuModule;
let mainI18n: MainI18nModule;

/**
 * The main process starts with an empty catalogue registry (only English): the lazy-locale change
 * (#1765) loads one language on demand. The modules are imported fresh so this file sees that state
 * rather than the registry the test setup fills.
 */
beforeAll(async () => {
  vi.resetModules();
  tray = await import("../../src/main/tray.ts");
  menu = await import("../../src/main/menu.ts");
  mainI18n = await import("../../src/main/main-i18n.ts");
});

const actions = {
  open: () => {},
  newSideChat: () => {},
  quickEntry: () => {},
  openApprovals: () => {},
  closeWindow: () => {},
  quitApp: () => {},
  quitEntirely: () => {},
  settings: () => {},
  palette: () => {},
  closeThreadView: () => {},
  zoomIn: () => {},
  zoomOut: () => {},
  zoomReset: () => {},
} as never;

const model = {
  status: { phase: "paired" },
  run: { kind: "running", mode: "launchd" },
  pendingApprovals: 0,
  usagePercentRemaining: 42,
};

function trayLabels(locale: string): string[] {
  const items = tray.trayTemplate(
    { ...model, locale } as never,
    actions,
  ) as MenuItemConstructorOptions[];
  return items.map((i) => i.label).filter((l): l is string => typeof l === "string");
}

function flatLabels(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((i) => [
    ...(typeof i.label === "string" ? [i.label] : []),
    ...(Array.isArray(i.submenu) ? flatLabels(i.submenu) : []),
  ]);
}

describe("the tray and menu labels follow the system language", () => {
  it("are English before the language's catalogue is loaded (the failure this guards)", () => {
    expect(trayLabels("de-DE")).toContain("Nothing needs you");
    expect(flatLabels(menu.appMenuTemplate(actions, "darwin", "de-DE"))).not.toContain(
      "Neuer Chat",
    );
  });

  it("are translated once the system language is loaded at startup", async () => {
    await mainI18n.loadMainLocale();
    const labels = trayLabels("de-DE");
    expect(labels).toContain("Nichts wartet auf dich");
    expect(labels).not.toContain("Nothing needs you");
    expect(flatLabels(menu.appMenuTemplate(actions, "darwin", "de-DE"))).toContain("Neuer Chat");
  });

  it("are loaded before the tray and the menu are built in main.ts", () => {
    const text = readFileSync(join(__dirname, "..", "..", "src", "main.ts"), "utf8");
    const load = text.indexOf("await loadMainLocale();");
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(text.indexOf("buildAppMenu("));
    expect(load).toBeLessThan(text.indexOf("new PsycheTray("));
  });
});
