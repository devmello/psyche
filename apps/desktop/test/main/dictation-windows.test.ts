import { describe, expect, it } from "vitest";
import {
  parseDictationSettings,
  physicalKey,
  type SystemDictation,
  sameKey,
} from "../../src/main/dictation/controller.ts";
import {
  DictationService,
  dictationSettingsUrl,
  parseVoiceKey,
} from "../../src/main/dictation/service.ts";

/**
 * Hold-to-talk on Windows: the Windows helper's `dictation.watch` (a low-level keyboard hook)
 * takes the key names as stored: its own (`rightCtrl`, `capsLock`, `f13`…) and the macOS names an
 * older Settings stored (`fn` and `rightOption` on Right Alt, `rightCommand` on Right Ctrl).
 */

function gateway(settings: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const call = async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "settings.get") return { settings };
    if (method === "dictation.watch") return { watching: true };
    throw { code: "unknown_method" };
  };
  return { call, calls };
}

/** Only `configure` and `cancel` are reached by the service in these tests. */
const dictation = {
  configure: () => undefined,
  cancel: () => undefined,
  onKey: () => undefined,
  onSegment: () => undefined,
  toggle: () => undefined,
} as unknown as SystemDictation;

describe("Windows dictation keys", () => {
  it("passes the stored names through; fn and Right Option are one key (Right Alt)", () => {
    expect(parseDictationSettings({}, "darwin").key).toBe("fn");
    // Windows defaults to Right Ctrl: never AltGr, and the same key on every layout.
    expect(parseDictationSettings({}, "win32").key).toBe("rightCtrl");
    expect(parseDictationSettings({ "voice.pushToTalk": "fn" }, "win32").key).toBe("fn");
    expect(parseDictationSettings({ "voice.pushToTalk": "capsLock" }, "win32").key).toBe(
      "capsLock",
    );
    // A Windows key name means nothing to a Mac helper: the Mac default instead.
    expect(parseDictationSettings({ "voice.pushToTalk": "capsLock" }, "darwin").key).toBe("fn");
    expect(parseDictationSettings({ "voice.pushToTalk": "f13" }, "win32").key).toBe("f13");
    expect(parseDictationSettings({ "voice.pushToTalk": "vk:42" }, "win32").key).toBe("rightCtrl");
    expect(physicalKey("rightCtrl", "win32")).toBe("rightCtrl");
    expect(physicalKey("capsLock", "win32")).toBe("capsLock");
    expect(sameKey("rightCommand", "rightCtrl", "win32")).toBe(true);
    expect(sameKey("rightAlt", "fn", "win32")).toBe(true);
    expect(physicalKey("fn", "win32")).toBe("rightAlt");
    expect(physicalKey("rightOption", "win32")).toBe("rightAlt");
    expect(physicalKey("rightCommand", "win32")).toBe("rightCtrl");
    expect(sameKey("fn", "rightOption", "win32")).toBe(true);
    expect(sameKey("fn", "rightOption", "darwin")).toBe(false);
  });

  it("turns the voice key off when it would share dictation's physical key", () => {
    const mac = parseDictationSettings({}, "darwin");
    const win = parseDictationSettings({}, "win32");
    const on = { "voice.conversation.enabled": true };
    // Defaults: Right ⌘ beside fn on a Mac; Right Alt beside Right Ctrl on Windows.
    expect(parseVoiceKey(on, mac, "darwin")).toBe("rightCommand");
    expect(parseVoiceKey(on, win, "win32")).toBe("rightAlt");
    // Right Command is Right Ctrl on Windows: the dictation key, so voice is off.
    expect(parseVoiceKey({ ...on, "voice.conversation.key": "rightCommand" }, win, "win32")).toBe(
      null,
    );
    const fn = parseDictationSettings({ "voice.pushToTalk": "fn" }, "win32");
    expect(parseVoiceKey({ ...on, "voice.conversation.key": "rightOption" }, fn, "win32")).toBe(
      null,
    );
    expect(parseVoiceKey({ ...on, "voice.conversation.key": "rightOption" }, mac, "darwin")).toBe(
      "rightOption",
    );
  });

  it("sends the microphone privacy page when dictation cannot listen", () => {
    expect(dictationSettingsUrl("win32")).toBe("ms-settings:privacy-microphone");
    expect(dictationSettingsUrl("darwin")).toMatch(/^x-apple\.systempreferences:/);
  });

  it("arms the Windows helper's watch with the names as stored, and re-arms on win-helper", async () => {
    const gw = gateway({
      "voice.conversation.enabled": true,
      "voice.pushToTalk": "fn",
      "voice.conversation.key": "rightCommand",
    });
    const svc = new DictationService({ dictation, call: gw.call, platform: "win32" });
    await svc.load();
    const watches = () => gw.calls.filter((c) => c.method === "dictation.watch");
    expect(watches().at(-1)?.params).toEqual({
      key: "fn",
      keys: [
        { key: "fn", role: "dictation" },
        { key: "rightCommand", role: "voice" },
      ],
    });
    expect(svc.status).toMatchObject({ helper: "online", watching: true });

    svc.onEvent("node.updated", { node: { kind: "win-helper", status: "offline" } });
    expect(svc.status).toMatchObject({ helper: "offline", watching: false });
    svc.onEvent("node.updated", { node: { kind: "win-helper", status: "online" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(watches()).toHaveLength(2);
    expect(svc.status).toMatchObject({ helper: "online", watching: true });

    // Another computer's node is not this computer's helper.
    svc.onEvent("node.updated", { node: { kind: "remote", status: "offline" } });
    expect(svc.status).toMatchObject({ helper: "online" });
  });

  it("arms the Windows defaults and reports an AltGr layout for Settings", async () => {
    const gw = gateway({ "voice.conversation.enabled": true });
    const svc = new DictationService({
      dictation,
      call: gw.call,
      platform: "win32",
      altGrLayout: async () => true,
    });
    await svc.load();
    expect(gw.calls.filter((c) => c.method === "dictation.watch").at(-1)?.params).toEqual({
      key: "rightCtrl",
      keys: [
        { key: "rightCtrl", role: "dictation" },
        { key: "rightAlt", role: "voice" },
      ],
    });
    expect(svc.status).toMatchObject({ altGrLayout: true });
    // A Mac never asks.
    const asked: string[] = [];
    const mac = new DictationService({
      dictation,
      call: gateway().call,
      platform: "darwin",
      altGrLayout: async () => {
        asked.push("x");
        return true;
      },
    });
    await mac.load();
    expect(asked).toEqual([]);
    expect(mac.status.altGrLayout).toBeUndefined();
  });
});
