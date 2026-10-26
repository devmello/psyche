import {
  type AudioFormat,
  type MethodParams,
  type MethodResult,
  PsycheError,
  type SpeechEngine,
  type ToolCallStatus,
  type TranscriptSegment,
  type VoiceConversationEndReason,
  type VoiceConversationMode,
  type VoiceConversationPhase,
  type VoiceConversationReason,
  type VoiceTurnOptions,
} from "@psyche/protocol";
import { bytesPerSample, isPcm } from "../audio.ts";
import type { EngineLocation, SpeechCaller, SpeechEngineSelector } from "../policy.ts";
import { AsyncQueue, fromBase64, toBase64 } from "../queue.ts";
import { mergeVocabulary } from "../vocabulary.ts";
import {
  APPROVAL_WINDOW_MS,
  type ApprovalPhrases,
  DEFAULT_APPROVAL_PHRASES,
  matchApprovalPhrase,
  planVoiceApproval,
  type VoiceApprovalInfo,
  type VoiceApprovalPlan,
  type VoiceApprovalTier,
} from "./approvals.ts";
import { NARRATE_SLOW_MS } from "./narration.ts";
import { type SpeakLevel, SpokenText } from "./spoken.ts";
import { PcmVad } from "./vad.ts";

/**
 * The Gateway-owned voice conversation (feature Q5; docs/voice/voice-mode-2026.md §3–§5, §7).
 *
 * One `VoiceConversation` per device:
 * 1. It listens to the client's microphone PCM. Push-to-talk turns end on key up; tap and
 *    hands-free turns end after a pause (`PcmVad`), longer after an unfinished phrase.
 * 2. It transcribes each turn with the dictation engine and custom vocabulary.
 * 3. It sends the owner's words through `VoiceTurnPort` (the Gateway's chat path, as a
 *    `via: "voice"` owner message).
 * 4. It speaks the reply sentence by sentence while the run streams (`SpokenText`).
 * 5. It tracks what the owner heard (`played`), and stops speaking on barge-in: a client
 *    `suspect` is confirmed only by a transcribed word that is not in the sentence being spoken.
 *
 * Events go to the starting device only. Approvals and questions put the conversation in
 * `waiting`, with the card on screen; answering them by voice is G3.
 */

/** The run's events, as the Gateway's chat path reports them to the conversation. */
export type VoiceTurnEvent =
  | { type: "delta"; text: string }
  | { type: "step"; toolCallId: string; label: string; status: ToolCallStatus }
  | {
      type: "waiting";
      reason: "approval" | "question";
      approvalId?: string;
      /** The pending approval as the card shows it (for a spoken readback and answer). */
      approval?: VoiceApprovalInfo;
    }
  | { type: "resumed" }
  | { type: "done"; status: "done" | "failed" | "cancelled" };

export interface VoiceTurnInput {
  threadId: string | null;
  deviceId: string;
  text: string;
  voice: VoiceTurnOptions;
  signal: AbortSignal;
}

/** The Gateway's side of a turn: send the owner's words, stream the run until it ends. */
export interface VoiceTurnPort {
  send(input: VoiceTurnInput): AsyncIterable<VoiceTurnEvent>;
}

export type VoiceConversationEvent =
  | { event: "voice.conversation.state"; payload: StatePayload }
  | {
      event: "voice.conversation.caption";
      payload: {
        conversationId: string;
        role: "owner" | "agent";
        utteranceId: string;
        text: string;
        final: boolean;
      };
    }
  | {
      event: "voice.conversation.speech";
      payload: {
        conversationId: string;
        utteranceId: string;
        seq: number;
        audio: string;
        format: AudioFormat;
        last: boolean;
      };
    }
  | {
      event: "voice.conversation.step";
      payload: {
        conversationId: string;
        toolCallId: string;
        label: string;
        status: ToolCallStatus;
      };
    }
  | {
      event: "voice.conversation.ended";
      payload: {
        conversationId: string;
        reason: VoiceConversationEndReason;
        error?: { code: string; message: string };
      };
    };

interface StatePayload {
  conversationId: string;
  phase: VoiceConversationPhase;
  reason?: VoiceConversationReason;
  approvalId?: string;
  prompt?: string;
  windowMs?: number;
  listening: boolean;
  draft?: string;
  utteranceId?: string;
}

export interface VoiceConversationSettings {
  speak: SpeakLevel;
  narrate: "off" | "brief" | "steps";
  /** Silence that ends a tap or hands-free turn (default 600 ms). */
  pauseMs: number;
  /** Silence after an unfinished phrase (default 1 200 ms). */
  trailingPauseMs: number;
  /** Hands-free ends after this long without speech (default 30 s). */
  idleMs: number;
  /** Shorter speech is ignored (coughs, doors; default 300 ms). */
  minSpeechMs: number;
  /** A suspect barge-in is released after this long without a new word (default 1 s). */
  suspectMs: number;
  /** After the last reply audio, wait this long before listening again (echo tail; 600 ms). */
  postPlaybackMs: number;
  /** Words that mean the owner hasn't finished (per locale; English default). */
  trailingWords: readonly string[];
  /** Which approvals voice may answer (spec §4.6; default "write"). */
  approvals: VoiceApprovalTier;
  /** How long Psyche listens for an approval answer after the readback (default 10 s). */
  approvalWindowMs: number;
  /** Review before sending (spec §4.10; off by default): hold each turn for the owner to edit. */
  reviewBeforeSend: boolean;
}

export const DEFAULT_VOICE_CONVERSATION_SETTINGS: VoiceConversationSettings = {
  speak: "brief",
  narrate: "brief",
  pauseMs: 600,
  trailingPauseMs: 1_200,
  idleMs: 30_000,
  minSpeechMs: 300,
  suspectMs: 1_000,
  postPlaybackMs: 600,
  trailingWords: ["and", "but", "so", "or", "because", "um", "uh", "like", "then", "with", "to"],
  approvals: "write",
  approvalWindowMs: APPROVAL_WINDOW_MS,
  reviewBeforeSend: false,
};

export interface VoiceConversationOptions {
  selector: SpeechEngineSelector;
  /** Synthesis for the reply (the routed engine: helper voice, Kokoro or a named cloud voice). */
  tts: SpeechEngine;
  turns: VoiceTurnPort;
  emit: (deviceId: string, event: VoiceConversationEvent) => void;
  /** Session-default vocabulary (agent name, owner, contacts). */
  vocabulary?: () => Promise<string[]> | string[];
  /** The owner's settings at the start of each conversation. */
  settings?: () => Partial<VoiceConversationSettings> | Promise<Partial<VoiceConversationSettings>>;
  newId?: () => string;
  /** Pre-roll kept for a new turn (default 600 ms). */
  prerollMs?: number;
  /**
   * The owner's switch (`voice.conversation.enabled`, off by default): `start` refuses with
   * `policy_denied` while it is off. Without the option, conversations are allowed (tests).
   */
  enabled?: () => boolean | Promise<boolean>;
  /** Answers an approval as the conversation's device. Without it, approvals stay cards. */
  approvals?: VoiceApprovalPort;
  /** Approval phrases for a language (the UI catalogues); English by default. */
  phrases?: (language: string | undefined) => ApprovalPhrases;
  /**
   * Listen (spec §4.9): the script for a daily-brief or check-in notification, which the
   * conversation speaks before the owner's first turn. Rejects for a notification without the
   * Listen action, or while the spoken brief is off. Without it `start {listen}` is unavailable.
   */
  listen?: (notificationId: string) => Promise<VoiceListenScript>;
}

/** What Listen speaks: the notification's text, then an optional hand-over line. */
export interface VoiceListenScript {
  text: string;
  /** The thread the notification belongs to, if any; the conversation continues there. */
  threadId: string | null;
  /** Said after the script ("Ask me about any of these."). */
  handOff?: string;
}

/** Listen speaks at most about 90 s (spec §4.9): ~230 words. */
export const LISTEN_MAX_CHARS = 1_400;

/** The Gateway's side of an approval answered by voice: the broker, as this device's surface. */
export interface VoiceApprovalPort {
  answer(input: {
    approvalId: string;
    deviceId: string;
    decision: "approve" | "deny";
    /** The owner's words, for the audit entry. */
    utterance: string;
  }): Promise<void>;
}

/** One base64 chunk may carry at most 1 s of 48 kHz stereo f32, as `voice.push`. */
const MAX_CHUNK_BYTES = 384_000;

interface Turn {
  id: string;
  audio: AsyncQueue<Uint8Array>;
  abort: AbortController;
  done: Promise<string>;
  partial: string;
  /** Opened by a suspect barge-in: becomes a real turn only when a new word is heard. */
  tentative: boolean;
}

interface Reply {
  abort: AbortController;
  spoken: SpokenText;
  /** Sentences waiting for synthesis, in order; `readback` marks an approval's readback. */
  queue: { text: string; tag?: "readback" }[];
  synthesizing: boolean;
  runDone: boolean;
  /** Utterances sent and not yet reported as played to the end. */
  unplayed: Set<string>;
  /** The sentence being spoken, for barge-in confirmation and caption cutting. */
  current: { id: string; text: string; durationMs: number } | undefined;
  /** Speech stopped (barge-in or stop); later deltas are shown, not spoken. */
  muted: boolean;
  /** Narration timers for running steps (`brief`), or a marker that a step was said (`steps`). */
  slow: Map<string, Timer | null>;
  /** A narration phrase was spoken this turn (`brief` says at most one). */
  narrated: boolean;
  /** Answer text was spoken this turn (narration stops once the answer starts). */
  answered: boolean;
}

type Timer = ReturnType<typeof setTimeout>;

interface PendingApproval {
  info: VoiceApprovalInfo;
  plan: VoiceApprovalPlan;
  /** The utterance that reads the approval back; its `played … done` opens the window. */
  readbackId?: string;
  /** Opens the window anyway when the client never reports `played`. */
  fallback?: Timer;
  /** Closes the window after `approvalWindowMs`. */
  window?: Timer;
  /** Listening for the answer now. */
  open: boolean;
}

export class VoiceConversation {
  readonly id: string;
  readonly deviceId: string;
  readonly threadId: string | null;
  readonly mode: VoiceConversationMode;
  readonly format: AudioFormat;
  readonly #opts: VoiceConversationOptions;
  readonly #settings: VoiceConversationSettings;
  readonly #language: string | undefined;
  readonly #voice: string | undefined;
  readonly #vocabulary: string[];
  readonly #engine: SpeechEngine;
  readonly #vad: PcmVad;
  readonly #preroll: Uint8Array[] = [];
  readonly #prerollBytes: number;
  readonly #onEnd: (c: VoiceConversation) => void;
  #prerollSize = 0;
  #nextSeq = 0;
  #phase: VoiceConversationPhase = "listening";
  #listening: boolean;
  #turn: Turn | undefined;
  #reply: Reply | undefined;
  #suspect: Timer | undefined;
  #endTimer: Timer | undefined;
  #idle: Timer | undefined;
  #resume: Timer | undefined;
  #counter = 0;
  #ended = false;
  /** An approval the run is waiting for, while voice may answer it. */
  #approval: PendingApproval | undefined;
  /** The owner's transcript held for review before sending (spec §4.10). */
  #review: { utteranceId: string; text: string } | undefined;

  constructor(init: {
    id: string;
    deviceId: string;
    threadId: string | null;
    mode: VoiceConversationMode;
    format: AudioFormat;
    language?: string;
    voice?: string;
    vocabulary: string[];
    engine: SpeechEngine;
    settings: VoiceConversationSettings;
    options: VoiceConversationOptions;
    onEnd: (c: VoiceConversation) => void;
  }) {
    this.id = init.id;
    this.deviceId = init.deviceId;
    this.threadId = init.threadId;
    this.mode = init.mode;
    this.format = init.format;
    this.#language = init.language;
    this.#voice = init.voice;
    this.#vocabulary = init.vocabulary;
    this.#engine = init.engine;
    this.#settings = init.settings;
    this.#opts = init.options;
    this.#onEnd = init.onEnd;
    this.#listening = init.mode !== "push";
    this.#vad = new PcmVad((e) => this.#onVad(e), { endMs: init.settings.pauseMs });
    const bytesPerMs =
      (init.format.sampleRate * init.format.channels * bytesPerSample(init.format)) / 1000;
    this.#prerollBytes = Math.round((init.options.prerollMs ?? 600) * bytesPerMs);
  }

  get phase(): VoiceConversationPhase {
    return this.#phase;
  }

  get listening(): boolean {
    return this.#listening;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Announces the first state; hands-free starts its idle clock. */
  begin(): void {
    this.#state("listening");
    this.#armIdle();
  }

  // --- Client calls -------------------------------------------------------------------------------

  audio(seq: number, base64: string): void {
    if (this.#ended) throw new PsycheError("conflict", "the voice conversation has ended");
    if (seq !== this.#nextSeq) {
      throw new PsycheError("invalid_params", `expected chunk ${this.#nextSeq}, got ${seq}`);
    }
    const pcm = fromBase64(base64);
    if (pcm.byteLength > MAX_CHUNK_BYTES)
      throw new PsycheError("invalid_params", "audio chunk too large");
    this.#nextSeq++;
    this.#remember(pcm);
    // The server VAD drives tap and hands-free turns; while speaking the client reports barge-in.
    if (this.#phase === "listening" && this.#listening) this.#vad.push(pcm, this.format);
    else if (this.#turn !== undefined) this.#vad.push(pcm, this.format);
    this.#turn?.audio.push(pcm);
  }

  turn(action: "begin" | "end"): void {
    if (this.#ended) throw new PsycheError("conflict", "the voice conversation has ended");
    if (action === "begin") {
      if (this.#approval !== undefined && this.#approval.plan.mode !== "card") {
        // Talking during the readback, or pressing the key in the window, answers the approval.
        this.#openAnswerWindow();
        if (this.#turn === undefined) {
          this.#vad.reset();
          this.#openTurn(false);
        }
        return;
      }
      if (this.#phase === "speaking") this.#stopSpeaking("barge_in");
      // Talking again while reviewing replaces the draft with the new words.
      if (this.#review !== undefined) this.#review = undefined;
      else if (this.#phase === "thinking" || this.#phase === "waiting") return;
      this.#listening = true;
      if (this.#turn === undefined) {
        // A key or tap opens the turn before any speech: start counting from here.
        this.#vad.reset();
        this.#openTurn(false);
      } else this.#turn.tentative = false;
      this.#state("listening");
      return;
    }
    if (this.mode === "push") {
      if (this.#turn !== undefined) void this.#endTurn();
      return;
    }
    // A second tap ends the turn now.
    if (this.#turn !== undefined && !this.#turn.tentative) void this.#endTurn();
  }

  interrupt(stage: "suspect" | "confirmed"): void {
    if (this.#ended || (this.#phase !== "speaking" && this.#phase !== "waiting")) return;
    const a = this.#approval;
    if (a !== undefined && a.plan.mode !== "card" && this.#reply?.current?.id === a.readbackId) {
      // The owner answered over the readback: listen now, and keep the rest of the reply.
      this.#openAnswerWindow();
      return;
    }
    if (this.#phase !== "speaking") return;
    if (stage === "confirmed") {
      this.#stopSpeaking("barge_in");
      if (this.mode !== "push") this.#openTurn(false);
      return;
    }
    if (this.#suspect !== undefined) return;
    if (this.#turn === undefined) this.#openTurn(true);
    this.#suspect = setTimeout(() => {
      this.#suspect = undefined;
      // No new word: the owner (or the echo) didn't really take the floor. Keep speaking.
      if (this.#turn?.tentative === true) this.#dropTurn();
    }, this.#settings.suspectMs);
  }

  played(utteranceId: string, done: boolean): void {
    if (done && this.#approval?.readbackId === utteranceId) this.#openAnswerWindow();
    const r = this.#reply;
    if (r === undefined || !done) return;
    r.unplayed.delete(utteranceId);
    this.#maybeReplyFinished();
  }

  /**
   * Review before sending: sends the held transcript (as edited) as the voice turn, or discards
   * it and listens again. Only the draft the conversation is waiting on can be answered.
   */
  review(utteranceId: string, action: "send" | "discard", text?: string): void {
    if (this.#ended) throw new PsycheError("conflict", "the voice conversation has ended");
    const r = this.#review;
    if (r === undefined || r.utteranceId !== utteranceId) {
      throw new PsycheError("conflict", "nothing is waiting for review");
    }
    this.#review = undefined;
    if (action === "discard") {
      this.#listening = this.mode === "handsfree";
      this.#state("listening");
      this.#armIdle();
      return;
    }
    const words = (text ?? r.text).trim();
    if (words === "") {
      this.#listening = this.mode === "handsfree";
      this.#state("listening", { reason: "no_speech" });
      this.#armIdle();
      return;
    }
    if (words !== r.text) {
      // The thread shows what was sent; the caption follows the edit.
      this.#emit({
        event: "voice.conversation.caption",
        payload: { conversationId: this.id, role: "owner", utteranceId, text: words, final: true },
      });
    }
    this.#state("heard");
    this.#state("thinking");
    void this.#runTurn(words);
  }

  stop(): void {
    this.end("stopped");
  }

  /** Ends the conversation (stop, idle, lock, disconnect, error). Idempotent. */
  end(reason: VoiceConversationEndReason, error?: { code: string; message: string }): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const t of [this.#suspect, this.#endTimer, this.#idle, this.#resume]) {
      if (t !== undefined) clearTimeout(t);
    }
    this.#closeApproval();
    this.#dropTurn();
    this.#review = undefined;
    if (this.#reply !== undefined) {
      this.#clearSlow(this.#reply);
      this.#reply.muted = true;
      this.#reply.abort.abort();
      this.#reply = undefined;
    }
    this.#listening = false;
    this.#phase = "ended";
    this.#emit({
      event: "voice.conversation.state",
      payload: { conversationId: this.id, phase: "ended", listening: false },
    });
    this.#emit({
      event: "voice.conversation.ended",
      payload: { conversationId: this.id, reason, ...(error === undefined ? {} : { error }) },
    });
    this.#onEnd(this);
  }

  // --- Turns -------------------------------------------------------------------------------------

  #onVad(e: "start" | "end"): void {
    if (this.#ended) return;
    if (e === "start") {
      this.#armIdle();
      if (this.#endTimer !== undefined) {
        // Speech resumed during the trailing-word wait.
        clearTimeout(this.#endTimer);
        this.#endTimer = undefined;
      }
      if (
        this.#phase === "listening" &&
        this.#listening &&
        this.#turn === undefined &&
        this.mode !== "push"
      ) {
        this.#openTurn(false);
      }
      return;
    }
    const t = this.#turn;
    if (t === undefined || t.tentative || this.mode === "push") return;
    const lastWord = t.partial
      .trim()
      .split(/\s+/)
      .at(-1)
      ?.toLowerCase()
      .replace(/[^\p{L}']/gu, "");
    if (lastWord !== undefined && this.#settings.trailingWords.includes(lastWord)) {
      const extra = Math.max(0, this.#settings.trailingPauseMs - this.#settings.pauseMs);
      this.#endTimer = setTimeout(() => {
        this.#endTimer = undefined;
        if (this.#turn === t) void this.#endTurn();
      }, extra);
      return;
    }
    void this.#endTurn();
  }

  #openTurn(tentative: boolean): void {
    const audio = new AsyncQueue<Uint8Array>();
    const abort = new AbortController();
    const id = `${this.id}_o${++this.#counter}`;
    // Seed the turn with the pre-roll, so the first word isn't lost.
    for (const chunk of this.#preroll) audio.push(chunk);
    const turn: Turn = { id, audio, abort, done: Promise.resolve(""), partial: "", tentative };
    const options: { signal: AbortSignal; language?: string; vocabulary?: string[] } = {
      signal: abort.signal,
    };
    if (this.#language !== undefined) options.language = this.#language;
    if (this.#vocabulary.length > 0) options.vocabulary = this.#vocabulary;
    const stream = this.#engine.transcribeStream(audio, this.format, options);
    turn.done = this.#consume(turn, stream);
    turn.done.catch(() => {});
    // The VAD keeps its state: a turn opened by speech must still see that speech end.
    this.#turn = turn;
  }

  async #consume(turn: Turn, stream: AsyncIterable<TranscriptSegment>): Promise<string> {
    const finals: string[] = [];
    let volatile = "";
    for await (const seg of stream) {
      if (turn.abort.signal.aborted) break;
      const text = seg.text.trim();
      if (seg.final) {
        if (text !== "") finals.push(text);
        volatile = "";
      } else volatile = text;
      turn.partial = [...finals, volatile].filter(Boolean).join(" ");
      if (turn.tentative) this.#checkSuspect(turn);
      if (!turn.tentative && turn.partial !== "") {
        this.#emit({
          event: "voice.conversation.caption",
          payload: {
            conversationId: this.id,
            role: "owner",
            utteranceId: turn.id,
            text: turn.partial,
            final: false,
          },
        });
      }
    }
    return [...finals, volatile].filter(Boolean).join(" ").trim();
  }

  /** A suspect barge-in is real once the owner says a word that isn't in Psyche's sentence. */
  #checkSuspect(turn: Turn): void {
    const spoken = new Set(
      (this.#reply?.current?.text ?? "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}']+/u)
        .filter(Boolean),
    );
    const words = turn.partial
      .toLowerCase()
      .split(/[^\p{L}\p{N}']+/u)
      .filter(Boolean);
    if (!words.some((w) => !spoken.has(w))) return;
    if (this.#suspect !== undefined) {
      clearTimeout(this.#suspect);
      this.#suspect = undefined;
    }
    turn.tentative = false;
    this.#stopSpeaking("barge_in");
  }

  #dropTurn(): void {
    const t = this.#turn;
    if (t === undefined) return;
    this.#turn = undefined;
    t.abort.abort();
    t.audio.end();
  }

  async #endTurn(): Promise<void> {
    const t = this.#turn;
    if (t === undefined || t.tentative) return;
    this.#turn = undefined;
    if (this.#endTimer !== undefined) {
      clearTimeout(this.#endTimer);
      this.#endTimer = undefined;
    }
    const speechMs = this.#vad.speechMs;
    this.#vad.reset();
    t.audio.end();
    if (this.mode !== "handsfree") this.#listening = false;
    let text = "";
    try {
      text = await t.done;
    } catch (err) {
      if (this.#ended) return;
      this.end("error", errorOf(err));
      return;
    }
    if (this.#ended) return;
    if (this.#approval?.open === true) {
      await this.#answerApproval(text);
      return;
    }
    // Push-to-talk turns are deliberate: only the transcript decides. Others need real speech.
    const tooShort = this.mode !== "push" && speechMs < this.#settings.minSpeechMs;
    if (text === "" || tooShort) {
      this.#listening = this.mode === "handsfree";
      this.#state("listening", { reason: "no_speech" });
      return;
    }
    this.#emit({
      event: "voice.conversation.caption",
      payload: { conversationId: this.id, role: "owner", utteranceId: t.id, text, final: true },
    });
    if (this.#settings.reviewBeforeSend) {
      // Nothing goes out until the owner sends it; the microphone closes meanwhile.
      this.#review = { utteranceId: t.id, text };
      this.#listening = false;
      this.#state("waiting", { reason: "review", draft: text, utteranceId: t.id });
      return;
    }
    this.#state("heard");
    this.#state("thinking");
    void this.#runTurn(text);
  }

  // --- The reply --------------------------------------------------------------------------------

  /**
   * Listen (spec §4.9): speaks a script (the daily brief or a check-in) as a reply with no run,
   * flattened and capped at about 90 s, then the hand-over line. Barge-in and push-to-talk work
   * as for any reply; afterwards the conversation listens for the owner's turn.
   */
  say(script: string, handOff?: string): void {
    if (this.#ended) return;
    const reply = this.#newReply(new SpokenText({ speak: "full", maxChars: LISTEN_MAX_CHARS }));
    this.#reply = reply;
    const sentences = [...reply.spoken.push(`${script}\n`), ...reply.spoken.finish()];
    if (handOff !== undefined && handOff !== "") sentences.push(handOff);
    reply.runDone = true;
    this.#queueSentences(reply, sentences);
    this.#maybeReplyFinished();
  }

  #newReply(spoken: SpokenText): Reply {
    return {
      abort: new AbortController(),
      spoken,
      queue: [],
      synthesizing: false,
      runDone: false,
      unplayed: new Set(),
      current: undefined,
      muted: false,
      slow: new Map(),
      narrated: false,
      answered: false,
    };
  }

  async #runTurn(text: string): Promise<void> {
    const reply = this.#newReply(new SpokenText({ speak: this.#settings.speak }));
    this.#reply = reply;
    const voice: VoiceTurnOptions = {
      speak: this.#settings.speak,
      narrate: this.#settings.narrate,
      ...(this.#language === undefined ? {} : { language: this.#language }),
    };
    try {
      for await (const e of this.#opts.turns.send({
        threadId: this.threadId,
        deviceId: this.deviceId,
        text,
        voice,
        signal: reply.abort.signal,
      })) {
        if (this.#ended || this.#reply !== reply) return;
        if (e.type === "delta") {
          const sentences = reply.spoken.push(e.text);
          if (sentences.length > 0) reply.answered = true;
          this.#queueSentences(reply, sentences);
        } else if (e.type === "step") {
          this.#emit({
            event: "voice.conversation.step",
            payload: {
              conversationId: this.id,
              toolCallId: e.toolCallId,
              label: e.label,
              status: e.status,
            },
          });
          this.#narrate(reply, e.toolCallId, e.label, e.status);
        } else if (e.type === "waiting") {
          this.#state("waiting", {
            reason: e.reason,
            ...(e.approvalId === undefined ? {} : { approvalId: e.approvalId }),
          });
          if (e.reason === "approval" && e.approval !== undefined)
            this.#onApproval(reply, e.approval);
          else if (e.reason === "question") {
            this.#queueSentences(reply, ["I have a question for you on screen."]);
          }
        } else if (e.type === "resumed") {
          // Answered (by voice or on the card): the window closes and the run goes on.
          this.#closeApproval();
          if (this.#phase === "waiting" || this.#phase === "speaking") this.#state("thinking");
        } else if (e.type === "done") break;
      }
    } catch (err) {
      if (this.#ended || this.#reply !== reply) return;
      // The run failed: say nothing more and go back to listening; the error is on screen.
      void err;
      reply.runDone = true;
      reply.muted = true;
      this.#reply = undefined;
      this.#afterReply();
      return;
    }
    if (this.#ended || this.#reply !== reply) return;
    this.#clearSlow(reply);
    this.#queueSentences(reply, reply.spoken.finish());
    reply.runDone = true;
    this.#maybeReplyFinished();
  }

  // --- Approvals by voice (spec §4.6) -----------------------------------------------------------

  #onApproval(reply: Reply, info: VoiceApprovalInfo): void {
    this.#closeApproval();
    const tier = this.#opts.approvals === undefined ? "off" : this.#settings.approvals;
    const plan = planVoiceApproval(info, tier);
    this.#approval = { info, plan, open: false };
    if (plan.mode === "card") this.#queueSentences(reply, [plan.speech]);
    else this.#queueSentences(reply, [plan.speech], "readback");
  }

  /** The readback played (or the owner talked over it): listen for the answer. */
  #openAnswerWindow(): void {
    const a = this.#approval;
    if (a === undefined || a.open || a.plan.mode === "card" || this.#ended) return;
    a.open = true;
    if (a.fallback !== undefined) clearTimeout(a.fallback);
    this.#listening = true;
    this.#phase = "waiting";
    this.#emit({
      event: "voice.conversation.state",
      payload: {
        conversationId: this.id,
        phase: "waiting",
        reason: "approval",
        approvalId: a.info.id,
        prompt: a.plan.speech,
        windowMs: this.#settings.approvalWindowMs,
        listening: true,
      },
    });
    // Push-to-talk answers with the key; tap and hands-free listen at once.
    if (this.mode !== "push" && this.#turn === undefined) {
      this.#vad.reset();
      this.#openTurn(false);
    }
    a.window = setTimeout(() => {
      if (this.#approval !== a) return;
      this.#dropTurn();
      this.#leaveOnScreen(a);
    }, this.#settings.approvalWindowMs);
  }

  async #answerApproval(text: string): Promise<void> {
    const a = this.#approval;
    if (a === undefined) return;
    const phrases = this.#opts.phrases?.(this.#language) ?? DEFAULT_APPROVAL_PHRASES;
    let decision = matchApprovalPhrase(text, phrases);
    // In a tainted turn voice can only deny: an approve here counts as no answer.
    if (decision === "approve" && a.plan.mode === "deny_only") decision = undefined;
    const port = this.#opts.approvals;
    if (decision === undefined || port === undefined) {
      this.#leaveOnScreen(a);
      return;
    }
    if (a.window !== undefined) clearTimeout(a.window);
    a.open = false;
    try {
      await port.answer({
        approvalId: a.info.id,
        deviceId: this.deviceId,
        decision,
        utterance: text,
      });
    } catch {
      if (this.#approval === a) this.#leaveOnScreen(a);
      return;
    }
    if (this.#ended) return;
    const reply = this.#reply;
    if (reply !== undefined) {
      this.#queueSentences(reply, [decision === "approve" ? phrases.approved : phrases.denied]);
    }
    this.#approval = undefined;
    this.#listening = this.mode === "handsfree";
    this.#state("thinking");
  }

  /** No usable answer: the card stays, and Psyche says so once. */
  #leaveOnScreen(a: PendingApproval): void {
    if (a.window !== undefined) clearTimeout(a.window);
    a.open = false;
    this.#listening = false;
    const reply = this.#reply;
    const phrases = this.#opts.phrases?.(this.#language) ?? DEFAULT_APPROVAL_PHRASES;
    if (reply !== undefined) this.#queueSentences(reply, [phrases.leftOnScreen]);
    this.#state("waiting", {
      reason: "approval",
      ...(this.#approval ? { approvalId: this.#approval.info.id } : {}),
    });
  }

  #closeApproval(): void {
    const a = this.#approval;
    if (a === undefined) return;
    if (a.window !== undefined) clearTimeout(a.window);
    if (a.fallback !== undefined) clearTimeout(a.fallback);
    if (a.open) this.#dropTurn();
    this.#approval = undefined;
  }

  /**
   * Narration (spec §4.5): `steps` says each step's label once as it starts. `brief` says one
   * phrase per turn, for a step still running after 1.5 s, and only before the answer started.
   */
  #narrate(reply: Reply, toolCallId: string, label: string, status: string): void {
    const level = this.#settings.narrate;
    if (level === "off" || reply.muted) return;
    const running = status === "running" || status === "pending";
    if (!running) {
      const t = reply.slow.get(toolCallId);
      if (t != null) clearTimeout(t);
      if (level === "brief") reply.slow.delete(toolCallId);
      return;
    }
    if (reply.slow.has(toolCallId)) return;
    if (level === "steps") {
      reply.slow.set(toolCallId, null);
      this.#queueSentences(reply, [`${label}.`]);
      return;
    }
    if (reply.narrated || reply.answered) return;
    reply.slow.set(
      toolCallId,
      setTimeout(() => {
        reply.slow.delete(toolCallId);
        if (reply.narrated || reply.answered || reply.muted || this.#reply !== reply) return;
        reply.narrated = true;
        this.#queueSentences(reply, [`${label}.`]);
      }, NARRATE_SLOW_MS),
    );
  }

  #clearSlow(reply: Reply): void {
    for (const t of reply.slow.values()) if (t != null) clearTimeout(t);
    reply.slow.clear();
  }

  #queueSentences(reply: Reply, sentences: string[], tag?: "readback"): void {
    if (reply.muted || sentences.length === 0) return;
    reply.queue.push(...sentences.map((text) => (tag === undefined ? { text } : { text, tag })));
    if (!reply.synthesizing) void this.#synthesize(reply);
  }

  async #synthesize(reply: Reply): Promise<void> {
    reply.synthesizing = true;
    try {
      while (reply.queue.length > 0 && !reply.muted) {
        const item = reply.queue.shift() as { text: string; tag?: "readback" };
        await this.#speakSentence(reply, item.text, item.tag);
      }
    } catch {
      // Synthesis failed: the rest of the reply is shown, not spoken.
      reply.muted = true;
    } finally {
      reply.synthesizing = false;
      this.#maybeReplyFinished();
    }
  }

  async #speakSentence(reply: Reply, text: string, tag?: "readback"): Promise<void> {
    const id = `${this.id}_a${++this.#counter}`;
    if (tag === "readback" && this.#approval !== undefined) this.#approval.readbackId = id;
    const opts: { signal: AbortSignal; voice?: string } = { signal: reply.abort.signal };
    if (this.#voice !== undefined) opts.voice = this.#voice;
    let seq = 0;
    let held: { data: Uint8Array; format: AudioFormat } | undefined;
    let bytes = 0;
    let format: AudioFormat | undefined;
    const send = (last: boolean) => {
      if (held === undefined) return;
      if (seq === 0) {
        reply.unplayed.add(id);
        // While waiting for an approval the phase stays `waiting`: the readback and notices are
        // spoken under "Needs your approval on screen".
        if (this.#phase !== "speaking" && this.#phase !== "waiting") this.#state("speaking");
        this.#emit({
          event: "voice.conversation.caption",
          payload: { conversationId: this.id, role: "agent", utteranceId: id, text, final: false },
        });
      }
      this.#emit({
        event: "voice.conversation.speech",
        payload: {
          conversationId: this.id,
          utteranceId: id,
          seq: seq++,
          audio: toBase64(held.data),
          format: held.format,
          last,
        },
      });
      held = undefined;
    };
    reply.current = { id, text, durationMs: 0 };
    for await (const chunk of this.#opts.tts.synthesize(text, opts)) {
      if (reply.muted) return;
      format ??= chunk.format;
      bytes += chunk.data.byteLength;
      send(false);
      held = chunk;
    }
    if (reply.muted) return;
    send(true);
    if (format !== undefined) {
      const bytesPerMs = (format.sampleRate * format.channels * bytesPerSample(format)) / 1000;
      reply.current = { id, text, durationMs: Math.round(bytes / bytesPerMs) };
    }
    const a = this.#approval;
    if (tag === "readback" && a !== undefined && a.readbackId === id) {
      // A client that never reports `played` still gets its window, after the readback's length.
      a.fallback = setTimeout(
        () => this.#openAnswerWindow(),
        (reply.current.durationMs ?? 0) + 2_000,
      );
    }
  }

  /** The reply is over once the run ended, nothing waits for synthesis and everything played. */
  #maybeReplyFinished(): void {
    const r = this.#reply;
    if (r === undefined || this.#ended) return;
    if (!r.runDone || r.synthesizing || r.queue.length > 0) return;
    if (!r.muted && r.unplayed.size > 0) return;
    this.#reply = undefined;
    this.#afterReply();
  }

  #afterReply(): void {
    if (this.#ended) return;
    if (this.#resume !== undefined) clearTimeout(this.#resume);
    // Wait out the echo tail before listening again (spec §4.2).
    this.#resume = setTimeout(() => {
      this.#resume = undefined;
      // A barge-in may already have opened the owner's next turn: leave it alone.
      if (this.#ended || this.#reply !== undefined || this.#turn !== undefined) return;
      this.#preroll.length = 0;
      this.#prerollSize = 0;
      this.#vad.reset();
      this.#listening = this.mode === "handsfree";
      this.#state("listening");
      this.#armIdle();
    }, this.#settings.postPlaybackMs);
  }

  #stopSpeaking(reason: VoiceConversationReason): void {
    const r = this.#reply;
    if (r !== undefined && !r.muted) {
      r.muted = true;
      r.queue.length = 0;
      // Synthesis stops; the run keeps going, and its message completes on screen.
      if (r.current !== undefined) {
        this.#emit({
          event: "voice.conversation.caption",
          payload: {
            conversationId: this.id,
            role: "agent",
            utteranceId: r.current.id,
            text: r.current.text,
            final: true,
          },
        });
      }
    }
    this.#listening = true;
    this.#state("listening", { reason });
  }

  // --- Plumbing ---------------------------------------------------------------------------------

  #remember(pcm: Uint8Array): void {
    this.#preroll.push(pcm);
    this.#prerollSize += pcm.byteLength;
    while (
      this.#preroll.length > 1 &&
      this.#prerollSize - (this.#preroll[0]?.byteLength ?? 0) >= this.#prerollBytes
    ) {
      this.#prerollSize -= this.#preroll.shift()?.byteLength ?? 0;
    }
  }

  #armIdle(): void {
    if (this.mode !== "handsfree") return;
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      this.#idle = undefined;
      if (this.#phase === "listening" && this.#turn === undefined) this.end("idle");
      else this.#armIdle();
    }, this.#settings.idleMs);
  }

  #state(
    phase: VoiceConversationPhase,
    extra: {
      reason?: VoiceConversationReason;
      approvalId?: string;
      draft?: string;
      utteranceId?: string;
    } = {},
  ): void {
    if (this.#ended) return;
    this.#phase = phase;
    // `listening` means "the microphone is being transcribed": only while listening for a turn.
    const payload: StatePayload = {
      conversationId: this.id,
      phase,
      listening: phase === "listening" && this.#listening,
    };
    if (extra.reason !== undefined) payload.reason = extra.reason;
    if (extra.approvalId !== undefined) payload.approvalId = extra.approvalId;
    if (extra.draft !== undefined) payload.draft = extra.draft;
    if (extra.utteranceId !== undefined) payload.utteranceId = extra.utteranceId;
    this.#emit({ event: "voice.conversation.state", payload });
  }

  #emit(event: VoiceConversationEvent): void {
    this.#opts.emit(this.deviceId, event);
  }
}

function errorOf(err: unknown): { code: string; message: string } {
  return err instanceof PsycheError
    ? { code: err.code, message: err.message }
    : { code: "internal", message: "voice conversation failed" };
}

export interface VoiceConversationContext {
  deviceId: string;
  caller: SpeechCaller;
}

/**
 * All voice conversations, one per device. Handlers call it; the Gateway ends a device's
 * conversation on disconnect, screen lock or sleep, and all of them on shutdown.
 */
export class VoiceConversationManager {
  readonly #opts: VoiceConversationOptions;
  readonly #byDevice = new Map<string, VoiceConversation>();
  #counter = 0;

  constructor(options: VoiceConversationOptions) {
    this.#opts = options;
  }

  get active(): number {
    return this.#byDevice.size;
  }

  get(deviceId: string): VoiceConversation | undefined {
    return this.#byDevice.get(deviceId);
  }

  async start(
    p: MethodParams<"voice.conversation.start">,
    ctx: VoiceConversationContext,
  ): Promise<MethodResult<"voice.conversation.start">> {
    if (!isPcm(p.format) || p.format.channels < 1 || p.format.channels > 2) {
      throw new PsycheError(
        "invalid_params",
        "voice conversation audio must be mono or stereo raw PCM",
      );
    }
    if (p.format.sampleRate < 8_000 || p.format.sampleRate > 48_000) {
      throw new PsycheError("invalid_params", "sample rate must be 8–48 kHz");
    }
    // Listen is its own opt-in (the spoken brief setting), checked by the script source.
    let script: VoiceListenScript | undefined;
    if (p.listen !== undefined) {
      if (this.#opts.listen === undefined) {
        throw new PsycheError("unavailable", "Listen is not configured");
      }
      script = await this.#opts.listen(p.listen.notificationId);
    } else if (this.#opts.enabled !== undefined && (await this.#opts.enabled()) !== true) {
      throw new PsycheError(
        "policy_denied",
        "Voice conversation is off. Turn it on in Settings → Voice & dictation.",
      );
    }
    const sel = await this.#opts.selector.select({ purpose: "dictation", caller: ctx.caller });
    if (sel.engine === undefined || sel.location === "client") {
      throw new PsycheError(
        "unavailable",
        "no Gateway speech engine can transcribe a conversation",
        {
          retryable: true,
        },
      );
    }
    // One conversation per device: a new start replaces the old one.
    this.#byDevice.get(ctx.deviceId)?.end("stopped");
    const settings = {
      ...DEFAULT_VOICE_CONVERSATION_SETTINGS,
      ...((await this.#opts.settings?.()) ?? {}),
    };
    const vocabulary = mergeVocabulary((await this.#opts.vocabulary?.()) ?? []);
    const id = this.#opts.newId?.() ?? `vc_${Date.now().toString(36)}_${++this.#counter}`;
    const conv = new VoiceConversation({
      id,
      deviceId: ctx.deviceId,
      threadId: p.threadId ?? script?.threadId ?? null,
      mode: p.mode,
      format: p.format,
      ...(p.language === undefined ? {} : { language: p.language }),
      ...(p.voice === undefined ? {} : { voice: p.voice }),
      vocabulary,
      engine: sel.engine,
      settings,
      options: this.#opts,
      onEnd: (c) => {
        if (this.#byDevice.get(c.deviceId) === c) this.#byDevice.delete(c.deviceId);
      },
    });
    this.#byDevice.set(ctx.deviceId, conv);
    conv.begin();
    if (script !== undefined) conv.say(script.text, script.handOff);
    return { conversationId: id, engine: sel.id, location: sel.location as EngineLocation };
  }

  #own(conversationId: string, ctx: VoiceConversationContext): VoiceConversation {
    const c = this.#byDevice.get(ctx.deviceId);
    // Another device's conversation id is indistinguishable from an unknown one.
    if (c === undefined || c.id !== conversationId) {
      throw new PsycheError("not_found", `no voice conversation ${conversationId}`);
    }
    return c;
  }

  audio(p: MethodParams<"voice.conversation.audio">, ctx: VoiceConversationContext): void {
    this.#own(p.conversationId, ctx).audio(p.seq, p.audio);
  }

  turn(p: MethodParams<"voice.conversation.turn">, ctx: VoiceConversationContext): void {
    this.#own(p.conversationId, ctx).turn(p.action);
  }

  interrupt(p: MethodParams<"voice.conversation.interrupt">, ctx: VoiceConversationContext): void {
    this.#own(p.conversationId, ctx).interrupt(p.stage);
  }

  played(p: MethodParams<"voice.conversation.played">, ctx: VoiceConversationContext): void {
    this.#own(p.conversationId, ctx).played(p.utteranceId, p.done);
  }

  review(p: MethodParams<"voice.conversation.review">, ctx: VoiceConversationContext): void {
    this.#own(p.conversationId, ctx).review(p.utteranceId, p.action, p.text);
  }

  stop(p: MethodParams<"voice.conversation.stop">, ctx: VoiceConversationContext): void {
    this.#own(p.conversationId, ctx).stop();
  }

  /** Ends a device's conversation (disconnect, screen lock, sleep). */
  endForDevice(deviceId: string, reason: VoiceConversationEndReason): void {
    this.#byDevice.get(deviceId)?.end(reason);
  }

  /** Ends every conversation (Gateway shutdown). */
  endAll(reason: VoiceConversationEndReason = "disconnected"): void {
    for (const c of [...this.#byDevice.values()]) c.end(reason);
  }
}
