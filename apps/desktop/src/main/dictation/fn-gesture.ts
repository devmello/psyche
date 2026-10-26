/**
 * The fn key's gesture timing. fn/🌐 is also macOS's input-source switch, so a quick tap must not
 * start dictation: only a press held for `FN_HOLD_MS` is a hold, and two quick taps are a double
 * tap (opens "Ask about my screen"). The helper only watches (it never swallows the key), so a
 * tap reaches macOS untouched; this just decides what Psyche does with it.
 */
export const FN_HOLD_MS = 250;
/** Longest gap from the first tap's release to the second press for a double tap. */
export const FN_DOUBLE_TAP_GAP_MS = 300;

export type FnState = "idle" | "pressed" | "held" | "tapped" | "pressed2";
export type FnInput = "down" | "up" | "holdTimer" | "gapTimer";
export type FnAction = "holdStart" | "holdEnd" | "doubleTap";
/** What the driver must arm after a transition. */
export type FnTimer = "hold" | "gap" | null;

export interface FnStep {
  state: FnState;
  actions: FnAction[];
  /** Timer to (re)start; any timer not named here is cancelled. */
  timer: FnTimer;
}

const stay = (state: FnState): FnStep => ({ state, actions: [], timer: null });

/** Pure transition: tap / hold / double-tap. */
export function fnStep(state: FnState, input: FnInput): FnStep {
  switch (state) {
    case "idle":
      return input === "down" ? { state: "pressed", actions: [], timer: "hold" } : stay(state);
    case "pressed":
      if (input === "up") return { state: "tapped", actions: [], timer: "gap" };
      if (input === "holdTimer") return { state: "held", actions: ["holdStart"], timer: null };
      return stay(state);
    case "held":
      return input === "up" ? { state: "idle", actions: ["holdEnd"], timer: null } : stay(state);
    case "tapped":
      if (input === "down") return { state: "pressed2", actions: [], timer: "hold" };
      if (input === "gapTimer") return stay("idle");
      return stay(state);
    case "pressed2":
      if (input === "up") return { state: "idle", actions: ["doubleTap"], timer: null };
      // The second press outlasted a tap: it is a plain hold; the first tap is dropped.
      if (input === "holdTimer") return { state: "held", actions: ["holdStart"], timer: null };
      return stay(state);
  }
}

export interface FnGestureHandlers {
  onHoldStart(): void;
  onHoldEnd(): void;
  onDoubleTap(): void;
}

/** `fnStep` driven by real timers. */
export class FnGesture {
  #state: FnState = "idle";
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #h: FnGestureHandlers;
  readonly #holdMs: number;
  readonly #gapMs: number;

  constructor(handlers: FnGestureHandlers, holdMs = FN_HOLD_MS, gapMs = FN_DOUBLE_TAP_GAP_MS) {
    this.#h = handlers;
    this.#holdMs = holdMs;
    this.#gapMs = gapMs;
  }

  key(down: boolean): void {
    this.#feed(down ? "down" : "up");
  }

  /** Drops any pending gesture (key unarmed, disconnected). Ends a hold in progress. */
  reset(): void {
    const wasHeld = this.#state === "held";
    clearTimeout(this.#timer);
    this.#state = "idle";
    if (wasHeld) this.#h.onHoldEnd();
  }

  #feed(input: FnInput): void {
    const step = fnStep(this.#state, input);
    this.#state = step.state;
    clearTimeout(this.#timer);
    if (step.timer) {
      const timer: FnInput = step.timer === "hold" ? "holdTimer" : "gapTimer";
      this.#timer = setTimeout(
        () => this.#feed(timer),
        step.timer === "hold" ? this.#holdMs : this.#gapMs,
      );
    }
    for (const a of step.actions) {
      if (a === "holdStart") this.#h.onHoldStart();
      else if (a === "holdEnd") this.#h.onHoldEnd();
      else this.#h.onDoubleTap();
    }
  }
}
