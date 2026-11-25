/**
 * Night shift precheck and preview adapters (docs/design/night-shift-2026.md §2.3, §2.4).
 *
 * An adapter turns one staged write call into: a `capture` (the precondition, the "before" snapshot
 * and the undo data, read through a read-only registry), a `check` (is the precondition still true
 * at apply time), a `preview` (plain data, never HTML) and optionally an `inverse`.
 *
 * Every refusal fails closed: a registry that cannot answer, a field the adapter does not know how
 * to judge, or a missing dependency refuses the stage; it never falls back to a weaker check.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One side-effecting call the loop wants to stage. Args are the frozen, validated model args. */
export interface StagedCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface CaptureOk {
  ok: true;
  /** The target key: thread id, event id, reminder id or file `dev:ino` (§2.4). */
  target: string;
  /** Other target keys this item replaces or folds (file folding). */
  folds?: string[];
  /** A replacement call to store instead of the model's (file folding rewrites the earlier item). */
  call?: StagedCall;
  /** The precondition `check` re-reads at apply. */
  precondition: Json;
  /** The "before" snapshot for the preview and the undo data. */
  before: Json;
}

export interface Refused {
  ok: false;
  /** A short machine reason, shown in the stager's refusal and in tests. */
  reason: string;
}

export type CaptureResult = CaptureOk | Refused;

export type CheckResult = { fresh: true } | { fresh: false; reason: string };

/** One preview row. `truncated` means `value` is a shortened form of the real text. */
export interface PreviewRow {
  label: string;
  value: string;
  truncated?: true;
  /** `new_recipient`: the owner has never sent to this address. `reply_all`: a reply-all draft. */
  badge?: "new_recipient" | "reply_all";
}

/**
 * A preview is plain data: strings only, control characters removed. Clients render it as text.
 * Sendable fields (recipients, subject, body) are carried in full, never shortened. If any row is
 * shortened anyway, `truncated` is true and the UI must expand the full text before it enables
 * the send tick.
 */
export interface Preview {
  kind: "mail" | "calendar" | "reminder" | "file";
  title: string;
  rows: PreviewRow[];
  truncated: boolean;
}

/** The call that undoes an applied item (§5.4). It goes through the same apply path. */
export interface InverseCall {
  tool: string;
  args: Record<string, unknown>;
  /** Deleting what Night shift itself created: destructive, bound to the created id, device-only. */
  destructive?: true;
}

/** Context for folding: items already staged tonight, oldest first. */
export interface CaptureContext {
  pending?: ReadonlyArray<{ call: StagedCall; capture: CaptureOk }>;
}

export interface Adapter {
  /** Exact tool names, after connector prefixing. */
  readonly tools: readonly string[];
  capture(call: StagedCall, ctx?: CaptureContext): Promise<CaptureResult>;
  check(call: StagedCall, capture: CaptureOk): Promise<CheckResult>;
  preview(call: StagedCall, capture: CaptureOk): Preview;
  /** `created` is the id the applied create returned, when the call was a create. */
  inverse?(call: StagedCall, capture: CaptureOk, created?: { id: string }): InverseCall | undefined;
  /** Read right after apply: the state the inverse is later checked against. */
  postState?(call: StagedCall, capture: CaptureOk, created?: { id: string }): Promise<Json>;
  /** Is the inverse still safe to run (the target unchanged since `postState`)? */
  checkInverse?(
    call: StagedCall,
    capture: CaptureOk,
    post: Json,
    created?: { id: string },
  ): Promise<CheckResult>;
}

// --- Read-only registry (injected; tests fake it) -----------------------------------------------

export interface MailThreadInfo {
  threadId: string;
  /** Newest message id and the message count: a change means a new message arrived. */
  newestMessageId: string;
  count: number;
  /** Addresses of everyone who sent or received in the thread. */
  participants: string[];
}

export interface MailDraftInfo {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  inReplyTo: string;
  attachments: string[];
}

export interface CalendarEventInfo {
  id: string;
  calendarId?: string;
  etag: string;
  title: string;
  /** ISO start and end. */
  start: string;
  end: string;
  /** Attendees other than the owner. */
  attendees: string[];
  fields: Record<string, Json>;
}

export interface ReminderInfo {
  id: string;
  listId: string;
  modifiedAt: string;
  title: string;
  completed: boolean;
  fields: Record<string, Json>;
}

/**
 * Reads only. It deliberately has no write method, so an adapter cannot reach a connector's write
 * path. Each method returns null for "not there" and throws when it cannot answer; a throw refuses
 * the stage (capture) or marks the item stale (check).
 */
export interface ReadRegistry {
  mailThread(ref: {
    threadId?: string;
    messageId?: string;
    mailbox?: string;
    account?: string;
  }): Promise<MailThreadInfo | null>;
  mailDraft(draftId: string): Promise<MailDraftInfo | null>;
  /**
   * The recipients a reply to message `messageId` really goes to: Reply-To, else From, plus To
   * and Cc when `replyAll`. Lowercase addresses; null when the message is gone.
   */
  mailReplyRecipients(ref: {
    messageId: string;
    mailbox?: string;
    account?: string;
    replyAll: boolean;
  }): Promise<string[] | null>;
  /**
   * Which of these addresses the owner has ever sent mail to (their sent mail, not the thread).
   * A participant who only ever wrote to the owner is not in the answer, so the review UI can
   * show a "New recipient" badge.
   */
  mailSentTo(addresses: string[]): Promise<string[]>;
  calendarEvent(ref: { id: string; calendarId?: string }): Promise<CalendarEventInfo | null>;
  /** Events with exactly this title and start (the duplicate check for a create). */
  calendarFind(q: {
    title: string;
    start: string;
    calendarId?: string;
  }): Promise<CalendarEventInfo[]>;
  reminder(id: string): Promise<ReminderInfo | null>;
  remindersFind(q: { title: string; listId?: string }): Promise<ReminderInfo[]>;
}
