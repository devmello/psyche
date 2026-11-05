import { describe, expect, it } from "vitest";
import {
  defaultDictationKey,
  parseDictationSettings,
  platformKey,
  type SystemDictation,
} from "../../src/main/dictation/controller.ts";
import {
  DictationService,
  defaultVoiceKey,
  dictationSettingsUrl,
  parseVoiceKey,
} from "../../src/main/dictation/service.ts";

/**
 * Hold-to-talk on Windows: the Windows helper's `dictation.watch` (a low-level keyboard hook)
 * takes the same key names as the Mac helper's; `rightCommand` is Right Ctrl and `rightOption`
 * Right Alt there, and a PC keyboard has no Fn that Windows sees.
 */

function gateway() {
  const calls: { method: string; params: unknown }[] = [];
  const call = async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "settings.get") return { settings: {} };
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
  it("defaults to Right Ctrl, and reads a stored fn as that (no Fn reaches Windows)", () => {
    expect(defaultDictationKey("win32")).toBe("rightCommand");
    expect(defaultDictationKey("darwin")).toBe("fn");
    expect(parseDictationSettings({}, "win32").key).toBe("rightCommand");
    expect(parseDictationSettings({ "voice.pushToTalk": "fn" }, "win32").key).toBe("rightCommand");
    expect(parseDictationSettings({ "voice.pushToTalk": "rightOption" }, "win32").key).toBe(
      "rightOption",
    );
    expect(parseDictationSettings({ "voice.pushToTalk": "fn" }, "darwin").key).toBe("fn");
    expect(platformKey("fn", "darwin")).toBe("fn");
  });

  it("gives the voice key Right Alt by default, apart from dictation's Right Ctrl", () => {
    expect(defaultVoiceKey("win32")).toBe("rightOption");
    const dict = parseDictationSettings({}, "win32");
    expect(parseVoiceKey({ "voice.conversation.enabled": true }, dict, "win32")).toBe(
      "rightOption",
    );
    // A stored voice key that collides with dictation's is off, as on macOS.
    expect(
      parseVoiceKey(
        { "voice.conversation.enabled": true, "voice.conversation.key": "fn" },
        dict,
        "win32",
      ),
    ).toBeNull();
  });

  it("sends the microphone privacy page when dictation cannot listen", () => {
    expect(dictationSettingsUrl("win32")).toBe("ms-settings:privacy-microphone");
    expect(dictationSettingsUrl("darwin")).toMatch(/^x-apple\.systempreferences:/);
  });

  it("arms the Windows helper's watch, and re-arms when a win-helper node comes back", async () => {
    const gw = gateway();
    const svc = new DictationService({ dictation, call: gw.call, platform: "win32" });
    await svc.load();
    const watches = () => gw.calls.filter((c) => c.method === "dictation.watch");
    expect(watches().at(-1)?.params).toEqual({ key: "rightCommand" });
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
