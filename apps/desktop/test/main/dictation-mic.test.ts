import { describe, expect, it, vi } from "vitest";
import { CaptureLink, parseCaptureAck } from "../../src/main/dictation/capture-link.ts";
import {
  DEFAULT_DICTATION_SETTINGS,
  type HudState,
  SystemDictation,
} from "../../src/main/dictation/controller.ts";
import { Capture, type MicDevices } from "../../src/renderer/dictation-hud.tsx";

/**
 * Issue #611: the macOS microphone indicator stayed on after dictation. Every exit path must
 * leave no microphone stream open.
 */

const notes = { pid: 11, bundleId: "com.apple.Notes", appName: "Notes", insertable: true };
const settled = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A microphone that behaves like the HUD: a stop during an opening start cancels that start. */
function fakeMic(opts: { gate?: boolean; fail?: boolean } = {}) {
  const mic = { open: false, starts: 0, stops: 0, openGate: () => {} };
  let generation = 0;
  return {
    mic,
    capture: {
      async start() {
        mic.starts++;
        const gen = ++generation;
        if (opts.gate) await new Promise<void>((r) => (mic.openGate = r));
        if (gen !== generation) throw new Error("stopped while opening");
        if (opts.fail) throw new Error("denied");
        mic.open = true;
      },
      async stop() {
        mic.stops++;
        generation++;
        mic.open = false;
      },
    },
  };
}

function gateway(over: Record<string, () => unknown> = {}) {
  const methods: string[] = [];
  const handlers: Record<string, () => unknown> = {
    "dictation.target": () => ({ target: notes }),
    "voice.start": () => ({ sessionId: "vs_1", location: "node", engine: "x" }),
    "voice.push": () => ({}),
    "voice.stop": () => ({ transcript: { text: "hello", segments: [] } }),
    "voice.cancel": () => ({ ok: true }),
    "dictation.insert": () => ({ method: "ax", chars: 5, target: notes }),
    ...over,
  };
  return {
    methods,
    call: async (m: string) => {
      methods.push(m);
      const h = handlers[m];
      if (!h) throw { code: "unknown_method" };
      return h();
    },
  };
}

function setup(mic = fakeMic(), gw = gateway()) {
  let t = 0;
  const timers: { fn: () => void; at: number }[] = [];
  const hud: (HudState | null)[] = [];
  const d = new SystemDictation({
    call: gw.call,
    hud: { show: (s) => hud.push(s), hide: () => hud.push(null) },
    capture: mic.capture,
    now: () => t,
    setTimer: (fn, ms) => {
      const e = { fn, at: t + ms };
      timers.push(e);
      return () => {
        const i = timers.indexOf(e);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const x of timers.filter((x) => x.at <= t)) {
      timers.splice(timers.indexOf(x), 1);
      x.fn();
    }
  };
  return { d, mic: mic.mic, gw, hud, advance };
}

describe("dictation releases the microphone on every exit path (#611)", () => {
  it("hold and release", async () => {
    const s = setup();
    s.d.onKey(true);
    await settled();
    expect(s.mic.open).toBe(true);
    s.advance(1000);
    s.d.onKey(false);
    await settled();
    expect(s.mic.open).toBe(false);
    expect(s.d.phase).toBe("idle");
  });

  it("a stray tap", async () => {
    const s = setup();
    s.d.onKey(true);
    await settled();
    s.advance(100);
    s.d.onKey(false);
    await settled();
    expect(s.mic.open).toBe(false);
    expect(s.gw.methods).toContain("voice.cancel");
  });

  it("a release while the microphone is still opening: no stream, no error", async () => {
    const m = fakeMic({ gate: true });
    const s = setup(m);
    s.d.onKey(true);
    await settled();
    expect(s.d.phase).toBe("listening");
    s.d.onKey(false); // before getUserMedia answered
    await settled();
    m.mic.openGate();
    await settled();
    expect(m.mic.open).toBe(false);
    expect(s.d.phase).toBe("idle");
    expect(s.hud.filter((h) => h?.phase === "message")).toEqual([]);
  });

  it("a release while voice.start is in flight never opens the microphone", async () => {
    const s = setup();
    s.d.onKey(true);
    s.d.onKey(false);
    await settled();
    expect(s.mic.open).toBe(false);
    expect(s.d.phase).toBe("idle");
  });

  it("cancel, turning dictation off, and the hotkey toggling off", async () => {
    const a = setup();
    a.d.onKey(true);
    await settled();
    a.d.cancel();
    await settled();
    expect(a.mic.open).toBe(false);

    const b = setup();
    b.d.onKey(true);
    await settled();
    b.d.configure({ ...DEFAULT_DICTATION_SETTINGS, enabled: false });
    await settled();
    expect(b.mic.open).toBe(false);

    const c = setup();
    c.d.toggle();
    await settled();
    c.advance(1000);
    c.d.toggle();
    await settled();
    expect(c.mic.open).toBe(false);
  });

  it("the two-minute cap", async () => {
    const s = setup();
    s.d.toggle();
    await settled();
    s.advance(120_000);
    await settled();
    expect(s.mic.open).toBe(false);
  });

  it("errors: voice.stop fails, the insert is refused, the microphone fails to open", async () => {
    const stopFails = setup(
      fakeMic(),
      gateway({
        "voice.stop": () => {
          throw { code: "internal" };
        },
      }),
    );
    stopFails.d.onKey(true);
    await settled();
    stopFails.advance(1000);
    stopFails.d.onKey(false);
    await settled();
    expect(stopFails.mic.open).toBe(false);

    const refused = setup(
      fakeMic(),
      gateway({
        "dictation.insert": () => {
          throw { code: "policy_denied", details: { refusal: "focus_changed" } };
        },
      }),
    );
    refused.d.onKey(true);
    await settled();
    refused.advance(1000);
    refused.d.onKey(false);
    await settled();
    expect(refused.mic.open).toBe(false);

    const noMic = setup(fakeMic({ fail: true }));
    noMic.d.onKey(true);
    await settled();
    expect(noMic.mic.open).toBe(false);
    expect(noMic.mic.stops).toBeGreaterThan(0);
    expect(noMic.hud.at(-1)).toEqual({
      phase: "message",
      text: "Psyche can't use the microphone.",
    });
  });
});

describe("CaptureLink: main's watchdog over the HUD microphone", () => {
  function link(answer: (cmd: { command: string; id: number }) => object | null) {
    const timers: { fn: () => void; ms: number }[] = [];
    const forced: string[] = [];
    let l: CaptureLink;
    l = new CaptureLink({
      send: (cmd) => {
        const ack = answer(cmd);
        if (ack) queueMicrotask(() => l.onAck({ id: cmd.id, ...ack } as never));
        return true;
      },
      forceRelease: (reason) => forced.push(reason),
      setTimer: (fn, ms) => {
        const e = { fn, ms };
        timers.push(e);
        return () => {
          const i = timers.indexOf(e);
          if (i >= 0) timers.splice(i, 1);
        };
      },
    });
    const fire = () => {
      for (const t of timers.splice(0)) t.fn();
    };
    return { l: () => l, forced, timers, fire };
  }

  it("a confirmed start and stop release without force", async () => {
    const k = link(() => ({ ok: true, open: false }));
    await k.l().start();
    expect(k.l().capturing).toBe(true);
    await k.l().stop();
    expect(k.l().capturing).toBe(false);
    expect(k.forced).toEqual([]);
  });

  it("force-releases when the stop is not confirmed within 2 s", async () => {
    const k = link((c) => (c.command === "start" ? { ok: true, open: true } : null));
    await k.l().start();
    const stopping = k.l().stop();
    expect(k.timers.map((t) => t.ms)).toEqual([2_000]);
    k.fire();
    await stopping;
    expect(k.forced).toHaveLength(1);
    expect(k.l().capturing).toBe(false);
  });

  it("force-releases when the HUD still reports a live stream after stop", async () => {
    const k = link((c) =>
      c.command === "start" ? { ok: true, open: true } : { ok: true, open: true },
    );
    await k.l().start();
    await k.l().stop();
    expect(k.forced).toHaveLength(1);
  });

  it("a start that times out or fails with a stream open force-releases", async () => {
    const slow = link(() => null);
    const starting = slow.l().start();
    slow.fire();
    await expect(starting).rejects.toThrow();
    expect(slow.forced).toHaveLength(1);

    const leaky = link(() => ({ ok: false, open: true }));
    await expect(leaky.l().start()).rejects.toThrow();
    expect(leaky.forced).toHaveLength(1);

    const clean = link(() => ({ ok: false, open: false }));
    await expect(clean.l().start()).rejects.toThrow();
    expect(clean.forced).toEqual([]);
    expect(clean.l().capturing).toBe(false);
  });

  it("a stop is sent even while the start is still waiting, and stop is a no-op when idle", async () => {
    const sent: string[] = [];
    const forced: string[] = [];
    const l = new CaptureLink({
      send: (cmd) => {
        sent.push(cmd.command);
        if (cmd.command === "stop")
          queueMicrotask(() => {
            l.onAck({ id: cmd.id, ok: true, open: false });
            l.onAck({ id: cmd.id - 1, ok: false, open: false }); // the start it cancelled
          });
        return true;
      },
      forceRelease: (r) => forced.push(r),
    });
    const starting = l.start();
    await l.stop();
    await expect(starting).rejects.toThrow();
    expect(sent).toEqual(["start", "stop"]);
    expect(forced).toEqual([]);
    await l.stop();
    expect(sent).toEqual(["start", "stop"]);
  });

  it("parses acks strictly", () => {
    expect(parseCaptureAck({ id: 3, ok: true, open: false })).toEqual({
      id: 3,
      ok: true,
      open: false,
    });
    expect(parseCaptureAck({ id: "3" })).toBeNull();
    expect(parseCaptureAck(null)).toBeNull();
  });
});

describe("HUD renderer Capture", () => {
  function devices(opts: { gate?: boolean; contextFails?: boolean } = {}) {
    const tracks: { readyState: string; stop: () => void }[] = [];
    const contexts: { state: string; closed: number }[] = [];
    const nodes: { disconnected: number }[] = [];
    let release = () => {};
    const node = () => {
      const n = { disconnected: 0, connect: vi.fn(), disconnect: () => void n.disconnected++ };
      nodes.push(n);
      return n;
    };
    const dev: MicDevices = {
      async getUserMedia() {
        const track = {
          readyState: "live",
          stop() {
            track.readyState = "ended";
          },
        };
        tracks.push(track);
        if (opts.gate) await new Promise<void>((r) => (release = r));
        return { getTracks: () => [track] } as unknown as MediaStream;
      },
      createContext() {
        if (opts.contextFails) throw new Error("no audio");
        const ctx = {
          state: "running",
          closed: 0,
          sampleRate: 48_000,
          destination: {},
          resume: async () => undefined,
          close: async () => {
            ctx.closed++;
            ctx.state = "closed";
          },
          createMediaStreamSource: () => node(),
          createScriptProcessor: () => ({ ...node(), onaudioprocess: null }),
        };
        contexts.push(ctx);
        return ctx as unknown as AudioContext;
      },
    };
    return { dev, tracks, contexts, nodes, openGate: () => release() };
  }

  it("stop releases tracks, nodes and the context; release is idempotent", async () => {
    const d = devices();
    const c = new Capture(d.dev);
    await c.start(() => undefined);
    expect(c.open).toBe(true);
    c.stop();
    c.release();
    expect(c.open).toBe(false);
    expect(d.tracks.every((t) => t.readyState === "ended")).toBe(true);
    expect(d.contexts[0]?.closed).toBe(1);
    expect(d.nodes.length).toBe(2);
  });

  it("a stop during getUserMedia drops the stream that arrives late", async () => {
    const d = devices({ gate: true });
    const c = new Capture(d.dev);
    const starting = c.start(() => undefined);
    await settled(1);
    c.stop();
    d.openGate();
    await expect(starting).rejects.toThrow();
    expect(c.open).toBe(false);
    expect(d.tracks[0]?.readyState).toBe("ended");
    expect(d.contexts).toEqual([]);
  });

  it("a second start releases the first stream; a failing context releases the stream", async () => {
    const d = devices();
    const c = new Capture(d.dev);
    await c.start(() => undefined);
    await c.start(() => undefined);
    expect(d.tracks.map((t) => t.readyState)).toEqual(["ended", "live"]);
    c.release();

    const bad = devices({ contextFails: true });
    const b = new Capture(bad.dev);
    await expect(b.start(() => undefined)).rejects.toThrow();
    expect(b.open).toBe(false);
    expect(bad.tracks[0]?.readyState).toBe("ended");
  });
});
