import type { SpeechEngine, Voice } from "@psyche/protocol";
import { FakeMemoryStore, FakeNodeClient, FakeSpeechEngine } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  type ChannelVoiceTranscoder,
  channelVoiceTranscoder,
  DecodingSpeechEngine,
} from "../src/adapters.ts";
import { encodeWav, PCM_16K_MONO } from "../src/audio.ts";
import { createSpeechStack } from "../src/index.ts";
import { type EngineEntry, SpeechEngineSelector } from "../src/policy.ts";
import type { VoiceNoteTranscoder } from "../src/transcode/ffmpeg.ts";
import { VOICE_NOTE_PROFILES, type VoiceNoteProfile } from "../src/transcode/formats.ts";
import {
  agentNameFrom,
  DictationVocabularyProvider,
  NODE_CONTACTS_CAPABILITY,
  NodeContactsSource,
  ownerNamesFrom,
} from "../src/vocabulary.ts";
import { VoiceCatalog } from "../src/voices.ts";
import { remindAliceClip } from "./helpers.ts";

const IDENTITY = `---
name: "Pip"
creature: a small teal dragon with round glasses
voice: kokoro:af_heart
---
Pip is curious.
`;

const USER = `# About the owner
- Name: Pranav. Student at UCSC. Timezone: America/Los_Angeles.
## Directives (dated; latest wins)
- 2026-10-18 active: Keep replies short unless asked for detail.
## People
- Alice Chen (sister), prefers texts
- **Kaveh Farrokhzad** — landlord
- Ngozi Adeyemi: PhD advisor
- Dr. Marisol Echeverria
## Projects
- Psyche, an agent app
`;

function contactsNode(names: string[], withCapability = true) {
  const node = new FakeNodeClient({ nodeId: "node_mac" });
  if (withCapability) {
    node.handle({
      capability: { name: NODE_CONTACTS_CAPABILITY, sideEffect: "read" },
      handle: (params) => {
        const p = params as { limit: number; fields: string[] };
        expect(p.fields).toEqual(["name"]);
        return {
          contacts: names.slice(0, p.limit).map((name, i) => ({
            id: `c${i}`,
            name,
            ...(i === 0 ? { nickname: "Sam" } : {}),
          })),
        };
      },
    });
  }
  return node;
}

describe("dictation vocabulary from persona files and contacts (Q1, spike 03)", () => {
  it("reads the agent name and the owner's people from IDENTITY.md and USER.md", () => {
    expect(agentNameFrom(IDENTITY)).toBe("Pip");
    expect(agentNameFrom("no frontmatter")).toBeUndefined();
    expect(agentNameFrom(undefined)).toBeUndefined();
    expect(ownerNamesFrom(USER)).toEqual({
      owner: "Pranav",
      people: ["Alice Chen", "Kaveh Farrokhzad", "Ngozi Adeyemi", "Dr. Marisol Echeverria"],
    });
    expect(ownerNamesFrom("# About\n- likes tea\n")).toEqual({ people: [] });
  });

  it("assembles agent, owner, custom terms, people, contacts and topics in priority order", async () => {
    const memory = new FakeMemoryStore({ files: { "IDENTITY.md": IDENTITY, "USER.md": USER } });
    const node = contactsNode(["Samantha Ortiz", "Alice Chen", "Bob {{cred:x}}"]);
    let now = 1_000;
    const provider = new DictationVocabularyProvider({
      memory,
      contacts: new NodeContactsSource({ node: () => node, limit: 50 }),
      custom: () => ["sqlite-vec", "pip"],
      topics: async () => ["Tahoe trip"],
      ttlMs: 60_000,
      now: () => now,
    });
    const terms = await provider.get();
    expect(terms).toEqual([
      "Pip",
      "Pranav",
      "sqlite-vec",
      "Alice Chen",
      "Kaveh Farrokhzad",
      "Ngozi Adeyemi",
      "Dr. Marisol Echeverria",
      "Samantha Ortiz",
      "Sam",
      "Tahoe trip",
    ]);
    expect(node.invocations).toEqual([
      { capability: NODE_CONTACTS_CAPABILITY, params: { limit: 50, fields: ["name"] } },
    ]);
    // Cached within the TTL, refreshed after it, dropped by invalidate().
    await provider.get();
    expect(node.invocations).toHaveLength(1);
    now += 60_001;
    await provider.get();
    expect(node.invocations).toHaveLength(2);
    provider.invalidate();
    await Promise.all([provider.get(), provider.get()]);
    expect(node.invocations).toHaveLength(3);
  });

  it("is best effort: no node, no capability, a throwing source or no files still yield a list", async () => {
    const offline = new DictationVocabularyProvider({
      memory: new FakeMemoryStore({ files: { "IDENTITY.md": IDENTITY } }),
      contacts: new NodeContactsSource({ node: () => undefined }),
      topics: () => {
        throw new Error("index down");
      },
    });
    expect(await offline.get()).toEqual(["Pip"]);
    const noCap = new NodeContactsSource({ node: () => contactsNode(["x"], false) });
    expect(await noCap.names()).toEqual([]);
    expect(await new DictationVocabularyProvider().get()).toEqual([]);
    const sources = await new DictationVocabularyProvider({
      memory: new FakeMemoryStore({ files: { "USER.md": USER } }),
    }).sources();
    expect(sources.agentName).toBeUndefined();
    expect(sources.ownerName).toBe("Pranav");
  });
});

function synth(
  id: string,
  voices: Voice[],
  available = true,
  location: EngineEntry["location"] = "gateway",
) {
  const fake = new FakeSpeechEngine();
  const engine: SpeechEngine = {
    capabilities: () => fake.capabilities(),
    transcribeStream: (a, f, o) => fake.transcribeStream(a, f, o),
    transcribeFile: (d, f, o) => fake.transcribeFile(d, f, o),
    synthesize: (t, o) => fake.synthesize(t, o),
    voices: async () => voices,
  };
  const entry: EngineEntry = {
    id,
    location,
    supports: { transcribe: false, stream: false, synthesize: true },
    engine,
    available: async () => available,
  };
  return entry;
}

describe("voice catalog for persona voice selection (Q3)", () => {
  const kokoroVoices: Voice[] = [
    { id: "af_heart", name: "Heart", language: "en-US", local: true },
    { id: "bm_george", name: "George", language: "en-GB", local: true },
  ];
  const macVoices = [
    { id: "com.apple.voice.premium.en-US.Zoe", name: "Zoe", language: "en-US", local: true },
    { id: "personal.1", name: "My voice", language: "en-US", local: true, nonCommercial: true },
  ] as Voice[];

  it("lists <engine>:<voice> refs in tts order, marks the configured default and skips unavailable engines", async () => {
    const selector = new SpeechEngineSelector({
      stt: { order: [] },
      tts: { order: ["kokoro", "mac-node", "openai"], voice: "kokoro:bm_george" },
    });
    selector.register(synth("kokoro", kokoroVoices));
    selector.register(synth("mac-node", macVoices, true, "node"));
    selector.register(
      synth(
        "openai",
        [{ id: "alloy", name: "alloy", language: "*", local: false }],
        false,
        "cloud",
      ),
    );
    const r = await new VoiceCatalog(selector).list();
    expect(r.voices.map((v) => v.ref)).toEqual([
      "kokoro:af_heart",
      "kokoro:bm_george",
      "mac-node:com.apple.voice.premium.en-US.Zoe",
      "mac-node:personal.1",
    ]);
    expect(r.default).toBe("kokoro:bm_george");
    expect(r.voices.filter((v) => v.default).map((v) => v.ref)).toEqual(["kokoro:bm_george"]);
    expect(r.voices[3]).toMatchObject({
      engine: "mac-node",
      location: "node",
      nonCommercial: true,
    });
    expect(r.voices[0]?.nonCommercial).toBeUndefined();
    expect(r.unavailable).toEqual(["openai"]);
  });

  it("puts the persona's engine first and falls back to the first voice when the ref is unknown", async () => {
    const selector = new SpeechEngineSelector({
      stt: { order: [] },
      tts: { order: ["kokoro", "mac-node"], voice: "kokoro:af_heart" },
    });
    selector.register(synth("kokoro", kokoroVoices));
    selector.register(synth("mac-node", macVoices, true, "node"));
    const persona = await new VoiceCatalog(selector).list({ personaVoice: "mac-node:personal.1" });
    expect(persona.voices[0]?.engine).toBe("mac-node");
    expect(persona.default).toBe("mac-node:personal.1");
    const gone = await new VoiceCatalog(selector).list({ personaVoice: "kokoro:af_missing" });
    expect(gone.default).toBe("kokoro:af_heart");
    const none = await new VoiceCatalog(
      new SpeechEngineSelector({ stt: { order: [] }, tts: { order: ["kokoro"] } }).register(
        synth("kokoro", [], false),
      ),
    ).list();
    expect(none).toEqual({ voices: [], default: null, unavailable: ["kokoro"] });
  });
});

describe("channel glue for the voice-note round trip (Q4 / N11)", () => {
  function stubTranscoder(available = true) {
    const calls: { bytes: number; profile: VoiceNoteProfile }[] = [];
    const clip = remindAliceClip();
    const t = {
      available: async () => available,
      decode: async () => clip.data,
      encode: async (pcm: Uint8Array, _f: unknown, profile: VoiceNoteProfile) => {
        calls.push({ bytes: pcm.byteLength, profile });
        return {
          data: new Uint8Array([1]),
          mime: profile.mime,
          extension: profile.extension,
          fileName: profile.fileName ?? `voice-note.${profile.extension}`,
          container: profile.container,
          bitrateKbps: 32,
          durationMs: 4_500,
          nativeVoiceNote: profile.nativeVoiceNote,
        };
      },
    } as unknown as VoiceNoteTranscoder;
    return { t, calls };
  }

  it("decodes compressed inbound notes before the engine sees them and passes PCM through", async () => {
    const seen: { bytes: number; encoding: string }[] = [];
    const fake = new FakeSpeechEngine().transcript("call alice");
    const inner: SpeechEngine = {
      capabilities: () => fake.capabilities(),
      transcribeStream: (a, f, o) => fake.transcribeStream(a, f, o),
      transcribeFile: (d, f, o) => {
        seen.push({ bytes: d.byteLength, encoding: f.encoding });
        return fake.transcribeFile(d, f, o);
      },
      synthesize: (t, o) => fake.synthesize(t, o),
      voices: () => fake.voices(),
    };
    const clip = remindAliceClip();
    const engine = new DecodingSpeechEngine(inner, stubTranscoder().t);
    const opus = { encoding: "opus" as const, sampleRate: 48_000, channels: 1 };
    expect((await engine.transcribeFile(new Uint8Array([0x4f, 0x67]), opus)).text).toBe(
      "call alice",
    );
    await engine.transcribeFile(encodeWav(clip.data, clip.format), {
      ...PCM_16K_MONO,
      encoding: "wav",
    });
    await engine.transcribeFile(new Uint8Array(320), PCM_16K_MONO);
    expect(seen).toEqual([
      { bytes: clip.data.byteLength, encoding: "pcm_s16le" },
      { bytes: clip.data.byteLength, encoding: "pcm_s16le" },
      { bytes: 320, encoding: "pcm_s16le" },
    ]);
    await expect(
      new DecodingSpeechEngine(inner, stubTranscoder(false).t).transcribeFile(
        new Uint8Array(4),
        opus,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(createSpeechStack({ home: "/nonexistent" }).engine).toBeInstanceOf(DecodingSpeechEngine);
  });

  it("adapts the encoder to the channel port by container or by channel", async () => {
    const { t, calls } = stubTranscoder();
    const port: ChannelVoiceTranscoder = channelVoiceTranscoder(t);
    const pcm = new Uint8Array(3200);
    const ogg = await port.transcode(pcm, PCM_16K_MONO, "ogg_opus");
    expect(ogg).toEqual({
      data: new Uint8Array([1]),
      mime: "audio/ogg",
      name: "voice-note.ogg",
      durationMs: 4_500,
    });
    const caf = await port.transcode(pcm, PCM_16K_MONO, "caf_opus");
    expect(caf.name).toBe("Audio Message.caf");
    await port.transcode(pcm, PCM_16K_MONO, "mp3");
    await port.transcode(pcm, PCM_16K_MONO, "whatsapp");
    expect(calls.map((c) => c.profile)).toEqual([
      VOICE_NOTE_PROFILES.signal,
      VOICE_NOTE_PROFILES.imessage,
      VOICE_NOTE_PROFILES.slack,
      VOICE_NOTE_PROFILES.whatsapp,
    ]);
  });
});
