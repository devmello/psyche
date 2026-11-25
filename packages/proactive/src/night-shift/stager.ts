import { bindingHash, paramsHash, STAGEABLE_TOOLS } from "@psyche/agent-core";
import type { StagedCall as LoopStagedCall, StagedAction, StagingSink } from "@psyche/protocol";
import { bareTool, plain, stable } from "./adapters/common.ts";
import { adapterFor } from "./adapters/index.ts";
import type { Adapter, CaptureOk, CaptureResult, Json, StagedCall } from "./adapters/types.ts";
import type { NightDomain } from "./settings.ts";
import type { NightStore } from "./store.ts";

/**
 * The Night shift stager (docs/design/night-shift-2026.md §2.2): the `StagingSink` the loop's gate
 * calls for a write that passed policy. It never runs the tool. For each call it
 *
 *  1. finds the adapter for the exact tool (a connector prefix must name a live connector of a
 *     stageable type) and refuses anything else;
 *  2. ALWAYS runs the adapter's `capture` against the read-only registry: the loop's own checks only
 *     see the model's arguments, so a made-up thread id with a foreign `to` is refused here;
 *  3. stores the capture's call when it rewrote one (a file move carries the source's identity, so
 *     the binding hash covers it), with the params and binding hashes recomputed for that call;
 *  4. renders the preview, applies the one-live-item-per-target rule and writes the row.
 *
 * A capture that refuses, throws or cannot answer refuses the stage: the model is told the change
 * could not be prepared.
 */

export interface StagerDeps {
  nightId: string;
  store: Pick<NightStore, "insertStagedAction" | "listStagedActions" | "updateStagedAction">;
  /** Every adapter, keyed by bare tool name. Read at each call so a rebuilt registry applies. */
  adapters: () => Map<string, Adapter>;
  /** Live connector id to type (`apple`, `google`, ...): see `adapterFor`. */
  connectors: () => ReadonlyMap<string, string>;
  /** The domains the owner turned on. */
  domains: () => ReadonlySet<NightDomain>;
  /**
   * The params hash and binding hash of a call the stager rewrote. The Gateway derives it from the
   * tool's `describeCall` (binding fields included); the default is the loop's own fallback recipe.
   * W5 recomputes both again at apply, so a stored hash is never trusted there either.
   */
  rehash?: (
    tool: string,
    args: Record<string, unknown>,
    kind: string,
  ) => { paramsHash: string; bindingHash: string } | undefined;
  /** The one-sentence "why" for a task, from the job's candidate. Redacted and cut here. */
  whyFor?: (taskId: string | undefined) => string | undefined;
  /** Secret redaction, applied before the cut (psyche-permissions §3f). */
  redact?: (text: string) => string;
  onRefused?: (info: { tool: string; reason: string }) => void;
}

const WHY_MAX = 300;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The stored call of an item. */
export function callFromItem(item: Pick<StagedAction, "tool" | "params">): StagedCall {
  return {
    tool: item.tool,
    args: isRecord(item.params) ? (item.params as Record<string, unknown>) : {},
  };
}

/**
 * The capture an item was staged with. It is stored whole in the item's `precondition` column
 * (`{ok, target, folds?, precondition, before}`), so `adapter.check(callFromItem(i), captureFromItem(i))`
 * is exactly what staging saw. `undefined` for an expired item or a row this module did not write.
 */
export function captureFromItem(item: Pick<StagedAction, "precondition">): CaptureOk | undefined {
  const p = item.precondition;
  if (!isRecord(p) || p.ok !== true || typeof p.target !== "string") return undefined;
  return p as unknown as CaptureOk;
}

/** Whether the stored value is a capture this module wrote. */
export const hasCapture = (item: Pick<StagedAction, "precondition">): boolean =>
  captureFromItem(item) !== undefined;

const stableJson = (v: unknown): string => stable(v as Json);

/** The send an item may offer: only a mail draft, bound to what reaches the recipients. */
function sendFor(tool: string, call: StagedCall, cap: CaptureOk): StagedAction["send"] | undefined {
  if (
    !/^(mail_reply_draft|mail_draft|mail_create_draft|gmail_create_draft)$/.test(bareTool({ tool }))
  ) {
    return undefined;
  }
  const pre = isRecord(cap.precondition) ? cap.precondition : {};
  const recipients = Array.isArray(pre.recipients)
    ? (pre.recipients as unknown[]).filter((r): r is string => typeof r === "string")
    : [];
  if (recipients.length === 0) return undefined;
  const hashed = paramsHash({
    recipients,
    subject: call.args.subject ?? null,
    body: call.args.body ?? null,
    thread: cap.target,
  });
  return { recipients, contentHash: hashed.replace(/^sha256:/, "") };
}

export function createStager(deps: StagerDeps): StagingSink {
  const refuse = (tool: string, reason: string): { staged: false } => {
    deps.onRefused?.({ tool, reason });
    return { staged: false };
  };
  // Stage one at a time: the one-per-target rule and the sequence number read what is stored.
  let queue: Promise<unknown> = Promise.resolve();

  async function stageOne(
    call: LoopStagedCall,
  ): Promise<{ staged: true; stagedId: string } | { staged: false }> {
    if (call.staging.kind !== "night" || call.staging.nightId !== deps.nightId) {
      return refuse(call.tool, "wrong_night");
    }
    const adapter = adapterFor(deps.adapters(), call.tool, deps.connectors());
    if (adapter === undefined) return refuse(call.tool, "no_adapter");
    const entry = STAGEABLE_TOOLS.get(bareTool(call));
    if (entry === undefined) return refuse(call.tool, "not_stageable");
    const domain = entry.domain;
    if (!deps.domains().has(domain)) return refuse(call.tool, "domain_off");
    if (!isRecord(call.params)) return refuse(call.tool, "bad_args");

    let modelCall: StagedCall;
    try {
      modelCall = { tool: call.tool, args: structuredClone(call.params) };
    } catch {
      return refuse(call.tool, "bad_args");
    }
    const live = deps.store.listStagedActions(deps.nightId).filter((i) => i.status === "ready");
    const pending = live.flatMap((i) => {
      const cap = captureFromItem(i);
      return cap === undefined ? [] : [{ call: callFromItem(i), capture: cap }];
    });

    // Always the adapter's own capture: it reads the real thread, event, reminder or file.
    let result: CaptureResult;
    try {
      result = await adapter.capture(modelCall, { pending });
    } catch {
      return refuse(call.tool, "capture_failed");
    }
    if (!result.ok) return refuse(call.tool, `capture:${result.reason}`);

    const storedCall: StagedCall = result.call ?? modelCall;
    let paramsH = call.paramsHash;
    let bindingH = call.bindingHash;
    const rewritten =
      result.call !== undefined && stableJson(result.call.args) !== stableJson(modelCall.args);
    if (rewritten) {
      // The call differs from the one the broker decided on: its hashes must cover what is stored.
      const rehash = deps.rehash ?? defaultRehash;
      const h = rehash(storedCall.tool, storedCall.args, call.kind ?? "connector_action");
      if (h === undefined) return refuse(call.tool, "rehash_failed");
      paramsH = h.paramsHash;
      bindingH = h.bindingHash;
    }

    let preview: ReturnType<Adapter["preview"]>;
    try {
      preview = adapter.preview(storedCall, result);
    } catch {
      return refuse(call.tool, "preview_failed");
    }
    let inverse: unknown;
    try {
      inverse = adapter.inverse?.(storedCall, result);
    } catch {
      inverse = undefined;
    }

    // Folding: an earlier item this one replaces is not shown any more.
    for (const key of result.folds ?? []) {
      for (const i of live) {
        if (i.targetKey === key) deps.store.updateStagedAction(i.id, { status: "superseded" });
      }
    }

    const whyRaw = deps.whyFor?.(call.taskId);
    const why =
      whyRaw === undefined
        ? null
        : plain((deps.redact ?? ((t: string) => t))(whyRaw), WHY_MAX) || null;
    const send = sendFor(call.tool, storedCall, result);
    const seq = deps.store.listStagedActions(deps.nightId).length;
    const row = deps.store.insertStagedAction({
      nightId: deps.nightId,
      seq,
      domain,
      targetKey: result.target,
      tool: call.tool,
      kind: call.kind ?? "connector_action",
      sideEffect: call.sideEffect,
      target: call.target ?? null,
      params: storedCall.args,
      paramsHash: paramsH,
      bindingHash: bindingH,
      summary: plain(call.summary, 500),
      preview,
      why,
      precondition: { ...result } as unknown as Json,
      inverse: inverse ?? null,
      send: send ?? null,
      taint: call.taint,
      taintSources: call.taintSources,
      taskId: call.taskId ?? null,
      toolCallId: call.toolCallId,
    });
    return { staged: true, stagedId: row.id };
  }

  return {
    stage(call) {
      const run = queue.then(
        () => stageOne(call),
        () => stageOne(call),
      );
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

function defaultRehash(
  tool: string,
  args: Record<string, unknown>,
  kind: string,
): { paramsHash: string; bindingHash: string } {
  const p = paramsHash(args);
  return { paramsHash: p, bindingHash: bindingHash(kind, { tool, paramsHash: p }) };
}
