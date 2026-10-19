import { describe, expect, it } from "vitest";
import {
  chordLabel,
  type KeyEventLike,
  matchShortcut,
  SHORTCUTS,
} from "../../src/shell/keyboard.ts";

const ev = (key: string, mods: Partial<KeyEventLike> = {}, code?: string): KeyEventLike => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...(code ? { code } : {}),
  ...mods,
});

describe("keyboard map", () => {
  it("covers every E10 binding", () => {
    const actions = new Set(SHORTCUTS.map((s) => s.action));
    for (const a of [
      "newSideChat",
      "palette",
      "toggleThreadList",
      "stop",
      "openBrowserPane",
      "permissionMode",
      "modelPicker",
      "toggleTerminalPane",
      "closePane",
    ] as const)
      expect(actions.has(a), a).toBe(true);
  });

  it("matches macOS chords", () => {
    const mac = { mac: true };
    expect(matchShortcut(ev("k", { metaKey: true }, "KeyK"), mac)).toBe("palette");
    expect(matchShortcut(ev("B", { metaKey: true, shiftKey: true }, "KeyB"), mac)).toBe(
      "openBrowserPane",
    );
    expect(matchShortcut(ev("b", { metaKey: true }, "KeyB"), mac)).toBe("toggleThreadList");
    expect(matchShortcut(ev("M", { metaKey: true, shiftKey: true }, "KeyM"), mac)).toBe(
      "permissionMode",
    );
    expect(matchShortcut(ev("I", { metaKey: true, shiftKey: true }, "KeyI"), mac)).toBe(
      "modelPicker",
    );
    expect(matchShortcut(ev("`", { ctrlKey: true }, "Backquote"), mac)).toBe("toggleTerminalPane");
    expect(matchShortcut(ev("\\", { metaKey: true }, "Backslash"), mac)).toBe("closePane");
    expect(matchShortcut(ev("Escape"), mac)).toBe("stop");
    expect(matchShortcut(ev("k", { ctrlKey: true }, "KeyK"), mac)).toBeNull();
    expect(matchShortcut(ev("x"), mac)).toBeNull();
  });

  it("uses Ctrl as mod elsewhere and respects text fields", () => {
    expect(matchShortcut(ev("k", { ctrlKey: true }, "KeyK"), { mac: false })).toBe("palette");
    expect(
      matchShortcut(ev("d", { metaKey: true }, "KeyD"), { mac: true, inText: true }),
    ).toBeNull();
    expect(matchShortcut(ev("d", { metaKey: true }, "KeyD"), { mac: true })).toBe("deny");
  });

  it("labels chords", () => {
    expect(chordLabel({ key: "b", mod: true, shift: true }, true)).toBe("⇧⌘B");
    expect(chordLabel({ key: "b", mod: true, shift: true }, false)).toBe("Ctrl+Shift+B");
    expect(chordLabel({ key: "Space", alt: true }, true)).toBe("⌥Space");
  });
});
