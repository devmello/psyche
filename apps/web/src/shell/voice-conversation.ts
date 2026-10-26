import type { VoiceConversationMode } from "@psyche/protocol";
import type { VoiceTerminal } from "@psyche/ui";
import { BARGE_IN_PROFILE, EnergyVad } from "./vad.ts";
import { type AudioSource, pcmChunkToBase64, toPcm16, VOICE_FORMAT } from "./voice.ts";

/**
 * The renderer as the voice conversation's audio terminal (docs/voice/voice-mode-2026.md §3
 * decisions 6–7, §4.1–§4.3, §6.3): it captures with echo cancellation, streams
 * `voice.conversation.audio`, plays `voice.conversation.speech` as it arrives and reports what
 * was heard with `played`, detects barge-in, and measures input and output levels for the lantern.
 * The Gateway (V-G's VoiceConversation) runs the turns.
 *
 * The microphone is honest: push-to-talk opens it only while the key is held, plus a 250 ms tail;
 * tap and hands-free keep it open for the conversation unless the owner mutes. Every ending
 * releases it.
 */

export type ConversationCall = (method: string, params: unknown) => Promise<unknown>;
export type EventTap = (listener: (event: string, payload: unknown) => void) => () => void;

/** Plays PCM per utterance with a volume (barge-in ducks it) and an output level. */
export interface ConversationPlayer {
  enqueue(utteranceId: string, pcm: Int16Array, sampleRate: number, last: boolean): void;
  /** Stops at once; returns what was heard of the current utterance. */
  stop(): { utteranceId: string; playedMs: number } | null;
  /** 1 or a duck (0.3). */
  setVolume(volume: number): void;
  /** Called when an utterance finished playing (all its chunks, `last` seen). */
  onFinished(cb: (utteranceId: string, playedMs: number) => void): void;
  readonly playing: boolean;
  /** Epoch ms when the last buffer ended (the echo tail starts there). */
  readonly endedAt: number;
  level(): number;
  close(): void;
}

/** The push-to-talk tail after the key comes up (§3 decision 7). */
export const PUSH_TAIL_MS = 250;
/** A suspected barge-in the Gateway doesn't confirm within this is released (§4.2). */
export const SUSPECT_MS = 1000;
/** The VAD ignores this long after the last buffer played: echo tails (§4.2). */
export const ECHO_TAIL_MS = 600;
export const DUCK_VOLUME = 0.3;

function rms(frames: Float32Array): number {
  let sum = 0;
  for (const v of frames) sum += v * v;
  return frames.length === 0 ? 0 : Math.sqrt(sum / frames.length);
}

function decodePcm(base64: string): Int16Array {
  const bin = atob(base64);
  const n = Math.floor(bin.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

export interface VoiceConversationTerminalOptions {
  call: ConversationCall;
  tap: EventTap;
  source: AudioSource;
  player: () => ConversationPlayer;
  /** Barge-in by talking (Settings → Interrupt by talking). */
  bargeIn: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export class VoiceConversationTerminal implements VoiceTerminal {
  private readonly o: Required<VoiceConversationTerminalOptions>;
  private conversationId: string | null = null;
  private mode: VoiceConversationMode = "push";
  private seq = 0;
  private stopMic: (() => void) | null = null;
  private micOpening: Promise<void> | null = null;
  /** Whether captured audio is sent (push: while held + tail; tap / hands-free: unless muted). */
  private sending = false;
  private muted = false;
  private tail: unknown = null;
  private suspect: unknown = null;
  private inputLevel = 0;
  private player: ConversationPlayer | null = null;
  private offEvents: (() => void) | null = null;
  private readonly vad: EnergyVad;

  constructor(options: VoiceConversationTerminalOptions) {
    this.o = {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      ...options,
    };
    this.vad = new EnergyVad((e) => {
      if (e === "start") this.suspectBargeIn();
    }, BARGE_IN_PROFILE);
  }

  get active(): boolean {
    return this.conversationId !== null;
  }

  /** Whether the microphone is open (tests and the HUD's indicator check it against the chip). */
  get micOpen(): boolean {
    return this.stopMic !== null;
  }

  async start(options: { threadId: string | null; mode: VoiceConversationMode }): Promise<string> {
    if (this.conversationId) this.end();
    this.mode = options.mode;
    this.muted = false;
    this.seq = 0;
    // Tap and hands-free listen from the start; push-to-talk opens the mic per turn.
    if (this.mode !== "push") await this.openMic();
    let res: { conversationId: string };
    try {
      res = (await this.o.call("voice.conversation.start", {
        ...(options.threadId ? { threadId: options.threadId } : {}),
        mode: this.mode,
        format: VOICE_FORMAT,
      })) as { conversationId: string };
    } catch (err) {
      this.closeMic();
      throw err;
    }
    this.conversationId = res.conversationId;
    this.sending = this.mode !== "push";
    this.player = this.o.player();
    this.player.onFinished((utteranceId, playedMs) => this.report(utteranceId, playedMs, true));
    this.offEvents = this.o.tap((event, payload) => this.onEvent(event, payload));
    return res.conversationId;
  }

  turn(action: "begin" | "end"): void {
    if (!this.conversationId) return;
    if (action === "begin") {
      // Push-to-talk barge-in is the key itself: playback stops at once, no confirmation.
      if (this.player?.playing) this.interrupt("confirmed");
      if (this.tail !== null) {
        this.o.clearTimer(this.tail);
        this.tail = null;
      }
      if (this.mode === "push") {
        this.sending = true;
        void this.openMic().catch(() => undefined);
      }
      this.send("voice.conversation.turn", { action });
      return;
    }
    this.send("voice.conversation.turn", { action });
    if (this.mode === "push") {
      // Keep the last 250 ms so the end of the sentence isn't cut, then close the mic.
      this.tail = this.o.setTimer(() => {
        this.tail = null;
        this.sending = false;
        this.closeMic();
      }, PUSH_TAIL_MS);
    }
  }

  mute(muted: boolean): void {
    this.muted = muted;
    if (!this.conversationId) return;
    if (muted) {
      this.sending = false;
      this.closeMic();
    } else if (this.mode !== "push") {
      this.sending = true;
      void this.openMic().catch(() => undefined);
    }
  }

  stopSpeaking(): void {
    if (this.conversationId && this.player?.playing) this.interrupt("confirmed");
  }

  end(): void {
    const id = this.conversationId;
    this.teardown();
    if (id)
      void this.o.call("voice.conversation.stop", { conversationId: id }).catch(() => undefined);
  }

  levels(): { input: number; output: number } {
    return { input: this.stopMic ? this.inputLevel : 0, output: this.player?.level() ?? 0 };
  }

  // --- internals ------------------------------------------------------------------------------

  private teardown(): void {
    this.offEvents?.();
    this.offEvents = null;
    if (this.tail !== null) this.o.clearTimer(this.tail);
    if (this.suspect !== null) this.o.clearTimer(this.suspect);
    this.tail = null;
    this.suspect = null;
    this.player?.close();
    this.player = null;
    this.sending = false;
    this.closeMic();
    this.conversationId = null;
    this.inputLevel = 0;
  }

  private async openMic(): Promise<void> {
    if (this.stopMic || this.micOpening) return this.micOpening ?? undefined;
    this.micOpening = this.o.source
      .start((frames, rate) => this.onFrames(frames, rate))
      .then((stop) => {
        this.micOpening = null;
        // Ended or muted while the prompt was up: release at once.
        if ((this.mode === "push" && !this.conversationId) || this.muted) {
          stop();
          return;
        }
        this.stopMic = stop;
      })
      .catch((err: unknown) => {
        this.micOpening = null;
        throw err;
      });
    return this.micOpening;
  }

  private closeMic(): void {
    this.stopMic?.();
    this.stopMic = null;
    this.inputLevel = 0;
  }

  private onFrames(frames: Float32Array, rate: number): void {
    this.inputLevel = rms(frames);
    if (!this.conversationId) return;
    // Barge-in by talking: only while Psyche speaks, past the echo tail, never in push mode.
    if (
      this.mode !== "push" &&
      this.o.bargeIn() &&
      (this.player?.playing ?? false) &&
      this.o.now() - (this.player?.endedAt ?? 0) > ECHO_TAIL_MS
    ) {
      this.vad.push(frames, rate);
    }
    if (!this.sending) return;
    const pcm = toPcm16(frames, rate);
    if (pcm.length === 0) return;
    this.send("voice.conversation.audio", { seq: this.seq++, audio: pcmChunkToBase64(pcm) });
  }

  /** Two-step barge-in (§4.2): duck and tell the Gateway; it confirms with a word or lets go. */
  private suspectBargeIn(): void {
    if (!this.player?.playing || this.suspect !== null) return;
    this.player.setVolume(DUCK_VOLUME);
    this.send("voice.conversation.interrupt", { stage: "suspect" });
    this.suspect = this.o.setTimer(() => {
      this.suspect = null;
      this.player?.setVolume(1);
      this.vad.reset();
    }, SUSPECT_MS);
  }

  private interrupt(stage: "suspect" | "confirmed"): void {
    const heard = this.player?.stop() ?? null;
    if (this.suspect !== null) {
      this.o.clearTimer(this.suspect);
      this.suspect = null;
    }
    this.vad.reset();
    this.send("voice.conversation.interrupt", {
      stage,
      ...(heard ? { playedMs: Math.round(heard.playedMs) } : {}),
    });
    if (heard) this.report(heard.utteranceId, heard.playedMs, false);
  }

  private report(utteranceId: string, playedMs: number, done: boolean): void {
    this.send("voice.conversation.played", {
      utteranceId,
      playedMs: Math.max(0, Math.round(playedMs)),
      done,
    });
  }

  private send(method: string, params: Record<string, unknown>): void {
    const conversationId = this.conversationId;
    if (!conversationId) return;
    void this.o.call(method, { conversationId, ...params }).catch(() => undefined);
  }

  private onEvent(event: string, payload: unknown): void {
    const p = payload as { conversationId?: string } | null;
    if (!p || p.conversationId !== this.conversationId) return;
    if (event === "voice.conversation.speech") {
      const s = payload as {
        utteranceId: string;
        audio: string;
        format: { sampleRate: number };
        last: boolean;
      };
      this.player?.enqueue(s.utteranceId, decodePcm(s.audio), s.format.sampleRate, s.last);
    } else if (event === "voice.conversation.state") {
      const s = payload as { phase: string; reason?: string };
      // A confirmed barge-in: the Gateway heard a word that isn't in the sentence being spoken.
      if (s.phase === "listening" && s.reason === "barge_in" && this.player?.playing) {
        const heard = this.player.stop();
        if (this.suspect !== null) {
          this.o.clearTimer(this.suspect);
          this.suspect = null;
        }
        if (heard) this.report(heard.utteranceId, heard.playedMs, false);
      }
    } else if (event === "voice.conversation.ended") {
      this.teardown();
    }
  }
}

/**
 * Web Audio playback for the terminal: chunks scheduled back to back on one context, through a
 * gain (barge-in ducks it) and an analyser (the lantern's output level).
 */
export function webConversationPlayer(): ConversationPlayer {
  const Ctx = (globalThis as unknown as { AudioContext?: new () => AudioContext }).AudioContext;
  let finished: (utteranceId: string, playedMs: number) => void = () => {};
  if (!Ctx) {
    return {
      enqueue: () => {},
      stop: () => null,
      setVolume: () => {},
      onFinished: (cb) => {
        finished = cb;
      },
      playing: false,
      endedAt: 0,
      level: () => 0,
      close: () => {},
    };
  }
  const ctx = new Ctx();
  const gain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  gain.connect(analyser);
  analyser.connect(ctx.destination);
  const samples = new Float32Array(analyser.fftSize);
  let at = 0;
  let endedAt = 0;
  const sources = new Set<AudioBufferSourceNode>();
  // Per utterance: when it started on the context clock, how long it is, and whether `last` came.
  const utterances = new Map<
    string,
    { start: number; duration: number; last: boolean; pending: number }
  >();
  let current: string | null = null;
  const player: ConversationPlayer = {
    enqueue(utteranceId, pcm, rate, last) {
      if (pcm.length === 0 && !last) return;
      const u = utterances.get(utteranceId) ?? { start: 0, duration: 0, last: false, pending: 0 };
      utterances.set(utteranceId, u);
      u.last ||= last;
      if (pcm.length === 0) return;
      const buf = ctx.createBuffer(1, pcm.length, rate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = (pcm[i] ?? 0) / 0x8000;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      at = Math.max(at, ctx.currentTime);
      if (u.duration === 0) u.start = at;
      src.start(at);
      at += buf.duration;
      u.duration += buf.duration;
      u.pending += 1;
      current = utteranceId;
      sources.add(src);
      src.onended = () => {
        sources.delete(src);
        u.pending -= 1;
        endedAt = Date.now();
        if (u.pending === 0 && u.last) {
          utterances.delete(utteranceId);
          finished(utteranceId, u.duration * 1000);
        }
      };
    },
    stop() {
      const id = current;
      const u = id ? utterances.get(id) : undefined;
      const heard =
        id && u
          ? { utteranceId: id, playedMs: Math.max(0, (ctx.currentTime - u.start) * 1000) }
          : null;
      for (const s of sources) {
        s.onended = null;
        try {
          s.stop();
        } catch {
          // already stopped
        }
      }
      sources.clear();
      utterances.clear();
      current = null;
      at = ctx.currentTime;
      endedAt = Date.now();
      gain.gain.value = 1;
      return heard;
    },
    setVolume(v) {
      gain.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    },
    onFinished(cb) {
      finished = cb;
    },
    get playing() {
      return sources.size > 0;
    },
    get endedAt() {
      return endedAt;
    },
    level() {
      if (sources.size === 0) return 0;
      analyser.getFloatTimeDomainData(samples);
      return rms(samples);
    },
    close() {
      player.stop();
      void ctx.close().catch(() => undefined);
    },
  };
  return player;
}
