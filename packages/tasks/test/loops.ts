import type { AgentEvent, AgentLoop, RunOutcome, StartTurnInput } from "@psyche/protocol";
import type { FakeClock } from "@psyche/testing";
import type { Timers } from "../src/index.ts";

type Ev = AgentEvent extends infer E
  ? E extends { runId: string }
    ? Omit<E, "runId">
    : never
  : never;

/** One live turn the test drives event by event. */
export class TurnHandle {
  readonly input: StartTurnInput;
  #queue: AgentEvent[] = [];
  #waiter: (() => void) | undefined;
  #closed = false;

  constructor(input: StartTurnInput) {
    this.input = input;
    input.signal?.addEventListener("abort", () => this.end("cancelled"));
  }

  get runId(): string {
    return this.input.runId;
  }

  emit(e: Ev): void {
    if (this.#closed) return;
    const event = { ...e, runId: this.input.runId } as AgentEvent;
    this.#queue.push(event);
    if (event.type === "end") this.#closed = true;
    this.#waiter?.();
  }

  end(outcome: RunOutcome, error?: string): void {
    this.emit(error === undefined ? { type: "end", outcome } : { type: "end", outcome, error });
  }

  async *stream(): AsyncIterable<AgentEvent> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        if (next.type === "end") return;
        continue;
      }
      await new Promise<void>((r) => {
        this.#waiter = r;
      });
      this.#waiter = undefined;
    }
  }
}

/**
 * An `AgentLoop` whose turns the test drives by hand, so it can stop a turn mid-step (between a
 * tool call's `running` and its result). `cancel` ends the stream with `end{cancelled}`.
 */
export class ControlledLoop implements AgentLoop {
  readonly turns: TurnHandle[] = [];
  readonly cancelled: string[] = [];
  #started: ((t: TurnHandle) => void)[] = [];

  startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
    const turn = new TurnHandle(input);
    this.turns.push(turn);
    for (const s of this.#started.splice(0)) s(turn);
    return turn.stream();
  }

  /** Resolves with the next turn to start (or the latest one if it already started). */
  nextTurn(): Promise<TurnHandle> {
    return new Promise((resolve) => this.#started.push(resolve));
  }

  readonly steered: { runId: string; text: string }[] = [];
  async steer(runId: string, text: string): Promise<void> {
    this.steered.push({ runId, text });
  }
  async followUp(): Promise<void> {}
  async cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
    this.turns.find((t) => t.runId === runId)?.end("cancelled");
  }
}

/** `Timers` on a `FakeClock`: callbacks fire when the test advances the clock. */
export function clockTimers(clock: FakeClock): Timers {
  return {
    setTimeout: (fn, ms) => clock.setTimer(clock.now() + ms, fn),
    clearTimeout: (h) => (h as (() => void) | undefined)?.(),
  };
}

/** `Timers` that never fire: a frozen (crashed or asleep) process. */
export const frozenTimers: Timers = { setTimeout: () => undefined, clearTimeout: () => {} };

/** Let pending promise callbacks run. */
export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((r) => setImmediate(r));
}
