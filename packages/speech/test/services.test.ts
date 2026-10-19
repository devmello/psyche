import type { LibraryItem, SpeechEngine, TranscriptSegment } from "@psyche/protocol";
import { FakeSpeechEngine } from "@psyche/testing";
import { describe, expect, it, vi } from "vitest";
import { PCM_16K_MONO, PCM_24K_MONO } from "../src/audio.ts";
import { type EngineEntry, SpeechEngineSelector } from "../src/policy.ts";
import { toBase64 } from "../src/queue.ts";
import {
  type LibraryWriter,
  markdownToSpeech,
  type ReadAloudEvent,
  ReadAloudService,
  titleFrom,
} from "../src/readAloud.ts";
import type { VoiceNoteTranscoder } from "../src/transcode/ffmpeg.ts";
import { type VoiceEvent, VoiceSessionManager } from "../src/voice.ts";

const desktop = { deviceId: "dev_desktop", caller: "desktop" as const };
const phone = { deviceId: "dev_phone", caller: "web" as const };

function selectorWith(
  engine: SpeechEngine | undefined,
  location: EngineEntry["location"] = "gateway",
) {
  const e: EngineEntry = {
    id: location === "client" ? "web-speech" : "whisper",
    location,
    supports: { transcribe: true, stream: true, synthesize: false },
    available: async () => true,
  };
  if (engine !== undefined) e.engine = engine;
  return new SpeechEngineSelector({ stt: { order: [e.id] }, tts: { order: [] } }).register(e);
}

function manager(
  engine: SpeechEngine,
  opts: Partial<ConstructorParameters<typeof VoiceSessionManager>[0]> = {},
) {
  const events: [string, VoiceEvent][] = [];
  let n = 0;
  const m = new VoiceSessionManager({
    selector: selectorWith(engine),
    emit: (d, e) => events.push([d, e]),
    newId: () => `vs_${++n}`,
    vocabulary: () => ["Pip", "Alice Chen"],
    ...opts,
  });
  return { m, events };
}

describe("voice.* dictation sessions", () => {
  it("streams partials then the final to the starting device and returns the transcript", async () => {
    let seenVocab: string[] | undefined;
    const fake = new FakeSpeechEngine().transcript("call alice at noon");
    const engine: SpeechEngine = {
      ...fake,
      capabilities: () => fake.capabilities(),
      transcribeFile: (d, f, o) => fake.transcribeFile(d, f, o),
      synthesize: (t, o) => fake.synthesize(t, o),
      voices: () => fake.voices(),
      transcribeStream: (a, f, o) => {
        seenVocab = o?.vocabulary;
        return fake.transcribeStream(a, f, o);
      },
    };
    const { m, events } = manager(engine);
    const start = await m.start({ format: PCM_16K_MONO, vocabulary: ["noon", "pip"] }, desktop);
    expect(start).toEqual({ sessionId: "vs_1", location: "gateway", engine: "whisper" });
    m.push({ sessionId: "vs_1", seq: 0, audio: toBase64(new Uint8Array(640)) }, desktop);
    m.push({ sessionId: "vs_1", seq: 1, audio: toBase64(new Uint8Array(640)) }, desktop);
    const t = await m.stop("vs_1", desktop);
    expect(t.text).toBe("call alice at noon");
    // Request terms first, then the session defaults, de-duplicated.
    expect(seenVocab).toEqual(["noon", "pip", "Alice Chen"]);
    const segs = events
      .filter(([, e]) => e.event === "voice.segment")
      .map(([d, e]) => [d, (e.payload as { segment: TranscriptSegment }).segment]);
    expect(segs.every(([d]) => d === "dev_desktop")).toBe(true);
    expect(segs.map(([, s]) => (s as TranscriptSegment).final)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(events.at(-1)?.[1]).toEqual({
      event: "voice.ended",
      payload: { sessionId: "vs_1", reason: "stopped" },
    });
    expect(m.active).toBe(0);
  });

  it("binds sessions to their device and enforces chunk order and size", async () => {
    const { m } = manager(new FakeSpeechEngine());
    const { sessionId } = await m.start({ format: PCM_16K_MONO }, desktop);
    const id = sessionId ?? "";
    expect(() => m.push({ sessionId: id, seq: 0, audio: "" }, phone)).toThrow(
      /no dictation session/,
    );
    expect(() => m.push({ sessionId: id, seq: 1, audio: "" }, desktop)).toThrow(/expected chunk 0/);
    expect(() =>
      m.push({ sessionId: id, seq: 0, audio: toBase64(new Uint8Array(400_000)) }, desktop),
    ).toThrow(/too large/);
    expect(() => m.cancel(id, phone)).toThrow(/no dictation session/);
    m.cancel(id, desktop);
    await vi.waitFor(() => expect(m.active).toBe(0));
  });

  it("cancels without a final and refuses pushes after the end", async () => {
    const { m, events } = manager(new FakeSpeechEngine().transcript("never said"));
    const { sessionId } = await m.start({ format: PCM_16K_MONO }, desktop);
    const id = sessionId ?? "";
    m.cancel(id, desktop);
    expect(() => m.push({ sessionId: id, seq: 0, audio: "" }, desktop)).toThrow();
    await vi.waitFor(() => expect(events.at(-1)?.[1].event).toBe("voice.ended"));
    expect(events.some(([, e]) => e.event === "voice.segment")).toBe(false);
    expect(events.at(-1)?.[1]).toMatchObject({ payload: { reason: "cancelled" } });
  });

  it("times out idle sessions and caps sessions per device", async () => {
    vi.useFakeTimers();
    try {
      const { m, events } = manager(new FakeSpeechEngine(), {
        idleTimeoutMs: 1_000,
        maxPerDevice: 1,
      });
      await m.start({ format: PCM_16K_MONO }, desktop);
      await expect(m.start({ format: PCM_16K_MONO }, desktop)).rejects.toMatchObject({
        code: "rate_limited",
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(events.at(-1)?.[1]).toMatchObject({
        event: "voice.ended",
        payload: { reason: "timeout" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses non-PCM formats and stops at the maximum length", async () => {
    const { m } = manager(new FakeSpeechEngine(), { maxSessionMs: 100 });
    await expect(
      m.start({ format: { encoding: "opus", sampleRate: 48_000, channels: 1 } }, desktop),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const { sessionId } = await m.start({ format: PCM_16K_MONO }, desktop);
    expect(() =>
      m.push(
        { sessionId: sessionId ?? "", seq: 0, audio: toBase64(new Uint8Array(4_000)) },
        desktop,
      ),
    ).toThrow(/maximum length/);
  });

  it("answers location client for Web Speech without opening a session", async () => {
    const m = new VoiceSessionManager({
      selector: selectorWith(undefined, "client"),
      emit: () => {},
    });
    expect(await m.start({ format: PCM_16K_MONO }, phone)).toEqual({
      sessionId: null,
      location: "client",
      engine: "web-speech",
    });
    expect(m.active).toBe(0);
  });

  it("reports engine errors through voice.ended and stop", async () => {
    const failing: SpeechEngine = {
      ...new FakeSpeechEngine(),
      capabilities: async () => ({ engine: "x", streaming: true, synthesis: false, languages: [] }),
      transcribeFile: async () => ({ text: "", segments: [] }),
      synthesize: () => new FakeSpeechEngine().synthesize(""),
      voices: async () => [],
      // biome-ignore lint/correctness/useYield: throws on purpose
      async *transcribeStream() {
        throw new Error("model crashed");
      },
    };
    const { m, events } = manager(failing);
    const { sessionId } = await m.start({ format: PCM_16K_MONO }, desktop);
    await expect(m.stop(sessionId ?? "", desktop)).rejects.toThrow(/model crashed/);
    expect(events.at(-1)?.[1]).toMatchObject({
      event: "voice.ended",
      payload: { reason: "error", error: { code: "internal" } },
    });
  });
});

describe("read-aloud (Q3)", () => {
  const item = (name: string): LibraryItem => ({
    id: "lib_1",
    kind: "audio",
    name,
    mime: "audio/mpeg",
    path: `audio/${name}`,
    size: 3,
    sha256: "0".repeat(64),
    origin: "agent",
    threadId: "th_1",
    taskId: null,
    tags: [],
    textExtractRef: null,
    createdAt: "2026-10-19T00:00:00.000Z",
  });

  function service(text: string) {
    const engine = new FakeSpeechEngine();
    const events: [string, ReadAloudEvent][] = [];
    const saved: Parameters<LibraryWriter["saveAudio"]>[0][] = [];
    const encoded: unknown[] = [];
    const transcoder = {
      encode: async (pcm: Uint8Array, format: unknown, profile: { container: string }) => {
        encoded.push({ bytes: pcm.byteLength, format, container: profile.container });
        return { data: new Uint8Array(3), mime: "audio/mpeg", extension: "mp3", durationMs: 1234 };
      },
    } as unknown as VoiceNoteTranscoder;
    const svc = new ReadAloudService({
      engine,
      transcoder,
      messages: {
        get: async (id) => {
          if (id !== "msg_1") throw Object.assign(new Error("nope"), { code: "not_found" });
          return { text, threadId: "th_1" };
        },
      },
      library: {
        saveAudio: async (f) => {
          saved.push(f);
          return item(f.name);
        },
      },
      emit: (d, e) => events.push([d, e]),
      newId: () => "ra_1",
    });
    return { svc, engine, events, saved, encoded };
  }

  it("streams audio events, then saves an MP3 Library item", async () => {
    const { svc, engine, events, saved, encoded } = service("# Plan\n\nCall **Alice** at `noon`.");
    const { streamId, done } = svc.start("msg_1", "dev_desktop", { voice: "af_heart" });
    expect(streamId).toBe("ra_1");
    const lib = await done;
    expect(engine.synthesized).toEqual(["Plan. Call Alice at noon."]);
    const audio = events.filter(([, e]) => e.event === "speech.audio").map(([, e]) => e.payload);
    expect(audio.length).toBeGreaterThan(1);
    expect(audio.map((a) => (a as { seq: number }).seq)).toEqual(audio.map((_, i) => i));
    expect(audio.map((a) => (a as { last: boolean }).last)).toEqual(
      audio.map((_, i) => i === audio.length - 1),
    );
    expect(encoded).toEqual([
      { bytes: expect.any(Number), format: PCM_16K_MONO, container: "mp3" },
    ]);
    expect(saved[0]).toMatchObject({
      mime: "audio/mpeg",
      threadId: "th_1",
      tags: ["read-aloud", "message:msg_1"],
    });
    expect(saved[0]?.name).toBe("Read aloud – Plan Call Alice at noon.mp3");
    expect(events.at(-1)?.[1]).toMatchObject({
      event: "speech.readAloud.completed",
      payload: { streamId: "ra_1", messageId: "msg_1", item: lib, durationMs: 1234 },
    });
  });

  it("reports failures as speech.readAloud.failed", async () => {
    const { svc, events } = service("   ");
    await expect(svc.start("msg_1", "d").done).rejects.toMatchObject({ code: "invalid_params" });
    expect(events.at(-1)?.[1]).toMatchObject({
      event: "speech.readAloud.failed",
      payload: { error: { code: "invalid_params" } },
    });
    await expect(svc.start("msg_404", "d").done).rejects.toThrow();
  });

  it("flattens Markdown and strips markup so message text cannot inject SSML", () => {
    expect(
      markdownToSpeech(
        '## Steps\n- [Docs](https://x.y/z) say *hi*\n```js\nrun()\n```\n<break time="5s"/>See https://a.b',
      ),
    ).toBe("Steps Docs say hi (code omitted) See link");
    expect(titleFrom("!!!")).toBe("Read aloud – message");
  });

  it("keeps PCM format stable across chunks", async () => {
    const engine: SpeechEngine = {
      ...new FakeSpeechEngine(),
      capabilities: async () => ({ engine: "x", streaming: false, synthesis: true, languages: [] }),
      transcribeStream: () =>
        new FakeSpeechEngine().transcribeStream((async function* () {})(), PCM_16K_MONO),
      transcribeFile: async () => ({ text: "", segments: [] }),
      voices: async () => [],
      async *synthesize() {
        yield { data: new Uint8Array(2), format: PCM_16K_MONO };
        yield { data: new Uint8Array(2), format: PCM_24K_MONO };
      },
    };
    const svc = new ReadAloudService({
      engine,
      transcoder: {} as VoiceNoteTranscoder,
      messages: { get: async () => ({ text: "hello", threadId: null }) },
      library: { saveAudio: async () => item("x") },
      emit: () => {},
    });
    await expect(svc.start("m", "d").done).rejects.toThrow(/changed audio format/);
  });
});
