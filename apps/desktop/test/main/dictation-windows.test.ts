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
 * takes the macOS key names as stored; it holds `fn` and `rightOption` on Right Alt and
 * `rightCommand` on Right Ctrl.
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
    expect(parseDictationSettings({}).key).toBe("fn");
    expect(physicalKey("fn", "win32")).toBe("rightAlt");
    expect(physicalKey("rightOption", "win32")).toBe("rightAlt");
    expect(physicalKey("rightCommand", "win32")).toBe("rightCtrl");
    expect(sameKey("fn", "rightOption", "win32")).toBe(true);
    expect(sameKey("fn", "rightOption", "darwin")).toBe(false);
  });

  it("turns the voice key off when it would share dictation's physical key", () => {
    const dict = parseDictationSettings({});
    const on = { "voice.conversation.enabled": true };
    expect(parseVoiceKey(on, dict, "win32")).toBe("rightCommand");
    expect(parseVoiceKey({ ...on, "voice.conversation.key": "rightOption" }, dict, "win32")).toBe(
      null,
    );
    expect(parseVoiceKey({ ...on, "voice.conversation.key": "rightOption" }, dict, "darwin")).toBe(
      "rightOption",
    );
  });

  it("sends the microphone privacy page when dictation cannot listen", () => {
    expect(dictationSettingsUrl("win32")).toBe("ms-settings:privacy-microphone");
    expect(dictationSettingsUrl("darwin")).toMatch(/^x-apple\.systempreferences:/);
  });

  it("arms the Windows helper's watch with the names as stored, and re-arms on win-helper", async () => {
    const gw = gateway({ "voice.conversation.enabled": true });
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
});
