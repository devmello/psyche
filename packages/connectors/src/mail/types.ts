import type { JsonObject, ResolvedSecret } from "@psyche/protocol";
import type { AttachmentInfo, OutgoingMail } from "../google/mime.ts";

/**
 * One mail backend per protocol (JMAP, IMAP + SMTP) behind the tools of `MailConnector`, so
 * non-Google mail gets Gmail's tool surface and side-effect classes (feature M7). Everything a
 * backend returns comes from the mailbox and is third-party content; the connector tags it
 * `untrusted`.
 */

export type MailboxRole = "inbox" | "drafts" | "sent" | "trash" | "junk" | "archive" | "all";

export interface MailboxInfo {
  /** Backend id (IMAP: the mailbox name; JMAP: the Mailbox id). */
  id: string;
  name: string;
  role?: MailboxRole;
  total?: number;
  unread?: number;
}

export interface MailSearch {
  /** Free text over headers and body. */
  query?: string;
  /** Mailbox id; default the inbox. */
  mailbox?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** ISO dates (inclusive since, exclusive before). */
  since?: string;
  before?: string;
  unread?: boolean;
  maxResults?: number;
  pageToken?: string;
}

export interface MailRef {
  id: string;
  mailbox?: string;
}

export interface MailSummary {
  id: string;
  mailbox: string;
  threadId?: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  unread: boolean;
  /** Provider flags / keywords, normalized to lower case without the leading backslash or `$`. */
  flags: string[];
  size?: number;
}

export interface MailMessageView extends MailSummary {
  cc: string;
  messageId: string;
  inReplyTo: string;
  references: string;
  body: string;
  bodySource: "plain" | "html" | "none";
  attachments: AttachmentInfo[];
  warnings: string[];
}

export interface MailChange {
  addFlags?: string[];
  removeFlags?: string[];
  /** Mailbox id to move the message to. */
  moveTo?: string;
}

export interface MailSyncResult {
  changes: number;
  full: boolean;
  cursor: JsonObject;
  newMessageIds: string[];
}

/** An authenticated backend connection; the connector closes it after each tool call. */
export interface MailSession {
  /** The owner's primary address as the backend reports it. */
  account(): Promise<string>;
  listMailboxes(signal?: AbortSignal): Promise<MailboxInfo[]>;
  search(
    input: MailSearch,
    signal?: AbortSignal,
  ): Promise<{ messages: MailSummary[]; nextPageToken: string | null }>;
  read(ref: MailRef, signal?: AbortSignal): Promise<MailMessageView>;
  attachment(
    ref: MailRef & { partId: string },
    signal?: AbortSignal,
  ): Promise<{ filename: string; mimeType: string; bytes: Uint8Array }>;
  modify(ref: MailRef, change: MailChange, signal?: AbortSignal): Promise<MailRef>;
  /** `raw` is the RFC 5322 message the connector built from `mail`. */
  createDraft(mail: OutgoingMail, raw: Uint8Array, signal?: AbortSignal): Promise<{ id: string }>;
  send(
    mail: OutgoingMail,
    raw: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ id: string; threadId?: string }>;
  sync(cursor: JsonObject | null, signal?: AbortSignal): Promise<MailSyncResult>;
  close(): Promise<void>;
}

export interface MailBackend {
  readonly kind: "imap" | "jmap";
  /** Hosts the credential is sent to (for the setup copy and the vault binding display). */
  readonly hosts: string[];
  /**
   * Opens an authenticated session. The secret is used once, inside `open`, and never stored:
   * IMAP logs in and keeps the socket; JMAP keeps the bearer token for this session only.
   */
  open(secret: ResolvedSecret, signal?: AbortSignal): Promise<MailSession>;
}

/** The backend rejected the credential (bad app password, revoked token, 401 / 403). */
export class MailAuthError extends Error {
  readonly reason: "invalid_credentials" | "token_revoked";
  constructor(reason: MailAuthError["reason"], message = `mail authentication failed: ${reason}`) {
    super(message);
    this.name = "MailAuthError";
    this.reason = reason;
  }
}
