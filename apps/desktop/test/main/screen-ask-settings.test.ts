import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCREEN_ASK_SHORTCUT,
  parseScreenAskSettings,
  ScreenAskShortcut,
} from "../../src/main/screen-ask/settings.ts";

/** A globalShortcut where some accelerators belong to other apps. */
function registry(taken: string[] = []) {
  const held = new Map<string, () => void>();
  return {
    held,
    register(a: string, cb: () => void) {
      if (taken.includes(a) || held.has(a)) return false;
      held.set(a, cb);
      return true;
    },
    unregister(a: string) {
      held.delete(a);
    },
  };
}

function make(values: Record<string, unknown>, taken: string[] = []) {
  const shortcuts = registry(taken);
  const enabled: boolean[] = [];
  let triggers = 0;
  const s = new ScreenAskShortcut({
    call: async () => ({ settings: values }),
    shortcuts,
    trigger: () => {
      triggers++;
    },
    setEnabled: (on) => enabled.push(on),
  });
  return { s, shortcuts, enabled, triggers: () => triggers };
}

describe("Ask about screen settings", () => {
  it("defaults to on with ⌥⇧Space", () => {
    expect(parseScreenAskSettings({})).toEqual({
      enabled: true,
      shortcut: DEFAULT_SCREEN_ASK_SHORTCUT,
    });
    expect(
      parseScreenAskSettings({ "screenAsk.enabled": false, "screenAsk.shortcut": "" }),
    ).toEqual({
      enabled: false,
      shortcut: DEFAULT_SCREEN_ASK_SHORTCUT,
    });
  });

  it("registers the shortcut, falls back when the default is taken, and triggers", async () => {
    const { s, shortcuts, triggers } = make({}, ["Alt+Shift+Space"]);
    await s.load();
    expect(s.current).toBe("Control+Alt+Shift+Space");
    shortcuts.held.get("Control+Alt+Shift+Space")?.();
    expect(triggers()).toBe(1);
  });

  it("a custom shortcut has no fallback; off unregisters and disables the panel", async () => {
    const values: Record<string, unknown> = { "screenAsk.shortcut": "Control+Alt+A" };
    const { s, shortcuts, enabled } = make(values, ["Control+Alt+A"]);
    await s.load();
    expect(s.current).toBe("");
    values["screenAsk.shortcut"] = "Control+Alt+S";
    s.onEvent("settings.changed", {
      entries: [{ key: "screenAsk.shortcut", value: "Control+Alt+S" }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.current).toBe("Control+Alt+S");
    values["screenAsk.enabled"] = false;
    s.onEvent("settings.changed", { entries: [{ key: "screenAsk.enabled", value: false }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.current).toBe("");
    expect(shortcuts.held.size).toBe(0);
    expect(enabled.at(-1)).toBe(false);
    // Unrelated settings don't reload.
    s.onEvent("settings.changed", { entries: [{ key: "appearance.theme", value: "dark" }] });
  });

  it("checks a shortcut for Settings: its own is free, another app's is taken", async () => {
    const { s } = make({}, ["Command+K"]);
    await s.load();
    expect(s.check(DEFAULT_SCREEN_ASK_SHORTCUT)).toBe("ok");
    expect(s.check("Command+K")).toBe("taken");
    expect(s.check("Control+Alt+Z")).toBe("ok");
  });
});
