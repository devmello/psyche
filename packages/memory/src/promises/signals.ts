/**
 * Done signals (design section 4.2): when the world shows a promise was kept. Pure rules over
 * evidence metadata the Gateway's readers collected (headers, attachment names, calendar
 * attendees), so each row of the table runs without a mail server or a clock.
 *
 * A clear signal closes the promise (`auto`, undoable for 7 days). A weak or ambiguous one asks
 * ("Did Sam send the contract?"). Nothing is ever inferred from silence, and no body text is read
 * here: the evidence carries names, times and ids only.
 */

import type { LoopAction } from "../graph/store.ts";
import { contentWords } from "./dedupe.ts";
import type { LedgerLoop } from "./lifecycle.ts";
import type { PromiseStore } from "./store.ts";

export type SignalChannel = "mail" | "messages" | "calendar";

/** A message the owner or the counterpart sent: metadata only. */
export interface SentItem {
  at: number;
  channel: "mail" | "messages";
  /** A stable reference to the message (mail link or id, chat guid). Stored as the citation ref. */
  ref: string;
  /** The thread (mail thread key, chat id) the message is in, when the source knows it. */
  threadKey?: string | null;
  /**
   * The owner wrote it, as the source itself records (a Sent mailbox, the SENT label, `isFromMe`),
   * never from a From header. Only such a message can close an `i_owe` promise.
   */
  fromOwner: boolean;
  /** Entity ids of the recipients, for the owner's own messages only; empty for anyone else's. */
  toEntityIds: string[];
  /** Entity id of the sender, resolved by the caller. */
  fromEntityId?: string | null;
  /** Attachment file names (inline images are left out by the reader). */
  attachments: string[];
  /** Their MIME types, same order; "" when the source did not say. */
  attachmentMimes?: string[];
  /** Link texts or URLs' labels the message carries. */
  links: string[];
}

/** A reply in a thread (no attachment needed). */
export interface ReplyItem {
  at: number;
  channel: "mail" | "messages";
  ref: string;
  threadKey: string | null;
  fromOwner: boolean;
  fromEntityId?: string | null;
}

/** A calendar event: who made it, when, and who is invited. */
export interface CalendarItem {
  /** When the event was created. A missing creation time never qualifies. */
  createdAt: number | null;
  ref: string;
  title: string;
  createdByOwner: boolean;
  attendeeEntityIds: string[];
}

/** The model's `update: done` verdict on a later mention (W2 produces it). */
export interface ModelDone {
  at: number;
  ref: string;
  channel: "mail" | "messages";
  /** Whose words the quote is. Only `owner` is trusted to close a promise. */
  author: "owner" | "counterpart";
  hasAttachment: boolean;
}

export interface DoneEvidence {
  sent: SentItem[];
  replies: ReplyItem[];
  events: CalendarItem[];
  modelDone?: ModelDone[];
}

export interface DoneContext {
  /** Only evidence strictly after this counts: the first citation, or the last undo. */
  afterMs: number;
  /** A "Not yet" in the last 3 days holds the ask back. */
  askSuppressed: boolean;
  /** Whether a `done` question is already open and unanswered. */
  askOpen: boolean;
}

export type DoneLoop = Pick<
  LedgerLoop,
  "direction" | "whatAction" | "text" | "counterpartId" | "threadKey"
>;

export interface DoneEvidenceRef {
  channel: SignalChannel;
  ref: string;
  /** "deck.pdf", or the event title. Empty for a reply. */
  label: string;
  at: number;
  /** Whose act it was: the owner sent it, or the counterpart did. */
  by: "owner" | "counterpart";
}

export type DoneVerdict =
  | {
      kind: "auto";
      /** `reply_seen` is the existing rule for a counterpart's reply. */
      closedBy: "auto" | "reply_seen";
      evidence: DoneEvidenceRef;
    }
  | { kind: "ask"; reason: AskReason; evidence?: DoneEvidenceRef }
  | { kind: "none" };

export type AskReason =
  | "no_attachment"
  | "unclear_attachment"
  | "counterpart_said_done"
  | "do_promise";

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "send",
  "sending",
  "sent",
  "share",
  "forward",
  "over",
  "email",
  "mail",
  "attach",
  "attached",
  "copy",
  "file",
  "files",
  "document",
  "doc",
  "pdf",
  "new",
  "latest",
  "final",
  "version",
  "you",
  "your",
  "his",
  "her",
  "their",
  "our",
  "get",
  "will",
  "that",
  "this",
]);

/** The words of a promise or a file name that can tie one to the other. */
function topicWords(text: string): Set<string> {
  const spaced = text
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ");
  const out = new Set<string>();
  for (const w of contentWords(spaced)) {
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return out;
}

function sharesWord(what: string, name: string): boolean {
  const a = topicWords(what);
  if (a.size === 0) return false;
  for (const w of topicWords(name)) if (a.has(w)) return true;
  return false;
}

/** The thing a message delivered: its attachments and links, by name. */
const deliverables = (m: SentItem): string[] => [...m.attachments, ...m.links];

const IMAGE_EXT = /\.(png|jpe?g|gif|heic|heif|webp|tiff?|bmp|svg)$/i;
const NAMES_IMAGE =
  /\b(photos?|pictures?|pics?|images?|screenshots?|headshots?|logos?|jpe?g|png)\b/i;

/** Whether every attachment is a picture and there is no link: a signature image looks like this. */
function onlyImages(m: SentItem): boolean {
  if (m.links.length > 0 || m.attachments.length === 0) return false;
  return m.attachments.every(
    (n, i) =>
      (m.attachmentMimes?.[i] ?? "").toLowerCase().startsWith("image/") || IMAGE_EXT.test(n),
  );
}

/**
 * Whether a send's deliverables answer the promise: a shared content word, or exactly one. A
 * lone picture does not, unless the promise itself is about a photo or image.
 */
function delivers(what: string, m: SentItem): string | undefined {
  if (onlyImages(m) && !NAMES_IMAGE.test(what)) return undefined;
  const items = deliverables(m);
  const hit = items.find((n) => sharesWord(what, n));
  if (hit !== undefined) return hit;
  if (items.length === 1) return items[0];
  return undefined;
}

const inThread = (loop: DoneLoop, threadKey: string | null | undefined): boolean =>
  loop.threadKey !== null && threadKey !== null && threadKey !== undefined
    ? loop.threadKey === threadKey
    : false;

/** Whether the owner's message went to the promisee: same thread, or the promisee is a recipient. */
const toPromisee = (loop: DoneLoop, m: SentItem): boolean =>
  inThread(loop, m.threadKey) ||
  (typeof loop.counterpartId === "string" && m.toEntityIds.includes(loop.counterpartId));

const latest = <T extends { at: number }>(xs: T[]): T | undefined =>
  xs.reduce<T | undefined>((a, b) => (a === undefined || b.at > a.at ? b : a), undefined);

const ref = (
  m: { channel: "mail" | "messages"; ref: string; at: number },
  label: string,
  by: "owner" | "counterpart",
): DoneEvidenceRef => ({ channel: m.channel, ref: m.ref, label, at: m.at, by });

const auto = (
  evidence: DoneEvidenceRef,
  closedBy: "auto" | "reply_seen" = "auto",
): DoneVerdict => ({
  kind: "auto",
  closedBy,
  evidence,
});

/**
 * The verdict for one promise. Auto beats ask, ask beats nothing. Evidence at or before
 * `ctx.afterMs` is ignored, so a send from before the promise, or from before an undo, never counts.
 */
export function evaluateDone(
  loop: DoneLoop,
  evidence: DoneEvidence,
  ctx: DoneContext,
): DoneVerdict {
  const action: LoopAction | null = loop.whatAction;
  const after = <T extends { at: number }>(xs: T[]): T[] => xs.filter((x) => x.at > ctx.afterMs);
  const sent = after(evidence.sent);
  const replies = after(evidence.replies);
  const modelDone = after(evidence.modelDone ?? []);

  const askIf = (reason: AskReason, ev?: DoneEvidenceRef): DoneVerdict =>
    ctx.askSuppressed || ctx.askOpen
      ? { kind: "none" }
      : { kind: "ask", reason, ...(ev === undefined ? {} : { evidence: ev }) };

  // A `do` promise is never closed by a signal: any sign it happened is a question.
  if (action === "do") {
    const m = latest(modelDone);
    return m === undefined ? { kind: "none" } : askIf("do_promise", ref(m, "", m.author));
  }

  if (loop.direction === "i_owe") {
    // Only the owner's own messages count: someone else's reply, a stranger's mail that copies the
    // owner, or a photo Sam sent into the chat is never the owner keeping a promise.
    const mine = sent.filter((m) => m.fromOwner && toPromisee(loop, m));
    if (action === "send" || action === null) {
      const ok = mine
        .map((m) => ({ m, name: delivers(loop.text, m) }))
        .filter((x): x is { m: SentItem; name: string } => x.name !== undefined);
      const best = latest(ok.map((x) => ({ ...x, at: x.m.at })));
      if (best !== undefined) return auto(ref(best.m, best.name, "owner"));
      // The promisee got something, but not a clear delivery: ask.
      const withStuff = latest(mine.filter((m) => deliverables(m).length > 0));
      if (withStuff !== undefined) return askIf("unclear_attachment", ref(withStuff, "", "owner"));
      const plain = latest(mine);
      if (plain !== undefined) return askIf("no_attachment", ref(plain, "", "owner"));
    }
    if (action === "meet") {
      const evs = evidence.events.filter(
        (e) =>
          e.createdByOwner &&
          e.createdAt !== null &&
          e.createdAt > ctx.afterMs &&
          typeof loop.counterpartId === "string" &&
          e.attendeeEntityIds.includes(loop.counterpartId),
      );
      const e = evs.reduce<CalendarItem | undefined>(
        (a, b) => (a === undefined || (b.createdAt ?? 0) > (a.createdAt ?? 0) ? b : a),
        undefined,
      );
      if (e !== undefined && e.createdAt !== null)
        return auto({
          channel: "calendar",
          ref: e.ref,
          label: e.title,
          at: e.createdAt,
          by: "owner",
        });
    }
    if (action === "reply") {
      const r = latest(replies.filter((x) => x.fromOwner && inThread(loop, x.threadKey)));
      if (r !== undefined) return auto(ref(r, "", "owner"));
    }
    const own = latest(modelDone.filter((m) => m.author === "owner"));
    if (own !== undefined) return auto(ref(own, "", "owner"));
    const theirs = latest(modelDone.filter((m) => m.author === "counterpart"));
    if (theirs !== undefined) return askIf("counterpart_said_done", ref(theirs, "", "counterpart"));
    return { kind: "none" };
  }

  // waiting_on: the counterpart's own act.
  const them = (id: string | null | undefined): boolean =>
    typeof loop.counterpartId === "string" && id === loop.counterpartId;
  if (action === "send" || action === null) {
    const theirSends = sent.filter((m) => !m.fromOwner && them(m.fromEntityId));
    const isFile = (m: SentItem) =>
      deliverables(m).length > 0 && !(onlyImages(m) && !NAMES_IMAGE.test(loop.text));
    const delivered = latest(theirSends.filter(isFile));
    if (delivered !== undefined)
      return auto(ref(delivered, deliverables(delivered)[0] ?? "", "counterpart"));
    // Only a picture (their signature) came: not a delivery, but worth a question.
    const picture = latest(theirSends.filter((m) => deliverables(m).length > 0));
    if (picture !== undefined) return askIf("unclear_attachment", ref(picture, "", "counterpart"));
    // They wrote, but sent nothing: ask. (A reply is not a delivery for a `send` promise.)
    const bare = latest(theirSends);
    if (bare !== undefined) return askIf("no_attachment", ref(bare, "", "counterpart"));
    const reply = latest(replies.filter((r) => !r.fromOwner && them(r.fromEntityId)));
    if (reply !== undefined) return askIf("no_attachment", ref(reply, "", "counterpart"));
  }
  if (action === "reply") {
    const r = latest(
      replies.filter((x) => !x.fromOwner && them(x.fromEntityId) && inThread(loop, x.threadKey)),
    );
    if (r !== undefined) return auto(ref(r, "", "counterpart"), "reply_seen");
  }
  const own = latest(modelDone.filter((m) => m.author === "owner"));
  if (own !== undefined) return auto(ref(own, "", "owner"));
  const theirs = latest(modelDone.filter((m) => m.author === "counterpart"));
  if (theirs !== undefined) return askIf("counterpart_said_done", ref(theirs, "", "counterpart"));
  return { kind: "none" };
}

/** "Marked done: you sent deck.pdf on Thu", from the citation quote the store keeps. */
export function doneQuote(evidence: DoneEvidenceRef, who: string): string {
  // A file name is someone's text: no control characters or angle brackets in the quote.
  const plain = [...evidence.label]
    .map((ch) =>
      ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || ch === "<" || ch === ">" ? " " : ch,
    )
    .join("")
    .trim();
  const e = { ...evidence, label: plain };
  if (e.channel === "calendar") return `${who} scheduled ${e.label}`;
  if (e.label === "") return e.by === "owner" ? "you replied" : `${who} replied`;
  return e.by === "owner" ? `you sent ${e.label}` : `${who} sent ${e.label}`;
}

export type SignalOutcome =
  | { kind: "done"; promiseId: string; closedBy: "auto" | "reply_seen"; evidence: DoneEvidenceRef }
  | { kind: "ask"; promiseId: string; reason: AskReason }
  | { kind: "none"; promiseId: string };

/**
 * Runs the done rules for one promise against the ledger and applies the verdict: an automatic
 * done through the same lifecycle as the owner's (so Undo and the 7-day window are W1's), or one
 * recorded question. Idempotent: a closed promise is skipped, an open question is not asked twice,
 * and evidence from before the first citation or before an undo is ignored.
 */
export function applyDoneSignals(
  store: PromiseStore,
  promiseId: string,
  evidence: DoneEvidence,
  who: string,
): SignalOutcome {
  const none: SignalOutcome = { kind: "none", promiseId };
  const loop = store.get(promiseId);
  if (loop === undefined) return none;
  if (loop.status !== "open" && loop.status !== "broken" && loop.status !== "snoozed") return none;
  const first = store.firstCitationAt(promiseId) ?? 0;
  const afterMs = Math.max(first, store.lastUndoAt(promiseId) ?? 0);
  const verdict = evaluateDone(loop, evidence, {
    afterMs,
    askSuppressed: store.askSuppressed(promiseId),
    askOpen: store.doneAskOpen(promiseId),
  });
  if (verdict.kind === "ask") {
    store.recordAsk(promiseId, "done");
    return { kind: "ask", promiseId, reason: verdict.reason };
  }
  if (verdict.kind === "none") return none;
  const e = verdict.evidence;
  store.act(
    promiseId,
    { action: "done", by: verdict.closedBy },
    {
      citation: {
        source: e.channel,
        sourceRef: e.ref,
        quote: doneQuote(e, who),
        provenance: e.by === "owner" ? "owner" : "untrusted",
        observedAt: new Date(e.at).toISOString(),
      },
    },
  );
  return { kind: "done", promiseId, closedBy: verdict.closedBy, evidence: e };
}
