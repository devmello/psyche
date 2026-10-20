import { createHash } from "node:crypto";
import { bindingFor } from "@psyche/permissions";
import {
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelHealth,
  type InboundMessage,
  type JsonObject,
  type OutboundMessage,
  PsycheError,
  type SendResult,
  type Unsubscribe,
} from "@psyche/protocol";
import { type EmailInbound, mapEmail, replySubject, threadKey } from "./mapping.ts";

/**
 * Email as a channel (feature N9, "reply-by-email through the mail connector"; owner S10). The
 * transport is the Gateway's: it polls the mailbox through the mail connector's backend and sends
 * through it. This adapter maps threads to conversations and replies only to the sender of the
 * conversation being answered, never reply-all, never a new recipient.
 *
 * Every sender is weak (`From:` is forgeable; DKIM is not checked yet), so even the owner's
 * address is a non-owner: their mail reaches a chat-only, untrusted route (security §9, #293), and
 * no approval is ever answerable by mail. Unknown senders get nothing back: there is no pairing
 * code by mail (no outbound mail to strangers). Use `dmPolicy: allowlist`.
 */

export interface EmailSendIntent {
  channel: "email";
  account: string;
  /** The thread being answered (its root Message-ID): the only conversation. */
  recipient: string;
  bodySha256: string;
  bindingHash: string;
  grantKey: string;
  purpose: "reply";
}

/** Resolves the id of an approved `message_send` approval for exactly this intent, or throws. */
export type EmailSendAuthorizer = (intent: EmailSendIntent) => Promise<string>;

export interface EmailReply {
  /** The thread (binding recipient) and the one address it goes to. */
  thread: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo: string;
  references: string[];
}

export interface EmailTransport {
  /** Inbox messages after `cursor` (null: start from now, nothing old). */
  poll(cursor: JsonObject | null): Promise<{ messages: EmailInbound[]; cursor: JsonObject }>;
  /** Sends one reply; the executor re-verifies `approvalId` against the reply. */
  send(reply: EmailReply, approvalId: string): Promise<{ messageId: string }>;
  attachment?(id: string, partId: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface EmailCursorStore {
  load(): Promise<JsonObject | null>;
  save(cursor: JsonObject): Promise<void>;
}

export class MemoryEmailCursorStore implements EmailCursorStore {
  value: JsonObject | null = null;
  async load(): Promise<JsonObject | null> {
    return this.value;
  }
  async save(cursor: JsonObject): Promise<void> {
    this.value = cursor;
  }
}

export interface EmailAdapterOptions {
  /** The mailbox address Psyche reads and sends as: the channel's `account`. */
  account: string;
  transport: EmailTransport;
  cursor: EmailCursorStore;
  authorizeSend: EmailSendAuthorizer;
  /** Poll interval, default 60 s. */
  pollMs?: number;
  clock?: { now(): number };
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const EMAIL_MAX_MESSAGE_CHARS = 20_000;
const DEFAULT_POLL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
/** Threads remembered for replies (the newest win). */
const MAX_THREADS = 500;

interface ThreadState {
  to: string;
  subject: string;
  lastMessageId: string;
  references: string[];
}

export class EmailAdapter implements ChannelAdapter {
  readonly type = "email" as const;
  readonly account: string;

  readonly #transport: EmailTransport;
  readonly #cursor: EmailCursorStore;
  readonly #authorize: EmailSendAuthorizer;
  readonly #pollMs: number;
  readonly #clock: { now(): number };
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #inbound = new Set<(message: InboundMessage) => void | Promise<void>>();
  readonly #threads = new Map<string, ThreadState>();
  readonly #sent = new Set<string>();

  #run: AbortController | undefined;
  #polled: Promise<void> = Promise.resolve();
  #lastOkAt: number | undefined;
  #lastError: string | undefined;
  #fatal: string | undefined;
  #handlerErrors = 0;

  constructor(options: EmailAdapterOptions) {
    this.account = options.account.trim().toLowerCase();
    this.#transport = options.transport;
    this.#cursor = options.cursor;
    this.#authorize = options.authorizeSend;
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#sleep = options.sleep ?? sleep;
  }

  get handlerErrors(): number {
    return this.#handlerErrors;
  }

  capabilities(): ChannelCapabilities {
    return {
      buttons: false,
      polls: false,
      reactions: false,
      voiceNotes: false,
      attachments: true,
      groups: false,
      maxMessageChars: EMAIL_MAX_MESSAGE_CHARS,
      typing: false,
      markdown: false,
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#run !== undefined) return;
    this.#fatal = undefined;
    const run = new AbortController();
    this.#run = run;
    signal?.addEventListener("abort", () => void this.stop(), { once: true });
    void this.#loop(run.signal);
  }

  async stop(): Promise<void> {
    this.#run?.abort();
    this.#run = undefined;
  }

  onInbound(handler: (message: InboundMessage) => void | Promise<void>): Unsubscribe {
    this.#inbound.add(handler);
    return () => {
      this.#inbound.delete(handler);
    };
  }

  /** Resolves when the current poll has been handled (tests). */
  idle(): Promise<void> {
    return this.#polled;
  }

  /** One poll now (tests; the loop calls it on its timer). */
  pollOnce(): Promise<void> {
    this.#polled = this.#poll();
    return this.#polled;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.text.trim() === "") throw new PsycheError("invalid_params", "empty message");
    if (message.text.length > EMAIL_MAX_MESSAGE_CHARS) {
      throw new PsycheError("invalid_params", "message too long", {
        details: { max: EMAIL_MAX_MESSAGE_CHARS, length: message.text.length },
      });
    }
    if ((message.attachments ?? []).length > 0) {
      throw new PsycheError("invalid_params", "email attachments are not supported yet");
    }
    const thread = this.#threads.get(message.chatId);
    if (thread === undefined) {
      // Only a thread someone wrote in can be answered; never a new address.
      throw new PsycheError("forbidden", "email replies go only to a thread someone wrote in");
    }
    const bodySha256 = `sha256:${createHash("sha256").update(message.text, "utf8").digest("hex")}`;
    const binding = bindingFor("message_send", {
      channel: "email",
      account: this.account,
      recipient: message.chatId,
      bodySha256,
    });
    const approvalId = await this.#authorize({
      channel: "email",
      account: this.account,
      recipient: message.chatId,
      bodySha256,
      bindingHash: binding.bindingHash,
      grantKey: binding.grantKey,
      purpose: "reply",
    });
    const references = [...thread.references, thread.lastMessageId].slice(-20);
    const sent = await this.#transport.send(
      {
        thread: message.chatId,
        to: thread.to,
        subject: replySubject(thread.subject),
        text: message.text,
        inReplyTo: thread.lastMessageId,
        references,
      },
      approvalId,
    );
    this.#sent.add(sent.messageId);
    return { messageId: sent.messageId };
  }

  async fetchAttachment(ref: string, signal?: AbortSignal): Promise<Uint8Array> {
    const hash = ref.lastIndexOf("#");
    if (hash <= 0 || this.#transport.attachment === undefined) {
      throw new PsycheError("invalid_params", "not an email attachment reference");
    }
    return this.#transport.attachment(ref.slice(0, hash), ref.slice(hash + 1), signal);
  }

  async health(): Promise<ChannelHealth> {
    const base = this.#lastOkAt === undefined ? {} : { lastEventAt: this.#lastOkAt };
    if (this.#fatal !== undefined) return { ok: false, detail: this.#fatal, ...base };
    if (this.#run === undefined) return { ok: false, detail: "stopped", ...base };
    if (this.#lastError !== undefined) return { ok: false, detail: this.#lastError, ...base };
    return { ok: true, ...base };
  }

  // ── polling ──────────────────────────────────────────────────────────────

  async #loop(signal: AbortSignal): Promise<void> {
    let wait = this.#pollMs;
    while (!signal.aborted) {
      await this.pollOnce();
      if (this.#fatal !== undefined) return;
      wait = this.#lastError === undefined ? this.#pollMs : Math.min(wait * 2, MAX_BACKOFF_MS);
      try {
        await this.#sleep(wait, signal);
      } catch {
        return;
      }
    }
  }

  async #poll(): Promise<void> {
    let batch: { messages: EmailInbound[]; cursor: JsonObject };
    try {
      batch = await this.#transport.poll(await this.#cursor.load());
    } catch (err) {
      const e = PsycheError.from(err);
      if (e.code === "forbidden" || e.code === "unauthorized") {
        this.#fatal = `the mailbox rejected the credential (${e.code})`;
      } else {
        this.#lastError = `mail poll failed (${e.code})`;
      }
      return;
    }
    this.#lastError = undefined;
    this.#lastOkAt = this.#clock.now();
    for (const m of batch.messages) {
      const inbound = mapEmail(m, this.account, (id) => this.#sent.has(id));
      if (inbound === undefined) continue;
      this.#remember(m, inbound);
      for (const handler of [...this.#inbound]) {
        try {
          await handler(inbound);
        } catch {
          this.#handlerErrors++;
        }
      }
    }
    // After handling: a crash mid-batch re-reads it (mail is idempotent by Message-ID upstream).
    await this.#cursor.save(batch.cursor).catch(() => {
      this.#handlerErrors++;
    });
  }

  #remember(m: EmailInbound, inbound: InboundMessage): void {
    const key = threadKey(m);
    this.#threads.delete(key);
    this.#threads.set(key, {
      to: inbound.senderId,
      subject: m.subject,
      lastMessageId: m.messageId,
      references: m.references,
    });
    if (this.#threads.size > MAX_THREADS) {
      const oldest = this.#threads.keys().next().value;
      if (oldest !== undefined) this.#threads.delete(oldest);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
