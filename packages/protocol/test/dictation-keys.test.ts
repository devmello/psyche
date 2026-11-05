import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  DictationKey,
  defaultHoldKeys,
  MAC_DICTATION_KEYS,
  WINDOWS_DICTATION_KEYS,
  windowsHoldKey,
} from "../src/methods/dictation.ts";

describe("hold-to-talk key names", () => {
  it("keeps the Mac's names and adds the PC's, each once", () => {
    const all = [...MAC_DICTATION_KEYS, ...WINDOWS_DICTATION_KEYS];
    expect(new Set(all).size).toBe(all.length);
    for (const k of all) expect(Value.Check(DictationKey, k), k).toBe(true);
    for (const k of ["vk:42", "F13", "leftWin", "a", ""]) {
      expect(Value.Check(DictationKey, k), k).toBe(false);
    }
    expect(WINDOWS_DICTATION_KEYS).toContain("capsLock");
    expect(WINDOWS_DICTATION_KEYS.filter((k) => /^f\d+$/.test(k))).toHaveLength(12);
  });

  it("maps every name to the key the Windows helper holds", () => {
    expect(windowsHoldKey("fn")).toBe("rightAlt");
    expect(windowsHoldKey("rightOption")).toBe("rightAlt");
    expect(windowsHoldKey("rightCommand")).toBe("rightCtrl");
    for (const k of WINDOWS_DICTATION_KEYS) expect(windowsHoldKey(k)).toBe(k);
  });

  it("defaults to fn and Right ⌘ on a Mac, Right Ctrl and Right Alt on Windows", () => {
    expect(defaultHoldKeys(false)).toEqual({ dictation: "fn", voice: "rightCommand" });
    expect(defaultHoldKeys(true)).toEqual({ dictation: "rightCtrl", voice: "rightAlt" });
  });
});
