import type { AgentEvent, AgentLoop, IssuedApproval, StartTurnInput } from "@psyche/protocol";
import { FakePermissionBroker, type ScriptedAgentEvent } from "@psyche/testing";

type Step = ScriptedAgentEvent | { type: "wait"; gate: string } | { type: "do"; fn: () => void };

/**
 * Agent loop driven by the test: each turn plays a script of events, pausing at `wait` steps
 * until the test calls `open(gate)`. Abort ends the turn with `end{cancelled}` at the next step.
 * Without a script a turn streams "ok" and ends.
 */
export class GatedAgentLoop implements AgentLoop {
  readonly turns: StartTurnInput[] = [];
  readonly steers: { runId: string; text: string }[] = [];
  readonly cancels: string[] = [];
  readonly #scripts: Step[][] = [];
  readonly #gates = new Map<string, { open: boolean; waiters: (() => void)[] }>();

  script(...turns: Step[][]): this {
    this.#scripts.push(...turns);
    return this;
  }

  open(gate: string): void {
    const g = this.#gate(gate);
    g.open = true;
    for (const w of g.waiters.splice(0)) w();
  }

  #gate(name: string) {
    let g = this.#gates.get(name);
    if (!g) {
      g = { open: false, waiters: [] };
      this.#gates.set(name, g);
    }
    return g;
  }

  /** Resolves once `n` turns have started. */
  async started(n: number, timeoutMs = 4000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.turns.length < n) {
      if (Date.now() > until) throw new Error(`only ${this.turns.length} turns started`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async *startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
    const { signal, ...rest } = input;
    this.turns.push(rest);
    const steps: Step[] = this.#scripts.shift() ?? [
      { type: "chat.delta", messageId: `m_${input.runId}`, delta: "ok" },
      { type: "end", outcome: "final" },
    ];
    for (const step of steps) {
      if (step.type === "wait") {
        const g = this.#gate(step.gate);
        if (!g.open) {
          await new Promise<void>((resolve) => {
            g.waiters.push(resolve);
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      } else {
        await Promise.resolve();
      }
      if (signal?.aborted || this.cancels.includes(input.runId)) {
        yield { type: "end", runId: input.runId, outcome: "cancelled" };
        return;
      }
      if (step.type === "wait") continue;
      if (step.type === "do") {
        step.fn();
        continue;
      }
      yield { ...step, runId: input.runId } as AgentEvent;
      if (step.type === "end") return;
    }
    yield { type: "end", runId: input.runId, outcome: "final" };
  }

  async steer(runId: string, text: string): Promise<void> {
    this.steers.push({ runId, text });
  }

  async followUp(): Promise<void> {}

  async cancel(runId: string): Promise<void> {
    this.cancels.push(runId);
  }
}

/** Fake broker that also records revocations and keeps the answer tokens it issued. */
export class RecordingBroker extends FakePermissionBroker {
  readonly revoked: string[] = [];
  readonly issued: IssuedApproval[] = [];

  override async revokeRunAuthority(runId: string): Promise<void> {
    this.revoked.push(runId);
    return super.revokeRunAuthority(runId);
  }

  override async requestApproval(input: Parameters<FakePermissionBroker["requestApproval"]>[0]) {
    const issued = await super.requestApproval(input);
    this.issued.push(issued);
    return issued;
  }
}
