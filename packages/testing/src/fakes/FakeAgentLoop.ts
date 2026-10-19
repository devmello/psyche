import type { AgentEvent, AgentLoop, StartTurnInput } from "@psyche/protocol";

/** A scripted turn: events without `runId` (filled in from the turn input). */
export type ScriptedAgentEvent = AgentEvent extends infer E
  ? E extends { runId: string }
    ? Omit<E, "runId">
    : never
  : never;

/**
 * Scripted agent loop for Gateway, task engine and UI tests. Each `startTurn` consumes the next
 * scripted turn (default: one delta and `end{final}`). Cancellation ends the stream with
 * `end{cancelled}`. `steer` / `followUp` / `cancel` calls are recorded.
 */
export class FakeAgentLoop implements AgentLoop {
  readonly turns: StartTurnInput[] = [];
  readonly steers: { runId: string; text: string }[] = [];
  readonly followUps: { threadId: string; text: string }[] = [];
  readonly cancelled = new Set<string>();
  #script: ScriptedAgentEvent[][] = [];

  static script(turns: ScriptedAgentEvent[][]): FakeAgentLoop {
    return new FakeAgentLoop().script(turns);
  }

  script(turns: ScriptedAgentEvent[][]): this {
    this.#script = structuredClone(turns);
    return this;
  }

  async *startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
    const { signal, ...recorded } = input;
    this.turns.push(structuredClone(recorded));
    const runId = input.runId;
    const events = this.#script.shift() ?? [
      { type: "run.status", status: "running" },
      { type: "chat.delta", messageId: `msg_${runId}`, delta: "ok" },
      { type: "end", outcome: "final" },
    ];
    for (const e of events) {
      await Promise.resolve();
      if (signal?.aborted === true || this.cancelled.has(runId)) {
        yield { type: "end", runId, outcome: "cancelled" };
        return;
      }
      const event = { ...e, runId } as AgentEvent;
      yield event;
      if (event.type === "end") return;
    }
    yield { type: "end", runId, outcome: "final" };
  }

  async steer(runId: string, text: string): Promise<void> {
    this.steers.push({ runId, text });
  }

  async followUp(threadId: string, text: string): Promise<void> {
    this.followUps.push({ threadId, text });
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }
}
