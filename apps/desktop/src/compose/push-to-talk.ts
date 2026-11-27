import type { VoiceState } from "../shell/voice.ts";

/** The parts of `VoiceCapture` that push-to-talk drives. */
export interface PushToTalkCapture {
  start(): Promise<void>;
  stop(): Promise<string>;
  cancel(): void;
  getState(): VoiceState;
}

/**
 * Hold-to-talk for the ask panel's voice mode: the voice key going down starts dictation, going
 * up finishes it and hands the words to `onDone`. A release that comes while `voice.start` is
 * still in flight finishes as soon as the microphone is listening (feed every capture state to
 * `onState`), so a quick tap never leaves the microphone open. Nothing is spoken back.
 */
export class PushToTalk {
  readonly #capture: PushToTalkCapture;
  readonly #onDone: (text: string) => void;
  #held = false;
  #releasePending = false;
  /** Bumped by `cancel`, so a finish already in flight sends nothing. */
  #generation = 0;

  constructor(capture: PushToTalkCapture, onDone: (text: string) => void) {
    this.#capture = capture;
    this.#onDone = onDone;
  }

  get held(): boolean {
    return this.#held;
  }

  /** Key down (or the panel opening in voice mode). Repeats while held are ignored. */
  down(): void {
    if (this.#held) return;
    this.#held = true;
    this.#releasePending = false;
    void this.#capture.start();
  }

  /** Key up: finish what was heard, now or once listening has begun. */
  up(): void {
    this.#held = false;
    const { phase } = this.#capture.getState();
    if (phase === "listening") void this.#finish();
    else if (phase === "starting") this.#releasePending = true;
  }

  /** Every capture state, in order. */
  onState(s: VoiceState): void {
    if (s.phase === "starting") return;
    const finish = this.#releasePending && s.phase === "listening";
    this.#releasePending = false;
    // After `start` has settled its own bookkeeping.
    if (finish) void Promise.resolve().then(() => this.#finish());
  }

  /** Esc or the panel closing: drop what was heard, send nothing. */
  cancel(): void {
    this.#held = false;
    this.#releasePending = false;
    this.#generation++;
    this.#capture.cancel();
  }

  async #finish(): Promise<void> {
    const gen = this.#generation;
    const said = (await this.#capture.stop()).trim();
    if (said !== "" && gen === this.#generation) this.#onDone(said);
  }
}
