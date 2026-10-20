import type { Receipt } from "@psyche/protocol";
import { ulid } from "ulid";
import type { InvocationContext, ReceiptInput } from "./capabilities/types.ts";
import { SkewClock } from "./clock.ts";

export interface InvocationContextInit {
  invocationId: string;
  capability: string;
  approvalId?: string | undefined;
  signal?: AbortSignal;
  clock?: SkewClock;
  emit?: (data: unknown) => void;
}

/** Builds the context a handler sees. The agent wires `emit` to `node.event`; tests collect. */
export function createInvocationContext(init: InvocationContextInit): InvocationContext {
  const clock = init.clock ?? new SkewClock();
  const approvalId = init.approvalId;
  return {
    invocationId: init.invocationId,
    capability: init.capability,
    approvalId,
    signal: init.signal ?? new AbortController().signal,
    clock,
    emit: init.emit ?? (() => {}),
    receipt(input: ReceiptInput): Receipt {
      return {
        id: `rcpt_${ulid()}`,
        kind: input.kind,
        taskId: null,
        toolCallId: null,
        approvalId: approvalId ?? null,
        outcome: input.outcome,
        summary: input.summary,
        externalRefs: { invocationId: init.invocationId, ...(input.externalRefs ?? {}) },
        payload: (input.payload ?? null) as Receipt["payload"],
        createdAt: clock.iso(),
      };
    },
  };
}
