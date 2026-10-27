import {
  type AgentToolRegistration,
  bindingHash,
  paramsHash,
  type ToolRunContext,
} from "@psyche/agent-core";
import type { PolicyBatchInput, PolicyCall } from "@psyche/permissions";
import {
  type ActionCall,
  type ActionCallResult,
  type ActionProposal,
  type ApprovalRequest,
  type BindingVerification,
  type Clock,
  type IssuedApproval,
  namespacedGrantKey,
  PsycheError,
  type Receipt,
  type ReceiptInput,
  type SideEffect,
  type Surface,
  type TaintSource,
} from "@psyche/protocol";
import { ulid } from "ulid";
import { type SqliteDatabase, toIso } from "../sqlite.ts";
import { ProposalStore, type StoredProposal, toActionProposal } from "./store.ts";

/**
 * Batch proposals (docs/workflows/mail-and-meetings-2026.md §8.1, §7.2; #670 W2).
 *
 *   create(calls) ─▶ pending row ─▶ approve() ─▶ broker.requestBatch (every call decided now;
 *     refused when any call is denied, above `write`, a send or a device-only kind)
 *     ─▶ one `batch` card ─▶ the owner answers ─▶ the broker mints one approved child per call
 *     ─▶ run each child: verifyBinding (consumed once) ─▶ the tool with the child as its
 *     authority ─▶ per-call results (`done`, `partial`, `failed`) ─▶ undo for 30 s when every
 *     call has an inverse.
 *
 * The calls that run are the broker's stored calls, not this table's copy, so editing a row
 * after approval changes nothing. Hooks and plugins that the agent loop runs before a call do
 * not run here; the broker's decision at request time does (see the PR notes).
 */

export const MAX_PROPOSAL_CALLS = 100;
export const PROPOSAL_TTL_MS = 24 * 3_600_000;
export const UNDO_WINDOW_MS = 30_000;

const SEVERITY: Record<SideEffect, number> = {
  none: 0,
  read: 1,
  write: 2,
  destructive: 3,
  financial: 4,
};

export type ProposalEvent = { event: "proposal.updated"; payload: { proposal: ActionProposal } };

/** What the service needs from the Permission Broker (`PsychePermissionBroker` fits). */
export interface BatchBroker {
  requestBatch(input: PolicyBatchInput): Promise<IssuedApproval>;
  batchChildren(
    batchApprovalId: string,
  ): Promise<{ approval: ApprovalRequest; call: PolicyCall; summary: string }[]>;
  verifyBinding(approvalId: string, bindingHash: string): Promise<BindingVerification>;
  recordReceipt(input: ReceiptInput): Promise<Receipt>;
  subscribe(listener: (e: { type: string; approval?: ApprovalRequest }) => void): () => void;
}

export interface ToolLookup {
  get(name: string):
    | AgentToolRegistration
    | {
        spec: AgentToolRegistration["spec"];
        execute: AgentToolRegistration["execute"];
        describeCall?: AgentToolRegistration["describeCall"];
      }
    | undefined;
}

/** The inverse of a reversible call (undo), or `undefined` when there is none. */
export type Inverse = (call: ActionCall) => ActionCall | undefined;

/** Mark read / unread and flag / unflag (Apple Mail M7); Gmail label changes. */
export const DEFAULT_INVERSES: Readonly<Record<string, Inverse>> = {
  mail_set_flags: (c) => {
    const p = c.params as { read?: boolean; flagged?: boolean };
    if (p.read === undefined && p.flagged === undefined) return undefined;
    return {
      tool: c.tool,
      params: {
        ...c.params,
        ...(p.read === undefined ? {} : { read: !p.read }),
        ...(p.flagged === undefined ? {} : { flagged: !p.flagged }),
      },
      summary: `Undo: ${c.summary}`,
    };
  },
  gmail_modify_labels: (c) => {
    const p = c.params as { add?: unknown; remove?: unknown };
    return {
      tool: c.tool,
      params: { ...c.params, add: p.remove ?? [], remove: p.add ?? [] },
      summary: `Undo: ${c.summary}`,
    };
  },
};

export interface ProposalServiceOptions {
  db: SqliteDatabase;
  clock: Clock;
  broker: BatchBroker;
  tools: ToolLookup;
  /** The thread a proposal's calls run in when its creator names none (the main chat). */
  mainThread: () => Promise<string>;
  surfaces?: Surface[];
  newId?: () => string;
  onEvent?: (event: ProposalEvent) => void;
  inverses?: Readonly<Record<string, Inverse>>;
  onError?: (error: unknown) => void;
}

export interface CreateProposalInput {
  title: string;
  calls: ActionCall[];
  createdBy: ActionProposal["createdBy"];
  postId?: string | null;
  threadId?: string | null;
  taint?: boolean;
  taintSources?: TaintSource[];
  ttlMs?: number;
  undoOf?: string;
}

function bad(message: string): never {
  throw new PsycheError("invalid_params", message);
}

export class ProposalService {
  readonly store: ProposalStore;
  readonly #o: ProposalServiceOptions;
  readonly #inflight = new Set<Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(options: ProposalServiceOptions) {
    this.#o = options;
    this.store = new ProposalStore(options.db);
    this.#unsubscribe = options.broker.subscribe((e) => this.#onBroker(e));
  }

  stop(): void {
    this.#unsubscribe();
  }

  /** Resolves when every running proposal has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all([...this.#inflight]);
  }

  #now(): string {
    return toIso(this.#o.clock.now());
  }

  #emit(p: StoredProposal): void {
    this.#o.onEvent?.({ event: "proposal.updated", payload: { proposal: toActionProposal(p) } });
  }

  #save(p: StoredProposal): StoredProposal {
    const next = { ...p, updatedAt: this.#now() };
    this.store.update(next);
    this.#emit(next);
    return next;
  }

  #get(id: string): StoredProposal {
    this.#sweep();
    const p = this.store.get(id);
    if (p === undefined) throw new PsycheError("not_found", `proposal ${id} not found`);
    return p;
  }

  /** Pending proposals past their expiry become `expired`. */
  #sweep(): void {
    const now = this.#o.clock.now();
    for (const p of this.store.list({ status: ["pending"], limit: 500 }).proposals) {
      if (Date.parse(p.expiresAt) <= now) this.#save({ ...p, status: "expired" });
    }
  }

  // --- create, read ----------------------------------------------------------------------------

  create(input: CreateProposalInput): ActionProposal {
    if (input.title.trim() === "") bad("a proposal needs a title");
    if (input.calls.length === 0 || input.calls.length > MAX_PROPOSAL_CALLS) {
      bad(`a proposal holds 1 to ${MAX_PROPOSAL_CALLS} calls`);
    }
    for (const c of input.calls) {
      const reg = this.#o.tools.get(c.tool);
      if (reg === undefined) bad(`unknown tool ${c.tool}`);
      if (SEVERITY[reg.spec.sideEffect] > SEVERITY.write) {
        throw new PsycheError(
          "policy_denied",
          `${c.tool} is ${reg.spec.sideEffect}; a batch holds write actions only`,
        );
      }
    }
    const nowMs = this.#o.clock.now();
    const now = toIso(nowMs);
    const p: StoredProposal = {
      id: this.#o.newId?.() ?? ulid(nowMs),
      title: input.title.trim().slice(0, 200),
      calls: structuredClone(input.calls),
      sideEffect: "write",
      status: "pending",
      createdBy: { ...input.createdBy },
      postId: input.postId ?? null,
      approvalId: null,
      taint: input.taint === true || (input.taintSources?.length ?? 0) > 0,
      ...(input.taintSources === undefined
        ? {}
        : { taintSources: structuredClone(input.taintSources) }),
      undoOf: input.undoOf ?? null,
      createdAt: now,
      expiresAt: toIso(nowMs + (input.ttlMs ?? PROPOSAL_TTL_MS)),
      updatedAt: now,
      threadId: input.threadId ?? null,
      finishedAt: null,
    };
    this.store.insert(p);
    this.#emit(p);
    return toActionProposal(p);
  }

  list(filter: Parameters<ProposalStore["list"]>[0] = {}) {
    this.#sweep();
    const page = this.store.list(filter);
    return { proposals: page.proposals.map(toActionProposal), nextCursor: page.nextCursor };
  }

  get(id: string): ActionProposal {
    return toActionProposal(this.#get(id));
  }

  // --- approve ---------------------------------------------------------------------------------

  /** The intent the agent loop would build for this call (same hashing and binding rules). */
  #intent(c: ActionCall, index: number, proposalId: string): PolicyCall {
    const reg = this.#o.tools.get(c.tool);
    if (reg === undefined) bad(`unknown tool ${c.tool}`);
    const invalid = "validate" in reg ? reg.validate?.(c.params) : undefined;
    if (invalid !== undefined) bad(`call ${index + 1} (${c.tool}): ${invalid}`);
    const desc = reg.describeCall?.(c.params) ?? {};
    const sideEffect =
      desc.sideEffect !== undefined && SEVERITY[desc.sideEffect] > SEVERITY[reg.spec.sideEffect]
        ? desc.sideEffect
        : reg.spec.sideEffect;
    const args = structuredClone(c.params);
    const hash = paramsHash(args);
    const kind = desc.kind;
    const target = desc.target;
    const targetKind = target?.kind ?? reg.spec.targetKind;
    return {
      tool: c.tool,
      toolCallId: `${proposalId}:${index}`,
      sideEffect,
      ...(targetKind === undefined ? {} : { targetKind }),
      ...(target === undefined ? {} : { target }),
      params: args,
      paramsHash: hash,
      ...(kind === undefined
        ? {}
        : {
            kind,
            bindingHash: bindingHash(kind, {
              tool: c.tool,
              paramsHash: hash,
              ...(desc.bindingFields === undefined ? {} : { fields: desc.bindingFields }),
            }),
          }),
      ...(desc.grantKey === undefined
        ? {}
        : { grantKey: namespacedGrantKey(c.tool, desc.grantKey) }),
      ...(desc.connectorRule === undefined ? {} : { connectorRule: { ...desc.connectorRule } }),
    };
  }

  /**
   * Requests the one batch approval (spec §8.1). Returns the card and the answer tokens; the
   * calls run once the owner approves it (`approvals.answer`).
   */
  async approve(id: string): Promise<{ proposal: ActionProposal; issued: IssuedApproval }> {
    const p = this.#get(id);
    if (p.status !== "pending") throw new PsycheError("conflict", `proposal ${id} is ${p.status}`);
    const threadId = p.threadId ?? (await this.#o.mainThread());
    const runId = `batch_${p.id}`;
    const issued = await this.#o.broker.requestBatch({
      title: p.title,
      children: p.calls.map((c, i) => ({ call: this.#intent(c, i, p.id), summary: c.summary })),
      context: {
        threadId,
        runId,
        permissionMode: "balanced",
        taint: p.taint,
        ...(p.taintSources === undefined ? {} : { taintSources: p.taintSources }),
      },
      requestedBy: { runId, taskId: null, threadId },
      surfaces: this.#o.surfaces ?? ["desktop", "web"],
      details: { proposalId: p.id, job: p.createdBy.job },
      ...(p.taintSources === undefined ? {} : { taintSources: p.taintSources }),
    });
    const next = this.#save({
      ...p,
      threadId,
      status: "awaiting_approval",
      approvalId: issued.approval.id,
    });
    // A standing grant for prep notes approved the batch inside requestBatch, before the proposal
    // knew its approval id, so no `approval.decided` reached #onBroker: run it now.
    if (issued.approval.status === "approved") this.#start(next);
    return { proposal: toActionProposal(this.#get(id)), issued };
  }

  dismiss(id: string): ActionProposal {
    const p = this.#get(id);
    if (p.status !== "pending" && p.status !== "awaiting_approval") {
      throw new PsycheError("conflict", `proposal ${id} is ${p.status}`);
    }
    return toActionProposal(this.#save({ ...p, status: "dismissed" }));
  }

  /** The inverse proposal of a finished one, within 30 s, when every call has an inverse. */
  undo(id: string): ActionProposal {
    const p = this.#get(id);
    if (p.status !== "done" && p.status !== "partial") {
      throw new PsycheError("conflict", `proposal ${id} has not run`);
    }
    if (p.finishedAt === null || this.#o.clock.now() - Date.parse(p.finishedAt) > UNDO_WINDOW_MS) {
      throw new PsycheError("conflict", "the undo window has passed");
    }
    const inverses = this.#o.inverses ?? DEFAULT_INVERSES;
    const okIdx = new Set((p.results ?? []).filter((r) => r.status === "ok").map((r) => r.index));
    const calls: ActionCall[] = [];
    for (const [i, c] of p.calls.entries()) {
      if (!okIdx.has(i)) continue;
      const inv = inverses[c.tool]?.(c);
      if (inv === undefined) throw new PsycheError("conflict", `${c.tool} cannot be undone`);
      calls.unshift(inv);
    }
    if (calls.length === 0) throw new PsycheError("conflict", "nothing to undo");
    return this.create({
      title: `Undo: ${p.title}`,
      calls,
      createdBy: { job: "proposal.undo" },
      postId: p.postId ?? null,
      threadId: p.threadId,
      taint: p.taint,
      ...(p.taintSources === undefined ? {} : { taintSources: p.taintSources }),
      undoOf: p.id,
    });
  }

  // --- run -------------------------------------------------------------------------------------

  #onBroker(e: { type: string; approval?: ApprovalRequest }): void {
    const a = e.approval;
    if (a === undefined || a.kind !== "batch") return;
    const p = this.store.byApproval(a.id);
    if (p === undefined || p.status !== "awaiting_approval") return;
    if (e.type === "approval.decided" && a.status === "approved") {
      this.#start(p);
    } else if (e.type === "approval.decided") {
      this.#save({ ...p, status: "dismissed" });
    } else if (e.type === "approval.expired" || e.type === "approval.invalidated") {
      this.#save({ ...p, status: "expired" });
    }
  }

  #start(p: StoredProposal): void {
    const run = this.#run(p).catch((err) => this.#o.onError?.(err));
    const tracked = run.finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }

  async #run(start: StoredProposal): Promise<void> {
    let p = this.#save({ ...start, status: "running" });
    const children = await this.#o.broker.batchChildren(p.approvalId ?? "");
    const results: ActionCallResult[] = [];
    const runId = `batch_${p.id}`;
    const threadId = p.threadId ?? (await this.#o.mainThread());
    for (const [index, child] of children.entries()) {
      const c = child.call;
      const reg = this.#o.tools.get(c.tool);
      if (reg === undefined) {
        results.push({ index, status: "failed", error: `unknown tool ${c.tool}` });
        continue;
      }
      // The broker's stored call is what runs: its params must still hash to what it decided.
      if (paramsHash(c.params) !== c.paramsHash) {
        results.push({ index, status: "failed", error: "the call changed after it was approved" });
        continue;
      }
      const verified = await this.#o.broker.verifyBinding(
        child.approval.id,
        child.approval.bindingHash,
      );
      if (!verified.ok) {
        results.push({ index, status: "failed", error: `approval ${verified.reason}` });
        continue;
      }
      const callId = `${p.id}:${index}`;
      const controller = new AbortController();
      const ctx: ToolRunContext = {
        callId,
        threadId,
        runId,
        taint: p.taint,
        ...(p.taintSources === undefined ? {} : { taintSources: p.taintSources }),
        permissionMode: "balanced",
        mode: "attended",
        approvalId: child.approval.id,
        authority: {
          rule: `approval:${child.approval.id}`,
          bindingHash: child.approval.bindingHash,
          approvalId: child.approval.id,
          scope: "once",
        },
        signal: controller.signal,
        onUpdate: () => {},
      };
      try {
        const r =
          "run" in reg && reg.run !== undefined
            ? await reg.run(structuredClone(c.params), ctx)
            : await reg.execute(callId, structuredClone(c.params), controller.signal, () => {});
        let receiptId = r.receiptId;
        if (receiptId === undefined) {
          receiptId = (
            await this.#o.broker.recordReceipt({
              kind: child.approval.kind,
              outcome: r.isError === true ? "failed" : "ok",
              summary: child.summary,
              toolCallId: callId,
              approvalId: child.approval.id,
            })
          ).id;
        }
        results.push({
          index,
          status: r.isError === true ? "failed" : "ok",
          ...(r.isError === true ? { error: errorText(r.output) } : {}),
          receiptId,
        });
      } catch (err) {
        results.push({
          index,
          status: "failed",
          error: err instanceof Error ? err.message.slice(0, 300) : "failed",
        });
      }
    }
    const ok = results.filter((r) => r.status === "ok").length;
    p = this.#save({
      ...p,
      results,
      status:
        ok === children.length && children.length > 0 ? "done" : ok === 0 ? "failed" : "partial",
      finishedAt: this.#now(),
    });
  }
}

function errorText(output: unknown): string {
  if (typeof output === "string") return output.slice(0, 300);
  try {
    return JSON.stringify(output).slice(0, 300);
  } catch {
    return "failed";
  }
}
