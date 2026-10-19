import { PsycheError } from "@psyche/protocol";
import type { LibrarySink } from "../framework/types.ts";
import { type GoogleApi, statusOf } from "./api.ts";
import {
  type AttachmentInfo,
  buildMime,
  decodeBase64Url,
  type GmailPart,
  MAX_ATTACHMENT_BYTES,
  type OutgoingMail,
  parsePayload,
} from "./mime.ts";

/**
 * Gmail API v1 (research KQ4). Every value read from mail is third-party content: the tools
 * that return it tag it `untrusted`. History sync follows Google's sync guide: poll
 * `history.list` from the saved `historyId`; a 404 (history expired) means full resync.
 */
export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
export const MAX_LIST = 50;

interface RawMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
}

export interface ThreadSummary {
  id: string;
  snippet: string;
  subject: string;
  from: string;
  date: string;
  messageCount: number;
  labelIds: string[];
}

export interface MessageView {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  subject: string;
  messageId: string;
  references: string;
  labelIds: string[];
  body: string;
  bodySource: "plain" | "html" | "none";
  attachments: AttachmentInfo[];
  warnings: string[];
}

function hdr(part: GmailPart | undefined, name: string): string {
  const lower = name.toLowerCase();
  const v = part?.headers?.find((h) => h.name?.toLowerCase() === lower)?.value;
  return typeof v === "string" ? v.slice(0, 2000) : "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function messageView(m: RawMessage): MessageView {
  const parsed = parsePayload(m.payload);
  return {
    id: str(m.id),
    threadId: str(m.threadId),
    from: hdr(m.payload, "From"),
    to: hdr(m.payload, "To"),
    cc: hdr(m.payload, "Cc"),
    date: hdr(m.payload, "Date"),
    subject: hdr(m.payload, "Subject"),
    messageId: hdr(m.payload, "Message-ID"),
    references: hdr(m.payload, "References"),
    labelIds: Array.isArray(m.labelIds) ? m.labelIds.filter((x) => typeof x === "string") : [],
    body: parsed.text,
    bodySource: parsed.source,
    attachments: parsed.attachments,
    warnings: parsed.warnings,
  };
}

export class Gmail {
  readonly #api: GoogleApi;

  constructor(api: GoogleApi) {
    this.#api = api;
  }

  profile(signal?: AbortSignal) {
    return this.#api.json<{ emailAddress?: string; historyId?: string }>(`${GMAIL_BASE}/profile`, {
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async listThreads(
    input: { query?: string; labelIds?: string[]; maxResults?: number; pageToken?: string },
    signal?: AbortSignal,
  ): Promise<{ threads: ThreadSummary[]; nextPageToken: string | null }> {
    const max = Math.min(Math.max(input.maxResults ?? 20, 1), MAX_LIST);
    const list = await this.#api.json<{ threads?: { id?: string }[]; nextPageToken?: string }>(
      `${GMAIL_BASE}/threads`,
      {
        query: {
          q: input.query,
          labelIds: input.labelIds,
          maxResults: max,
          pageToken: input.pageToken,
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const threads: ThreadSummary[] = [];
    for (const t of (list.threads ?? []).slice(0, max)) {
      if (typeof t.id !== "string") continue;
      const full = await this.#api.json<{ id?: string; messages?: RawMessage[] }>(
        `${GMAIL_BASE}/threads/${encodeURIComponent(t.id)}`,
        {
          query: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] },
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const msgs = full.messages ?? [];
      const first = msgs[0];
      const last = msgs.at(-1);
      threads.push({
        id: t.id,
        snippet: str(last?.snippet).slice(0, 500),
        subject: hdr(first?.payload, "Subject"),
        from: hdr(last?.payload, "From"),
        date: hdr(last?.payload, "Date"),
        messageCount: msgs.length,
        labelIds: [...new Set(msgs.flatMap((m) => m.labelIds ?? []))],
      });
    }
    return { threads, nextPageToken: list.nextPageToken ?? null };
  }

  async readThread(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; messages: MessageView[] }> {
    const t = await this.#api.json<{ id?: string; messages?: RawMessage[] }>(
      `${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}`,
      { query: { format: "full" }, ...(signal === undefined ? {} : { signal }) },
    );
    return {
      id: str(t.id) || threadId,
      messages: (t.messages ?? []).slice(0, 100).map(messageView),
    };
  }

  async message(messageId: string, signal?: AbortSignal): Promise<MessageView> {
    const m = await this.#api.json<RawMessage>(
      `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}`,
      {
        query: { format: "full" },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return messageView(m);
  }

  /** Download one attachment into the Library; refuses anything over `MAX_ATTACHMENT_BYTES`. */
  async saveAttachment(
    input: { connectorId: string; messageId: string; attachment: AttachmentInfo },
    library: LibrarySink | undefined,
    signal?: AbortSignal,
  ): Promise<{ libraryItemId: string }> {
    if (library === undefined) throw new PsycheError("unavailable", "no Library is configured");
    const a = input.attachment;
    if (a.attachmentId === undefined) throw new PsycheError("not_found", "attachment has no id");
    if (a.tooLarge || a.size > MAX_ATTACHMENT_BYTES) {
      throw new PsycheError("invalid_params", "attachment is too large to download");
    }
    const res = await this.#api.json<{ data?: string; size?: number }>(
      `${GMAIL_BASE}/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(a.attachmentId)}`,
      signal === undefined ? {} : { signal },
    );
    const bytes = typeof res.data === "string" ? decodeBase64Url(res.data) : null;
    if (bytes === null) throw new PsycheError("internal", "attachment data is not valid base64url");
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new PsycheError("invalid_params", "attachment is too large to download");
    }
    return library.put({
      name: a.filename,
      mimeType: a.mimeType,
      bytes,
      source: { connectorId: input.connectorId, ref: `gmail:${input.messageId}/${a.attachmentId}` },
      provenance: "untrusted",
    });
  }

  async listLabels(signal?: AbortSignal) {
    const r = await this.#api.json<{ labels?: { id?: string; name?: string; type?: string }[] }>(
      `${GMAIL_BASE}/labels`,
      signal === undefined ? {} : { signal },
    );
    return (r.labels ?? []).map((l) => ({ id: str(l.id), name: str(l.name), type: str(l.type) }));
  }

  async modifyThreadLabels(
    threadId: string,
    add: string[],
    remove: string[],
    signal?: AbortSignal,
  ) {
    return this.#api.json<{ id?: string }>(
      `${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}/modify`,
      {
        method: "POST",
        json: { addLabelIds: add, removeLabelIds: remove },
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async createDraft(mail: OutgoingMail, threadId: string | undefined, signal?: AbortSignal) {
    const message: Record<string, string> = { raw: buildMime(mail) };
    if (threadId !== undefined) message.threadId = threadId;
    return this.#api.json<{ id?: string; message?: { id?: string; threadId?: string } }>(
      `${GMAIL_BASE}/drafts`,
      {
        method: "POST",
        json: { message },
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  async send(mail: OutgoingMail, threadId: string | undefined, signal?: AbortSignal) {
    const body: Record<string, string> = { raw: buildMime(mail) };
    if (threadId !== undefined) body.threadId = threadId;
    return this.#api.json<{ id?: string; threadId?: string; labelIds?: string[] }>(
      `${GMAIL_BASE}/messages/send`,
      {
        method: "POST",
        json: body,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  /**
   * Incremental sync from `startHistoryId`. Returns new message ids and the latest history id.
   * A 404 (history no longer available) falls back to a full resync of recent inbox messages.
   */
  async sync(
    startHistoryId: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ historyId: string; messageIds: string[]; full: boolean }> {
    if (startHistoryId === undefined) return this.#fullSync(signal);
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latest = startHistoryId;
    try {
      for (let page = 0; page < 20; page++) {
        const r = await this.#api.json<{
          history?: { messagesAdded?: { message?: { id?: string } }[] }[];
          historyId?: string;
          nextPageToken?: string;
        }>(`${GMAIL_BASE}/history`, {
          query: {
            startHistoryId,
            historyTypes: ["messageAdded"],
            labelId: "INBOX",
            maxResults: 500,
            pageToken,
          },
          ...(signal === undefined ? {} : { signal }),
        });
        for (const h of r.history ?? []) {
          for (const a of h.messagesAdded ?? [])
            if (typeof a.message?.id === "string") ids.add(a.message.id);
        }
        if (typeof r.historyId === "string") latest = r.historyId;
        if (r.nextPageToken === undefined) break;
        pageToken = r.nextPageToken;
      }
    } catch (err) {
      if (statusOf(err) === 404) return this.#fullSync(signal);
      throw err;
    }
    return { historyId: latest, messageIds: [...ids], full: false };
  }

  async #fullSync(signal?: AbortSignal) {
    const profile = await this.profile(signal);
    const list = await this.#api.json<{ messages?: { id?: string }[] }>(`${GMAIL_BASE}/messages`, {
      query: { labelIds: ["INBOX"], maxResults: 100 },
      ...(signal === undefined ? {} : { signal }),
    });
    if (typeof profile.historyId !== "string")
      throw new PsycheError("internal", "Gmail profile has no historyId");
    return {
      historyId: profile.historyId,
      messageIds: (list.messages ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : [])),
      full: true,
    };
  }
}
