import { createHash } from "node:crypto";
import { paramsHash } from "@psyche/agent-core";
import { canonicalAddress } from "@psyche/connectors";
import {
  callRecipients,
  type IssuedStagedApply,
  type PolicyCall,
  type PolicyStagedApplyInput,
  type StagedApplyChildInput,
  stagedSendBindingHash,
} from "@psyche/permissions";
import {
  type ApprovalRequest,
  type Clock,
  namespacedGrantKey,
  PsycheError,
  type StagedAction,
  type Surface,
  type TaintSource,
} from "@psyche/protocol";
import { toolCallBindingHash } from "@psyche/protocol/binding";
import { type ChildBroker, type ChildOutcome, runChild } from "../exec/run-children.ts";
import type { ToolLookup } from "../proposals/service.ts";
import { asRecord, bareTool, splitTool, stable, toolPrefix } from "../staged/adapters/common.ts";
import { adapterFor, type ConnectorTypes } from "../staged/adapters/index.ts";
import { hasHiddenContent } from "../staged/adapters/mail.ts";
import type { Adapter, CaptureOk, Json, StagedCall } from "../staged/adapters/types.ts";
import { callFromItem, captureFromItem, sendFor } from "./stager.ts";
import type { NightStore } from "./store.ts";

/**
 * Night shift apply, undo and dismiss (docs/design/night-shift-2026.md §2.4, §3.2, §3.3, §5.3,
 * §5.4). Nothing a client sends is trusted beyond which items it ticked:
 *
 *  - every call is rebuilt from the stored item through the tool's own `describeCall`, and its
 *    params and binding hash are recomputed (`toolCallBindingHash`, what the connector re-derives);
 *    the client's `bindingHash` must equal the rebuilt one, so a changed arg or a swapped item is
 *    refused;
 *  - a send is offered only for an item in `sends[]` whose `sendHash` equals the stored content
 *    hash, and the stored hash is recomputed from the stored draft first; recipients come from the
 *    stored record; the send child is bound to the content hash, and turned into the exact send
 *    call only after the draft the helper reports saving has the staged to, cc, subject and body
 *    (`broker.bindStagedSend`); the helper re-checks the live draft at send. Gmail drafts and
 *    replies can't be read back that way, so their sends are refused;
 *  - an item made from Messages gets a generic summary on the card, and only the desktop shell on
 *    this Mac may apply or undo it (owner rule: no Messages text on remote devices);
 *  - an undo's created id comes only from the original apply's result refs, within 24 hours;
 *  - items move `ready` to bound with a compare-and-set on `approval_id`, so a second apply of
 *    the same item is refused, and the broker's `verifyBinding` consumes each child once;
 *  - `check()` runs right before each item executes: a stale item is never applied.
 */

export const UNDO_WINDOW_MS = 24 * 3_600_000;

export interface ApplyBroker extends ChildBroker {
  requestStagedApply(input: PolicyStagedApplyInput): Promise<IssuedStagedApply>;
  batchChildren(
    id: string,
  ): Promise<{ approval: ApprovalRequest; call: PolicyCall; summary: string }[]>;
  bindStagedSend(input: {
    childApprovalId: string;
    itemId: string;
    sendHash: string;
    call: PolicyCall;
    connectorIds: ReadonlySet<string>;
  }): Promise<ApprovalRequest>;
  get(id: string): Promise<ApprovalRequest | undefined>;
  subscribe(listener: (e: { type: string; approval?: ApprovalRequest }) => void): () => void;
}

export interface ApplyStore
  extends Pick<
    NightStore,
    "getNight" | "updateNight" | "getStagedAction" | "listStagedActions" | "updateStagedAction"
  > {
  /** Compare-and-set: binds each item still in `status` with `approval_id = from`; returns the bound ids. */
  bindApproval(
    ids: readonly string[],
    approvalId: string,
    from: { status: StagedAction["status"]; approvalId: string | null },
  ): string[];
  /** Clears `approval_id` on items of `status` still bound to `approvalId`. */
  unbindApproval(approvalId: string, status: StagedAction["status"]): number;
  listByApproval(approvalId: string): StagedAction[];
  /** Items bound to any approval and in `ready` or `applied` (restart recovery). */
  listBound(): StagedAction[];
  setInverse(id: string, inverse: unknown): void;
}

export interface NightApplyDeps {
  clock: Clock;
  store: ApplyStore;
  broker: ApplyBroker;
  /** The loop's tool registry (writes included): `describeCall` and the executors. */
  tools: ToolLookup;
  /** Adapters for a connector id (the staged tool's own connector). */
  adapters: (connectorId: string | undefined) => Map<string, Adapter>;
  connectors: () => ConnectorTypes;
  /** The live connector ids (`requestStagedApply`'s `connectorIds`). */
  connectorIds: () => ReadonlySet<string>;
  /** The night's own thread: applies never run in the owner's chat. */
  threadId: (nightId: string) => Promise<string>;
  surfaces?: Surface[];
  onItem?: (item: StagedAction) => void;
  onNight?: (nightId: string) => void;
  onError?: (err: unknown) => void;
}

export interface ApplyRequest {
  reviewId: string;
  items: readonly { itemId: string; bindingHash: string }[];
  sends: readonly { itemId: string; sendHash: string }[];
}

export interface ApplyAnswer {
  issued?: IssuedStagedApply;
  refused: { itemId: string; reason: string }[];
}

/** Who asks: `local` is the desktop shell on this Mac's loopback, set by the Gateway only. */
export interface ApplyCaller {
  local: boolean;
}

type Op = "apply" | "undo";

/**
 * The card line for an item made from Messages: English fallback text; clients show their own
 * localised line for `details.items[].withheld === "messages"`.
 */
export const MESSAGES_ITEM_LINE = "An item from your Messages. Open Psyche on this Mac to see it.";
const MESSAGES_ONLY_HERE = "items from your Messages can be applied only in Psyche on this Mac";

/** An item whose taint includes Messages (the owner rule: its text stays on this Mac). */
export function fromMessages(item: StagedAction): boolean {
  return item.taintSources.some((t) => t.sourceKind === "message");
}

/**
 * Why a "Send it too" can't be honoured for this draft tool, or undefined when it can. Only the
 * Mac helper reports the draft it saved (`MailDraftRecord`) and re-checks it at send.
 */
export function sendRefusal(draftTool: string): string | undefined {
  const bare = bareTool({ tool: draftTool });
  if (bare === "gmail_create_draft") {
    return "Gmail drafts can't be read back to check them before sending: send it from Gmail";
  }
  if (bare === "mail_reply_draft") {
    return "a reply's saved draft can't be checked against what you saw: send it from Mail";
  }
  return undefined;
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The send tool for a draft tool, with the draft's connector prefix. */
export function sendToolFor(draftTool: string): string | undefined {
  const bare = bareTool({ tool: draftTool });
  const prefix = toolPrefix(draftTool);
  if (bare === "gmail_create_draft") return `${prefix}gmail_send`;
  if (bare === "mail_reply_draft" || bare === "mail_draft" || bare === "mail_create_draft") {
    return `${prefix}mail_send_draft`;
  }
  return undefined;
}

const SEND_SUFFIX = ":send";

/**
 * A draft's id from the draft tool's output: the Mac helper answers `{draft: {draftId, ...,
 * bodySha256}}` (`MailDraftRecord`), Gmail `{draftId, messageId, threadId}`.
 */
export function draftIdOf(output: unknown): string | undefined {
  const o = asRecord(output as Json);
  const d = asRecord(o.draft as Json);
  for (const v of [d.draftId, o.draftId, d.id]) if (typeof v === "string" && v !== "") return v;
  return undefined;
}

/** What the Mac helper's `mail.draft` says it saved (`MailDraftRecord`): no bcc, no In-Reply-To. */
export interface SavedDraft {
  draftId: string;
  subject: string;
  to: string[];
  cc: string[];
  body: string;
  bodySha256: string;
}

export function savedDraftOf(output: unknown): SavedDraft | undefined {
  const d = asRecord(asRecord(output as Json).draft as Json);
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
  const to = list(d.to);
  const cc = d.cc === undefined || d.cc === null ? [] : list(d.cc);
  if (
    typeof d.draftId !== "string" ||
    d.draftId === "" ||
    typeof d.subject !== "string" ||
    typeof d.body !== "string" ||
    typeof d.bodySha256 !== "string" ||
    to === undefined ||
    cc === undefined
  ) {
    return undefined;
  }
  return { draftId: d.draftId, subject: d.subject, to, cc, body: d.body, bodySha256: d.bodySha256 };
}

const canonSet = (xs: readonly unknown[]): string[] =>
  [...new Set(xs.map((x) => canonicalAddress(String(x))))].sort();

/**
 * The saved draft against the staged one, field by field, on exactly what the helper reports:
 * to and cc as sets, the subject, and the body as `MailWave1.bodyHash` sees it (also the hash the
 * helper reported). Staged bcc can't be checked (the record has none), so it refuses.
 */
export function checkSavedDraft(
  saved: SavedDraft,
  staged: Record<string, unknown>,
  recipients: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const body = typeof staged.body === "string" ? staged.body : "";
  const subject = typeof staged.subject === "string" ? staged.subject : "";
  try {
    const cc = canonSet(Array.isArray(staged.cc) ? staged.cc : []);
    const bcc = canonSet(Array.isArray(staged.bcc) ? staged.bcc : []);
    if (bcc.length > 0) return { ok: false, reason: "bcc_unverifiable" };
    const apart = new Set(cc);
    const to = canonSet(recipients).filter((r) => !apart.has(r));
    if (stable(canonSet(saved.to)) !== stable(to) || stable(canonSet(saved.cc)) !== stable(cc)) {
      return { ok: false, reason: "recipients_changed" };
    }
  } catch {
    return { ok: false, reason: "bad_recipients" };
  }
  if (hasHiddenContent(saved.subject) || hasHiddenContent(body)) {
    return { ok: false, reason: "hidden_content" };
  }
  const want = appleBodySha256(body);
  if (
    saved.subject !== subject ||
    appleBodySha256(saved.body) !== want ||
    saved.bodySha256.toLowerCase() !== want
  ) {
    return { ok: false, reason: "draft_changed" };
  }
  return { ok: true };
}

/**
 * Exactly the Mac helper's `MailWave1.bodyHash`: `replacingOccurrences("\r\n", "\n")`, then
 * `("\r", "\n")`, then `trimmingCharacters(in: .whitespacesAndNewlines)`, then sha256 hex of the
 * UTF-8. `mail_send_draft` binds and re-checks it, so this must match Swift byte for byte.
 *
 * Checked against a Swift probe (the rows in apply.test.ts):
 *  - `replacingOccurrences` matches whole composed sequences, so a `\r` (or the `\n` of `\r\n`)
 *    followed by a grapheme extender (combining mark, ZWNJ, variation selector, emoji modifier) is
 *    not matched; ZWJ and spacing marks (U+0903) don't block it;
 *  - `.whitespacesAndNewlines` is exactly U+0009-000D, 0020, 0085, 00A0, 1680, 2000-200B, 2028,
 *    2029, 202F, 205F, 3000: it takes U+200B and leaves U+FEFF.
 */
const SWIFT_TRIM =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000]+$/gu;
const CRLF = /\r\n(?![\p{Grapheme_Extend}\p{Emoji_Modifier}])/gu;
const CR = /\r(?![\p{Grapheme_Extend}\p{Emoji_Modifier}])/gu;

export function appleBodySha256(body: string): string {
  return sha256Hex(body.replace(CRLF, "\n").replace(CR, "\n").replace(SWIFT_TRIM, ""));
}

/** The id a create returned (event, reminder), from its output. */
function createdIdOf(output: unknown): string | undefined {
  const o = asRecord(output as Json);
  for (const k of ["id", "eventId", "reminderId"]) {
    if (typeof o[k] === "string" && o[k] !== "") return o[k];
  }
  for (const k of ["event", "reminder"]) {
    const n = asRecord(o[k] as Json);
    if (typeof n.id === "string" && n.id !== "") return n.id;
  }
  return undefined;
}

interface DraftOutcome {
  ok: boolean;
  draftId?: string;
  saved?: SavedDraft;
}

interface StoredInverse {
  call?: StagedCall;
  post?: Json;
  createdId?: string;
  calendarId?: string;
}

export class NightShiftApply {
  readonly #d: NightApplyDeps;
  readonly #inflight = new Set<Promise<void>>();
  readonly #off: () => void;

  constructor(deps: NightApplyDeps) {
    this.#d = deps;
    this.#off = deps.broker.subscribe((e) => this.#onBroker(e));
  }

  stop(): void {
    this.#off();
  }

  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all([...this.#inflight]);
  }

  // --- building calls --------------------------------------------------------------------------

  /** The call as the agent loop would build it, from the stored item and the live tool. */
  #rebuild(item: StagedAction, call: StagedCall, callId: string): PolicyCall | string {
    const reg = this.#d.tools.get(call.tool);
    if (reg === undefined) return "the tool is no longer available";
    const args = structuredClone(call.args);
    let desc: ReturnType<NonNullable<typeof reg.describeCall>> | undefined;
    try {
      desc = reg.describeCall?.(structuredClone(args), { runId: `night_${item.nightId}` });
    } catch {
      return "the call can't be described";
    }
    const order = { none: 0, read: 1, write: 2, destructive: 3, financial: 4 } as const;
    const sideEffect =
      desc?.sideEffect !== undefined && order[desc.sideEffect] > order[reg.spec.sideEffect]
        ? desc.sideEffect
        : reg.spec.sideEffect;
    const target = desc?.target;
    const targetKind = target?.kind ?? reg.spec.targetKind;
    return {
      tool: call.tool,
      toolCallId: callId,
      sideEffect,
      ...(targetKind === undefined ? {} : { targetKind }),
      ...(target === undefined ? {} : { target }),
      params: args,
      paramsHash: paramsHash(args),
      ...(desc?.kind === undefined ? {} : { kind: desc.kind }),
      bindingHash: toolCallBindingHash(call.tool, args, desc),
      grantKey:
        desc?.grantKey === undefined
          ? `${call.tool}|staged:${callId}`
          : namespacedGrantKey(call.tool, desc.grantKey),
      ...(desc?.connectorRule === undefined ? {} : { connectorRule: { ...desc.connectorRule } }),
    };
  }

  #adapter(tool: string): Adapter | undefined {
    return adapterFor(this.#d.adapters(splitTool(tool).connector), tool, this.#d.connectors());
  }

  /** The stored send, its content hash recomputed from the stored draft: undefined on any mismatch. */
  #trustedSend(item: StagedAction): { recipients: string[]; contentHash: string } | undefined {
    const cap = captureFromItem(item);
    if (item.send == null || cap === undefined) return undefined;
    const again = sendFor(item.tool, callFromItem(item), cap);
    if (again === undefined || again === null) return undefined;
    if (again.contentHash !== item.send.contentHash) return undefined;
    if (stable(again.recipients) !== stable(item.send.recipients)) return undefined;
    return again;
  }

  // --- apply -----------------------------------------------------------------------------------

  async apply(req: ApplyRequest, caller: ApplyCaller = { local: false }): Promise<ApplyAnswer> {
    const night = this.#d.store.getNight(req.reviewId);
    if (night === null || night.reviewStatus === "none") {
      throw new PsycheError("not_found", "that review is gone");
    }
    if (night.reviewStatus !== "ready" && night.reviewStatus !== "partial") {
      throw new PsycheError("conflict", `the review is ${night.reviewStatus}`);
    }
    const refused: ApplyAnswer["refused"] = [];
    const items = this.#d.store.listStagedActions(night.id);
    const byId = new Map(items.map((i) => [i.id, i]));
    const ticked = new Map<string, string>();
    for (const t of req.items) {
      if (ticked.has(t.itemId)) refused.push({ itemId: t.itemId, reason: "listed twice" });
      else ticked.set(t.itemId, t.bindingHash);
    }
    const sendTicks = new Map<string, string>();
    for (const s of req.sends) {
      if (sendTicks.has(s.itemId)) refused.push({ itemId: s.itemId, reason: "send listed twice" });
      else sendTicks.set(s.itemId, s.sendHash);
    }
    for (const id of sendTicks.keys()) {
      // A send needs its own draft in the same apply (§3.2).
      if (!ticked.has(id)) {
        refused.push({ itemId: id, reason: "a send needs its draft ticked too" });
        sendTicks.delete(id);
      }
    }

    const children: StagedApplyChildInput[] = [];
    const kept: StagedAction[] = [];
    const ordered = [...ticked.keys()]
      .map((id) => byId.get(id) ?? id)
      .sort((a, b) => (typeof a === "string" || typeof b === "string" ? 0 : a.seq - b.seq));
    for (const entry of ordered) {
      if (typeof entry === "string") {
        refused.push({ itemId: entry, reason: "not in this review" });
        continue;
      }
      const item = entry;
      const refuse = (reason: string) => {
        refused.push({ itemId: item.id, reason });
        sendTicks.delete(item.id);
      };
      if (item.status !== "ready") {
        refuse(`the item is ${item.status}`);
        continue;
      }
      if (item.approvalId != null) {
        refuse("the item is already being applied");
        continue;
      }
      const withheld = fromMessages(item);
      // A remote device saw only the generic line: it can't approve what it never saw.
      if (withheld && !caller.local) {
        refuse(MESSAGES_ONLY_HERE);
        continue;
      }
      const cap = captureFromItem(item);
      const adapter = this.#adapter(item.tool);
      if (cap === undefined || adapter === undefined) {
        refuse("the item can't be applied");
        continue;
      }
      const call = this.#rebuild(item, callFromItem(item), item.id);
      if (typeof call === "string") {
        refuse(call);
        continue;
      }
      // The owner ticked exactly the call they saw: the stored and the rebuilt hash both match.
      if (ticked.get(item.id) !== call.bindingHash || item.bindingHash !== call.bindingHash) {
        refuse("the item changed since it was shown");
        continue;
      }
      let fresh: Awaited<ReturnType<Adapter["check"]>>;
      try {
        fresh = await adapter.check(callFromItem(item), cap);
      } catch {
        fresh = { fresh: false, reason: "check_failed" };
      }
      if (!fresh.fresh) {
        this.#save(item.id, { status: "stale", result: { error: fresh.reason } });
        refuse(`stale: ${fresh.reason}`);
        continue;
      }
      children.push({
        itemId: item.id,
        call,
        ...(withheld
          ? { summary: MESSAGES_ITEM_LINE, withheld: "messages" as const }
          : { summary: item.summary }),
      });
      kept.push(item);
      const sendHash = sendTicks.get(item.id);
      if (sendHash === undefined) continue;
      const cannot = sendRefusal(item.tool);
      if (cannot !== undefined) {
        refused.push({ itemId: item.id, reason: cannot });
        continue;
      }
      const send = this.#trustedSend(item);
      const sendTool = sendToolFor(item.tool);
      if (send === undefined || sendTool === undefined || sendHash !== send.contentHash) {
        refused.push({ itemId: item.id, reason: "the send doesn't match the draft" });
        continue;
      }
      const sendId = `${item.id}${SEND_SUFFIX}`;
      const params = { to: send.recipients };
      children.push({
        itemId: sendId,
        call: {
          tool: sendTool,
          toolCallId: sendId,
          sideEffect: "destructive",
          kind: "send_email",
          targetKind: "recipient",
          target: { kind: "recipient", value: send.recipients.join(",") },
          params,
          paramsHash: paramsHash(params),
          bindingHash: stagedSendBindingHash(sendTool, send.contentHash, send.recipients),
          grantKey: `send_email|staged:${sendId}`,
        },
        ...(withheld
          ? { summary: MESSAGES_ITEM_LINE, withheld: "messages" as const }
          : { summary: `Send to ${send.recipients.join(", ")}` }),
        explicitSend: true,
        recipients: [...send.recipients],
      });
    }
    if (children.length === 0) return { refused };
    return this.#issue("apply", night.id, kept, children, refused, null);
  }

  /** Binds the items, requests the approval, and unbinds on any failure. */
  async #issue(
    op: Op,
    nightId: string,
    items: StagedAction[],
    children: StagedApplyChildInput[],
    refused: ApplyAnswer["refused"],
    pendingId: string | null,
  ): Promise<ApplyAnswer> {
    const ids = items.map((i) => i.id);
    const status = op === "apply" ? "ready" : "applied";
    // A placeholder binding first, so two concurrent applies can't both take an item.
    const claim = `claim_${op}_${this.#d.clock.now()}_${Math.random().toString(36).slice(2)}`;
    const bound = new Set(
      items.flatMap((i) =>
        this.#d.store.bindApproval([i.id], claim, {
          status,
          approvalId: op === "apply" ? pendingId : (i.approvalId ?? null),
        }),
      ),
    );
    const lost = ids.filter((id) => !bound.has(id));
    for (const id of lost)
      refused.push({ itemId: id, reason: "the item is already being applied" });
    const keep = children.filter((c) => bound.has(c.itemId.replace(/:send$/, "")));
    if (keep.length === 0) {
      this.#d.store.unbindApproval(claim, status);
      return { refused };
    }
    const kept = items.filter((i) => bound.has(i.id));
    const taintSources = dedupe(kept.flatMap((i) => i.taintSources));
    const taint = kept.some((i) => i.taint) || taintSources.length > 0;
    const runId = `night_${op}_${nightId}`;
    let issued: IssuedStagedApply;
    try {
      const threadId = await this.#d.threadId(nightId);
      issued = await this.#d.broker.requestStagedApply({
        connectorIds: this.#d.connectorIds(),
        title:
          op === "apply"
            ? `Apply ${kept.length} prepared change${kept.length === 1 ? "" : "s"}`
            : `Undo ${kept.length} change${kept.length === 1 ? "" : "s"}`,
        children: keep,
        context: {
          threadId,
          runId,
          permissionMode: "balanced",
          taint,
          ...(taintSources.length === 0 ? {} : { taintSources }),
        },
        requestedBy: { runId, taskId: null, threadId },
        // The review lives in the Mac and iOS apps; never a chat surface.
        surfaces: this.#d.surfaces ?? ["desktop", "web", "notification"],
        details: { nightShift: { op, reviewId: nightId } },
        ...(taintSources.length === 0 ? {} : { taintSources }),
      });
    } catch (err) {
      this.#d.store.unbindApproval(claim, status);
      const refusedBy = (PsycheError.from(err).details as { refused?: unknown } | undefined)
        ?.refused;
      if (Array.isArray(refusedBy)) {
        for (const r of refusedBy as { itemId: string; message: string }[]) {
          refused.push({ itemId: r.itemId.replace(/:send$/, ""), reason: r.message });
        }
        return { refused };
      }
      throw err;
    }
    for (const r of issued.refused) {
      refused.push({ itemId: r.itemId.replace(/:send$/, ""), reason: r.message });
    }
    // Items whose own child the broker refused stay unbound (a refused send keeps its draft).
    const refusedItems = new Set(
      issued.refused.filter((r) => !r.itemId.endsWith(SEND_SUFFIX)).map((r) => r.itemId),
    );
    const final = kept.filter((i) => !refusedItems.has(i.id)).map((i) => i.id);
    this.#d.store.bindApproval(final, issued.approval.id, { status, approvalId: claim });
    this.#d.store.unbindApproval(claim, status);
    for (const id of ids) this.#emitItem(id);
    return { issued, refused };
  }

  // --- undo ------------------------------------------------------------------------------------

  async undo(
    itemIds: readonly string[],
    caller: ApplyCaller = { local: false },
  ): Promise<ApplyAnswer> {
    const refused: ApplyAnswer["refused"] = [];
    const now = this.#d.clock.now();
    const children: StagedApplyChildInput[] = [];
    const kept: StagedAction[] = [];
    let nightId: string | undefined;
    for (const id of new Set(itemIds)) {
      const item = this.#d.store.getStagedAction(id);
      const refuse = (reason: string) => refused.push({ itemId: id, reason });
      if (item === null || item.nightId == null) {
        refuse("not found");
        continue;
      }
      if (nightId !== undefined && item.nightId !== nightId) {
        refuse("undo one review at a time");
        continue;
      }
      if (item.status !== "applied" || item.appliedAt == null) {
        refuse(`the item is ${item.status}`);
        continue;
      }
      if (now - Date.parse(item.appliedAt) > UNDO_WINDOW_MS) {
        refuse("the undo window has passed");
        continue;
      }
      const withheld = fromMessages(item);
      if (withheld && !caller.local) {
        refuse(MESSAGES_ONLY_HERE);
        continue;
      }
      const inv = asRecord(item.inverse as Json) as StoredInverse;
      const cap = captureFromItem(item);
      const adapter = this.#adapter(item.tool);
      if (inv.call === undefined || cap === undefined || adapter === undefined) {
        refuse("this change can't be undone");
        continue;
      }
      // The created id comes only from the original apply's own result.
      const createdId = this.#createdIdOf(item, inv);
      const inverseOk = await this.#checkInverse(item, adapter, cap, inv, createdId);
      if (inverseOk !== true) {
        refuse(inverseOk);
        continue;
      }
      const call = this.#rebuild(item, inv.call, item.id);
      if (typeof call === "string") {
        refuse(call);
        continue;
      }
      nightId = item.nightId;
      kept.push(item);
      children.push({
        itemId: item.id,
        call,
        ...(withheld
          ? { summary: `Undo: ${MESSAGES_ITEM_LINE}`, withheld: "messages" as const }
          : { summary: `Undo: ${item.summary}`.slice(0, 300) }),
        ...(createdId === undefined
          ? {}
          : {
              undo: {
                createdId,
                ...(inv.calendarId === undefined ? {} : { calendarId: inv.calendarId }),
              },
            }),
      });
    }
    if (children.length === 0 || nightId === undefined) return { refused };
    return this.#issue("undo", nightId, kept, children, refused, null);
  }

  /** The created thing is as the apply left it (§5.4): true, or why not. A throw is a refusal. */
  async #checkInverse(
    item: StagedAction,
    adapter: Adapter,
    cap: CaptureOk,
    inv: StoredInverse,
    createdId: string | undefined,
  ): Promise<true | string> {
    try {
      const ok = await adapter.checkInverse?.(
        callFromItem(item),
        cap,
        inv.post ?? null,
        createdId === undefined ? undefined : { id: createdId },
      );
      if (ok === undefined || !ok.fresh) {
        return `changed since it was applied${ok?.fresh === false ? `: ${ok.reason}` : ""}`;
      }
      return true;
    } catch {
      return "changed since it was applied";
    }
  }

  /** The undo's created id, only when the apply's own result refs hold it. */
  #createdIdOf(item: StagedAction, inv: StoredInverse): string | undefined {
    return inv.createdId !== undefined && (item.result?.refs ?? []).includes(inv.createdId)
      ? inv.createdId
      : undefined;
  }

  // --- dismiss ---------------------------------------------------------------------------------

  dismiss(reviewId: string, itemIds?: readonly string[]): number {
    const night = this.#d.store.getNight(reviewId);
    if (night === null || night.reviewStatus === "none") {
      throw new PsycheError("not_found", "that review is gone");
    }
    const want = itemIds === undefined ? undefined : new Set(itemIds);
    let n = 0;
    for (const i of this.#d.store.listStagedActions(night.id)) {
      if (want !== undefined && !want.has(i.id)) continue;
      // A bound item is mid-apply: dismissing it would race the run.
      if ((i.status !== "ready" && i.status !== "stale") || i.approvalId != null) continue;
      this.#save(i.id, { status: "dismissed", clearParams: true });
      n += 1;
    }
    this.#settle(night.id);
    return n;
  }

  // --- restart ---------------------------------------------------------------------------------

  /**
   * After a restart the broker has invalidated every pending card, so an item bound to one goes
   * back to `ready`. An item bound to an approved apply that never finished may have run: it is
   * `uncertain`, never retried.
   */
  async recover(): Promise<void> {
    for (const i of this.#d.store.listBound()) {
      const a = i.approvalId == null ? undefined : await this.#d.broker.get(i.approvalId);
      if (a?.status === "pending") continue;
      if (a?.status === "approved" && i.status === "ready") {
        this.#save(i.id, {
          status: "uncertain",
          approvalId: null,
          result: { error: "Psyche restarted while applying this" },
        });
      } else {
        this.#save(i.id, { approvalId: null });
      }
      if (i.nightId != null) this.#settle(i.nightId);
    }
  }

  // --- run -------------------------------------------------------------------------------------

  #onBroker(e: { type: string; approval?: ApprovalRequest }): void {
    const a = e.approval;
    if (a === undefined || a.kind !== "staged_apply") return;
    const ns = asRecord(asRecord(a.details as Json).nightShift as Json);
    const op = ns.op === "undo" ? "undo" : ns.op === "apply" ? "apply" : undefined;
    if (op === undefined) return;
    const status = op === "apply" ? "ready" : "applied";
    if (e.type === "approval.decided" && a.status === "approved") {
      const run = this.#run(a, op).catch((err) => this.#d.onError?.(err));
      const tracked = run.finally(() => this.#inflight.delete(tracked));
      this.#inflight.add(tracked);
    } else if (
      e.type === "approval.decided" ||
      e.type === "approval.expired" ||
      e.type === "approval.invalidated"
    ) {
      const items = this.#d.store.listByApproval(a.id);
      this.#d.store.unbindApproval(a.id, status);
      for (const i of items) this.#emitItem(i.id);
    }
  }

  async #run(a: ApprovalRequest, op: Op): Promise<void> {
    const children = await this.#d.broker.batchChildren(a.id);
    const ns = asRecord(asRecord(a.details as Json).nightShift as Json);
    const nightId = typeof ns.reviewId === "string" ? ns.reviewId : undefined;
    if (nightId === undefined) return;
    const threadId = await this.#d.threadId(nightId);
    const runId = `night_${op}_${nightId}`;
    const ctx = { threadId, runId, taint: a.taint, taintSources: a.taintSources ?? [] };
    const drafts = new Map<string, DraftOutcome>();
    for (const child of children) {
      const childId = child.approval.requestedBy.toolCallId ?? "";
      if (childId.endsWith(SEND_SUFFIX)) {
        await this.#runSend(child, childId.slice(0, -SEND_SUFFIX.length), drafts, ctx);
        continue;
      }
      const item = this.#d.store.getStagedAction(childId);
      const status = op === "apply" ? "ready" : "applied";
      if (item === null || item.status !== status || item.approvalId !== a.id) {
        drafts.set(childId, { ok: false });
        continue;
      }
      // check() right before this item, not once per batch.
      const cap = captureFromItem(item);
      const adapter = this.#adapter(item.tool);
      if (op === "apply") {
        let fresh: { fresh: boolean; reason?: string } = { fresh: false, reason: "no_adapter" };
        if (cap !== undefined && adapter !== undefined) {
          try {
            fresh = await adapter.check(callFromItem(item), cap);
          } catch {
            fresh = { fresh: false, reason: "check_failed" };
          }
        }
        if (!fresh.fresh) {
          this.#save(item.id, {
            status: "stale",
            approvalId: null,
            result: { error: fresh.reason ?? "stale" },
          });
          drafts.set(item.id, { ok: false });
          continue;
        }
      } else {
        // The undo is checked again right before it runs: the card may have been open a while.
        const inv = asRecord(item.inverse as Json) as StoredInverse;
        const ok =
          adapter === undefined || cap === undefined
            ? "this change can't be undone"
            : await this.#checkInverse(item, adapter, cap, inv, this.#createdIdOf(item, inv));
        if (ok !== true) {
          this.#save(item.id, {
            approvalId: null,
            result: { ...(item.result ?? {}), error: `undo refused: ${ok}`.slice(0, 500) },
          });
          continue;
        }
      }
      // The broker's stored call must be the stored item's (a row edited after the tap differs).
      const want = op === "apply" ? callFromItem(item).args : asRecord(item.inverse as Json).call;
      const wantArgs = op === "apply" ? want : asRecord(want as Json).args;
      if (paramsHash(wantArgs) !== child.call.paramsHash) {
        this.#save(item.id, {
          status: op === "apply" ? "ready" : "applied",
          approvalId: null,
          result: { error: "the item changed after it was approved" },
        });
        drafts.set(item.id, { ok: false });
        continue;
      }
      const out = await runChild(
        { tools: this.#d.tools, broker: this.#d.broker },
        { ...child, callId: item.id },
        ctx,
        { uncertainOnThrow: true },
      );
      this.#record(item, out, op, adapter, cap);
      const draftId = out.status === "ok" ? draftIdOf(out.output) : undefined;
      const saved = out.status === "ok" ? savedDraftOf(out.output) : undefined;
      drafts.set(item.id, {
        ok: out.status === "ok",
        ...(draftId === undefined ? {} : { draftId }),
        ...(saved === undefined ? {} : { saved }),
      });
    }
    this.#settle(nightId);
  }

  #record(
    item: StagedAction,
    out: ChildOutcome,
    op: Op,
    adapter: Adapter | undefined,
    cap: CaptureOk | undefined,
  ): void {
    const receipt = "receiptId" in out && out.receiptId !== undefined ? out.receiptId : undefined;
    if (out.status === "ok") {
      if (op === "undo") {
        this.#save(item.id, {
          status: "undone",
          approvalId: null,
          result: {
            ...(item.result ?? {}),
            ...(receipt === undefined ? {} : { receiptId: receipt }),
          },
        });
        return;
      }
      const createdId = createdIdOf(out.output);
      const draftId = draftIdOf(out.output);
      const refs = [...new Set([createdId, draftId].filter((x): x is string => !!x))];
      this.#save(item.id, {
        status: "applied",
        approvalId: null,
        appliedAt: new Date(this.#d.clock.now()).toISOString(),
        result: { ...(receipt === undefined ? {} : { receiptId: receipt }), refs },
      });
      void this.#storeInverse(item, adapter, cap, createdId).catch((err) => this.#d.onError?.(err));
      return;
    }
    const back = op === "apply" ? "ready" : "applied";
    if (out.status === "before_effect") {
      // Nothing happened: the item can be ticked again (§5.3).
      this.#save(item.id, { status: back, approvalId: null, result: { error: out.error } });
    } else {
      this.#save(item.id, {
        status: out.status === "uncertain" ? "uncertain" : op === "undo" ? "applied" : "failed",
        approvalId: null,
        result: { error: out.error, ...(receipt === undefined ? {} : { receiptId: receipt }) },
      });
    }
  }

  /** The inverse call and the post-apply state the undo is later checked against (§5.4). */
  async #storeInverse(
    item: StagedAction,
    adapter: Adapter | undefined,
    cap: CaptureOk | undefined,
    createdId: string | undefined,
  ): Promise<void> {
    if (adapter === undefined || cap === undefined || adapter.inverse === undefined) return;
    const created = createdId === undefined ? undefined : { id: createdId };
    const inv = adapter.inverse(callFromItem(item), cap, created);
    if (inv === undefined) return;
    let post: Json = null;
    try {
      post = (await adapter.postState?.(callFromItem(item), cap, created)) ?? null;
    } catch {
      return; // no post state: no undo
    }
    if (post === null) return;
    const calendarId = typeof inv.args.calendarId === "string" ? inv.args.calendarId : undefined;
    this.#d.store.setInverse(item.id, {
      call: { tool: inv.tool, args: inv.args },
      post,
      ...(inv.destructive === true && createdId !== undefined ? { createdId } : {}),
      ...(calendarId === undefined ? {} : { calendarId }),
    } satisfies StoredInverse);
    this.#emitItem(item.id);
  }

  /**
   * The send recipe (§3.2): the draft saved now, what the helper says it saved equal to the staged
   * to, cc, subject and body, then `mail_send_draft` with those fields and the body hash, which the
   * helper checks again against the live draft before it sends.
   */
  async #runSend(
    child: { approval: ApprovalRequest; call: PolicyCall; summary: string },
    itemId: string,
    drafts: Map<string, DraftOutcome>,
    ctx: { threadId: string; runId: string; taint: boolean; taintSources: TaintSource[] },
  ): Promise<void> {
    const item = this.#d.store.getStagedAction(itemId);
    const draft = drafts.get(itemId);
    const fail = (error: string) => {
      if (item === null) return;
      const result = { ...(item.result ?? {}), error: `send: ${error}` };
      this.#d.store.updateStagedAction(item.id, { result });
      this.#emitItem(item.id);
    };
    if (item === null || draft?.ok !== true || draft.draftId === undefined) {
      return fail("skipped: the draft was not saved");
    }
    const cannot = sendRefusal(item.tool);
    if (cannot !== undefined) return fail(cannot);
    const send = this.#trustedSend(item);
    const sendTool = sendToolFor(item.tool);
    if (send === undefined || sendTool === undefined || sendTool !== child.call.tool) {
      return fail("the send doesn't match the draft");
    }
    const saved = draft.saved;
    if (saved === undefined || saved.draftId !== draft.draftId) {
      return fail("draft_unreadable: the draft tool didn't say what it saved");
    }
    const check = checkSavedDraft(saved, callFromItem(item).args, send.recipients);
    if (!check.ok) return fail(check.reason);
    // Exactly what the helper reported: `mail.send_draft` compares these with the live draft.
    const args: Record<string, unknown> = {
      draftId: saved.draftId,
      to: saved.to,
      ...(saved.cc.length === 0 ? {} : { cc: saved.cc }),
      subject: saved.subject,
      bodySha256: saved.bodySha256.toLowerCase(),
    };
    const sendId = `${item.id}${SEND_SUFFIX}`;
    const call = this.#rebuild(item, { tool: sendTool, args }, sendId);
    if (typeof call === "string") return fail(call);
    if (stable(callRecipients(call)) !== stable([...send.recipients].sort())) {
      return fail("recipients_changed");
    }
    let approval: ApprovalRequest;
    try {
      approval = await this.#d.broker.bindStagedSend({
        childApprovalId: child.approval.id,
        itemId: sendId,
        sendHash: send.contentHash,
        call,
        connectorIds: this.#d.connectorIds(),
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message.slice(0, 200) : "not bound");
    }
    const out = await runChild(
      { tools: this.#d.tools, broker: this.#d.broker },
      { approval, call, summary: child.summary, callId: sendId },
      ctx,
      { uncertainOnThrow: true },
    );
    const now = this.#d.store.getStagedAction(item.id);
    const result = { ...(now?.result ?? item.result ?? {}) };
    if (out.status === "ok") {
      result.refs = [...new Set([...(result.refs ?? []), `sent:${draft.draftId}`])].slice(0, 20);
      delete result.error;
    } else {
      result.error = `send ${out.status}: ${out.error}`.slice(0, 500);
    }
    this.#d.store.updateStagedAction(item.id, { result });
    this.#emitItem(item.id);
  }

  // --- bookkeeping -----------------------------------------------------------------------------

  #save(id: string, patch: Parameters<ApplyStore["updateStagedAction"]>[1]): void {
    this.#d.store.updateStagedAction(id, patch);
    this.#emitItem(id);
  }

  #emitItem(id: string): void {
    const i = this.#d.store.getStagedAction(id);
    if (i !== null) this.#d.onItem?.(i);
  }

  /** The review's status from its items (§5.3): applied, partial, dismissed or still ready. */
  #settle(nightId: string): void {
    const night = this.#d.store.getNight(nightId);
    if (night === null || night.reviewStatus === "expired" || night.reviewStatus === "none") return;
    const items = this.#d.store.listStagedActions(nightId).filter((i) => i.status !== "superseded");
    const open = items.some((i) => i.status === "ready" || i.status === "stale");
    const done = items.filter((i) => i.status === "applied" || i.status === "undone").length;
    const bad = items.some((i) => i.status === "failed" || i.status === "uncertain");
    const next: typeof night.reviewStatus =
      done === 0 && !bad
        ? open
          ? night.reviewStatus
          : "dismissed"
        : open || bad
          ? "partial"
          : "applied";
    if (next !== night.reviewStatus) {
      this.#d.store.updateNight(nightId, { reviewStatus: next });
      this.#d.onNight?.(nightId);
    }
  }
}

function dedupe(xs: readonly TaintSource[]): TaintSource[] {
  const seen = new Set<string>();
  const out: TaintSource[] = [];
  for (const x of xs) {
    const k = stable(x as unknown as Json);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(structuredClone(x));
  }
  return out.slice(0, 20);
}
