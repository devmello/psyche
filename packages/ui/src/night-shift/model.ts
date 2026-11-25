import type { ApprovalRequest, StagedAction, StagedActionDomain } from "@psyche/protocol";

/**
 * The pure rules of the Night shift review (docs/design/night-shift-2026.md §3.2, §3.3, §5):
 * what a preview shows, what can be ticked, what a send needs, and whether the approval the
 * Gateway minted is for exactly what the owner saw. Nothing here touches the network.
 */

/** Longest text a preview field may carry into the page; the rest is cut. */
export const MAX_PREVIEW_TEXT = 20_000;
/** `nightShift.apply` takes at most this many items. */
export const MAX_APPLY_ITEMS = 50;
/** An applied item can be undone for this long (§5.4). */
export const UNDO_WINDOW_MS = 24 * 60 * 60_000;

export const DOMAIN_ORDER: readonly StagedActionDomain[] = [
  "mail",
  "calendar",
  "files",
  "reminders",
];

// --- Previews: server data only, as plain text --------------------------------------------------

export interface PreviewRow {
  label: string;
  /** The text (a calendar change is already "before -> after" in it, written by the Gateway). */
  value: string;
  /** The owner has never written to this recipient (`badge: "new_recipient"`). */
  newRecipient: boolean;
  /** The text shown here is cut; the owner must open the full draft. */
  truncated: boolean;
}

export interface ItemPreview {
  rows: PreviewRow[];
  truncated: boolean;
  replyAll: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Plain text only: a string is cut, a number is written out, anything else is nothing. */
function text(v: unknown): string | null {
  if (typeof v === "string") return v.length > MAX_PREVIEW_TEXT ? v.slice(0, MAX_PREVIEW_TEXT) : v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Reads a preview in the shape the Night shift adapters write (packages/proactive
 * src/night-shift/adapters/types.ts): `{kind, title, rows: [{label, value, truncated?, badge?}],
 * truncated}`, where `badge` is `new_recipient` or `reply_all`. Only the keys named here are read, every value becomes text (React escapes
 * it; nothing is ever set as HTML), and a field this does not know is dropped.
 */
export function readPreview(preview: unknown): ItemPreview {
  if (!isRecord(preview)) return { rows: [], truncated: false, replyAll: false };
  const rows: PreviewRow[] = [];
  let replyAll = false;
  if (Array.isArray(preview.rows)) {
    for (const r of preview.rows.slice(0, 50)) {
      if (!isRecord(r)) continue;
      rows.push({
        label: text(r.label) ?? "",
        value: text(r.value) ?? "",
        newRecipient: r.badge === "new_recipient",
        truncated: r.truncated === true,
      });
      if (r.badge === "reply_all") replyAll = true;
    }
  }
  return { rows, truncated: preview.truncated === true, replyAll };
}

/** Whether any part of the preview is cut (on the preview itself or on any row). */
export function isTruncated(p: ItemPreview): boolean {
  return p.truncated || p.rows.some((r) => r.truncated);
}

export const hasNewRecipient = (p: ItemPreview): boolean => p.rows.some((r) => r.newRecipient);

// --- Which items can be ticked, and what a send needs -------------------------------------------

/** Selection state. Hashes are kept so a changed item drops its tick instead of keeping it. */
export interface Selection {
  /** itemId to the bindingHash the owner saw when ticking. */
  ticked: ReadonlyMap<string, string>;
  /** itemId to the sendHash the owner saw when ticking "Send it too". */
  sends: ReadonlyMap<string, string>;
  /** itemId to the bindingHash whose full draft the owner opened. */
  opened: ReadonlyMap<string, string>;
  /** itemId to why the Gateway refused it (not tickable again). */
  refused: ReadonlyMap<string, string>;
}

export const EMPTY_SELECTION: Selection = {
  ticked: new Map(),
  sends: new Map(),
  opened: new Map(),
  refused: new Map(),
};

/** Only a `ready` item the Gateway has not refused. Stale, applied and the rest never. */
export function tickable(item: StagedAction, sel: Selection): boolean {
  return item.status === "ready" && !sel.refused.has(item.id);
}

export type SendBlock = "draft" | "truncated" | null;

/**
 * Why "Send it too" is off for this item: its draft is not ticked, or the preview is cut and the
 * owner has not opened the full draft. `null` when the box may be ticked.
 */
export function sendBlock(item: StagedAction, sel: Selection): SendBlock {
  if (!sel.ticked.has(item.id)) return "draft";
  if (isTruncated(readPreview(item.preview)) && sel.opened.get(item.id) !== item.bindingHash)
    return "truncated";
  return null;
}

export const hasSend = (item: StagedAction): boolean =>
  item.send !== null && item.status === "ready";

/**
 * Drops whatever no longer holds against the items now on screen: a tick on an item that went
 * stale, was refused or changed hash; a send whose draft is unticked, whose content hash changed
 * or whose full draft was not opened. Run on every render and again before an apply, so the
 * payload is always what the owner can see ticked.
 */
export function reconcile(sel: Selection, items: readonly StagedAction[]): Selection {
  const byId = new Map(items.map((i) => [i.id, i]));
  const ticked = new Map<string, string>();
  for (const [id, hash] of sel.ticked) {
    const item = byId.get(id);
    if (item && tickable(item, sel) && item.bindingHash === hash) ticked.set(id, hash);
  }
  const opened = new Map<string, string>();
  for (const [id, hash] of sel.opened) if (byId.get(id)?.bindingHash === hash) opened.set(id, hash);
  const base: Selection = { ...sel, ticked, opened };
  const sends = new Map<string, string>();
  for (const [id, hash] of sel.sends) {
    const item = byId.get(id);
    if (
      item?.send &&
      hasSend(item) &&
      item.send.contentHash === hash &&
      sendBlock(item, base) === null
    )
      sends.set(id, hash);
  }
  return { ...base, sends };
}

/** The first selection: ready mail drafts are ticked (§3.2), nothing else, and never a send. */
export function seedSelection(items: readonly StagedAction[]): Selection {
  const ticked = new Map<string, string>();
  for (const i of items) {
    if (ticked.size >= MAX_APPLY_ITEMS) break;
    if (i.domain === "mail" && i.status === "ready") ticked.set(i.id, i.bindingHash);
  }
  return { ...EMPTY_SELECTION, ticked };
}

export function toggleItem(sel: Selection, item: StagedAction): Selection {
  if (!tickable(item, sel)) return sel;
  const ticked = new Map(sel.ticked);
  const sends = new Map(sel.sends);
  if (ticked.has(item.id)) {
    ticked.delete(item.id);
    // A send needs its draft: unticking the draft takes the send with it.
    sends.delete(item.id);
  } else if (ticked.size < MAX_APPLY_ITEMS) ticked.set(item.id, item.bindingHash);
  return { ...sel, ticked, sends };
}

/** "Select all": every tickable item, up to the apply limit. It never touches a send. */
export function selectAll(sel: Selection, items: readonly StagedAction[]): Selection {
  const ticked = new Map(sel.ticked);
  for (const i of items) {
    if (ticked.size >= MAX_APPLY_ITEMS) break;
    if (tickable(i, sel)) ticked.set(i.id, i.bindingHash);
  }
  return { ...sel, ticked };
}

export function toggleSend(sel: Selection, item: StagedAction): Selection {
  const sends = new Map(sel.sends);
  if (sends.has(item.id)) sends.delete(item.id);
  else if (item.send && hasSend(item) && sendBlock(item, sel) === null)
    sends.set(item.id, item.send.contentHash);
  return { ...sel, sends };
}

export function markOpened(sel: Selection, item: StagedAction): Selection {
  if (sel.opened.get(item.id) === item.bindingHash) return sel;
  return { ...sel, opened: new Map(sel.opened).set(item.id, item.bindingHash) };
}

export function markRefused(
  sel: Selection,
  refused: readonly { itemId: string; reason: string }[],
): Selection {
  const next = new Map(sel.refused);
  for (const r of refused) next.set(r.itemId, r.reason);
  return { ...sel, refused: next };
}

export interface ApplyPayload {
  items: { itemId: string; bindingHash: string }[];
  sends: { itemId: string; sendHash: string }[];
}

/** What `nightShift.apply` is sent: the reconciled selection, in the order shown. */
export function buildApply(sel: Selection, items: readonly StagedAction[]): ApplyPayload {
  const s = reconcile(sel, items);
  return {
    items: items
      .filter((i) => s.ticked.has(i.id))
      .map((i) => ({ itemId: i.id, bindingHash: i.bindingHash })),
    sends: items.flatMap((i) =>
      s.sends.has(i.id) && i.send ? [{ itemId: i.id, sendHash: i.send.contentHash }] : [],
    ),
  };
}

// --- The approval check -------------------------------------------------------------------------

/** What an approval row may show: these keys of `details.items` and no others. */
export interface ApprovalRow {
  itemId: string;
  bindingHash: string | null;
  sendHash: string | null;
  summary: string | null;
  recipients: string[];
}

/**
 * The rows of `details.items`, read key by key. Anything else in `details` belongs to whoever
 * made the call and is never read or shown. `null` when `details.items` is not a list of rows
 * with ids.
 */
export function approvalRows(approval: ApprovalRequest): ApprovalRow[] | null {
  const raw = (approval.details as Record<string, unknown>).items;
  if (!Array.isArray(raw)) return null;
  const rows: ApprovalRow[] = [];
  for (const r of raw) {
    if (!isRecord(r) || typeof r.itemId !== "string") return null;
    rows.push({
      itemId: r.itemId,
      bindingHash: typeof r.bindingHash === "string" ? r.bindingHash : null,
      sendHash: typeof r.sendHash === "string" ? r.sendHash : null,
      summary: text(r.summary),
      recipients: Array.isArray(r.recipients)
        ? r.recipients.map(text).filter((x): x is string => x !== null)
        : [],
    });
  }
  return rows;
}

/**
 * Whether the approval is for exactly what was sent (§3.3). The set of `details.items` must
 * equal the ticked items (id and binding hash) plus the ticked sends (id and send hash): no row
 * missing, none extra, none twice, none with another hash. For an undo there are no hashes to
 * compare, so the ids must match. Returns the reason on a mismatch.
 */
export function checkApproval(
  approval: ApprovalRequest,
  expected: ApplyPayload | { undo: readonly string[] },
): { ok: true; rows: ApprovalRow[] } | { ok: false; reason: string } {
  if (approval.kind !== "staged_apply") return { ok: false, reason: "kind" };
  if (approval.status !== "pending") return { ok: false, reason: "status" };
  const rows = approvalRows(approval);
  if (rows === null) return { ok: false, reason: "items" };
  let want: string[];
  let got: string[];
  if ("undo" in expected) {
    want = expected.undo.map((id) => `u|${id}`);
    got = rows.map((r) => `u|${r.itemId}`);
  } else {
    want = [
      ...expected.items.map((i) => `i|${i.itemId}|${i.bindingHash}`),
      ...expected.sends.map((s) => `s|${s.itemId}|${s.sendHash}`),
    ];
    got = rows.map((r) =>
      r.sendHash !== null ? `s|${r.itemId}|${r.sendHash}` : `i|${r.itemId}|${r.bindingHash ?? ""}`,
    );
  }
  want.sort();
  got.sort();
  if (want.length === 0 || want.length !== got.length || want.some((k, i) => k !== got[i]))
    return { ok: false, reason: "mismatch" };
  return { ok: true, rows };
}

// --- Row facts ----------------------------------------------------------------------------------

/** Undo is offered for an applied item that has an inverse, for 24 hours (§5.4). Never a draft. */
export function undoable(item: StagedAction, now: number): boolean {
  if (item.status !== "applied" || item.inverse === null || item.domain === "mail") return false;
  const at = item.appliedAt == null ? Number.NaN : Date.parse(item.appliedAt);
  return Number.isFinite(at) && now - at < UNDO_WINDOW_MS;
}

/** Items shown in the review: a superseded one is never shown (§2.4). */
export function visibleItems(items: readonly StagedAction[]): StagedAction[] {
  return items.filter((i) => i.status !== "superseded");
}

export function groupByDomain(
  items: readonly StagedAction[],
): [StagedActionDomain, StagedAction[]][] {
  return DOMAIN_ORDER.map((d): [StagedActionDomain, StagedAction[]] => [
    d,
    items.filter((i) => i.domain === d),
  ]).filter(([, list]) => list.length > 0);
}
