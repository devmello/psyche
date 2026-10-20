import {
  type AudioFormat,
  type LibraryItem,
  type SpeechEngine,
  validateEventPayload,
  validateResult,
} from "@psyche/protocol";
import { FakeNodeClient, FakeSpeechEngine, FakeTaskEngine } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { concatBytes, PCM_16K_MONO, pcmDurationMs } from "../src/audio.ts";
import { NODE_SPEECH_CAPABILITIES, NodeSpeechEngine } from "../src/engines/node.ts";
import { createSpeechHandlers } from "../src/handlers.ts";
import { VoiceMemoService } from "../src/memo.ts";
import { type EngineEntry, RoutedSpeechEngine, SpeechEngineSelector } from "../src/policy.ts";
import { fromBase64, toBase64 } from "../src/queue.ts";
import { type LibrarySaveInput, type ReadAloudEvent, ReadAloudService } from "../src/readAloud.ts";
import { VoiceNoteTranscoder } from "../src/transcode/ffmpeg.ts";
import { VoiceSessionManager } from "../src/voice.ts";
import { VoiceCatalog } from "../src/voices.ts";
import { collect, ffmpegAvailable, remindAliceClip } from "./helpers.ts";

const cap = (name: string, streaming = false) => ({ name, sideEffect: "read" as const, streaming });
const AVA = "com.apple.voice.premium.en-US.Ava";
const MINE = "com.apple.speech.personalvoice.ABC";

/** A Mac helper with one ordinary voice and one Personal Voice (apps/mac-helper speech.*). */
function helper() {
  const node = new FakeNodeClient({ nodeId: "mac" });
  node
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.synthesize, true),
      handle: (params, emit) => {
        const p = params as {
          text: string;
          format: string;
          voice?: string;
          personalVoice?: boolean;
        };
        // The helper refuses a Personal Voice id without the opt-in (SpeechSynthesis.resolveVoice).
        if (p.voice === MINE && p.personalVoice !== true) {
          throw new Error("personal_voice_opt_in_required");
        }
        const format = { encoding: p.format, sampleRate: 22_050, channels: 1 };
        emit({ type: "speech.audio", seq: 0, data: toBase64(new Uint8Array(441)), format });
        return { format, voice: p.voice ?? AVA, nonCommercial: p.voice === MINE };
      },
    })
    .handle({
      capability: cap(NODE_SPEECH_CAPABILITIES.voices),
      handle: () => ({
        voices: [
          { id: AVA, name: "Ava", language: "en-US", quality: "premium", personalVoice: false },
          {
            id: MINE,
            name: "My Voice",
            language: "en-US",
            quality: "premium",
            personalVoice: true,
          },
        ],
        personalVoiceAuthorization: "authorized",
      }),
    });
  return node;
}

const synthCalls = (node: FakeNodeClient) =>
  node.invocations
    .filter((i) => i.capability === NODE_SPEECH_CAPABILITIES.synthesize)
    .map((i) => i.params as { voice?: string; personalVoice?: boolean });

describe("Personal Voice opt-in (Q3)", () => {
  it("refuses a Personal Voice until the owner turns it on, then sends personalVoice: true", async () => {
    const node = helper();
    let allowed = false;
    const engine = new NodeSpeechEngine({ node: () => node, personalVoice: () => allowed });

    await expect(collect(engine.synthesize("hello", { voice: MINE }))).rejects.toMatchObject({
      code: "policy_denied",
      message: /Personal Voice is off/,
    });
    // Refused before the helper was asked to speak.
    expect(synthCalls(node)).toEqual([]);

    allowed = true;
    expect(await collect(engine.synthesize("hello", { voice: MINE }))).toHaveLength(1);
    await collect(engine.synthesize("hello", { voice: AVA }));
    await collect(engine.synthesize("hello"));
    expect(synthCalls(node)).toEqual([
      { text: "hello", format: "pcm_s16le", voice: MINE, personalVoice: true },
      { text: "hello", format: "pcm_s16le", voice: AVA },
      { text: "hello", format: "pcm_s16le" },
    ]);
    // `speech.voices` was asked once; the answer is cached for the next calls.
    expect(node.invocations.filter((i) => i.capability === "speech.voices")).toHaveLength(1);
  });

  it("asks the helper again for an id it has not seen, and is off without the setting", async () => {
    const node = helper();
    const engine = new NodeSpeechEngine({ node: () => node });
    expect(await engine.isPersonalVoice(AVA)).toBe(false);
    expect(await engine.isPersonalVoice("com.apple.voice.new")).toBe(false);
    expect(node.invocations.filter((i) => i.capability === "speech.voices")).toHaveLength(2);
    await expect(collect(engine.synthesize("x", { voice: MINE }))).rejects.toMatchObject({
      code: "policy_denied",
    });
  });
});

function macSelector(node: FakeNodeClient, personalVoice: boolean, voice?: string) {
  const engine = new NodeSpeechEngine({ node: () => node, personalVoice: () => personalVoice });
  const entry: EngineEntry = {
    id: "mac-node",
    location: "node",
    supports: { transcribe: false, stream: false, synthesize: true },
    engine,
    available: async () => true,
  };
  const selector = new SpeechEngineSelector({
    stt: { order: [] },
    tts: { order: ["mac-node"], ...(voice === undefined ? {} : { voice }) },
  });
  return selector.register(entry);
}

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

describe("read-aloud with the persona's voice (Q3)", () => {
  it("reads with the persona voice and tags a Personal Voice clip non-commercial", async () => {
    const node = helper();
    const selector = macSelector(node, true, `mac-node:${AVA}`);
    const catalog = new VoiceCatalog(selector);
    const saved: LibrarySaveInput[] = [];
    let persona: string | undefined = `mac-node:${MINE}`;
    const svc = new ReadAloudService({
      engine: new RoutedSpeechEngine(selector),
      transcoder: stubTranscoder,
      messages: { get: async () => ({ text: "Pick up the keys.", threadId: "thr_1" }) },
      library: {
        saveAudio: async (f) => {
          saved.push(f);
          return libraryItem(f, saved.length);
        },
      },
      emit: () => {},
      personaVoice: () => persona,
      nonCommercial: (ref) => catalog.isNonCommercial(ref),
    });

    await svc.start("msg_1", "dev_1").done;
    expect(synthCalls(node).at(-1)).toMatchObject({ voice: MINE, personalVoice: true });
    expect(saved[0]?.tags).toEqual(["read-aloud", "message:msg_1", "non-commercial"]);

    // An explicit voice wins over the persona; an ordinary voice carries no caveat.
    await svc.start("msg_1", "dev_1", { voice: `mac-node:${AVA}` }).done;
    expect(synthCalls(node).at(-1)).toEqual({
      text: "Pick up the keys.",
      format: "pcm_s16le",
      voice: AVA,
    });
    expect(saved[1]?.tags).toEqual(["read-aloud", "message:msg_1"]);

    // No persona voice: the configured default (Ava) reads.
    persona = undefined;
    await svc.start("msg_1", "dev_1").done;
    expect(synthCalls(node).at(-1)?.voice).toBe(AVA);
    expect(saved[2]?.tags).not.toContain("non-commercial");
    expect(await catalog.isNonCommercial(`mac-node:${MINE}`)).toBe(true);
  });

  it("fails the read-aloud, with nothing saved, when the persona's Personal Voice is not allowed", async () => {
    const node = helper();
    const selector = macSelector(node, false);
    const events: ReadAloudEvent[] = [];
    const saved: LibrarySaveInput[] = [];
    const svc = new ReadAloudService({
      engine: new RoutedSpeechEngine(selector),
      transcoder: stubTranscoder,
      messages: { get: async () => ({ text: "hello", threadId: null }) },
      library: {
        saveAudio: async (f) => {
          saved.push(f);
          return libraryItem(f, 1);
        },
      },
      emit: (_d, e) => events.push(e),
      personaVoice: () => `mac-node:${MINE}`,
    });
    await expect(svc.start("msg_1", "dev_1").done).rejects.toMatchObject({ code: "policy_denied" });
    expect(saved).toEqual([]);
    expect(events.map((e) => e.event)).toEqual(["speech.readAloud.failed"]);
  });
});

/** Speaks the remind-alice fixture (real speech audio) in 100 ms chunks, whatever the text. */
function fixtureVoice(): SpeechEngine {
  const fake = new FakeSpeechEngine();
  const clip = remindAliceClip();
  return {
    capabilities: () => fake.capabilities(),
    transcribeStream: (a, f, o) => fake.transcribeStream(a, f, o),
    transcribeFile: (d, f, o) => fake.transcribeFile(d, f, o),
    voices: () => fake.voices(),
    async *synthesize() {
      for (let off = 0; off < clip.data.byteLength; off += 3_200) {
        yield { data: clip.data.subarray(off, off + 3_200), format: clip.format };
      }
    },
  };
}

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
    supports: { transcribe: true, stream: true, synthesize: true },
    engine,
    available: async () => true,
  };
  const selector = new SpeechEngineSelector({
    stt: { order: ["whisper"] },
    tts: { order: ["whisper"] },
  }).register(entry);
  const emit = (d: string, e: { event: string; payload: unknown }) => events.push([d, e]);
  const voice = new VoiceSessionManager({ selector, emit, newId: () => "vs_1" });
  const handlers = createSpeechHandlers({
    voice,
    memos: new VoiceMemoService({ engine, library, transcoder, tasks: new FakeTaskEngine() }),
    readAloud: new ReadAloudService({
      engine,
      transcoder,
      library,
      emit,
      newId: () => "ra_1",
      messages: {
        get: async (id) => ({
          text: `**Reminder**: call Alice at noon (${id}).`,
          threadId: "thr_1",
        }),
      },
    }),
    catalog: new VoiceCatalog(selector),
  });
  return { handlers, events, saved };
}

const desktop = { deviceId: "dev_desktop", caller: "desktop" as const };

describe("Q3 done when: a message can be played and saved as a file", () => {
  it("streams playable PCM to the device and saves a real MP3 in the Library (ffmpeg)", async () => {
    if (!(await ffmpegAvailable())) return;
    const transcoder = new VoiceNoteTranscoder();
    const { handlers, events, saved } = stack(fixtureVoice(), transcoder);

    const started = validateResult(
      "speech.readAloud",
      await handlers["speech.readAloud"]({ messageId: "msg_1" }, desktop),
    );
    expect(started).toEqual({ streamId: "ra_1" });
    await expect
      .poll(() => events.some(([, e]) => e.event === "speech.readAloud.completed"), {
        timeout: 20_000,
      })
      .toBe(true);

    // Played: every speech.audio event goes to the requesting device, in order, last flagged,
    // and together they are exactly the synthesized PCM.
    const audio = events.filter(([, e]) => e.event === "speech.audio");
    expect(audio.every(([d]) => d === "dev_desktop")).toBe(true);
    const payloads = audio.map(([, e]) => validateEventPayload("speech.audio", e.payload)) as {
      seq: number;
      audio: string;
      format: AudioFormat;
      last: boolean;
    }[];
    expect(payloads.map((p) => p.seq)).toEqual(payloads.map((_, i) => i));
    expect(payloads.map((p) => p.last)).toEqual(payloads.map((_, i) => i === payloads.length - 1));
    expect(payloads[0]?.format).toEqual(PCM_16K_MONO);
    const pcm = concatBytes(payloads.map((p) => fromBase64(p.audio)));
    expect(Buffer.from(pcm).equals(Buffer.from(remindAliceClip().data))).toBe(true);

    // Saved as a file: an MP3 Library item named after the message, announced to the device.
    const done = events.find(([, e]) => e.event === "speech.readAloud.completed")?.[1].payload;
    const completed = validateEventPayload("speech.readAloud.completed", done);
    expect(completed.item.mime).toBe("audio/mpeg");
    expect(completed.item.name).toBe("Read aloud – Reminder call Alice at noon msg 1.mp3");
    const clipMs = pcmDurationMs(remindAliceClip().data.byteLength, PCM_16K_MONO);
    expect(completed.durationMs).toBe(Math.round(clipMs));
    const file = saved[0]?.data as Uint8Array;
    const probe = await transcoder.probe(file);
    expect(probe).toMatchObject({
      formatName: "mp3",
      codec: "mp3",
      sampleRate: 44_100,
      channels: 1,
    });
    expect(Math.abs(probe.durationMs - clipMs)).toBeLessThan(150);
    // And the file plays back: it decodes to about the same amount of 16 kHz audio.
    const decoded = await transcoder.decode(file);
    expect(Math.abs(decoded.byteLength - pcm.byteLength)).toBeLessThan(16_000 * 2 * 0.15);
  });
});

describe("speech handlers for the Gateway", () => {
  it("runs dictation, memo and voice listing with results valid against the protocol", async () => {
    const fake = new FakeSpeechEngine().transcript("remind me to call Alice");
    const engine: SpeechEngine = {
      capabilities: () => fake.capabilities(),
      transcribeStream: (a, f, o) => fake.transcribeStream(a, f, o),
      transcribeFile: (d, f, o) => fake.transcribeFile(d, f, o),
      synthesize: (t, o) => fake.synthesize(t, o),
      voices: () => fake.voices(),
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
      selector: new SpeechEngineSelector({ stt: { order: ["w"] }, tts: { order: [] } }).register({
        id: "w",
        location: "gateway",
        supports: { transcribe: true, stream: true, synthesize: false },
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

    // Missing services answer unavailable rather than crashing.
    await expect(h2["speech.readAloud"]({ messageId: "m" }, desktop)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(h2["voice.memo.save"]({ sessionId: "vs_2" }, desktop)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(h2["speech.voices"]({}, desktop)).rejects.toMatchObject({ code: "unavailable" });

    const voices = validateResult("speech.voices", await h["speech.voices"]({}, desktop));
    expect(voices.voices.map((v) => v.ref)).toEqual(["whisper:fake-en"]);
    expect(voices.default).toBe("whisper:fake-en");
  });
});
