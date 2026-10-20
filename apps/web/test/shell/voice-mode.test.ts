import type { Message } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { BARGE_IN_PROFILE, EnergyVad, LISTEN_PROFILE, SharedMic } from "../../src/shell/vad.ts";
import { type AudioSource, pcmChunkToBase64 } from "../../src/shell/voice.ts";
import {
  BrowserSpeaker,
  GatewaySpeaker,
  type PcmPlayer,
  type ReplySpeaker,
  speakableText,
  type Utterance,
  VoiceMode,
  type VoiceModePhase,
  type VoiceModeSettings,
  voiceModeLabel,
  voiceModeSettings,
} from "../../src/shell/voice-mode.ts";

const RATE = 16_000;

/** 100 ms of a 220 Hz tone at `amp` (0 = silence with a faint noise floor). */
function frames(amp: number, ms = 100): Float32Array {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const noise = ((i * 7919) % 13) / 13 - 0.5;
    out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / RATE) + noise * 0.002;
  }
  return out;
}

/** A microphone the test feeds by hand. */
function fakeMic() {
  let sink: ((f: Float32Array, rate: number) => void) | undefined;
  let opened = 0;
  let closed = 0;
  const source: AudioSource = {
    async start(onFrames) {
      opened++;
      sink = onFrames;
      return () => {
        closed++;
        sink = undefined;
      };
    },
  };
  return {
    source,
    /** Feeds `ms` of audio at `amp` in 100 ms buffers. */
    feed(amp: number, ms: number) {
      for (let t = 0; t < ms; t += 100) sink?.(frames(amp), RATE);
    },
    get open() {
      return sink !== undefined;
    },
    counts: () => ({ opened, closed }),
  };
}

const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A Gateway that answers voice.*, chat.send and read-aloud; every call is recorded. */
function fakeGateway(transcripts: string[]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let sessions = 0;
  const call = async (method: string, params: unknown) => {
    calls.push({ method, params: params as Record<string, unknown> });
    switch (method) {
      case "voice.start":
        return { sessionId: `vs_${++sessions}`, location: "gateway", engine: "mac-node" };
      case "voice.push":
        return {};
      case "voice.stop":
        return { transcript: { text: transcripts.shift() ?? "", segments: [] } };
      case "voice.cancel":
        return { ok: true };
      case "chat.send":
        return { messageId: `msg_u${calls.length}`, queued: false };
      case "speech.readAloud":
        return { streamId: "ra_1" };
      case "speech.readAloud.cancel":
        return { ok: true };
      default:
        throw Object.assign(new Error(method), { code: "unknown_method" });
    }
  };
  return { call, calls, methods: () => calls.map((c) => c.method) };
}

/** A speaker the test finishes by hand. */
function fakeSpeaker() {
  const spoken: string[] = [];
  let finish: (() => void) | undefined;
  let stops = 0;
  const speaker: ReplySpeaker = {
    speak(m): Utterance {
      spoken.push(m.id);
      const done = new Promise<void>((r) => {
        finish = r;
      });
      return {
        done,
        stop: () => {
          stops++;
          finish?.();
        },
      };
    },
  };
  return { speaker, spoken, finish: () => finish?.(), stops: () => stops };
}

function agentMessage(id: string, text: string): Message {
  return {
    id,
    threadId: "thr_1",
    seq: 2,
    role: "agent",
    blocks: [{ type: "text", md: text }],
    providerNative: null,
    provenance: "agent",
    replyToMessageId: null,
    channelRef: null,
    runId: "run_1",
    createdAt: "2026-10-20T10:00:00.000Z",
  };
}

const run = (status: string) => ({ run: { id: "run_1", threadId: "thr_1", status } });

function setup(settings: Partial<VoiceModeSettings> = {}, transcripts = ["what's on my calendar"]) {
  const mic = fakeMic();
  const gw = fakeGateway(transcripts);
  const sp = fakeSpeaker();
  const states: VoiceModePhase[] = [];
  const vm = new VoiceMode({
    call: gw.call,
    source: mic.source,
    speaker: sp.speaker,
    settings: { enabled: true, start: "toggle", reply: "gateway", bargeIn: true, ...settings },
    onState: (s) => states.push(s),
  });
  return { vm, mic, gw, sp, states, phase: () => vm.getState().phase };
}

describe("voice mode settings (off by default)", () => {
  it("defaults to off, hands-free, Gateway voice, barge-in on", () => {
    expect(voiceModeSettings({})).toEqual({
      enabled: false,
      start: "toggle",
      reply: "gateway",
      bargeIn: true,
    });
    expect(
      voiceModeSettings({
        "voice.conversation.enabled": true,
        "voice.conversation.start": "push",
        "voice.conversation.reply": "browser",
        "voice.conversation.bargeIn": false,
      }),
    ).toEqual({ enabled: true, start: "push", reply: "browser", bargeIn: false });
    // Only a real `true` turns it on.
    expect(voiceModeSettings({ "voice.conversation.enabled": "yes" }).enabled).toBe(false);
  });

  it("does nothing when voice mode is off", async () => {
    const { vm, mic, gw, phase } = setup({ enabled: false });
    await vm.start("thr_1");
    expect(phase()).toBe("off");
    expect(mic.counts().opened).toBe(0);
    expect(gw.calls).toEqual([]);
  });

  it("labels each state for the pill", () => {
    expect(voiceModeLabel({ phase: "listening", partial: "" })).toBe("Listening");
    expect(voiceModeLabel({ phase: "thinking", said: "x" })).toBe("Thinking");
    expect(voiceModeLabel({ phase: "speaking", messageId: "m" })).toBe("Speaking");
    expect(voiceModeLabel({ phase: "waiting", reason: "approval" })).toBe(
      "Needs your approval on screen",
    );
  });
});

describe("hands-free loop (toggle)", () => {
  it("listens, sends the utterance after a pause, speaks the reply, then listens again", async () => {
    const { vm, mic, gw, sp, phase } = setup();
    await vm.start("thr_1");
    await tick();
    expect(phase()).toBe("listening");
    expect(gw.methods()).toEqual(["voice.start"]);

    mic.feed(0, 300);
    mic.feed(0.3, 800); // speech
    mic.feed(0, 1_000); // a pause ends the utterance
    await tick();
    expect(gw.methods()).toContain("voice.push");
    expect(gw.methods().filter((m) => m === "voice.stop")).toHaveLength(1);
    const send = gw.calls.find((c) => c.method === "chat.send");
    expect(send?.params).toEqual({ threadId: "thr_1", content: "what's on my calendar" });
    expect(phase()).toBe("thinking");

    vm.onEvent("run.updated", run("running"));
    vm.onEvent("chat.message", { message: agentMessage("msg_a1", "You have **two** meetings.") });
    vm.onEvent("run.updated", run("done"));
    expect(phase()).toBe("speaking");
    expect(sp.spoken).toEqual(["msg_a1"]);

    sp.finish();
    await tick();
    expect(phase()).toBe("listening");
    expect(gw.methods().filter((m) => m === "voice.start")).toHaveLength(2);

    vm.stop();
    expect(phase()).toBe("off");
    expect(mic.open).toBe(false);
    expect(gw.methods().at(-1)).toBe("voice.cancel");
  });

  it("keeps listening when nothing was recognised, and ignores other threads' runs", async () => {
    const { vm, mic, gw, phase } = setup({}, ["", "hello"]);
    await vm.start("thr_1");
    await tick();
    mic.feed(0.3, 500);
    mic.feed(0, 1_000);
    await tick();
    expect(gw.methods()).not.toContain("chat.send");
    expect(phase()).toBe("listening");
    expect(gw.methods().filter((m) => m === "voice.start")).toHaveLength(2);
    mic.feed(0.3, 500);
    mic.feed(0, 1_000);
    await tick();
    expect(phase()).toBe("thinking");
    vm.onEvent("chat.message", { message: { ...agentMessage("m_other", "x"), threadId: "thr_9" } });
    vm.onEvent("run.updated", { run: { id: "r9", threadId: "thr_9", status: "done" } });
    expect(phase()).toBe("thinking");
    vm.stop();
  });

  it("goes back to listening when a run ends without a spoken reply", async () => {
    const { vm, mic, phase, sp } = setup();
    await vm.start("thr_1");
    await tick();
    mic.feed(0.3, 500);
    mic.feed(0, 1_000);
    await tick();
    vm.onEvent("run.updated", run("failed"));
    await tick();
    expect(phase()).toBe("listening");
    expect(sp.spoken).toEqual([]);
    vm.stop();
  });
});

describe("barge-in", () => {
  async function speaking(settings: Partial<VoiceModeSettings> = {}) {
    const t = setup(settings);
    await t.vm.start("thr_1");
    await tick();
    t.mic.feed(0.3, 500);
    t.mic.feed(0, 1_000);
    await tick();
    t.vm.onEvent("chat.message", { message: agentMessage("msg_a1", "Here is a long answer.") });
    t.vm.onEvent("run.updated", run("done"));
    expect(t.phase()).toBe("speaking");
    return t;
  }

  it("stops the reply when the owner talks over it and transcribes what they said", async () => {
    const { vm, mic, gw, sp, phase } = await speaking();
    const pushesBefore = gw.methods().filter((m) => m === "voice.push").length;
    // The reply's quiet echo does not count; the owner's voice does.
    mic.feed(0.02, 500);
    expect(phase()).toBe("speaking");
    mic.feed(0.4, 400);
    await tick();
    expect(sp.stops()).toBe(1);
    expect(phase()).toBe("listening");
    // A fresh dictation session, fed the pre-roll that triggered barge-in.
    expect(gw.methods().filter((m) => m === "voice.start")).toHaveLength(2);
    mic.feed(0.4, 100);
    await tick();
    const pushes = gw.calls.filter((c) => c.method === "voice.push").slice(pushesBefore);
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes[0]?.params.sessionId).toBe("vs_2");
    vm.stop();
  });

  it("lets the reply finish when barge-in is off", async () => {
    const { vm, mic, sp, phase } = await speaking({ bargeIn: false });
    mic.feed(0.4, 800);
    await tick();
    expect(sp.stops()).toBe(0);
    expect(phase()).toBe("speaking");
    vm.stop();
    expect(sp.stops()).toBe(1);
  });
});

describe("approvals stay cards", () => {
  it("waits on screen during an approval, never answers it, and speaks the reply after", async () => {
    const { vm, mic, gw, sp, phase } = setup({}, ["yes approve it and send the email"]);
    await vm.start("thr_1");
    await tick();
    mic.feed(0.3, 500);
    mic.feed(0, 1_000);
    await tick();
    expect(phase()).toBe("thinking");

    vm.onEvent("run.updated", run("awaiting_approval"));
    expect(phase()).toBe("waiting");
    expect(voiceModeLabel(vm.getState())).toBe("Needs your approval on screen");
    // Talking now is not transcribed and cannot approve anything.
    const startsBefore = gw.methods().filter((m) => m === "voice.start").length;
    mic.feed(0.4, 800);
    mic.feed(0, 1_000);
    await tick();
    expect(gw.methods().filter((m) => m === "voice.start")).toHaveLength(startsBefore);
    expect(gw.methods().some((m) => m.startsWith("approvals."))).toBe(false);

    // The owner answered the card in the UI; the run continues and the reply is spoken.
    vm.onEvent("run.updated", run("running"));
    expect(phase()).toBe("thinking");
    vm.onEvent("chat.message", { message: agentMessage("msg_a2", "Sent.") });
    vm.onEvent("run.updated", run("done"));
    expect(sp.spoken).toEqual(["msg_a2"]);
    // The spoken "yes approve it" went out only as an ordinary message.
    expect(gw.calls.filter((c) => c.method === "chat.send").map((c) => c.params.content)).toEqual([
      "yes approve it and send the email",
    ]);
    expect(gw.methods().some((m) => m.startsWith("approvals."))).toBe(false);
    vm.stop();
  });

  it("waits the same way for an ask_user question", async () => {
    const { vm, mic, phase } = setup();
    await vm.start("thr_1");
    await tick();
    mic.feed(0.3, 500);
    mic.feed(0, 1_000);
    await tick();
    vm.onEvent("run.updated", run("awaiting_input"));
    expect(vm.getState()).toEqual({ phase: "waiting", reason: "question" });
    expect(phase()).toBe("waiting");
    vm.stop();
  });
});

describe("push-to-talk", () => {
  it("transcribes only while held; a pause does not end the turn", async () => {
    const { vm, mic, gw, sp, phase } = setup({ start: "push" });
    await vm.start("thr_1");
    await tick();
    expect(phase()).toBe("ready");
    mic.feed(0.4, 500);
    await tick();
    expect(gw.methods()).toEqual([]);

    vm.pushStart();
    await tick();
    expect(phase()).toBe("listening");
    mic.feed(0.3, 500);
    mic.feed(0, 1_500); // a long pause while held
    await tick();
    expect(gw.methods()).not.toContain("voice.stop");
    vm.pushEnd();
    await tick();
    expect(gw.methods()).toContain("chat.send");

    vm.onEvent("chat.message", { message: agentMessage("msg_a1", "Okay.") });
    vm.onEvent("run.updated", run("done"));
    expect(phase()).toBe("speaking");
    // Pressing again talks over the reply.
    vm.pushStart();
    await tick();
    expect(sp.stops()).toBe(1);
    expect(phase()).toBe("listening");
    vm.stop();
  });
});

describe("Gateway speaker", () => {
  function fakePlayer() {
    const played: number[] = [];
    let stopped = 0;
    let release: (() => void) | undefined;
    const player: PcmPlayer = {
      enqueue: (pcm) => played.push(pcm.length),
      drained: () => new Promise((r) => (release = r)),
      stop: () => {
        stopped++;
      },
    };
    return { player, played, stopped: () => stopped, drain: () => release?.() };
  }

  const audio = (seq: number, last: boolean, samples = 1_600) => ({
    streamId: "ra_1",
    seq,
    audio: pcmChunkToBase64(new Int16Array(samples).fill(1_000)),
    format: { encoding: "pcm_s16le", sampleRate: 22_050, channels: 1 },
    last,
  });

  it("reads the reply without saving it and plays the stream to its end", async () => {
    const gw = fakeGateway([]);
    const p = fakePlayer();
    const speaker = new GatewaySpeaker(gw.call, () => p.player);
    const u = speaker.speak(agentMessage("msg_a1", "Hello there."));
    // Audio that raced the method's answer is kept and played.
    speaker.onEvent("speech.audio", audio(0, false));
    await tick();
    expect(gw.calls).toEqual([
      { method: "speech.readAloud", params: { messageId: "msg_a1", save: false } },
    ]);
    speaker.onEvent("speech.audio", { ...audio(1, false), streamId: "ra_other" });
    speaker.onEvent("speech.audio", audio(1, true, 800));
    expect(p.played).toEqual([1_600, 800]);
    let done = false;
    void u.done.then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    p.drain();
    await tick();
    expect(done).toBe(true);
  });

  it("cancels the Gateway stream and silences playback on stop", async () => {
    const gw = fakeGateway([]);
    const p = fakePlayer();
    const speaker = new GatewaySpeaker(gw.call, () => p.player);
    const u = speaker.speak(agentMessage("msg_a1", "Hello there."));
    await tick();
    speaker.onEvent("speech.audio", audio(0, false));
    u.stop();
    await u.done;
    await tick();
    expect(p.stopped()).toBe(1);
    expect(gw.calls.at(-1)).toEqual({
      method: "speech.readAloud.cancel",
      params: { streamId: "ra_1" },
    });
    // Late audio for the stopped stream is ignored.
    speaker.onEvent("speech.audio", audio(1, true));
    expect(p.played).toEqual([1_600]);
  });

  it("finishes when the Gateway reports the read-aloud failed", async () => {
    const gw = fakeGateway([]);
    const speaker = new GatewaySpeaker(gw.call, () => fakePlayer().player);
    const u = speaker.speak(agentMessage("msg_a1", "Hello."));
    await tick();
    speaker.onEvent("speech.readAloud.failed", {
      streamId: "ra_1",
      messageId: "msg_a1",
      error: { code: "unavailable", message: "no voice" },
    });
    await expect(u.done).resolves.toBeUndefined();
  });
});

describe("browser speaker", () => {
  it("speaks the reply's plain text with speechSynthesis and cancels on stop", async () => {
    const spoken: string[] = [];
    let cancels = 0;
    let last: { onend: (() => void) | null } | undefined;
    const speaker = new BrowserSpeaker(
      {
        speak: (u) => {
          spoken.push(u.text);
          last = u;
        },
        cancel: () => {
          cancels++;
        },
      },
      (text) => ({ text, onend: null, onerror: null }),
    );
    const u = speaker.speak(agentMessage("m", "See [the doc](https://example.com/x) and `code`."));
    expect(spoken).toEqual(["See the doc and code."]);
    last?.onend?.();
    await u.done;
    const u2 = speaker.speak(agentMessage("m2", "Second."));
    u2.stop();
    await u2.done;
    expect(cancels).toBe(3);
  });

  it("flattens Markdown and the wrap-up recap for speaking", () => {
    const m = agentMessage("m", "# Plan\n- **one**\n- two\n```js\nx()\n```");
    m.blocks.push({ type: "wrap_up", recap: "Done for now." });
    expect(speakableText(m)).toBe("Plan - one - two Done for now.");
  });
});

describe("energy detector and shared microphone", () => {
  it("starts on sustained speech and ends after a pause", () => {
    const events: string[] = [];
    const vad = new EnergyVad((e) => events.push(e), LISTEN_PROFILE);
    for (let i = 0; i < 5; i++) vad.push(frames(0), RATE);
    vad.push(frames(0.3, 60), RATE); // too short
    for (let i = 0; i < 5; i++) vad.push(frames(0), RATE);
    expect(events).toEqual([]);
    for (let i = 0; i < 5; i++) vad.push(frames(0.3), RATE);
    expect(events).toEqual(["start"]);
    for (let i = 0; i < 5; i++) vad.push(frames(0), RATE);
    expect(events).toEqual(["start"]);
    for (let i = 0; i < 6; i++) vad.push(frames(0), RATE);
    expect(events).toEqual(["start", "end"]);
    // The barge-in profile ignores a quieter voice.
    vad.setProfile(BARGE_IN_PROFILE);
    for (let i = 0; i < 10; i++) vad.push(frames(0.02), RATE);
    expect(events).toEqual(["start", "end"]);
  });

  it("replays the last 600 ms to a new tap, then streams live frames", async () => {
    const mic = fakeMic();
    const shared = new SharedMic(mic.source, 600);
    let total = 0;
    await shared.start(() => {});
    mic.feed(0.1, 1_000);
    const tap = shared.tap();
    const stop = await tap.start((f) => (total += f.length));
    expect(total).toBe(RATE * 0.6);
    mic.feed(0.1, 200);
    expect(total).toBe(RATE * 0.8);
    stop();
    mic.feed(0.1, 200);
    expect(total).toBe(RATE * 0.8);
    shared.clearPreroll();
    let replayed = 0;
    await shared.tap().start((f) => (replayed += f.length));
    expect(replayed).toBe(0);
    shared.stop();
    expect(mic.open).toBe(false);
  });
});
