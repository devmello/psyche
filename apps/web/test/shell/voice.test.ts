import { describe, expect, it } from "vitest";
import {
  type AudioSource,
  type LocalDictation,
  pcmChunkToBase64,
  toPcm16,
  VoiceCapture,
  type VoiceSegment,
  type VoiceState,
  webSpeechDictation,
} from "../../src/shell/voice.ts";

function fakeSource() {
  let push: ((f: Float32Array, r: number) => void) | undefined;
  let stopped = false;
  const source: AudioSource = {
    async start(cb) {
      push = cb;
      return () => {
        stopped = true;
      };
    },
  };
  return { source, push: (f: Float32Array) => push?.(f, 48_000), stopped: () => stopped };
}

function gateway(stop: unknown = { transcript: { text: "book the dentist", segments: [] } }) {
  const calls: [string, Record<string, unknown>][] = [];
  const call = async (m: string, p: unknown) => {
    calls.push([m, p as Record<string, unknown>]);
    if (m === "voice.start") return { sessionId: "vs_1", location: "node", engine: "mac-helper" };
    if (m === "voice.stop") return stop;
    if (m === "voice.cancel") return { ok: true };
    return {};
  };
  return { calls, call };
}

describe("dictation capture", () => {
  it("downsamples to 16 kHz int16", () => {
    const pcm = toPcm16(new Float32Array(4800).fill(0.5), 48_000);
    expect(pcm.length).toBe(1600);
    expect(pcm[0]).toBe(Math.round(0.5 * 0x7fff));
    expect(toPcm16(new Float32Array([-1, -1, -1]), 48_000)[0]).toBe(-0x8000);
  });

  it("encodes chunks as standard base64 of little-endian bytes", () => {
    expect(pcmChunkToBase64(new Int16Array([0x0201, -1]))).toBe(btoa("\x01\x02\xff\xff"));
  });

  it("streams chunks to voice.* in the protocol's shape and returns the transcript", async () => {
    const { calls, call } = gateway();
    const src = fakeSource();
    const states: VoiceState[] = [];
    const v = new VoiceCapture(call, src.source, (s) => states.push(s));
    await v.start("t1");
    src.push(new Float32Array(4800)); // 100 ms at 48 kHz → one chunk
    src.push(new Float32Array(4800));
    v.onSegment("vs_1", { text: "book", final: true });
    v.onSegment("vs_1", { text: "the", final: false });
    v.onSegment("vs_other", { text: "ignored", final: true });
    expect(v.getState()).toMatchObject({
      phase: "listening",
      sessionId: "vs_1",
      partial: "book the",
    });
    await expect(v.stop()).resolves.toBe("book the dentist");
    expect(src.stopped()).toBe(true);
    expect(calls.map((c) => c[0])).toEqual([
      "voice.start",
      "voice.push",
      "voice.push",
      "voice.stop",
    ]);
    expect(calls[0]?.[1]).toEqual({
      format: { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 },
      threadId: "t1",
    });
    expect(calls[1]?.[1]).toMatchObject({ sessionId: "vs_1", seq: 0 });
    expect(calls[2]?.[1]).toMatchObject({ sessionId: "vs_1", seq: 1 });
    expect(atob(calls[1]?.[1].audio as string).length).toBe(3200); // 1600 samples × 2 bytes
    expect(calls[3]?.[1]).toEqual({ sessionId: "vs_1" });
    expect(states.at(-1)).toEqual({ phase: "idle" });
  });

  it("falls back to the segments heard when voice.stop fails", async () => {
    const call = async (m: string) => {
      if (m === "voice.start") return { sessionId: "vs_1", location: "gateway", engine: "w" };
      if (m === "voice.stop") throw Object.assign(new Error("x"), { code: "internal" });
      return {};
    };
    const v = new VoiceCapture(call, fakeSource().source, () => undefined);
    await v.start();
    v.onSegment("vs_1", { text: "call mom", final: true });
    await expect(v.stop()).resolves.toBe("call mom");
    expect(v.getState()).toEqual({ phase: "idle" });
  });

  it("cancels with the session id", async () => {
    const { calls, call } = gateway();
    const src = fakeSource();
    const v = new VoiceCapture(call, src.source, () => undefined);
    await v.start();
    v.cancel();
    expect(calls.at(-1)).toEqual(["voice.cancel", { sessionId: "vs_1" }]);
    expect(src.stopped()).toBe(true);
    expect(v.getState()).toEqual({ phase: "idle" });
  });

  it("hands over the text heard when the Gateway ends the session on its own", async () => {
    const { call } = gateway();
    const src = fakeSource();
    const said: string[] = [];
    const v = new VoiceCapture(call, src.source, () => undefined, {
      onInterrupted: (t) => said.push(t),
    });
    await v.start();
    v.onSegment("vs_1", { text: "pick up milk", final: true });
    v.onEnded("vs_1", "stopped"); // our own stop; nothing to do
    expect(v.getState()).toMatchObject({ phase: "listening" });
    v.onEnded("vs_1", "timeout");
    expect(said).toEqual(["pick up milk"]);
    expect(src.stopped()).toBe(true);
    expect(v.getState()).toEqual({ phase: "idle" });
  });

  it("reports unavailable when the Gateway lacks voice.* or has no engine", async () => {
    for (const code of ["unknown_method", "unavailable"]) {
      const v = new VoiceCapture(
        async () => Promise.reject(Object.assign(new Error("x"), { code })),
        fakeSource().source,
        () => undefined,
      );
      await v.start();
      expect(v.getState()).toMatchObject({ phase: "unavailable" });
    }
  });

  it("dictates in the browser when the Gateway answers location client", async () => {
    const calls: string[] = [];
    let handlers: { onSegment: (s: VoiceSegment) => void } | undefined;
    let stopped = false;
    const local: LocalDictation = {
      start(h) {
        handlers = h;
        return {
          async stop() {
            h.onSegment({ text: "hello there", final: true });
            stopped = true;
          },
          cancel() {},
        };
      },
    };
    const src = fakeSource();
    const v = new VoiceCapture(
      async (m) => {
        calls.push(m);
        return { sessionId: null, location: "client", engine: "web-speech" };
      },
      src.source,
      () => undefined,
      { local },
    );
    await v.start();
    expect(v.getState()).toMatchObject({ phase: "listening", sessionId: null });
    handlers?.onSegment({ text: "hello", final: false });
    expect(v.getState()).toMatchObject({ partial: "hello" });
    src.push(new Float32Array(4800)); // the Gateway source was never opened
    await expect(v.stop()).resolves.toBe("hello there");
    expect(stopped).toBe(true);
    expect(calls).toEqual(["voice.start"]);
  });

  it("says so when the Gateway wants client dictation and the browser has none", async () => {
    const v = new VoiceCapture(
      async () => ({ sessionId: null, location: "client", engine: "web-speech" }),
      fakeSource().source,
      () => undefined,
    );
    await v.start();
    expect(v.getState()).toMatchObject({ phase: "unavailable" });
  });
});

describe("web speech adapter", () => {
  it("is undefined without SpeechRecognition", () => {
    expect(webSpeechDictation({})).toBeUndefined();
  });

  it("turns recognition results into segments and waits for end on stop", async () => {
    const made: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((ev: unknown) => void) | null = null;
      onerror: ((ev: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        made.push(this);
      }
      start() {}
      stop() {
        queueMicrotask(() => this.onend?.());
      }
      abort() {}
    }
    const segs: VoiceSegment[] = [];
    const ends: number[] = [];
    const session = webSpeechDictation({ webkitSpeechRecognition: FakeRecognition })?.start({
      onSegment: (s) => segs.push(s),
      onError: () => undefined,
      onEnd: () => ends.push(1),
    });
    made[0]?.onresult?.({
      resultIndex: 0,
      results: [
        { isFinal: true, 0: { transcript: "one" } },
        { isFinal: false, 0: { transcript: "tw" } },
      ],
    });
    expect(segs).toEqual([
      { text: "one", final: true },
      { text: "tw", final: false },
    ]);
    await session?.stop();
    expect(ends).toEqual([]); // stop() resolves; onEnd is only for unrequested ends
  });
});
