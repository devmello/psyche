import {
  type AgentEvent,
  type AgentLoop,
  type ApprovalRequest,
  type BindingVerification,
  type DecisionResult,
  type Grant,
  type IssuedApproval,
  type PermissionBroker,
  PsycheError,
  type Receipt,
  type ReceiptInput,
  type StartTurnInput,
  type ToolCallIntent,
} from "@psyche/protocol";

/**
 * Placeholders `psyched` runs with until the real packages are wired in (S02 agent-core,
 * S05 permissions). Tests inject the fakes from `@psyche/testing` instead.
 */

/** Every turn fails cleanly: there is no agent runtime yet. */
export class UnavailableAgentLoop implements AgentLoop {
  async *startTurn(input: StartTurnInput): AsyncIterable<AgentEvent> {
    yield {
      type: "end",
      runId: input.runId,
      outcome: "failed",
      error: "agent runtime not installed (S02)",
    };
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async cancel(): Promise<void> {}
}

/**
 * Fail-closed broker: reads are allowed, every side effect is denied, nothing can be approved.
 * Receipts are kept in memory so callers still get one.
 */
export class LockedPermissionBroker implements PermissionBroker {
  readonly #receipts: Receipt[] = [];
  #n = 0;

  async decide(call: ToolCallIntent): Promise<DecisionResult> {
    if (call.sideEffect === "none" || call.sideEffect === "read") {
      return { decision: "allow", rule: "broker:not_installed/read" };
    }
    return {
      decision: "deny",
      rule: "broker:not_installed",
      reason: "no Permission Broker installed (S05)",
    };
  }
  async requestApproval(): Promise<IssuedApproval> {
    throw new PsycheError("not_implemented", "approvals need the Permission Broker (S05)");
  }
  async answer(): Promise<ApprovalRequest> {
    throw new PsycheError("not_implemented", "approvals need the Permission Broker (S05)");
  }
  async awaitDecision(): Promise<ApprovalRequest> {
    throw new PsycheError("not_implemented", "approvals need the Permission Broker (S05)");
  }
  async verifyBinding(): Promise<BindingVerification> {
    return { ok: false, reason: "not_found" };
  }
  async get(): Promise<ApprovalRequest | undefined> {
    return undefined;
  }
  async list(): Promise<ApprovalRequest[]> {
    return [];
  }
  async reissue(): Promise<IssuedApproval[]> {
    return [];
  }
  async recordReceipt(input: ReceiptInput): Promise<Receipt> {
    const receipt: Receipt = {
      id: `rcpt_${++this.#n}`,
      kind: input.kind,
      taskId: input.taskId ?? null,
      toolCallId: input.toolCallId ?? null,
      approvalId: input.approvalId ?? null,
      outcome: input.outcome,
      summary: input.summary,
      externalRefs: input.externalRefs ?? {},
      payload: input.payload ?? null,
      createdAt: new Date().toISOString(),
    };
    this.#receipts.push(receipt);
    return receipt;
  }
  async listReceipts(): Promise<Receipt[]> {
    return [...this.#receipts];
  }
  async revokeRunAuthority(): Promise<void> {}
  async listGrants(): Promise<Grant[]> {
    return [];
  }
  async revokeGrant(): Promise<Grant> {
    throw new PsycheError("not_found", "no grants");
  }
}
