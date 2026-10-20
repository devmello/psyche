import type { Message } from "@psyche/protocol";
import { t } from "@psyche/ui";
import { BARGE_IN_PROFILE, EnergyVad, LISTEN_PROFILE, SharedMic } from "./vad.ts";
import {
  type AudioSource,
  type LocalDictation,
  type VoiceCall,
  VoiceCapture,
  type VoiceSegment,
  type VoiceState,
} from "./voice.ts";

/**
 * Voice mode (feature Q5: "continuous spoken conversation with barge-in", "hands-free
 * conversation on the Mac"). Off by default behind Settings → Voice & dictation → Voice mode.
 *
 * One loop per thread, driven entirely by existing Gateway methods:
 *
 *   listening  a dictation session (`voice.*`) on the shared microphone; in hands-free mode a
 *              0.9 s pause ends the utterance, in push-to-talk mode releasing the button does
 *   thinking   the transcript went out with `chat.send` as the owner's message; the run works
 *   speaking   the agent's reply is read with the system voice: `speech.readAloud {save: false}`
 *              on the Gateway (the Mac helper's AVSpeechSynthesizer) or the browser's
 *              `speechSynthesis`; talking over it stops it at once (barge-in) and listens again
 *   waiting    the run needs an approval or an answer: the card is on screen, the microphone is
 *              not transcribing, and nothing here can answer it
 *
 * Approvals are never answered by voice: this controller only calls `voice.*`, `chat.send` and
 * `speech.readAloud*`; a spoken "yes, approve it" is an ordinary owner message, and the Gateway
 * never treats chat text as an approval (security §3.7).
 */

export type VoiceModeStart = "toggle" | "push";
export type VoiceModeReply = "gateway" | "browser";

export interface VoiceModeSettings {
  enabled: boolean;
  /** `toggle`: hands-free, a pause ends each turn. `push`: hold to talk for each turn. */
  start: VoiceModeStart;
  reply: VoiceModeReply;
  bargeIn: boolean;
}

export const VOICE_MODE_KEYS = {
  enabled: "voice.conversation.enabled",
  start: "voice.conversation.start",
  reply: "voice.conversation.reply",
  bargeIn: "voice.conversation.bargeIn",
} as const;

/** Settings → Voice mode, with every value defaulted; off unless the owner turned it on. */
export function voiceModeSettings(values: Record<string, unknown>): VoiceModeSettings {
  return {
    enabled: values[VOICE_MODE_KEYS.enabled] === true,
    start: values[VOICE_MODE_KEYS.start] === "push" ? "push" : "toggle",
    reply: values[VOICE_MODE_KEYS.reply] === "browser" ? "browser" : "gateway",
    bargeIn: values[VOICE_MODE_KEYS.bargeIn] !== false,
  };
}

export type VoiceModePhase =
  | { phase: "off" }
  | { phase: "starting" }
  /** Push-to-talk between turns: the microphone is open for barge-in, not transcribing. */
  | { phase: "ready" }
  | { phase: "listening"; partial: string }
  | { phase: "thinking"; said: string }
  | { phase: "speaking"; messageId: string }
  | { phase: "waiting"; reason: "approval" | "question" }
  | { phase: "error"; reason: string };

/** The short label the state pill shows ("listening / thinking / speaking"). */
export function voiceModeLabel(s: VoiceModePhase): string {
  switch (s.phase) {
    case "off":
      return t("web.voiceMode.off");
    case "starting":
      return t("web.voiceMode.starting");
    case "ready":
      return t("web.voiceMode.holdToTalk");
    case "listening":
      return t("web.voiceMode.listening");
    case "thinking":
      return t("web.voiceMode.thinking");
    case "speaking":
      return t("web.voiceMode.speaking");
    case "waiting":
      return s.reason === "approval"
        ? t("web.voiceMode.needsApproval")
        : t("web.voiceMode.needsAnswer");
    case "error":
      return s.reason;
  }
}

/** A reply being spoken; `done` settles when it finished or was stopped. */
export interface Utterance {
  done: Promise<void>;
  stop(): void;
}

export interface ReplySpeaker {
  speak(message: Message): Utterance;
  /** Gateway events (`speech.audio`, `speech.readAloud.failed`) for this device. */
  onEvent?(event: string, payload: unknown): void;
}

/** Plain text of an agent message for a speaker (text blocks and the wrap-up recap). */
export function speakableText(m: Message): string {
  return m.blocks
    .flatMap((b) => (b.type === "text" ? [b.md] : b.type === "wrap_up" ? [b.recap] : []))
    .join("\n\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/[*_~#>|]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Speakers -----------------------------------------------------------------------------------

/** Plays PCM chunks in order (Web Audio in the renderer, a fake in tests). */
export interface PcmPlayer {
  enqueue(pcm: Int16Array, sampleRate: number): void;
  /** Resolves once everything enqueued has played. */
  drained(): Promise<void>;
  stop(): void;
}

function decodeBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Little-endian PCM bytes → samples (`pcm_s16le` only; voice mode asks for nothing else). */
function toInt16(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/**
 * The reply read on the Gateway (`speech.readAloud {messageId, save: false}`): the Mac helper's
 * system voice (AVSpeechSynthesizer) or the persona's configured voice, streamed back as
 * `speech.audio` and played as it arrives. `stop()` cancels the stream on the Gateway.
 */
export class GatewaySpeaker implements ReplySpeaker {
  private readonly call: VoiceCall;
  private readonly player: () => PcmPlayer;
  private current:
    | { streamId: string | null; player: PcmPlayer; finish: () => void; ended: boolean }
    | undefined;
  private early: { event: string; payload: unknown }[] = [];

  constructor(call: VoiceCall, player: () => PcmPlayer) {
    this.call = call;
    this.player = player;
  }

  speak(message: Message): Utterance {
    this.stopCurrent();
    const player = this.player();
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cur = { streamId: null as string | null, player, finish, ended: false };
    this.current = cur;
    this.early = [];
    void this.call("speech.readAloud", { messageId: message.id, save: false }).then(
      (res) => {
        const id = (res as { streamId?: unknown } | undefined)?.streamId;
        if (this.current !== cur) {
          if (typeof id === "string")
            void this.call("speech.readAloud.cancel", { streamId: id }).catch(() => undefined);
          return;
        }
        if (typeof id !== "string") {
          this.end(cur);
          return;
        }
        cur.streamId = id;
        // Events that raced the method's answer.
        for (const e of this.early) this.onEvent(e.event, e.payload);
        this.early = [];
      },
      () => this.end(cur),
    );
    return {
      done,
      stop: () => {
        if (this.current === cur) this.stopCurrent();
      },
    };
  }

  onEvent(event: string, payload: unknown): void {
    const cur = this.current;
    if (!cur || cur.ended) return;
    const p = payload as {
      streamId?: string;
      audio?: string;
      format?: { encoding?: string; sampleRate?: number };
      last?: boolean;
    };
    if (cur.streamId === null) {
      if (event === "speech.audio" || event === "speech.readAloud.failed")
        this.early.push({ event, payload });
      return;
    }
    if (p?.streamId !== cur.streamId) return;
    if (event === "speech.readAloud.failed") {
      this.end(cur);
      return;
    }
    if (event !== "speech.audio" || typeof p.audio !== "string") return;
    if (p.format?.encoding === "pcm_s16le" && typeof p.format.sampleRate === "number") {
      cur.player.enqueue(toInt16(decodeBase64(p.audio)), p.format.sampleRate);
    }
    if (p.last === true) {
      cur.ended = true;
      void cur.player.drained().then(() => this.end(cur));
    }
  }

  private end(cur: NonNullable<GatewaySpeaker["current"]>): void {
    cur.ended = true;
    if (this.current === cur) this.current = undefined;
    cur.finish();
  }

  private stopCurrent(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = undefined;
    cur.ended = true;
    cur.player.stop();
    if (cur.streamId !== null)
      void this.call("speech.readAloud.cancel", { streamId: cur.streamId }).catch(() => undefined);
    cur.finish();
  }
}

/** The slice of `speechSynthesis` the browser speaker uses. */
export interface SpeechSynthesisLike {
  speak(u: SpeechSynthesisUtteranceLike): void;
  cancel(): void;
}

export interface SpeechSynthesisUtteranceLike {
  text: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

/**
 * The reply read by the browser's own voice (`speechSynthesis`): no Gateway round trip; on a Mac
 * it is the system voice too. Its sound is not echo-cancelled everywhere, so barge-in works best
 * with headphones.
 */
export class BrowserSpeaker implements ReplySpeaker {
  private readonly synth: SpeechSynthesisLike;
  private readonly make: (text: string) => SpeechSynthesisUtteranceLike;

  constructor(synth: SpeechSynthesisLike, make: (text: string) => SpeechSynthesisUtteranceLike) {
    this.synth = synth;
    this.make = make;
  }

  speak(message: Message): Utterance {
    const text = speakableText(message);
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (text === "") {
      finish();
      return { done, stop: () => {} };
    }
    const u = this.make(text);
    u.onend = () => finish();
    u.onerror = () => finish();
    this.synth.cancel();
    this.synth.speak(u);
    return {
      done,
      stop: () => {
        u.onend = null;
        u.onerror = null;
        this.synth.cancel();
        finish();
      },
    };
  }
}

/** `speechSynthesis` of this window, or undefined where there is none. */
export function browserSpeaker(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): BrowserSpeaker | undefined {
  const synth = scope.speechSynthesis as SpeechSynthesisLike | undefined;
  const Utt = scope.SpeechSynthesisUtterance as
    | (new (
        text: string,
      ) => SpeechSynthesisUtteranceLike)
    | undefined;
  if (!synth || typeof Utt !== "function") return undefined;
  return new BrowserSpeaker(synth, (text) => new Utt(text));
}

/** Web Audio player for the Gateway voice (renderer only). */
export function webAudioPlayer(): PcmPlayer {
  const Ctx = (globalThis as unknown as { AudioContext?: new () => AudioContext }).AudioContext;
  if (!Ctx) {
    return { enqueue: () => {}, drained: async () => {}, stop: () => {} };
  }
  const ctx = new Ctx();
  let at = 0;
  const sources = new Set<AudioBufferSourceNode>();
  let waiters: (() => void)[] = [];
  const settle = () => {
    if (sources.size > 0) return;
    for (const w of waiters) w();
    waiters = [];
  };
  return {
    enqueue(pcm, rate) {
      if (pcm.length === 0) return;
      const buf = ctx.createBuffer(1, pcm.length, rate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = (pcm[i] ?? 0) / 0x8000;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      at = Math.max(at, ctx.currentTime);
      src.start(at);
      at += buf.duration;
      sources.add(src);
      src.onended = () => {
        sources.delete(src);
        settle();
      };
    },
    drained: () =>
      sources.size === 0 ? Promise.resolve() : new Promise((r) => waiters.push(() => r())),
    stop() {
      for (const s of sources) {
        s.onended = null;
        try {
          s.stop();
        } catch {
          // already stopped
        }
      }
      sources.clear();
      settle();
      void ctx.close();
    },
  };
}

// --- The loop -----------------------------------------------------------------------------------

export interface VoiceModeOptions {
  call: VoiceCall;
  /** The microphone (getUserMedia in the renderer, synthetic frames in tests). */
  source: AudioSource;
  speaker: ReplySpeaker;
  settings: VoiceModeSettings;
  onState: (s: VoiceModePhase) => void;
  /** Browser dictation when the Gateway answers `location: "client"`. */
  local?: LocalDictation;
}

const RUN_DONE = new Set(["done", "failed", "cancelled"]);

export class VoiceMode {
  private state: VoiceModePhase = { phase: "off" };
  private threadId: string | null = null;
  private readonly opts: VoiceModeOptions;
  private readonly mic: SharedMic;
  private readonly vad: EnergyVad;
  private capture: VoiceCapture | undefined;
  private utterance: Utterance | undefined;
  private lastReply: Message | undefined;
  private awaitingReply = false;
  private finishing = false;
  /** Bumped on every turn change, so late async work from an earlier turn does nothing. */
  private turn = 0;

  constructor(opts: VoiceModeOptions) {
    this.opts = opts;
    this.mic = new SharedMic(opts.source);
    this.vad = new EnergyVad((e) => this.onVad(e), LISTEN_PROFILE);
  }

  getState(): VoiceModePhase {
    return this.state;
  }

  get active(): boolean {
    return this.state.phase !== "off";
  }

  /** The thread the running conversation belongs to, or null when voice mode is off. */
  get thread(): string | null {
    return this.threadId;
  }

  private set(s: VoiceModePhase): void {
    this.state = s;
    this.opts.onState(s);
  }

  /** Opens the microphone and starts the first turn. */
  async start(threadId: string): Promise<void> {
    if (!this.opts.settings.enabled || this.active) return;
    this.threadId = threadId;
    this.set({ phase: "starting" });
    try {
      await this.mic.start((frames, rate) => this.vad.push(frames, rate));
    } catch {
      this.set({ phase: "error", reason: t("web.voice.noMicrophone") });
      return;
    }
    if (this.state.phase !== "starting") return;
    if (this.opts.settings.start === "push") this.ready();
    else void this.listen();
  }

  /** Ends voice mode: the microphone closes, speech stops, any dictation is cancelled. */
  stop(): void {
    this.turn++;
    this.utterance?.stop();
    this.utterance = undefined;
    this.capture?.cancel();
    this.capture = undefined;
    this.mic.stop();
    this.vad.reset();
    this.awaitingReply = false;
    this.lastReply = undefined;
    this.threadId = null;
    if (this.state.phase !== "off") this.set({ phase: "off" });
  }

  /** Push-to-talk: the button went down (also stops a reply being spoken). */
  pushStart(): void {
    if (this.opts.settings.start !== "push") return;
    const p = this.state.phase;
    if (p === "speaking") this.interruptReply();
    if (p === "ready" || p === "speaking") void this.listen();
  }

  /** Push-to-talk: the button came up; the utterance goes out. */
  pushEnd(): void {
    if (this.opts.settings.start !== "push" || this.state.phase !== "listening") return;
    void this.finishUtterance();
  }

  /**
   * Gateway events for this device and thread: dictation segments, the agent's messages, run
   * status, and read-aloud audio for the Gateway speaker.
   */
  onEvent(event: string, payload: unknown): void {
    if (event === "voice.segment" || event === "voice.ended") {
      const p = payload as { sessionId?: string; segment?: VoiceSegment; reason?: string };
      if (typeof p?.sessionId !== "string") return;
      if (event === "voice.segment" && p.segment) this.capture?.onSegment(p.sessionId, p.segment);
      if (event === "voice.ended" && typeof p.reason === "string")
        this.capture?.onEnded(p.sessionId, p.reason);
      return;
    }
    if (event === "speech.audio" || event === "speech.readAloud.failed") {
      this.opts.speaker.onEvent?.(event, payload);
      return;
    }
    if (!this.active || this.threadId === null) return;
    if (event === "chat.message") {
      const m = (payload as { message?: Message })?.message;
      if (m?.threadId === this.threadId && m.role === "agent" && this.awaitingReply)
        this.lastReply = m;
      return;
    }
    if (event === "run.updated") {
      const run = (payload as { run?: { threadId?: string; status?: string } })?.run;
      if (run?.threadId !== this.threadId || !this.awaitingReply) return;
      const status = run.status ?? "";
      if (status === "awaiting_approval") this.set({ phase: "waiting", reason: "approval" });
      else if (status === "awaiting_input") this.set({ phase: "waiting", reason: "question" });
      else if (status === "running" && this.state.phase === "waiting")
        this.set({ phase: "thinking", said: "" });
      else if (RUN_DONE.has(status)) this.onRunDone();
    }
  }

  private ready(): void {
    this.vad.setProfile(BARGE_IN_PROFILE);
    this.set({ phase: "ready" });
  }

  private async listen(): Promise<void> {
    const threadId = this.threadId;
    if (threadId === null) return;
    const turn = ++this.turn;
    this.vad.setProfile(LISTEN_PROFILE);
    this.finishing = false;
    this.set({ phase: "listening", partial: "" });
    const capture = new VoiceCapture(
      this.opts.call,
      this.mic.tap(),
      (s) => this.onCapture(turn, s),
      {
        ...(this.opts.local ? { local: this.opts.local } : {}),
        // The Gateway ended the session itself: send what was heard, if anything.
        onInterrupted: (said) => {
          if (this.turn === turn) void this.send(said, turn);
        },
      },
    );
    this.capture = capture;
    await capture.start(threadId);
    // The pre-roll replayed into this session; the next turn starts fresh.
    this.mic.clearPreroll();
  }

  private onCapture(turn: number, s: VoiceState): void {
    if (this.turn !== turn) return;
    if (s.phase === "listening" && this.state.phase === "listening")
      this.set({ phase: "listening", partial: s.partial });
    if (s.phase === "unavailable") {
      this.capture = undefined;
      this.set({ phase: "error", reason: s.reason });
    }
    if (s.phase === "idle" && !this.finishing && this.state.phase === "listening") {
      // The session ended on its own. `onInterrupted` runs right after this with any text and
      // moves on to thinking; with nothing heard, listen again.
      queueMicrotask(() => {
        if (this.turn !== turn || this.state.phase !== "listening") return;
        this.capture = undefined;
        this.afterReply();
      });
    }
  }

  private onVad(e: "start" | "end"): void {
    const p = this.state.phase;
    if (e === "start" && p === "speaking" && this.opts.settings.bargeIn) {
      this.interruptReply();
      if (this.opts.settings.start === "push") this.ready();
      else void this.listen();
      return;
    }
    if (e === "end" && p === "listening" && this.opts.settings.start === "toggle")
      void this.finishUtterance();
  }

  private async finishUtterance(): Promise<void> {
    const capture = this.capture;
    if (!capture || this.finishing) return;
    this.finishing = true;
    const turn = this.turn;
    const said = await capture.stop();
    if (this.turn !== turn) return;
    this.capture = undefined;
    await this.send(said, turn);
  }

  private async send(said: string, turn: number): Promise<void> {
    const threadId = this.threadId;
    if (threadId === null || this.turn !== turn) return;
    const text = said.trim();
    if (text === "") {
      // Nothing recognised (a cough, a door): keep listening.
      if (this.opts.settings.start === "push") this.ready();
      else void this.listen();
      return;
    }
    this.capture = undefined;
    this.lastReply = undefined;
    this.awaitingReply = true;
    this.vad.setProfile(BARGE_IN_PROFILE);
    this.set({ phase: "thinking", said: text });
    try {
      await this.opts.call("chat.send", { threadId, content: text });
    } catch {
      if (this.turn !== turn) return;
      this.awaitingReply = false;
      this.set({ phase: "error", reason: t("web.voiceMode.sendFailed") });
    }
  }

  private onRunDone(): void {
    this.awaitingReply = false;
    const reply = this.lastReply;
    this.lastReply = undefined;
    if (!reply || speakableText(reply) === "") {
      this.afterReply();
      return;
    }
    const turn = ++this.turn;
    this.vad.setProfile(BARGE_IN_PROFILE);
    this.set({ phase: "speaking", messageId: reply.id });
    const u = this.opts.speaker.speak(reply);
    this.utterance = u;
    void u.done.then(() => {
      if (this.turn !== turn || this.utterance !== u) return;
      this.utterance = undefined;
      this.afterReply();
    });
  }

  private interruptReply(): void {
    this.turn++;
    this.utterance?.stop();
    this.utterance = undefined;
  }

  private afterReply(): void {
    if (!this.active) return;
    // The reply's own sound must not be replayed into the next utterance (only barge-in keeps it).
    this.mic.clearPreroll();
    if (this.opts.settings.start === "push") this.ready();
    else void this.listen();
  }
}
