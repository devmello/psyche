import type {
  AudioChunk,
  AudioFormat,
  SpeechEngine,
  SynthesizeOptions,
  TranscribeOptions,
  TranscriptSegment,
} from "@psyche/protocol";
import { validateEventPayload, validateResult } from "@psyche/protocol";
import { FakeSpeechEngine } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PCM_16K_MONO } from "../src/audio.ts";
import {
  type VoiceConversationEvent,
  VoiceConversationManager,
  type VoiceTurnEvent,
  type VoiceTurnInput,
  type VoiceTurnPort,
} from "../src/conversation/conversation.ts";
import { SpokenText } from "../src/conversation/spoken.ts";
import { PcmVad } from "../src/conversation/vad.ts";
import { createSpeechHandlers } from "../src/handlers.ts";
import { type EngineEntry, SpeechEngineSelector } from "../src/policy.ts";
import { AsyncQueue, toBase64 } from "../src/queue.ts";
import { VoiceSessionManager } from "../src/voice.ts";
import { tonePcm } from "./helpers.ts";

/** Reveals one word of the next scripted transcript per audio chunk; the final on end of audio. */
class ScriptedStt {
  readonly texts: string[];
  readonly options: TranscribeOptions[] = [];
  constructor(texts: string[]) {
    this.texts = texts;
  }
  engine(): SpeechEngine {
    const fake = new FakeSpeechEngine();
    const self = this;
    return {
      capabilities: () => fake.capabilities(),
      transcribeFile: (d, f, o) => fake.transcribeFile(d, f, o),
      synthesize: (t, o) => fake.synthesize(t, o),
      voices: () => fake.voices(),
      async *transcribeStream(audio, _format: AudioFormat, options: TranscribeOptions = {}) {
        self.options.push(options);
        const text = self.texts.shift() ?? "";
        const words = text.split(/\s+/).filter(Boolean);
        let i = 0;
        for await (const _chunk of audio) {
          if (options.signal?.aborted === true) return;
          if (i < words.length) {
            i++;
            const seg: TranscriptSegment = {
              text: words.slice(0, i).join(" "),
              startMs: 0,
              endMs: i * 100,
              final: false,
            };
            yield seg;
          }
        }
        if (options.signal?.aborted === true) return;
        yield { text, startMs: 0, endMs: words.length * 100, final: true };
      },
    };
  }
}

/** Two 100 ms PCM chunks per sentence; records what it was asked to say. */
class FakeVoice {
  readonly said: string[] = [];
  engine(): SpeechEngine {
    const fake = new FakeSpeechEngine();
    const self = this;
    return {
      capabilities: () => fake.capabilities(),
      transcribeFile: (d, f, o) => fake.transcribeFile(d, f, o),
      transcribeStream: (a, f, o) => fake.transcribeStream(a, f, o),
      voices: () => fake.voices(),
      async *synthesize(text: string, o: SynthesizeOptions = {}): AsyncIterable<AudioChunk> {
        self.said.push(text);
        for (let i = 0; i < 2; i++) {
          await Promise.resolve();
          if (o.signal?.aborted === true) return;
          yield { data: new Uint8Array(3_200), format: PCM_16K_MONO };
        }
      },
    };
  }
}

/** The Gateway's chat path, driven by the test. */
function scriptedTurns() {
  const sends: VoiceTurnInput[] = [];
  let current: AsyncQueue<VoiceTurnEvent> | undefined;
  const port: VoiceTurnPort = {
    send(input) {
      sends.push(input);
      current = new AsyncQueue<VoiceTurnEvent>();
      return current;
    },
  };
  return {
    port,
    sends,
    emit: (e: VoiceTurnEvent) => current?.push(e),
    close: () => current?.end(),
    fail: (err: Error) => current?.fail(err),
  };
}

const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function setup(texts: string[], opts: { settings?: object } = {}) {
  const stt = new ScriptedStt(texts);
  const voice = new FakeVoice();
  const turns = scriptedTurns();
  const events: [string, VoiceConversationEvent][] = [];
  const entry: EngineEntry = {
    id: "mac-node",
    location: "node",
    supports: { transcribe: true, stream: true, synthesize: true },
    engine: stt.engine(),
    available: async () => true,
  };
  const selector = new SpeechEngineSelector({ stt: { order: ["mac-node"] }, tts: { order: [] } });
  selector.register(entry);
  let n = 0;
  const manager = new VoiceConversationManager({
    selector,
    tts: voice.engine(),
    turns: turns.port,
    emit: (d, e) => events.push([d, e]),
    vocabulary: () => ["Wren", "Alice Chen"],
    settings: () => opts.settings ?? {},
    newId: () => `vc_${++n}`,
  });
  const ctx = { deviceId: "dev_mac", caller: "desktop" as const };
  let seq = 0;
  /** Feeds `ms` of audio (amp 0 = silence) in 100 ms chunks. */
  const feed = (amp: number, ms: number, id = "vc_1") => {
    for (let t = 0; t < ms; t += 100) {
      manager.audio(
        { conversationId: id, seq: seq++, audio: toBase64(tonePcm([[100, amp]])) },
        ctx,
      );
    }
  };
  const of = <E extends VoiceConversationEvent["event"]>(name: E) =>
    events
      .filter(([, e]) => e.event === name)
      .map(([, e]) => e.payload as Extract<VoiceConversationEvent, { event: E }>["payload"]);
  const phases = () => of("voice.conversation.state").map((s) => s.phase);
  /** Like `feed`, but lets the transcriber catch up after each chunk, as real-time audio does. */
  const feedLive = async (amp: number, ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      feed(amp, 100);
      await flush(5);
    }
  };
  return { stt, voice, turns, events, manager, ctx, feed, feedLive, of, phases };
}

/** Speak a turn hands-free: silence, speech, then a pause that ends it. */
async function sayTurn(t: ReturnType<typeof setup>) {
  t.feed(0, 300);
  t.feed(0.3, 800);
  t.feed(0, 700);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("voice conversation: hands-free turn and spoken reply", () => {
  it("transcribes a turn, sends it as a voice turn, speaks the lead sentence by sentence and listens again", async () => {
    const t = setup(["what's on my calendar today"]);
    const r = await t.manager.start({ mode: "handsfree", format: PCM_16K_MONO }, t.ctx);
    expect(validateResult("voice.conversation.start", r)).toEqual({
      conversationId: "vc_1",
      engine: "mac-node",
      location: "node",
    });
    expect(t.of("voice.conversation.state")[0]).toEqual({
      conversationId: "vc_1",
      phase: "listening",
      listening: true,
    });

    await sayTurn(t);
    expect(t.stt.options[0]?.vocabulary).toEqual(["Wren", "Alice Chen"]);
    expect(t.turns.sends).toHaveLength(1);
    expect(t.turns.sends[0]).toMatchObject({
      threadId: null,
      deviceId: "dev_mac",
      text: "what's on my calendar today",
      voice: { speak: "brief", narrate: "brief" },
    });
    const captions = t.of("voice.conversation.caption");
    expect(captions.filter((c) => c.role === "owner" && !c.final).length).toBeGreaterThan(0);
    expect(captions.at(-1)).toMatchObject({
      role: "owner",
      text: "what's on my calendar today",
      final: true,
    });
    expect(t.phases().slice(-2)).toEqual(["heard", "thinking"]);

    // The model streams; the first sentence is spoken before the answer is complete.
    t.turns.emit({ type: "delta", text: "You have two meetings today, both in the morning. " });
    await flush();
    expect(t.voice.said).toEqual(["You have two meetings today, both in the morning."]);
    expect(t.phases().at(-1)).toBe("speaking");
    t.turns.emit({ type: "delta", text: "The first is at nine with Alice.\n\n| time | what |\n" });
    t.turns.emit({ type: "delta", text: "```\ncode()\n```\nMore details follow here.\n" });
    t.turns.emit({ type: "done", status: "done" });
    t.turns.close();
    await flush();
    expect(t.voice.said).toEqual([
      "You have two meetings today, both in the morning.",
      "The first is at nine with Alice.",
      "The rest is on screen.",
    ]);

    // Every speech event is valid, ordered per utterance, and the last chunk is flagged.
    const speech = t.of("voice.conversation.speech");
    for (const s of speech) validateEventPayload("voice.conversation.speech", s);
    const ids = [...new Set(speech.map((s) => s.utteranceId))];
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      const mine = speech.filter((s) => s.utteranceId === id);
      expect(mine.map((s) => s.seq)).toEqual([0, 1]);
      expect(mine.map((s) => s.last)).toEqual([false, true]);
    }
    for (const e of t.events) expect(e[0]).toBe("dev_mac");

    // Listening again waits until every utterance played, plus the echo hold.
    for (const id of ids.slice(0, 2)) {
      t.manager.played(
        { conversationId: "vc_1", utteranceId: id, playedMs: 200, done: true },
        t.ctx,
      );
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.phases().at(-1)).toBe("speaking");
    t.manager.played(
      { conversationId: "vc_1", utteranceId: ids[2] as string, playedMs: 200, done: true },
      t.ctx,
    );
    await vi.advanceTimersByTimeAsync(599);
    expect(t.phases().at(-1)).toBe("speaking");
    await vi.advanceTimersByTimeAsync(1);
    expect(t.of("voice.conversation.state").at(-1)).toMatchObject({
      phase: "listening",
      listening: true,
    });
  });

  it("waits longer after an unfinished phrase, and ignores a cough", async () => {
    const t = setup(["remind me to call Alice and", "uh"]);
    await t.manager.start({ mode: "handsfree", format: PCM_16K_MONO }, t.ctx);
    await t.feedLive(0, 300);
    await t.feedLive(0.3, 800);
    await t.feedLive(0, 700); // 600 ms pause reached, but the phrase ends in "and"
    await flush();
    expect(t.turns.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(599);
    await flush();
    expect(t.turns.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(t.turns.sends[0]?.text).toBe("remind me to call Alice and");
    t.turns.emit({ type: "done", status: "done" });
    t.turns.close();
    await flush();
    await vi.advanceTimersByTimeAsync(600);

    // A 200 ms sound is not a turn.
    t.feed(0.3, 200);
    t.feed(0, 700);
    await flush();
    expect(t.turns.sends).toHaveLength(1);
    expect(t.of("voice.conversation.state").at(-1)).toMatchObject({
      phase: "listening",
      reason: "no_speech",
      listening: true,
    });
  });

  it("goes back to listening when the run fails or synthesis breaks, and shows waiting during an approval", async () => {
    const t = setup(["send the report to Alice", "and again"]);
    await t.manager.start({ mode: "handsfree", format: PCM_16K_MONO }, t.ctx);
    await sayTurn(t);
    t.turns.emit({
      type: "step",
      toolCallId: "tc_1",
      label: "Drafting an email",
      status: "running",
    });
    t.turns.emit({ type: "waiting", reason: "approval", approvalId: "apr_1" });
    await flush();
    expect(t.of("voice.conversation.step")).toEqual([
      { conversationId: "vc_1", toolCallId: "tc_1", label: "Drafting an email", status: "running" },
    ]);
    expect(t.of("voice.conversation.state").at(-1)).toMatchObject({
      phase: "waiting",
      reason: "approval",
      approvalId: "apr_1",
      listening: false,
    });
    t.turns.emit({ type: "resumed" });
    await flush();
    expect(t.phases().at(-1)).toBe("thinking");
    t.turns.fail(new Error("provider down"));
    await flush();
    await vi.advanceTimersByTimeAsync(600);
    expect(t.of("voice.conversation.state").at(-1)).toMatchObject({
      phase: "listening",
      listening: true,
    });
    expect(t.of("voice.conversation.ended")).toEqual([]);
  });
});

describe("voice conversation: barge-in", () => {
  async function speaking(texts: string[], mode: "handsfree" | "push" = "handsfree") {
    const t = setup(texts);
    await t.manager.start({ mode, format: PCM_16K_MONO }, t.ctx);
    if (mode === "push") {
      t.manager.turn({ conversationId: "vc_1", action: "begin" }, t.ctx);
      t.feed(0.3, 500);
      t.manager.turn({ conversationId: "vc_1", action: "end" }, t.ctx);
      await flush();
    } else await sayTurn(t);
    t.turns.emit({ type: "delta", text: "You have two meetings today, both in the morning. " });
    await flush();
    expect(t.phases().at(-1)).toBe("speaking");
    return t;
  }

  it("confirms a suspect with a new word, stops speaking and takes the owner's turn", async () => {
    const t = await speaking(["what's next", "stop that"]);
    t.manager.interrupt({ conversationId: "vc_1", stage: "suspect", playedMs: 300 }, t.ctx);
    t.feed(0.4, 100);
    await flush();
    expect(t.of("voice.conversation.state").at(-1)).toMatchObject({
      phase: "listening",
      reason: "barge_in",
      listening: true,
    });
    // The interrupted sentence's caption is closed; nothing more is synthesized.
    expect(t.of("voice.conversation.caption").some((c) => c.role === "agent" && c.final)).toBe(
      true,
    );
    const said = t.voice.said.length;
    t.turns.emit({ type: "delta", text: "The first is at nine with Alice, then lunch. " });
    await flush();
    expect(t.voice.said).toHaveLength(said);
    // The owner's turn continues and ends on a pause.
    t.feed(0.4, 400);
    t.feed(0, 700);
    await flush();
    expect(t.turns.sends.map((s) => s.text)).toEqual(["what's next", "stop that"]);
  });

  it("releases a suspect with no new word and keeps speaking", async () => {
    const t = await speaking(["what's next", "you have"]);
    t.manager.interrupt({ conversationId: "vc_1", stage: "suspect" }, t.ctx);
    t.feed(0.05, 200);
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(t.phases().at(-1)).toBe("speaking");
    t.turns.emit({ type: "delta", text: "The first is at nine with Alice, then lunch. " });
    await flush();
    expect(t.voice.said.at(-1)).toBe("The first is at nine with Alice, then lunch.");
  });

  it("stops at once on a confirmed interrupt (push-to-talk key)", async () => {
    const t = await speaking(["what's next", "cancel it"], "push");
    expect(t.of("voice.conversation.state")[0]).toMatchObject({ listening: false });
    t.manager.interrupt({ conversationId: "vc_1", stage: "confirmed" }, t.ctx);
    expect(t.of("voice.conversation.state").at(-1)).toMatchObject({
      phase: "listening",
      reason: "barge_in",
    });
    t.manager.turn({ conversationId: "vc_1", action: "begin" }, t.ctx);
    t.feed(0.3, 300);
    t.manager.turn({ conversationId: "vc_1", action: "end" }, t.ctx);
    await flush();
    expect(t.turns.sends.map((s) => s.text)).toEqual(["what's next", "cancel it"]);
  });
});

describe("voice conversation: push-to-talk, endings and ownership", () => {
  it("transcribes only between key down and key up, even a short phrase", async () => {
    const t = setup(["yes"]);
    await t.manager.start({ mode: "push", format: PCM_16K_MONO }, t.ctx);
    t.feed(0.3, 800);
    t.feed(0, 800);
    await flush();
    expect(t.stt.options).toHaveLength(0);
    t.manager.turn({ conversationId: "vc_1", action: "begin" }, t.ctx);
    expect(t.of("voice.conversation.state").at(-1)).toMatchObject({
      phase: "listening",
      listening: true,
    });
    t.feed(0.3, 200);
    t.manager.turn({ conversationId: "vc_1", action: "end" }, t.ctx);
    await flush();
    expect(t.turns.sends.map((s) => s.text)).toEqual(["yes"]);
  });

  it("ends hands-free after 30 s without speech, and on lock, stop or a new start", async () => {
    const t = setup([]);
    await t.manager.start({ mode: "handsfree", format: PCM_16K_MONO }, t.ctx);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.of("voice.conversation.ended")).toEqual([{ conversationId: "vc_1", reason: "idle" }]);
    expect(t.of("voice.conversation.state").at(-1)).toMatchObject({
      phase: "ended",
      listening: false,
    });
    expect(t.manager.active).toBe(0);

    await t.manager.start({ mode: "tap", format: PCM_16K_MONO }, t.ctx);
    await t.manager.start({ mode: "tap", format: PCM_16K_MONO }, t.ctx);
    expect(t.of("voice.conversation.ended").at(-1)).toEqual({
      conversationId: "vc_2",
      reason: "stopped",
    });
    t.manager.endForDevice("dev_mac", "locked");
    expect(t.of("voice.conversation.ended").at(-1)).toEqual({
      conversationId: "vc_3",
      reason: "locked",
    });
    expect(() => t.manager.stop({ conversationId: "vc_3" }, t.ctx)).toThrow(
      /no voice conversation/,
    );
  });

  it("refuses another device's id, out-of-order audio and a client-only engine", async () => {
    const t = setup([]);
    await t.manager.start({ mode: "tap", format: PCM_16K_MONO }, t.ctx);
    const other = { deviceId: "dev_phone", caller: "web" as const };
    expect(() => t.manager.stop({ conversationId: "vc_1" }, other)).toThrow(
      /no voice conversation/,
    );
    expect(() =>
      t.manager.audio(
        { conversationId: "vc_1", seq: 5, audio: toBase64(new Uint8Array(320)) },
        t.ctx,
      ),
    ).toThrow(/expected chunk 0/);
    await expect(
      t.manager.start(
        { mode: "tap", format: { encoding: "opus", sampleRate: 48_000, channels: 1 } },
        t.ctx,
      ),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const web = new SpeechEngineSelector({
      stt: { order: ["web-speech"] },
      tts: { order: [] },
    }).register({
      id: "web-speech",
      location: "client",
      supports: { transcribe: true, stream: true, synthesize: false },
      available: async () => true,
    });
    const m = new VoiceConversationManager({
      selector: web,
      tts: new FakeVoice().engine(),
      turns: scriptedTurns().port,
      emit: () => {},
    });
    await expect(m.start({ mode: "tap", format: PCM_16K_MONO }, other)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("serves the methods through the speech handlers, unavailable without a manager", async () => {
    const t = setup(["hello"]);
    const voice = new VoiceSessionManager({
      selector: new SpeechEngineSelector({ stt: { order: [] }, tts: { order: [] } }),
      emit: () => {},
    });
    const h = createSpeechHandlers({ voice, conversations: t.manager });
    const r = await h["voice.conversation.start"]({ mode: "push", format: PCM_16K_MONO }, t.ctx);
    expect(r.conversationId).toBe("vc_1");
    expect(
      await h["voice.conversation.turn"]({ conversationId: "vc_1", action: "begin" }, t.ctx),
    ).toEqual({});
    expect(
      validateResult(
        "voice.conversation.stop",
        await h["voice.conversation.stop"]({ conversationId: "vc_1" }, t.ctx),
      ),
    ).toEqual({ ok: true });
    const bare = createSpeechHandlers({ voice });
    await expect(
      bare["voice.conversation.start"]({ mode: "push", format: PCM_16K_MONO }, t.ctx),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("what is spoken", () => {
  it("speaks the brief lead only, skipping code, tables and raw links", () => {
    const s = new SpokenText({ speak: "brief" });
    const out = [
      ...s.push("Here is the link https://example.com/x for you. And a second sentence follows."),
      ...s.push("\n\n```js\nconsole.log(1)\n```\n| a | b |\nMore text here."),
      ...s.finish(),
    ];
    expect(out).toEqual([
      "Here is the link link for you.",
      "And a second sentence follows.",
      "The rest is on screen.",
    ]);
  });

  it("speaks everything in full mode up to the cap, and says nothing extra when all was spoken", () => {
    const full = new SpokenText({ speak: "full" });
    const out = [
      ...full.push("First paragraph is here.\n\nSecond paragraph ends it."),
      ...full.finish(),
    ];
    expect(out).toEqual(["First paragraph is here.", "Second paragraph ends it."]);
    const capped = new SpokenText({ speak: "full" });
    const long = `${"word ".repeat(30).trim()}. `.repeat(20);
    const said = [...capped.push(long), ...capped.finish()];
    expect(said.at(-1)).toBe("The rest is on screen.");
    expect(said.slice(0, -1).join(" ").length).toBeLessThanOrEqual(2_000);
  });

  it("caps the brief lead at about 60 words", () => {
    const s = new SpokenText({ speak: "brief" });
    const sentence = `${"word ".repeat(25).trim()}. `;
    const out = [...s.push(sentence.repeat(4)), ...s.finish()];
    expect(out).toHaveLength(3);
    expect(out.at(-1)).toBe("The rest is on screen.");
  });
});

describe("conversation VAD", () => {
  it("starts on sustained speech, ends after the pause and counts speech", () => {
    const events: string[] = [];
    const vad = new PcmVad((e) => events.push(e), { endMs: 600 });
    vad.push(tonePcm([[300, 0]]), PCM_16K_MONO);
    vad.push(tonePcm([[60, 0.3]]), PCM_16K_MONO);
    vad.push(tonePcm([[300, 0]]), PCM_16K_MONO);
    expect(events).toEqual([]);
    vad.push(tonePcm([[500, 0.3]]), PCM_16K_MONO);
    expect(events).toEqual(["start"]);
    expect(vad.speechMs).toBeGreaterThanOrEqual(450);
    vad.push(tonePcm([[400, 0]]), PCM_16K_MONO);
    expect(events).toEqual(["start"]);
    vad.push(tonePcm([[300, 0]]), PCM_16K_MONO);
    expect(events).toEqual(["start", "end"]);
  });
});
