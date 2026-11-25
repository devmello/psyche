import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "Psyche", isPackaged: true, quit: () => {} },
  Menu: { buildFromTemplate: (t: MenuItemConstructorOptions[]) => t },
  nativeImage: { createEmpty: () => ({}) },
  Tray: class {},
}));

const { trayTemplate } = await import("../../src/main/tray.ts");

/**
 * Approvals wave W3: an approval is shown once, on its card, so the menu bar only counts what
 * waits and opens the approvals; it never repeats what the card says.
 */

const noop = () => {};
const actions = {
  open: noop,
  newSideChat: noop,
  quickEntry: noop,
  openApprovals: noop,
  closeWindow: noop,
  quitApp: noop,
  quitEntirely: noop,
};
const model = {
  status: { phase: "paired" } as never,
  run: { kind: "running", mode: "launchd" } as const,
  pendingApprovals: 0,
  usagePercentRemaining: null,
};
const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label);

describe("the tray's approval row", () => {
  it("shows only the count, never the summary of the first card", () => {
    const row = labels(trayTemplate({ ...model, pendingApprovals: 3 }, actions)).find((l) =>
      l?.startsWith("Needs you"),
    );
    expect(row).toBe("Needs you (3)");
    // A summary passed by an older caller is ignored.
    const withSummary = labels(
      trayTemplate(
        { ...model, pendingApprovals: 1, firstApproval: "Send email to jane" } as never,
        actions,
      ),
    ).find((l) => l?.startsWith("Needs you"));
    expect(withSummary).toBe("Needs you (1)");
  });

  it("says nothing needs you when nothing waits (control: the count shows above)", () => {
    expect(labels(trayTemplate(model, actions))).toContain("Nothing needs you");
  });
});
