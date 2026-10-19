import { describe, expect, it } from "vitest";
import { type AudioSource, toPcm16, VoiceCapture, type VoiceState } from "../../src/shell/voice.ts";

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

describe("dictation capture", () => {
  it("downsamples to 16 kHz int16", () => {
    const pcm = toPcm16(new Float32Array(4800).fill(0.5), 48_000);
    expect(pcm.length).toBe(1600);
    expect(pcm[0]).toBe(Math.round(0.5 * 0x7fff));
    expect(toPcm16(new Float32Array([-1, -1, -1]), 48_000)[0]).toBe(-0x8000);
  });

  it("streams chunks to voice.* and returns the final text", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const call = async (m: string, p: unknown) => {
      calls.push([m, p as Record<string, unknown>]);
      if (m === "voice.start") return { streamId: "vs_1" };
      if (m === "voice.stop") return { text: "book the dentist" };
      return { ok: true };
    };
    const src = fakeSource();
    const states: VoiceState[] = [];
    const v = new VoiceCapture(call, src.source, (s) => states.push(s));
    await v.start("push_to_talk", "t1");
    src.push(new Float32Array(4800)); // 100 ms at 48 kHz → one chunk
    v.onPartial("vs_1", "book the");
    expect(v.getState()).toMatchObject({ phase: "listening", partial: "book the" });
    await expect(v.stop()).resolves.toBe("book the dentist");
    expect(src.stopped()).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(["voice.start", "voice.push", "voice.stop"]);
    expect(calls[0]?.[1]).toMatchObject({
      mode: "push_to_talk",
      sampleRate: 16_000,
      threadId: "t1",
    });
    expect(calls[1]?.[1]).toMatchObject({ streamId: "vs_1", seq: 0 });
    expect(typeof calls[1]?.[1].chunk).toBe("string");
    expect(states.at(-1)).toEqual({ phase: "idle" });
  });

  it("reports unavailable when the Gateway lacks voice.*", async () => {
    const v = new VoiceCapture(
      async () => Promise.reject(Object.assign(new Error("x"), { code: "unknown_method" })),
      fakeSource().source,
      () => undefined,
    );
    await v.start("toggle");
    expect(v.getState()).toMatchObject({ phase: "unavailable" });
  });
});
