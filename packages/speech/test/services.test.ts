import type { SpeechEngine, TranscriptSegment } from "@psyche/protocol";
import { FakeSpeechEngine } from "@psyche/testing";
import { describe, expect, it, vi } from "vitest";
import { PCM_16K_MONO } from "../src/audio.ts";
import { type EngineEntry, SpeechEngineSelector } from "../src/policy.ts";
import { toBase64 } from "../src/queue.ts";
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
    supports: { transcribe: true, stream: true },
    available: async () => true,
  };
  if (engine !== undefined) e.engine = engine;
  return new SpeechEngineSelector({ stt: { order: [e.id] } }).register(e);
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
      capabilities: async () => ({ engine: "x", streaming: true, languages: [] }),
      transcribeFile: async () => ({ text: "", segments: [] }),
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
