import { describe, expect, it } from "vitest";
import type { AudioSource } from "../../src/shell/voice.ts";
import {
  type ConversationPlayer,
  DUCK_VOLUME,
  PUSH_TAIL_MS,
  SUSPECT_MS,
  VoiceConversationTerminal,
} from "../../src/shell/voice-conversation.ts";

/** Voice U2: the renderer as the voice conversation's audio terminal (voice-mode-2026 §4.2). */

function fakeMic() {
  const mic = {
    open: false,
    opens: 0,
    push: (_f: Float32Array, _r: number) => {},
  };
  const source: AudioSource = {
    start: async (onFrames) => {
      mic.open = true;
      mic.opens += 1;
      mic.push = onFrames;
      return () => {
        mic.open = false;
        mic.push = () => {};
      };
    },
  };
  return { mic, source };
}

function fakePlayer() {
  const p = {
    playing: false,
    endedAt: 0,
    volume: 1,
    chunks: [] as { utteranceId: string; samples: number; last: boolean }[],
    finished: (_u: string, _ms: number) => {},
    closed: false,
  };
  const player: ConversationPlayer = {
    enqueue(utteranceId, pcm, _rate, last) {
      p.playing = true;
      p.chunks.push({ utteranceId, samples: pcm.length, last });
    },
    stop() {
      const was = p.playing;
      p.playing = false;
      return was ? { utteranceId: "u1", playedMs: 1234 } : null;
    },
    setVolume(v) {
      p.volume = v;
    },
    onFinished(cb) {
      p.finished = cb;
    },
    get playing() {
      return p.playing;
    },
    get endedAt() {
      return p.endedAt;
    },
    level: () => (p.playing ? 0.2 : 0),
    close() {
      p.closed = true;
    },
  };
  return { p, player };
}

function setup(bargeIn = true) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const listeners = new Set<(e: string, p: unknown) => void>();
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let clock = 10_000;
  const { mic, source } = fakeMic();
  const { p, player } = fakePlayer();
  const terminal = new VoiceConversationTerminal({
    call: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === "voice.conversation.start")
        return { conversationId: "vc_1", engine: "x", location: "node" };
      return {};
    },
    tap: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    source,
    player: () => player,
    bargeIn: () => bargeIn,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: timers.length + 1 };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const emit = (event: string, payload: Record<string, unknown>) => {
    for (const l of [...listeners]) l(event, { conversationId: "vc_1", ...payload });
  };
  const flush = () => {
    for (const t of timers.splice(0)) t.fn();
  };
  return {
    terminal,
    calls,
    mic,
    p,
    emit,
    flush,
    advance: (ms: number) => {
      clock += ms;
    },
    timers,
  };
}

const speech = (n: number, level = 0.3) =>
  Float32Array.from({ length: n }, (_, i) => (i % 2 ? level : -level));
const silence = (n: number) => new Float32Array(n);
const pcmBase64 = btoa(String.fromCharCode(0, 0, 255, 127));

describe("VoiceConversationTerminal", () => {
  it("push-to-talk opens the mic only while held, plus a 250 ms tail", async () => {
    const s = setup();
    await s.terminal.start({ threadId: "th_1", mode: "push" });
    expect(s.calls[0]).toMatchObject({
      method: "voice.conversation.start",
      params: {
        threadId: "th_1",
        mode: "push",
        format: { encoding: "pcm_s16le", sampleRate: 16000 },
      },
    });
    expect(s.mic.open).toBe(false);
    s.terminal.turn("begin");
    await Promise.resolve();
    await Promise.resolve();
    expect(s.mic.open).toBe(true);
    s.mic.push(silence(1600), 16000);
    expect(s.calls.find((c) => c.method === "voice.conversation.audio")?.params).toMatchObject({
      conversationId: "vc_1",
      seq: 0,
    });
    s.terminal.turn("end");
    expect(
      s.calls.filter((c) => c.method === "voice.conversation.turn").map((c) => c.params.action),
    ).toEqual(["begin", "end"]);
    // The tail keeps sending until it runs out, then the mic closes.
    expect(s.timers[0]?.ms).toBe(PUSH_TAIL_MS);
    expect(s.mic.open).toBe(true);
    s.flush();
    expect(s.mic.open).toBe(false);
    expect(s.terminal.levels().input).toBe(0);
  });

  it("hands-free listens from the start; mute closes the mic and unmute reopens it", async () => {
    const s = setup();
    await s.terminal.start({ threadId: null, mode: "handsfree" });
    expect(s.mic.open).toBe(true);
    expect(s.calls[0]?.params.threadId).toBeUndefined();
    s.mic.push(speech(1600), 16000);
    expect(s.terminal.levels().input).toBeGreaterThan(0.2);
    s.terminal.mute(true);
    expect(s.mic.open).toBe(false);
    s.terminal.mute(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.mic.open).toBe(true);
    s.terminal.end();
    expect(s.mic.open).toBe(false);
    expect(s.calls.at(-1)).toMatchObject({ method: "voice.conversation.stop" });
  });

  it("plays speech, reports what was heard, and ducks then stops on a confirmed barge-in", async () => {
    const s = setup();
    await s.terminal.start({ threadId: null, mode: "tap" });
    s.emit("voice.conversation.speech", {
      utteranceId: "u1",
      seq: 0,
      audio: pcmBase64,
      format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
      last: false,
    });
    expect(s.p.chunks).toEqual([{ utteranceId: "u1", samples: 2, last: false }]);
    expect(s.terminal.levels().output).toBe(0.2);
    // The owner talks over the reply past the echo tail: duck and suspect.
    s.advance(5000);
    for (let i = 0; i < 20; i++) s.mic.push(speech(480, 0.4), 16000);
    expect(s.p.volume).toBe(DUCK_VOLUME);
    expect(s.calls.find((c) => c.method === "voice.conversation.interrupt")?.params).toMatchObject({
      stage: "suspect",
    });
    expect(s.timers.some((t) => t.ms === SUSPECT_MS)).toBe(true);
    // The Gateway confirms with a transcribed word: playback stops; what was heard is reported.
    s.emit("voice.conversation.state", { phase: "listening", reason: "barge_in", listening: true });
    expect(s.p.playing).toBe(false);
    expect(s.calls.at(-1)).toMatchObject({
      method: "voice.conversation.played",
      params: { utteranceId: "u1", playedMs: 1234, done: false },
    });
  });

  it("releases an unconfirmed suspect and never barges in with push-to-talk's voice", async () => {
    const s = setup();
    await s.terminal.start({ threadId: null, mode: "handsfree" });
    s.emit("voice.conversation.speech", {
      utteranceId: "u1",
      seq: 0,
      audio: pcmBase64,
      format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
      last: true,
    });
    s.advance(5000);
    for (let i = 0; i < 20; i++) s.mic.push(speech(480, 0.4), 16000);
    expect(s.p.volume).toBe(DUCK_VOLUME);
    s.flush();
    expect(s.p.volume).toBe(1);
    expect(s.p.playing).toBe(true);
    // A finished utterance reports done.
    s.p.finished("u1", 900);
    expect(s.calls.at(-1)).toMatchObject({
      method: "voice.conversation.played",
      params: { utteranceId: "u1", playedMs: 900, done: true },
    });
  });

  it("push-to-talk's key stops the reply at once (confirmed), and the Gateway ending releases all", async () => {
    const s = setup();
    await s.terminal.start({ threadId: null, mode: "push" });
    s.emit("voice.conversation.speech", {
      utteranceId: "u1",
      seq: 0,
      audio: pcmBase64,
      format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
      last: false,
    });
    s.terminal.turn("begin");
    expect(s.p.playing).toBe(false);
    expect(s.calls.find((c) => c.method === "voice.conversation.interrupt")?.params).toMatchObject({
      stage: "confirmed",
      playedMs: 1234,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(s.mic.open).toBe(true);
    s.emit("voice.conversation.ended", { reason: "stopped" });
    expect(s.mic.open).toBe(false);
    expect(s.p.closed).toBe(true);
    expect(s.terminal.active).toBe(false);
  });

  it("doesn't barge in when Interrupt by talking is off", async () => {
    const s = setup(false);
    await s.terminal.start({ threadId: null, mode: "handsfree" });
    s.emit("voice.conversation.speech", {
      utteranceId: "u1",
      seq: 0,
      audio: pcmBase64,
      format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
      last: false,
    });
    s.advance(5000);
    for (let i = 0; i < 20; i++) s.mic.push(speech(480, 0.4), 16000);
    expect(s.p.volume).toBe(1);
    expect(s.calls.some((c) => c.method === "voice.conversation.interrupt")).toBe(false);
  });
});
