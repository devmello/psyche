import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "Psyche", isPackaged: true, quit: () => {} },
  Menu: { buildFromTemplate: (t: MenuItemConstructorOptions[]) => t },
  nativeImage: { createEmpty: () => ({}) },
  Tray: class {},
}));

const { gatewayRowLabel, trayTemplate, trayTooltip } = await import("../../src/main/tray.ts");

const noop = () => {};
const actions = {
  open: noop,
  newSideChat: noop,
  quickEntry: noop,
  openApprovals: noop,
  closeWindow: noop,
  quitApp: noop,
  quitEntirely: noop,
} as never;

const connected = {
  status: { phase: "paired" },
  run: { kind: "running", mode: "launchd" },
  pendingApprovals: 0,
  usagePercentRemaining: 42,
};

function labels(model: object): string[] {
  const items = trayTemplate(model as never, actions) as MenuItemConstructorOptions[];
  return items.map((i) => i.label).filter((l): l is string => typeof l === "string");
}

describe("tray labels follow the language", () => {
  it("writes the status, usage and menu rows in German when the locale is German", () => {
    const de = labels({ ...connected, locale: "de-DE" });
    expect(de).toContain("Psyche — verbunden");
    expect(de).toContain("Nutzung: 42 % übrig");
    expect(de).toContain("Nichts wartet auf dich");
    expect(de).toContain("Neuer Chat");
    expect(de).toContain("Psyche läuft");
    expect(de).not.toContain("Quit Psyche entirely");
    expect(de).not.toContain("Nothing needs you");
  });

  it("counts what needs the owner in the chosen language", () => {
    const de = labels({ ...connected, pendingApprovals: 2, locale: "de" });
    expect(de).toContain("Wartet auf dich (2)");
  });

  it("writes the tooltip in the chosen language, and in English by default", () => {
    expect(trayTooltip({ ...connected, pendingApprovals: 1, locale: "de" } as never)).toBe(
      "Psyche — 1 Sache wartet auf dich",
    );
    expect(trayTooltip(connected as never)).toBe("Psyche — connected");
    expect(labels(connected)).toContain("Psyche — connected");
    expect(labels(connected)).toContain("Nothing needs you");
  });

  it("writes the gateway row in the chosen language, and in English by default", () => {
    const run = { kind: "stopped", reason: "crashed" } as never;
    expect(gatewayRowLabel(run, "de")).toBe("Psyche ist beendet (crashed)");
    expect(gatewayRowLabel(run)).toBe("Psyche stopped (crashed)");
  });
});
