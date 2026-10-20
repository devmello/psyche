import { describe, expect, it } from "vitest";
import {
  DEFAULT_DICTATION_SETTINGS,
  type HudState,
  parseDictationSettings,
  SystemDictation,
} from "../../src/main/dictation/controller.ts";
import { DictationService, type ShortcutRegistry } from "../../src/main/dictation/service.ts";

const notes = { pid: 11, bundleId: "com.apple.Notes", appName: "Notes", insertable: true };

/** A fake Gateway answering the speech and dictation methods like the real ones. */
function fakeGateway(over: Record<string, (p: unknown) => unknown> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const handlers: Record<string, (p: unknown) => unknown> = {
    "dictation.target": () => ({ target: notes }),
    "voice.start": () => ({ sessionId: "vs_1", location: "node", engine: "speechAnalyzer" }),
    "voice.push": () => ({}),
    "voice.stop": () => ({ transcript: { text: "hello world", segments: [] } }),
    "voice.cancel": () => ({ ok: true }),
    "dictation.insert": (p) => ({
      method: "ax",
      chars: (p as { text: string }).text.length,
      target: notes,
    }),
    "dictation.watch": (p) => ({ watching: (p as { key: unknown }).key !== null }),
    "settings.get": () => ({ settings: {} }),
    ...over,
  };
  const call = async (method: string, params: unknown) => {
    calls.push({ method, params });
    const h = handlers[method];
    if (!h) throw { code: "unknown_method" };
    return h(params);
  };
  return { call, calls, methods: () => calls.map((c) => c.method) };
}

function harness(opts: { gateway?: ReturnType<typeof fakeGateway>; micFails?: boolean } = {}) {
  const gw = opts.gateway ?? fakeGateway();
  const hud: (HudState | null)[] = [];
  let t = 0;
  const timers: { fn: () => void; at: number }[] = [];
  const capture = { starts: 0, stops: 0 };
  const d = new SystemDictation({
    call: gw.call,
    hud: { show: (s) => hud.push(s), hide: () => hud.push(null) },
    capture: {
      start: async () => {
        capture.starts++;
        if (opts.micFails) throw new Error("denied");
      },
      stop: async () => {
        capture.stops++;
      },
    },
    now: () => t,
    setTimer: (fn, ms) => {
      const entry = { fn, at: t + ms };
      timers.push(entry);
      return () => timers.splice(timers.indexOf(entry), 1);
    },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const x of timers.filter((x) => x.at <= t)) {
      timers.splice(timers.indexOf(x), 1);
      x.fn();
    }
  };
  return { d, gw, hud, capture, advance };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe("system-wide dictation controller (J9, Q2)", () => {
  it("hold: listens, shows partials, inserts the final text into the focused app", async () => {
    const h = harness();
    h.d.onKey(true);
    await settled();
    expect(h.d.phase).toBe("listening");
    expect(h.hud.at(-1)).toEqual({ phase: "listening", app: "Notes", text: "" });
    h.d.onAudio("AAAA");
    h.d.onAudio("BBBB");
    h.d.onSegment("vs_1", { text: "hello", final: false });
    expect(h.hud.at(-1)).toEqual({ phase: "listening", app: "Notes", text: "hello" });
    h.d.onSegment("other", { text: "ignored", final: false });
    h.advance(1000);
    h.d.onKey(false);
    await settled();
    await settled();
    expect(h.d.phase).toBe("idle");
    expect(h.gw.methods()).toEqual([
      "dictation.target",
      "voice.start",
      "voice.push",
      "voice.push",
      "voice.stop",
      "dictation.insert",
    ]);
    const pushes = h.gw.calls.filter((c) => c.method === "voice.push").map((c) => c.params);
    expect(pushes).toEqual([
      { sessionId: "vs_1", seq: 0, audio: "AAAA" },
      { sessionId: "vs_1", seq: 1, audio: "BBBB" },
    ]);
    expect(h.gw.calls.at(-1)?.params).toEqual({ text: "hello world", expectPid: 11 });
    expect(h.gw.calls[1]?.params).toEqual({
      format: { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 },
    });
    expect(h.capture).toEqual({ starts: 1, stops: 1 });
    expect(h.hud.at(-1)).toBeNull();
  });

  it("a stray tap is cancelled without inserting anything", async () => {
    const h = harness();
    h.d.onKey(true);
    await settled();
    h.advance(100);
    h.d.onKey(false);
    await settled();
    expect(h.gw.methods()).toEqual(["dictation.target", "voice.start", "voice.cancel"]);
    expect(h.d.phase).toBe("idle");
  });

  it("a release while voice.start is in flight still ends the session", async () => {
    const h = harness();
    h.d.onKey(true);
    h.d.onKey(false);
    await settled();
    await settled();
    expect(h.gw.methods()).toContain("voice.cancel");
    expect(h.gw.methods()).not.toContain("dictation.insert");
    expect(h.d.phase).toBe("idle");
  });

  it("does nothing over Psyche's own window and explains refusals elsewhere", async () => {
    const own = harness({
      gateway: fakeGateway({
        "dictation.target": () => ({
          target: { ...notes, insertable: false, refusal: "own_window" },
        }),
      }),
    });
    own.d.onKey(true);
    await settled();
    expect(own.gw.methods()).toEqual(["dictation.target"]);
    expect(own.hud).toEqual([]);

    const pw = harness({
      gateway: fakeGateway({
        "dictation.target": () => ({
          target: { ...notes, insertable: false, refusal: "secure_field" },
        }),
      }),
    });
    pw.d.onKey(true);
    await settled();
    expect(pw.gw.methods()).toEqual(["dictation.target"]);
    expect(pw.hud.at(-1)).toEqual({
      phase: "message",
      text: "Psyche never types into password fields.",
    });
    pw.advance(3000);
    expect(pw.hud.at(-1)).toBeNull();
  });

  it("reports a refused insert (focus moved) and an empty transcript inserts nothing", async () => {
    const moved = harness({
      gateway: fakeGateway({
        "dictation.insert": () => {
          throw { code: "policy_denied", details: { refusal: "focus_changed" } };
        },
      }),
    });
    moved.d.onKey(true);
    await settled();
    moved.advance(1000);
    await moved.d.release();
    expect(moved.hud.at(-1)).toEqual({
      phase: "message",
      text: "Focus moved to another app, so nothing was inserted.",
    });

    const empty = harness({
      gateway: fakeGateway({ "voice.stop": () => ({ transcript: { text: "  ", segments: [] } }) }),
    });
    empty.d.onKey(true);
    await settled();
    empty.advance(1000);
    await empty.d.release();
    expect(empty.gw.methods()).not.toContain("dictation.insert");
  });

  it("toggle mode: press to start, press to stop; the max duration stops it too", async () => {
    const h = harness();
    h.d.configure({ ...DEFAULT_DICTATION_SETTINGS, mode: "toggle" });
    h.d.onKey(true);
    await settled();
    h.d.onKey(false);
    expect(h.d.phase).toBe("listening");
    h.advance(500);
    h.d.onKey(true);
    await settled();
    await settled();
    expect(h.gw.methods()).toContain("dictation.insert");

    const long = harness();
    long.d.toggle();
    await settled();
    long.advance(120_000);
    await settled();
    await settled();
    expect(long.gw.methods()).toContain("dictation.insert");
  });

  it("is off when disabled, and a missing helper or microphone says so", async () => {
    const off = harness();
    off.d.configure({ ...DEFAULT_DICTATION_SETTINGS, enabled: false });
    off.d.onKey(true);
    off.d.toggle();
    await settled();
    expect(off.gw.calls).toEqual([]);

    const noHelper = harness({
      gateway: fakeGateway({
        "dictation.target": () => {
          throw { code: "unavailable" };
        },
      }),
    });
    noHelper.d.onKey(true);
    await settled();
    expect(noHelper.hud.at(-1)).toMatchObject({ phase: "message" });
    expect(noHelper.d.phase).toBe("idle");

    const mic = harness({ micFails: true });
    mic.d.onKey(true);
    await settled();
    expect(mic.gw.methods()).toContain("voice.cancel");
    expect(mic.hud.at(-1)).toEqual({ phase: "message", text: "Psyche can't use the microphone." });
  });

  it("parses settings with safe defaults", () => {
    expect(parseDictationSettings({})).toEqual(DEFAULT_DICTATION_SETTINGS);
    expect(
      parseDictationSettings({
        "voice.systemWide": false,
        "voice.pushToTalk": "rightOption",
        "voice.mode": "toggle",
        "voice.hotkey": " Control+Alt+D ",
      }),
    ).toEqual({ enabled: false, key: "rightOption", mode: "toggle", hotkey: "Control+Alt+D" });
    expect(
      parseDictationSettings({ "voice.pushToTalk": "capsLock", "voice.mode": 3 }),
    ).toMatchObject({ key: "fn", mode: "hold" });
  });
});

describe("dictation service", () => {
  function shortcuts(taken: string[] = []) {
    const registered = new Map<string, () => void>();
    const reg: ShortcutRegistry = {
      register: (a, cb) => {
        if (taken.includes(a)) return false;
        registered.set(a, cb);
        return true;
      },
      unregister: (a) => void registered.delete(a),
    };
    return { reg, registered };
  }

  it("arms the helper watch and the hotkey from settings, and follows changes", async () => {
    const values: Record<string, unknown> = { "voice.hotkey": "Control+Alt+D" };
    const gw = fakeGateway({ "settings.get": () => ({ settings: values }) });
    const h = harness({ gateway: gw });
    const sc = shortcuts();
    const svc = new DictationService({ dictation: h.d, call: gw.call, shortcuts: sc.reg });
    await svc.load();
    expect(gw.calls.find((c) => c.method === "dictation.watch")?.params).toEqual({ key: "fn" });
    expect(svc.watching).toBe(true);
    expect([...sc.registered.keys()]).toEqual(["Control+Alt+D"]);

    sc.registered.get("Control+Alt+D")?.();
    await settled();
    expect(h.d.phase).toBe("listening");
    h.d.cancel();

    // Off: the watch stops (key null) and the hotkey goes away.
    values["voice.systemWide"] = false;
    svc.onEvent("settings.changed", { entries: [{ key: "voice.systemWide", value: false }] });
    await settled();
    await settled();
    expect(gw.calls.filter((c) => c.method === "dictation.watch").at(-1)?.params).toEqual({
      key: null,
    });
    expect(sc.registered.size).toBe(0);
    expect(svc.watching).toBe(false);
  });

  it("routes key and segment events, ignoring other keys, and re-arms when the helper returns", async () => {
    const gw = fakeGateway();
    const h = harness({ gateway: gw });
    const svc = new DictationService({ dictation: h.d, call: gw.call });
    await svc.load();
    svc.onEvent("dictation.key", { key: "rightOption", down: true, at: "" });
    await settled();
    expect(h.d.phase).toBe("idle");
    svc.onEvent("dictation.key", { key: "fn", down: true, at: "" });
    await settled();
    expect(h.d.phase).toBe("listening");
    svc.onEvent("voice.segment", { sessionId: "vs_1", segment: { text: "hi", final: true } });
    expect(h.hud.at(-1)).toEqual({ phase: "listening", app: "Notes", text: "hi" });

    const before = gw.calls.filter((c) => c.method === "dictation.watch").length;
    svc.onEvent("node.updated", { node: { kind: "mac-helper", status: "online" } });
    await settled();
    expect(gw.calls.filter((c) => c.method === "dictation.watch").length).toBe(before + 1);
    svc.onDisconnected();
    expect(h.d.phase).toBe("idle");
  });

  it("warns when the hotkey is taken and stays quiet when no helper is connected", async () => {
    const warnings: string[] = [];
    const gw = fakeGateway({
      "settings.get": () => ({ settings: { "voice.hotkey": "Alt+Space" } }),
      "dictation.watch": () => {
        throw { code: "unavailable" };
      },
    });
    const h = harness({ gateway: gw });
    const sc = shortcuts(["Alt+Space"]);
    const svc = new DictationService({
      dictation: h.d,
      call: gw.call,
      shortcuts: sc.reg,
      warn: (m) => warnings.push(m),
    });
    await svc.load();
    expect(svc.hotkey).toBe("");
    expect(warnings).toEqual(["the dictation hotkey Alt+Space is taken by another app"]);
  });
});
