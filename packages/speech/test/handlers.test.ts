import { type LibraryItem, type SpeechEngine, validateResult } from "@psyche/protocol";
import { FakeSpeechEngine, FakeTaskEngine } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { PCM_16K_MONO } from "../src/audio.ts";
import { createSpeechHandlers } from "../src/handlers.ts";
import type { LibrarySaveInput } from "../src/library.ts";
import { VoiceMemoService } from "../src/memo.ts";
import { type EngineEntry, SpeechEngineSelector } from "../src/policy.ts";
import { toBase64 } from "../src/queue.ts";
import type { VoiceNoteTranscoder } from "../src/transcode/ffmpeg.ts";
import { VoiceSessionManager } from "../src/voice.ts";

function libraryItem(f: LibrarySaveInput, n: number): LibraryItem {
  return {
    id: `lib_${n}`,
    kind: f.kind ?? "audio",
    name: f.name,
    mime: f.mime,
    path: `audio/${f.name}`,
    size: f.data.byteLength,
    sha256: "0".repeat(64),
    origin: f.origin ?? "agent",
    threadId: f.threadId,
    taskId: null,
    tags: f.tags,
    textExtractRef: null,
    createdAt: "2026-10-19T12:00:00.000Z",
  };
}

/** A stand-in encoder for tests that do not need real MP3 bytes. */
const stubTranscoder = {
  available: async () => true,
  encode: async () => ({
    data: new Uint8Array([0x49, 0x44, 0x33]),
    mime: "audio/mpeg",
    extension: "mp3",
    fileName: "voice-note.mp3",
    container: "mp3" as const,
    bitrateKbps: 64,
    durationMs: 10,
    nativeVoiceNote: false,
  }),
} as unknown as VoiceNoteTranscoder;

function stack(engine: SpeechEngine, transcoder: VoiceNoteTranscoder) {
  const events: [string, { event: string; payload: unknown }][] = [];
  const saved: LibrarySaveInput[] = [];
  const library = {
    saveAudio: async (f: LibrarySaveInput) => {
      saved.push(f);
      return libraryItem(f, saved.length);
    },
  };
  const entry: EngineEntry = {
    id: "whisper",
    location: "gateway",
    supports: { transcribe: true, stream: true },
    engine,
    available: async () => true,
  };
  const selector = new SpeechEngineSelector({ stt: { order: ["whisper"] } }).register(entry);
  const emit = (d: string, e: { event: string; payload: unknown }) => events.push([d, e]);
  const voice = new VoiceSessionManager({ selector, emit, newId: () => "vs_1" });
  const handlers = createSpeechHandlers({
    voice,
    memos: new VoiceMemoService({ engine, library, transcoder, tasks: new FakeTaskEngine() }),
  });
  return { handlers, events, saved };
}

const desktop = { deviceId: "dev_desktop", caller: "desktop" as const };

describe("speech handlers for the Gateway", () => {
  it("runs dictation and memos with results valid against the protocol", async () => {
    const fake = new FakeSpeechEngine().transcript("remind me to call Alice");
    const engine: SpeechEngine = {
      capabilities: () => fake.capabilities(),
      transcribeStream: (a, f, o) => fake.transcribeStream(a, f, o),
      transcribeFile: (d, f, o) => fake.transcribeFile(d, f, o),
    };
    const { handlers, events } = stack(engine, stubTranscoder);
    const h = handlers;

    const start = validateResult(
      "voice.start",
      await h["voice.start"]({ format: PCM_16K_MONO, memo: true, threadId: "thr_1" }, desktop),
    );
    expect(start).toEqual({ sessionId: "vs_1", location: "gateway", engine: "whisper" });
    const chunk = toBase64(new Uint8Array(16_000));
    validateResult(
      "voice.push",
      await h["voice.push"]({ sessionId: "vs_1", seq: 0, audio: chunk }, desktop),
    );
    const memo = validateResult(
      "voice.memo.save",
      await h["voice.memo.save"]({ sessionId: "vs_1", threadId: "thr_1" }, desktop),
    );
    expect(memo.transcript.text).toBe("remind me to call Alice");
    expect(memo.provenance).toBe("owner");
    expect(memo.task?.title).toBe("Call Alice");
    expect(memo.blocks.map((b) => b.type)).toEqual(["text", "file", "task"]);
    expect(memo.durationMs).toBe(500);
    expect(events.some(([, e]) => e.event === "voice.segment")).toBe(true);

    // A plain session: stop answers the transcript; cancel answers ok.
    const s2 = new VoiceSessionManager({
      selector: new SpeechEngineSelector({ stt: { order: ["w"] } }).register({
        id: "w",
        location: "gateway",
        supports: { transcribe: true, stream: true },
        engine,
        available: async () => true,
      }),
      emit: () => {},
      newId: () => "vs_2",
    });
    const h2 = createSpeechHandlers({ voice: s2 });
    await h2["voice.start"]({ format: PCM_16K_MONO }, desktop);
    expect(
      validateResult("voice.stop", await h2["voice.stop"]({ sessionId: "vs_2" }, desktop))
        .transcript.text,
    ).toBe("remind me to call Alice");
    await h2["voice.start"]({ format: PCM_16K_MONO }, desktop);
    expect(await h2["voice.cancel"]({ sessionId: "vs_2" }, desktop)).toEqual({ ok: true });

    // A missing service answers unavailable rather than crashing.
    await expect(h2["voice.memo.save"]({ sessionId: "vs_2" }, desktop)).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
