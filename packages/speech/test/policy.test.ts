import { PsycheError, type SpeechEngine } from "@psyche/protocol";
import { FakeSpeechEngine } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { PCM_16K_MONO } from "../src/audio.ts";
import {
  DEFAULT_SPEECH_SETTINGS,
  type EngineEntry,
  parseVoiceRef,
  RoutedSpeechEngine,
  SpeechEngineSelector,
} from "../src/policy.ts";

function entry(
  id: string,
  location: EngineEntry["location"],
  opts: { up?: boolean; synth?: boolean; engine?: SpeechEngine; stream?: boolean } = {},
): EngineEntry {
  const e: EngineEntry = {
    id,
    location,
    supports: {
      transcribe: opts.synth !== true,
      stream: opts.stream ?? opts.synth !== true,
      synthesize: opts.synth === true,
    },
    available: async () => opts.up ?? true,
  };
  if (location !== "client") e.engine = opts.engine ?? new FakeSpeechEngine();
  return e;
}

function selector(up: { mac?: boolean; whisper?: boolean } = {}) {
  return new SpeechEngineSelector()
    .register(entry("mac-node", "node", { up: up.mac ?? true }))
    .register(entry("whisper", "gateway", { up: up.whisper ?? true }))
    .register(entry("web-speech", "client"))
    .register(entry("kokoro", "gateway", { synth: true }))
    .register(entry("openai", "cloud", { synth: true }));
}

describe("engine selection policy (Q1, ADR-014)", () => {
  it("prefers the Mac node, then whisper.cpp, then Web Speech", async () => {
    expect((await selector().select({ purpose: "dictation", caller: "desktop" })).id).toBe(
      "mac-node",
    );
    expect(
      (await selector({ mac: false }).select({ purpose: "dictation", caller: "desktop" })).id,
    ).toBe("whisper");
    const web = await selector({ mac: false, whisper: false }).select({
      purpose: "dictation",
      caller: "web",
    });
    expect(web).toMatchObject({ id: "web-speech", location: "client" });
    expect(web.engine).toBeUndefined();
  });

  it("never hands a client-only engine to the desktop, a channel or the agent", async () => {
    const s = selector({ mac: false, whisper: false });
    for (const caller of ["desktop", "channel", "agent"] as const) {
      const err = await s.select({ purpose: "dictation", caller }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PsycheError);
      expect((err as PsycheError).code).toBe("unavailable");
    }
    const explain = await s.explain({ purpose: "dictation", caller: "desktop" });
    expect(explain.map((e) => [e.id, e.reason])).toEqual([
      ["mac-node", "unavailable"],
      ["whisper", "unavailable"],
      ["web-speech", "client_only"],
    ]);
  });

  it("treats a throwing availability probe as unavailable", async () => {
    const s = new SpeechEngineSelector().register({
      ...entry("whisper", "gateway"),
      available: async () => {
        throw new Error("boom");
      },
    });
    await expect(s.select({ purpose: "file" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("follows the configured order and skips unknown ids", async () => {
    const s = selector();
    s.configure({ ...DEFAULT_SPEECH_SETTINGS, stt: { order: ["nope", "whisper", "mac-node"] } });
    expect((await s.select({ purpose: "file" })).id).toBe("whisper");
  });

  it("puts a persona voice's engine first for synthesis and passes the voice id", async () => {
    const s = selector();
    s.configure({
      ...DEFAULT_SPEECH_SETTINGS,
      tts: { order: ["kokoro"], voice: "kokoro:af_heart" },
    });
    expect(await s.select({ purpose: "synthesize" })).toMatchObject({
      id: "kokoro",
      voice: "af_heart",
    });
    // A persona pinned to a cloud voice wins even though cloud is not in the default order.
    expect(await s.select({ purpose: "synthesize", voice: "openai:nova" })).toMatchObject({
      id: "openai",
      voice: "nova",
    });
    // A voice for another engine is not passed to the fallback engine.
    s.configure({ ...DEFAULT_SPEECH_SETTINGS, tts: { order: ["kokoro"] } });
    const sel = await s.select({ purpose: "synthesize", voice: "missing:x" });
    expect(sel.id).toBe("kokoro");
    expect(sel.voice).toBeUndefined();
  });

  it("parses voice references", () => {
    expect(parseVoiceRef("kokoro:af_heart")).toEqual({ engine: "kokoro", voice: "af_heart" });
    expect(parseVoiceRef("af_heart")).toEqual({ voice: "af_heart" });
    expect(parseVoiceRef(undefined)).toEqual({});
  });

  it("rejects a server-side entry without an engine", () => {
    expect(() =>
      new SpeechEngineSelector().register({
        id: "x",
        location: "gateway",
        supports: { transcribe: true, stream: true, synthesize: false },
        available: async () => true,
      }),
    ).toThrow(PsycheError);
  });
});

describe("RoutedSpeechEngine", () => {
  it("routes per call and applies the language and vocabulary settings", async () => {
    const seen: unknown[] = [];
    const whisper = new FakeSpeechEngine().transcript("call alice");
    const spy: SpeechEngine = {
      capabilities: () => whisper.capabilities(),
      transcribeStream: (a, f, o) => whisper.transcribeStream(a, f, o),
      transcribeFile: async (d, f, o) => {
        seen.push(o);
        return whisper.transcribeFile(d, f, o);
      },
      synthesize: (t, o) => whisper.synthesize(t, o),
      voices: () => whisper.voices(),
    };
    const s = new SpeechEngineSelector({
      stt: { order: ["whisper"], language: "en-US", vocabulary: ["Pip"] },
      tts: { order: ["kokoro"], voice: "kokoro:af_heart" },
    })
      .register(entry("whisper", "gateway", { engine: spy }))
      .register(entry("kokoro", "gateway", { synth: true }));
    const routed = new RoutedSpeechEngine(s);
    const t = await routed.transcribeFile(new Uint8Array(320), PCM_16K_MONO, {
      vocabulary: ["Alice"],
    });
    expect(t.text).toBe("call alice");
    expect(seen[0]).toMatchObject({ language: "en-US", vocabulary: ["Alice", "Pip"] });
    const voices = await routed.voices();
    expect(voices.map((v) => v.id)).toEqual(["kokoro:fake-en"]);
    const caps = await routed.capabilities();
    expect(caps).toMatchObject({ synthesis: true, streaming: true });
  });
});
