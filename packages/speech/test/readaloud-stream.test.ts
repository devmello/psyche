import type { AudioChunk, LibraryItem, SpeechEngine, SynthesizeOptions } from "@psyche/protocol";
import { validateEventPayload, validateResult } from "@psyche/protocol";
import { FakeSpeechEngine } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { PCM_16K_MONO } from "../src/audio.ts";
import { createSpeechHandlers, SPEECH_METHODS } from "../src/handlers.ts";
import { type EngineEntry, SpeechEngineSelector } from "../src/policy.ts";
import { type ReadAloudEvent, ReadAloudService } from "../src/readAloud.ts";
import type { VoiceNoteTranscoder } from "../src/transcode/ffmpeg.ts";
import { VoiceSessionManager } from "../src/voice.ts";

/**
 * A voice that yields one 100 ms chunk at a time and waits for `next()` between chunks, so a test
 * can cancel in the middle of a reply (voice-mode barge-in, Q5).
 */
function steppedVoice(chunks = 5) {
  const fake = new FakeSpeechEngine();
  let release: (() => void) | undefined;
  let signals: AbortSignal[] = [];
  const engine: SpeechEngine = {
    capabilities: () => fake.capabilities(),
    transcribeStream: (a, f, o) => fake.transcribeStream(a, f, o),
    transcribeFile: (d, f, o) => fake.transcribeFile(d, f, o),
    voices: () => fake.voices(),
    async *synthesize(_text: string, o: SynthesizeOptions = {}): AsyncIterable<AudioChunk> {
      if (o.signal !== undefined) signals.push(o.signal);
      for (let i = 0; i < chunks; i++) {
        await new Promise<void>((r) => {
          release = r;
        });
        if (o.signal?.aborted === true) return;
        yield { data: new Uint8Array(3_200).fill(i + 1), format: PCM_16K_MONO };
      }
    },
  };
  return {
    engine,
    /** Lets the voice produce its next chunk. */
    next: async () => {
      for (let i = 0; i < 20 && release === undefined; i++) await Promise.resolve();
      const r = release;
      release = undefined;
      r?.();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    signals: () => signals,
    reset: () => {
      signals = [];
    },
  };
}

function service(engine: SpeechEngine) {
  const events: [string, ReadAloudEvent][] = [];
  const saved: string[] = [];
  let encodes = 0;
  const transcoder = {
    encode: async () => {
      encodes++;
      return { data: new Uint8Array(3), mime: "audio/mpeg", extension: "mp3", durationMs: 500 };
    },
  } as unknown as VoiceNoteTranscoder;
  let n = 0;
  const svc = new ReadAloudService({
    engine,
    transcoder,
    messages: { get: async () => ({ text: "Here is the plan for tomorrow.", threadId: "thr_1" }) },
    library: {
      saveAudio: async (f) => {
        saved.push(f.name);
        return { id: "lib_1", name: f.name } as LibraryItem;
      },
    },
    emit: (d, e) => events.push([d, e]),
    newId: () => `ra_${++n}`,
  });
  return { svc, events, saved, encodes: () => encodes };
}

const kinds = (events: [string, ReadAloudEvent][]) => events.map(([, e]) => e.event);

describe("read-aloud for voice mode (Q5)", () => {
  it("streams a reply without filing it when save is false", async () => {
    const voice = steppedVoice(3);
    const { svc, events, saved, encodes } = service(voice.engine);
    const { streamId, done } = svc.start("msg_1", "dev_1", { save: false });
    expect(svc.active).toBe(1);
    for (let i = 0; i < 3; i++) await voice.next();
    await voice.next();
    expect(await done).toBeNull();
    expect(saved).toEqual([]);
    expect(encodes()).toBe(0);
    expect(kinds(events)).toEqual(["speech.audio", "speech.audio", "speech.audio"]);
    const audio = events.map(([, e]) => validateEventPayload("speech.audio", e.payload));
    expect(audio.map((a) => [a.streamId, a.seq, a.last])).toEqual([
      [streamId, 0, false],
      [streamId, 1, false],
      [streamId, 2, true],
    ]);
    expect(svc.active).toBe(0);
  });

  it("stops at once on cancel from the same device, sends nothing more and reports cancelled", async () => {
    const voice = steppedVoice(5);
    const { svc, events, saved } = service(voice.engine);
    const { streamId, done } = svc.start("msg_1", "dev_1");
    await voice.next();
    await voice.next();
    // Another device cannot stop it: its id is treated as unknown.
    svc.cancel(streamId, "dev_other");
    expect(voice.signals()[0]?.aborted).toBe(false);
    svc.cancel(streamId, "dev_1");
    expect(voice.signals()[0]?.aborted).toBe(true);
    await voice.next();
    await expect(done).rejects.toMatchObject({ code: "cancelled" });
    // Chunk 0 went out; chunk 1 was held back for `last` and is dropped; nothing is saved.
    expect(kinds(events)).toEqual(["speech.audio", "speech.readAloud.failed"]);
    const failed = events.at(-1)?.[1] as Extract<
      ReadAloudEvent,
      { event: "speech.readAloud.failed" }
    >;
    expect(failed.payload).toEqual({
      streamId,
      messageId: "msg_1",
      error: { code: "cancelled", message: "read-aloud cancelled" },
    });
    expect(saved).toEqual([]);
    expect(svc.active).toBe(0);
    // Cancelling a finished or unknown stream is a no-op.
    svc.cancel(streamId, "dev_1");
    svc.cancel("ra_nope", "dev_1");
  });

  it("follows the caller's own abort signal too", async () => {
    const voice = steppedVoice(5);
    const { svc } = service(voice.engine);
    const ac = new AbortController();
    const { done } = svc.start("msg_1", "dev_1", { signal: ac.signal, save: false });
    await voice.next();
    ac.abort();
    await voice.next();
    await expect(done).rejects.toMatchObject({ code: "cancelled" });
  });

  it("exposes speech.readAloud {save} and speech.readAloud.cancel through the handlers", async () => {
    const voice = steppedVoice(5);
    const { svc, events } = service(voice.engine);
    const fake = new FakeSpeechEngine();
    const entry: EngineEntry = {
      id: "w",
      location: "gateway",
      supports: { transcribe: true, stream: true, synthesize: false },
      engine: fake,
      available: async () => true,
    };
    const selector = new SpeechEngineSelector({ stt: { order: ["w"] }, tts: { order: [] } });
    const h = createSpeechHandlers({
      voice: new VoiceSessionManager({ selector: selector.register(entry), emit: () => {} }),
      readAloud: svc,
    });
    expect(SPEECH_METHODS).toContain("speech.readAloud.cancel");
    const ctx = { deviceId: "dev_1", caller: "desktop" as const };
    const { streamId } = validateResult(
      "speech.readAloud",
      await h["speech.readAloud"]({ messageId: "msg_1", save: false }, ctx),
    );
    await voice.next();
    expect(
      validateResult(
        "speech.readAloud.cancel",
        await h["speech.readAloud.cancel"]({ streamId }, ctx),
      ),
    ).toEqual({ ok: true });
    await voice.next();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(kinds(events)).toEqual(["speech.readAloud.failed"]);
    // Without read-aloud the cancel method is unavailable, like speech.readAloud.
    const bare = createSpeechHandlers({
      voice: new VoiceSessionManager({ selector, emit: () => {} }),
    });
    await expect(bare["speech.readAloud.cancel"]({ streamId: "x" }, ctx)).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
