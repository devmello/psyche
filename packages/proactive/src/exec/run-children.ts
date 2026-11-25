import { paramsHash, type ToolRunContext } from "@psyche/agent-core";
import type { PolicyCall } from "@psyche/permissions";
import {
  type ApprovalRequest,
  type BindingVerification,
  PsycheError,
  type Receipt,
  type ReceiptInput,
  type TaintSource,
} from "@psyche/protocol";
import type { ToolLookup } from "../proposals/service.ts";

/**
 * One approved child call, run with its own approval as the authority (docs/design/
 * night-shift-2026.md §3.3). Shared by batch proposals and Night shift: the broker's stored call
 * runs, its params must still hash to what the broker decided, the child is consumed once by
 * `verifyBinding`, and a receipt is written when the tool writes none.
 */

export interface ChildBroker {
  verifyBinding(approvalId: string, bindingHash: string): Promise<BindingVerification>;
  recordReceipt(input: ReceiptInput): Promise<Receipt>;
}

export interface RunChildInput {
  approval: ApprovalRequest;
  call: PolicyCall;
  summary: string;
  /** The call id the tool sees: the connector registry requires it to equal the child's `toolCallId`. */
  callId: string;
}

export interface RunChildContext {
  threadId: string;
  runId: string;
  taint: boolean;
  taintSources?: TaintSource[];
}

/**
 * - `ok`, `failed` (the tool answered with an error, or a check refused before the tool ran);
 * - `before_effect`: refused before anything reached the tool or the provider (unknown tool, a
 *   changed call, a binding that did not verify, a connector that refused before acting);
 * - `uncertain`: the tool threw mid-flight (only with `uncertainOnThrow`; proposals keep `failed`).
 */
export type ChildOutcome =
  | { status: "ok"; receiptId?: string; output: unknown }
  | { status: "failed"; error: string; receiptId?: string; output?: unknown }
  | { status: "before_effect"; error: string }
  | { status: "uncertain"; error: string };

/** Error codes a connector or tool raises before it reaches the provider. */
const BEFORE_EFFECT_CODES = new Set([
  "binding_mismatch",
  "approval_required",
  "policy_denied",
  "invalid_params",
  "not_found",
  "conflict",
  "unavailable",
  "cancelled",
]);

function message(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : "failed";
}

export function errorText(output: unknown): string {
  if (typeof output === "string") return output.slice(0, 300);
  try {
    return JSON.stringify(output).slice(0, 300);
  } catch {
    return "failed";
  }
}

export async function runChild(
  deps: { tools: ToolLookup; broker: ChildBroker },
  child: RunChildInput,
  ctx: RunChildContext,
  opts: { uncertainOnThrow?: boolean } = {},
): Promise<ChildOutcome> {
  const c = child.call;
  const reg = deps.tools.get(c.tool);
  if (reg === undefined) return { status: "before_effect", error: `unknown tool ${c.tool}` };
  // The broker's stored call is what runs: its params must still hash to what it decided.
  if (paramsHash(c.params) !== c.paramsHash) {
    return { status: "before_effect", error: "the call changed after it was approved" };
  }
  const verified = await deps.broker.verifyBinding(child.approval.id, child.approval.bindingHash);
  if (!verified.ok) return { status: "before_effect", error: `approval ${verified.reason}` };
  const controller = new AbortController();
  const run: ToolRunContext = {
    callId: child.callId,
    threadId: ctx.threadId,
    runId: ctx.runId,
    taint: ctx.taint,
    ...(ctx.taintSources === undefined ? {} : { taintSources: ctx.taintSources }),
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
        ? await reg.run(structuredClone(c.params), run)
        : await reg.execute(child.callId, structuredClone(c.params), controller.signal, () => {});
    let receiptId = r.receiptId;
    if (receiptId === undefined) {
      receiptId = (
        await deps.broker.recordReceipt({
          kind: child.approval.kind,
          outcome: r.isError === true ? "failed" : "ok",
          summary: child.summary,
          toolCallId: child.callId,
          approvalId: child.approval.id,
        })
      ).id;
    }
    return r.isError === true
      ? { status: "failed", error: errorText(r.output), receiptId, output: r.output }
      : { status: "ok", receiptId, output: r.output };
  } catch (err) {
    if (!opts.uncertainOnThrow) return { status: "failed", error: message(err) };
    if (err instanceof PsycheError && BEFORE_EFFECT_CODES.has(err.code)) {
      return { status: "before_effect", error: message(err) };
    }
    if (err instanceof Error && err.name === "BeforeEffectError") {
      return { status: "before_effect", error: message(err) };
    }
    return { status: "uncertain", error: message(err) };
  }
}
