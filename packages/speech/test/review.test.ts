import { type NodeClient, type NodeInvokeOptions, ResolvedSecret } from "@psyche/protocol";
import { FakeNodeClient, FakeSpeechEngine } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  decodeWav,
  encodeWav,
  PCM_16K_MONO,
  StreamingResampler,
  toPcm16kMono,
} from "../src/audio.ts";
import { CloudTtsEngine } from "../src/engines/cloud.ts";
import { NODE_SPEECH_CAPABILITIES, NodeSpeechEngine } from "../src/engines/node.ts";
import { WhisperEngine, type WhisperRequest } from "../src/engines/whisper.ts";
import { SpeechEngineSelector } from "../src/policy.ts";
import { toBase64 } from "../src/queue.ts";
import { whisperPrompt } from "../src/vocabulary.ts";
import { VoiceSessionManager } from "../src/voice.ts";
import { chunks, collect, tonePcm } from "./helpers.ts";

// Regression tests for the independent review of the S17 branch (2026-10-19).

const cap = (name: string) => ({ name, sideEffect: "read" as const, streaming: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records the options of every invoke on top of a FakeNodeClient. */
function recording(node: FakeNodeClient) {
  const options: [string, NodeInvokeOptions | undefined][] = [];
  const client: NodeClient = {
    nodeId: node.nodeId,
    info: () => node.info(),
    capabilities: () => node.capabilities(),
    invoke: (c, p, o) => {
      options.push([c, o]);
      return node.invoke(c, p, o);
    },
  };
  return { client, options };
}

function startingHelper(onPush?: (p: { data: string; final?: boolean }) => void) {
  return new FakeNodeClient()
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.transcribeStream),
      handle: (_params, emit) =>
        new Promise((resolve) => {
          emit({ type: "speech.started", streamId: "st_1" });
          setTimeout(() => resolve({ text: "", segments: [] }), 10);
        }),
    })
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.audioPush),
      handle: (p) => {
        onPush?.(p as { data: string; final?: boolean });
        return {};
      },
    });
}

describe("review fixes", () => {
  it("1: node stream and synthesis calls get timeouts beyond the 60 s registry default", async () => {
    const node = startingHelper().handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.synthesize),
      handle: () => ({}),
    });
    const { client, options } = recording(node);
    const engine = new NodeSpeechEngine({ node: () => client });
    await collect(engine.transcribeStream(chunks(new Uint8Array(4), 4), PCM_16K_MONO)).catch(
      () => {},
    );
    await collect(engine.synthesize("hi"));
    const stream = options.find(([c]) => c === "speech.transcribe_stream")?.[1];
    const synth = options.find(([c]) => c === "speech.synthesize")?.[1];
    expect(stream?.timeoutMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(synth?.timeoutMs).toBeGreaterThan(60_000);
  });

  it("2: crafted WAV headers and PCM formats are refused before allocating", () => {
    const wav = encodeWav(new Uint8Array(16_000), PCM_16K_MONO);
    const at = (bytes: Uint8Array, off: number, v: number, size: 2 | 4) => {
      const copy = bytes.slice();
      const dv = new DataView(copy.buffer);
      if (size === 2) dv.setUint16(off, v, true);
      else dv.setUint32(off, v, true);
      return copy;
    };
    expect(decodeWav(at(wav, 24, 1, 4))).toBeUndefined(); // 1 Hz
    expect(decodeWav(at(wav, 22, 0, 2))).toBeUndefined(); // 0 channels
    expect(decodeWav(at(wav, 16, 8, 4))).toBeUndefined(); // truncated fmt chunk
    expect(decodeWav(wav)?.format).toEqual(PCM_16K_MONO);
    expect(() => toPcm16kMono(new Uint8Array(4), { ...PCM_16K_MONO, sampleRate: 1 })).toThrow(
      /sample rate/,
    );
    expect(() => toPcm16kMono(new Uint8Array(4), { ...PCM_16K_MONO, channels: 0 })).toThrow(
      /channel/,
    );
  });

  it("3: stopping a node synthesis early does not wait for the helper", async () => {
    const node = new FakeNodeClient().handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.synthesize),
      handle: async (_p, emit) => {
        emit({
          type: "speech.audio",
          seq: 0,
          data: toBase64(new Uint8Array(4)),
          format: PCM_16K_MONO,
        });
        await sleep(2_000);
        return {};
      },
    });
    const { client, options } = recording(node);
    const engine = new NodeSpeechEngine({ node: () => client });
    const t0 = Date.now();
    for await (const _ of engine.synthesize("hello")) break;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(options[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("4: a helper failure mid-stream reaches the consumer while the mic is idle", async () => {
    const node = new FakeNodeClient().handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.transcribeStream),
      handle: async (_p, emit) => {
        emit({ type: "speech.started", streamId: "st_1" });
        await sleep(20);
        throw new Error("node disconnected");
      },
    });
    node.handle({ capability: cap(NODE_SPEECH_CAPABILITIES.audioPush), handle: () => ({}) });
    async function* idleMic() {
      yield new Uint8Array(320);
      await new Promise(() => {}); // never yields again
    }
    const engine = new NodeSpeechEngine({ node: () => node });
    const t0 = Date.now();
    await expect(collect(engine.transcribeStream(idleMic(), PCM_16K_MONO))).rejects.toThrow(
      /node disconnected/,
    );
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("5: concurrent voice.start calls cannot exceed the per-device cap", async () => {
    const selector = new SpeechEngineSelector({ stt: { order: ["whisper"] }, tts: { order: [] } });
    selector.register({
      id: "whisper",
      location: "gateway",
      supports: { transcribe: true, stream: true, synthesize: false },
      engine: new FakeSpeechEngine(),
      available: async () => true,
    });
    let n = 0;
    const m = new VoiceSessionManager({
      selector,
      emit: () => {},
      maxPerDevice: 2,
      newId: () => `vs_${++n}`,
      vocabulary: async () => {
        await sleep(5);
        return [];
      },
    });
    const ctx = { deviceId: "d", caller: "desktop" as const };
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => m.start({ format: PCM_16K_MONO }, ctx)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(m.active).toBe(2);
    m.cancelAll();
  });

  it("6: the previous final reaches whisper's prompt even when long", async () => {
    const long = "Remind me to call Alice Chen at noon tomorrow about the quarterly report.";
    expect(whisperPrompt(["Pip"], undefined, long)).toBe(`Pip. ${long}`);
    expect(whisperPrompt([], undefined, "{{cred:x}} <b>hi</b>")).toBe("b hi /b");
    const requests: WhisperRequest[] = [];
    const engine = new WhisperEngine({
      backend: {
        name: "fake",
        available: async () => true,
        transcribe: async (r) => {
          requests.push(r);
          return [{ text: long, startMs: 0, endMs: 1 }];
        },
      },
      stream: { partialIntervalMs: 0 },
    });
    const pcm = tonePcm([
      [800, 0.3],
      [900, 0],
      [800, 0.3],
    ]);
    await collect(
      engine.transcribeStream(chunks(pcm, 3200), PCM_16K_MONO, { vocabulary: ["Pip"] }),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.prompt).toContain("quarterly report");
  });

  it("7: chunked resampling matches one-shot length without drift", () => {
    const total = 48_000 * 2;
    const r = new StreamingResampler(48_000, 16_000);
    let out = 0;
    for (let off = 0; off < total; off += 128) out += r.push(new Float32Array(128)).length;
    expect(Math.abs(out - total / 3)).toBeLessThanOrEqual(1);
    // Continuity: a ramp stays a ramp across chunk boundaries.
    const ramp = Float32Array.from({ length: 300 }, (_, i) => i / 300);
    const r2 = new StreamingResampler(3, 2);
    const parts = [r2.push(ramp.subarray(0, 101)), r2.push(ramp.subarray(101))];
    const joined = Float32Array.from([...(parts[0] ?? []), ...(parts[1] ?? [])]);
    for (let i = 1; i < joined.length; i++) {
      expect((joined[i] ?? 0) - (joined[i - 1] ?? 0)).toBeCloseTo(1.5 / 300, 6);
    }
  });

  it("8: cloud TTS cancels the response body when the consumer stops early", async () => {
    let cancelled = false;
    const engine = new CloudTtsEngine({
      provider: "elevenlabs",
      defaultVoice: "voice-1",
      apiKey: async () =>
        new ResolvedSecret("sk-test-review-0000", {
          credentialId: "c",
          target: { kind: "origin", value: "https://api.elevenlabs.io" },
        }),
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(new Uint8Array(4));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    for await (const _ of engine.synthesize("hello")) break;
    expect(cancelled).toBe(true);
  });

  it("9: an already-aborted signal stops node transcription before any push", async () => {
    const pushes: unknown[] = [];
    const node = startingHelper((p) => pushes.push(p));
    const engine = new NodeSpeechEngine({ node: () => node });
    const ac = new AbortController();
    ac.abort();
    await expect(
      engine.transcribeFile(new Uint8Array(32_000), PCM_16K_MONO, { signal: ac.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(pushes).toEqual([]);
  });
});
