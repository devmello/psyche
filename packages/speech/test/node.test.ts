import type { TranscriptSegment } from "@psyche/protocol";
import { FakeNodeClient } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { PCM_16K_MONO, PCM_24K_MONO } from "../src/audio.ts";
import { NODE_SPEECH_CAPABILITIES, NodeSpeechEngine } from "../src/engines/node.ts";
import { fromBase64, toBase64 } from "../src/queue.ts";
import { chunks, collect } from "./helpers.ts";

const cap = (name: string) => ({ name, sideEffect: "read" as const });

/** A fake Mac helper: concatenates pushed audio, emits one partial per push and one final. */
function macNode() {
  const node = new FakeNodeClient({ nodeId: "mac" });
  const streams = new Map<
    string,
    { bytes: number; finish: () => void; emit: (d: unknown) => void }
  >();
  node
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.transcribe),
      handle: (params) => {
        const p = params as { audio: string; vocabulary?: string[]; language?: string };
        return {
          text: `heard ${fromBase64(p.audio).byteLength} bytes (${(p.vocabulary ?? []).join("|")})`,
          segments: [],
          language: p.language,
        };
      },
    })
    .handle({
      capability: { ...cap(NODE_SPEECH_CAPABILITIES.streamOpen), streaming: true },
      handle: (params, emit) =>
        new Promise((resolve) => {
          const id = (params as { streamId: string }).streamId;
          streams.set(id, {
            bytes: 0,
            emit,
            finish: () => {
              const s = streams.get(id);
              emit({ segment: { text: `${s?.bytes} bytes`, startMs: 0, endMs: 100, final: true } });
              resolve({ text: "", segments: [] });
            },
          });
        }),
    })
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.streamPush),
      handle: (params) => {
        const p = params as { streamId: string; audio: string };
        const s = streams.get(p.streamId);
        if (s === undefined) throw new Error("unknown stream");
        s.bytes += fromBase64(p.audio).byteLength;
        s.emit({ segment: { text: `${s.bytes}`, startMs: 0, endMs: s.bytes, final: false } });
        return {};
      },
    })
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.streamFinish),
      handle: (params) => {
        streams.get((params as { streamId: string }).streamId)?.finish();
        return {};
      },
    })
    .handle({
      capability: { ...cap(NODE_SPEECH_CAPABILITIES.synthesize), streaming: true },
      handle: (params, emit) => {
        const text = (params as { text: string }).text;
        for (let i = 0; i < 3; i++) {
          emit({ audio: toBase64(new Uint8Array(text.length * 2)), format: PCM_24K_MONO });
        }
        return { format: PCM_24K_MONO };
      },
    })
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.voices),
      handle: () => ({
        voices: [{ id: "com.apple.voice.Ava", name: "Ava", language: "en-US", local: false }],
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

  it("transcribes a file with language and vocabulary", async () => {
    const node = macNode();
    const engine = new NodeSpeechEngine({ node: () => node });
    const t = await engine.transcribeFile(new Uint8Array(640), PCM_16K_MONO, {
      language: "en-US",
      vocabulary: ["Pip", "Alice"],
    });
    expect(t.text).toBe("heard 640 bytes (Pip|Alice)");
    expect(node.invocations[0]?.params).toMatchObject({ format: PCM_16K_MONO, language: "en-US" });
  });

  it("streams: pushes chunks in order, partials then the final", async () => {
    const node = macNode();
    const engine = new NodeSpeechEngine({ node: () => node, newStreamId: () => "s1" });
    const segs: TranscriptSegment[] = await collect(
      engine.transcribeStream(chunks(new Uint8Array(3000), 1000), PCM_16K_MONO, {
        vocabulary: ["Pip"],
      }),
    );
    expect(segs.map((s) => [s.text, s.final])).toEqual([
      ["1000", false],
      ["2000", false],
      ["3000", false],
      ["3000 bytes", true],
    ]);
    expect(node.invocations.map((i) => i.capability)).toEqual([
      "speech.stream.open",
      "speech.stream.push",
      "speech.stream.push",
      "speech.stream.push",
      "speech.stream.finish",
    ]);
    expect(node.invocations[0]?.params).toMatchObject({ streamId: "s1", vocabulary: ["Pip"] });
  });

  it("propagates a node failure", async () => {
    const node = new FakeNodeClient().handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.transcribe),
      handle: () => {
        throw new Error("SpeechAnalyzer: no locale assets");
      },
    });
    const engine = new NodeSpeechEngine({ node: () => node });
    await expect(engine.transcribeFile(new Uint8Array(2), PCM_16K_MONO)).rejects.toThrow(
      /no locale assets/,
    );
  });

  it("synthesizes streamed chunks and lists voices", async () => {
    const engine = new NodeSpeechEngine({ node: macNode });
    const out = await collect(engine.synthesize("hello", { voice: "com.apple.voice.Ava" }));
    expect(out).toHaveLength(3);
    expect(out[0]?.format).toEqual(PCM_24K_MONO);
    expect(out[0]?.data.byteLength).toBe(10);
    expect((await engine.voices())[0]).toMatchObject({ id: "com.apple.voice.Ava", local: true });
    expect(await engine.capabilities()).toMatchObject({ streaming: true, synthesis: true });
  });
});
