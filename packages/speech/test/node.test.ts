import type { TranscriptSegment } from "@psyche/protocol";
import { FakeNodeClient } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { encodeWav, PCM_16K_MONO, PCM_24K_MONO } from "../src/audio.ts";
import { NODE_SPEECH_CAPABILITIES, NodeSpeechEngine } from "../src/engines/node.ts";
import { fromBase64, toBase64 } from "../src/queue.ts";
import { chunks, collect } from "./helpers.ts";

const cap = (name: string, streaming = false) => ({ name, sideEffect: "read" as const, streaming });

/**
 * A fake Mac helper shaped like apps/mac-helper (PR #47): `speech.transcribe_stream` with
 * `source: "push"` announces `speech.started {streamId}`, emits a partial per push and a final
 * when a push carries `final: true`, then resolves with the transcript.
 */
function macNode(opts: { failPush?: boolean } = {}) {
  const node = new FakeNodeClient({ nodeId: "mac" });
  const streams = new Map<
    string,
    { bytes: number; emit: (d: unknown) => void; finish: () => void }
  >();
  let n = 0;
  node
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.transcribeStream, true),
      handle: (params, emit) =>
        new Promise((resolve, reject) => {
          const p = params as { source: string; format?: unknown; volatile: boolean };
          if (p.source !== "push" || p.format === undefined) {
            reject(new Error("push needs format"));
            return;
          }
          const streamId = `st_${++n}`;
          const state = {
            bytes: 0,
            emit,
            finish: () => {
              const text = `${state.bytes} bytes`;
              emit({ type: "speech.final", text, startMs: 0, endMs: 100, final: true });
              resolve({
                streamId,
                text,
                segments: [{ text, startMs: 0, endMs: 100, final: true }],
                engine: "speechAnalyzer",
                language: "en-US",
              });
            },
          };
          streams.set(streamId, state);
          emit({ type: "speech.started", streamId, engine: "speechAnalyzer" });
        }),
    })
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.audioPush),
      handle: (params) => {
        const p = params as { streamId: string; data: string; final?: boolean };
        if (opts.failPush === true) throw new Error("push_buffer_full");
        const s = streams.get(p.streamId);
        if (s === undefined) throw new Error("unknown stream");
        const bytes = fromBase64(p.data).byteLength;
        s.bytes += bytes;
        if (bytes > 0) {
          s.emit({
            type: "speech.partial",
            text: `${s.bytes}`,
            startMs: 0,
            endMs: s.bytes,
            final: false,
          });
        }
        if (p.final === true) s.finish();
        return { accepted: bytes, bufferedBytes: 0, final: p.final === true };
      },
    })
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.synthesize, true),
      handle: (params, emit) => {
        const p = params as { text: string; format: string };
        const format = { encoding: p.format, sampleRate: 22_050, channels: 1 };
        for (let seq = 0; seq < 3; seq++) {
          emit({
            type: "speech.audio",
            seq,
            data: toBase64(new Uint8Array(p.text.length * 2)),
            format,
          });
        }
        return { format, voice: "com.apple.voice.Ava" };
      },
    })
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.voices),
      handle: () => ({
        voices: [{ id: "com.apple.voice.Ava", name: "Ava", language: "en-US", quality: "premium" }],
        personalVoiceAuthorization: "notDetermined",
      }),
    });
  return node;
}

describe("NodeSpeechEngine (Mac helper speech.* capabilities)", () => {
  it("is unavailable without a node or without the capability", async () => {
    expect(await new NodeSpeechEngine({ node: () => undefined }).available()).toBe(false);
    expect(await new NodeSpeechEngine({ node: () => new FakeNodeClient() }).available()).toBe(
      false,
    );
    expect(await new NodeSpeechEngine({ node: macNode }).available()).toBe(true);
  });

  it("streams: waits for speech.started, pushes in order, ends with a final push", async () => {
    const node = macNode();
    const engine = new NodeSpeechEngine({ node: () => node });
    const segs: TranscriptSegment[] = await collect(
      engine.transcribeStream(chunks(new Uint8Array(3000), 1000), PCM_16K_MONO, {
        language: "en-US",
        vocabulary: ["Pip", " Pip ", "x".repeat(65)],
      }),
    );
    expect(segs.map((s) => [s.text, s.final])).toEqual([
      ["1000", false],
      ["2000", false],
      ["3000", false],
      ["3000 bytes", true],
    ]);
    expect(node.invocations.map((i) => i.capability)).toEqual([
      "speech.transcribe_stream",
      "speech.audio_push",
      "speech.audio_push",
      "speech.audio_push",
      "speech.audio_push",
    ]);
    expect(node.invocations[0]?.params).toMatchObject({
      source: "push",
      format: PCM_16K_MONO,
      locale: "en-US",
      volatile: true,
      // Trimmed, de-duplicated, over-long entries dropped (helper limits).
      vocabulary: ["Pip"],
    });
    expect(node.invocations.at(-1)?.params).toEqual({ streamId: "st_1", data: "", final: true });
  });

  it("transcribes a WAV file in ≤ 512 KiB pushes and returns the helper transcript", async () => {
    const node = macNode();
    const engine = new NodeSpeechEngine({ node: () => node });
    const pcm = new Uint8Array(600 * 1024);
    const t = await engine.transcribeFile(encodeWav(pcm, PCM_16K_MONO), {
      encoding: "wav",
      sampleRate: 16_000,
      channels: 1,
    });
    expect(t).toEqual({
      text: `${pcm.byteLength} bytes`,
      segments: [{ text: `${pcm.byteLength} bytes`, startMs: 0, endMs: 100, final: true }],
      language: "en-US",
    });
    const pushes = node.invocations.filter((i) => i.capability === "speech.audio_push");
    expect(pushes).toHaveLength(3);
    expect(node.invocations[0]?.params).toMatchObject({ volatile: false });
  });

  it("refuses formats the helper does not take", async () => {
    const engine = new NodeSpeechEngine({ node: macNode });
    expect(() =>
      engine.transcribeStream(chunks(new Uint8Array(4), 2), {
        encoding: "opus",
        sampleRate: 48_000,
        channels: 1,
      }),
    ).toThrow(/8–48 kHz/);
    await expect(
      engine.transcribeFile(new Uint8Array(4), {
        encoding: "pcm_s16le",
        sampleRate: 96_000,
        channels: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("propagates helper failures (stream open and push)", async () => {
    const failing = new FakeNodeClient().handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.transcribeStream, true),
      handle: () => {
        throw new Error("permission_missing");
      },
    });
    const engine = new NodeSpeechEngine({ node: () => failing });
    await expect(
      collect(engine.transcribeStream(chunks(new Uint8Array(10), 5), PCM_16K_MONO)),
    ).rejects.toThrow(/permission_missing/);
    const pushFails = new NodeSpeechEngine({ node: () => macNode({ failPush: true }) });
    await expect(
      collect(pushFails.transcribeStream(chunks(new Uint8Array(10), 5), PCM_16K_MONO)),
    ).rejects.toThrow(/push_buffer_full|cancelled|aborted/);
  });

  it("stops early without hanging when the consumer breaks", async () => {
    const node = macNode();
    const engine = new NodeSpeechEngine({ node: () => node });
    for await (const s of engine.transcribeStream(
      chunks(new Uint8Array(5000), 1000),
      PCM_16K_MONO,
    )) {
      expect(s.final).toBe(false);
      break;
    }
  });

  it("synthesizes speech.audio chunks and lists voices", async () => {
    const node = macNode();
    const engine = new NodeSpeechEngine({ node: () => node });
    const out = await collect(engine.synthesize("hello", { voice: "com.apple.voice.Ava" }));
    expect(out).toHaveLength(3);
    expect(out[0]?.format).toEqual({ encoding: "pcm_s16le", sampleRate: 22_050, channels: 1 });
    expect(out[0]?.data.byteLength).toBe(10);
    expect(node.invocations[0]?.params).toEqual({
      text: "hello",
      format: "pcm_s16le",
      voice: "com.apple.voice.Ava",
    });
    // Long text is split into requests within the helper's 5000-character limit.
    const long = Array.from({ length: 400 }, () => "This is a sentence.").join(" ");
    await collect(engine.synthesize(long, { format: PCM_24K_MONO }));
    const texts = node.invocations
      .filter((i) => i.capability === "speech.synthesize")
      .slice(1)
      .map((i) => (i.params as { text: string }).text);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every((t) => t.length <= 5000)).toBe(true);
    expect((await engine.voices())[0]).toEqual({
      id: "com.apple.voice.Ava",
      name: "Ava",
      language: "en-US",
      local: true,
    });
    expect(await engine.capabilities()).toMatchObject({ streaming: true, synthesis: true });
  });
});
