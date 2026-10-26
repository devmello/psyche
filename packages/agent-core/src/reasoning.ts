/** One `reasoning` loop event without the run and message ids. */
export interface ReasoningStepEvent {
  stepId: string;
  delta?: string;
  summary?: string;
  done?: boolean;
}

/** Characters held back so a secret split across deltas is masked before any of it leaves. */
export const REASONING_HOLDBACK = 128;

/**
 * Turns a model call's reasoning deltas into steps for the run's step log: one step per
 * contiguous reasoning block, opened by its first delta and closed (`done`) by anything else
 * the model streams. Text is redacted over the whole step, and the last `REASONING_HOLDBACK`
 * characters wait until the step closes, so a secret split across deltas is never emitted in
 * part. Reasoning text is display-only: it is never added to the transcript.
 */
export class ReasoningSteps {
  readonly #emit: (e: ReasoningStepEvent) => void;
  readonly #nextId: () => string;
  readonly #redact: (text: string) => string;
  #open: { id: string; raw: string; sent: string } | undefined;

  constructor(
    emit: (e: ReasoningStepEvent) => void,
    nextId: () => string,
    redact: (text: string) => string = (t) => t,
  ) {
    this.#emit = emit;
    this.#nextId = nextId;
    this.#redact = redact;
  }

  delta(text: string): void {
    if (text.length === 0) return;
    this.#open ??= { id: this.#nextId(), raw: "", sent: "" };
    this.#open.raw += text;
    this.#flush(false);
  }

  /** A provider summary: closes the open step with it, or forms a step of its own. */
  summary(text: string): void {
    const summary = this.#redact(text).trim();
    if (summary.length === 0) return;
    if (this.#open === undefined) {
      this.#emit({ stepId: this.#nextId(), summary, done: true });
      return;
    }
    const rest = this.#flush(true);
    this.#emit({
      stepId: this.#open.id,
      ...(rest === "" ? {} : { delta: rest }),
      summary,
      done: true,
    });
    this.#open = undefined;
  }

  /** Close the open step, if any (the block ended, or the model moved on). */
  close(): void {
    if (this.#open === undefined) return;
    const rest = this.#flush(true);
    this.#emit({ stepId: this.#open.id, ...(rest === "" ? {} : { delta: rest }), done: true });
    this.#open = undefined;
  }

  /** Emit newly safe text; with `final`, returns the remainder instead of emitting it. */
  #flush(final: boolean): string {
    const step = this.#open;
    if (step === undefined) return "";
    const redacted = this.#redact(step.raw);
    // If masking changed text already sent, send nothing more than what still lines up.
    if (!redacted.startsWith(step.sent)) return "";
    const end = final
      ? redacted.length
      : Math.max(step.sent.length, redacted.length - REASONING_HOLDBACK);
    const chunk = redacted.slice(step.sent.length, end);
    if (chunk === "") return "";
    step.sent += chunk;
    if (final) return chunk;
    this.#emit({ stepId: step.id, delta: chunk });
    return "";
  }
}
