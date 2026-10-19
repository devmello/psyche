import { randomBytes } from "node:crypto";
import {
  type ApprovalRequest,
  type ChannelAdapter,
  type ChannelApprovalAnswer,
  type ChannelAttachment,
  type ChannelCapabilities,
  type ChannelHealth,
  type InboundMessage,
  type OutboundMessage,
  PsycheError,
  type SendResult,
  type Unsubscribe,
} from "@psyche/protocol";
import { Bot, GrammyError, HttpError, InputFile, type Transformer } from "grammy";
import type { CallbackQuery, Update, UserFromGetMe } from "grammy/types";
import { approvalRef, chatEligibility, renderApprovalCard } from "../../format/approval-card.ts";
import { renderMarkdown } from "../../format/markdown.ts";
import {
  approvalCallbackData,
  type BotIdentity,
  mapUpdate,
  parseApprovalCallback,
  telegramChatId,
  telegramMessageId,
} from "./mapping.ts";

/**
 * Telegram channel adapter (architecture §4.10, owner S10) on grammY. Long polling by default;
 * `handleUpdate` is the entry point for tests and a later webhook mode. Approval buttons carry
 * only a random nonce: the approval id and answer token stay in this process (security §9).
 */

export interface TelegramAdapterOptions {
  /** Bot token, resolved by the vault in the Gateway. Never logged, never in error messages. */
  token: string;
  /** Mirror of the channel's `config.allowDestructiveApprovals` (default false). */
  allowDestructiveApprovals?: boolean;
  /** Channel account label; default the bot username from getMe. */
  account?: string;
  /** Skip getMe (tests). */
  botInfo?: UserFromGetMe;
  /** Test hook: API transformer installed before anything else. */
  transformer?: Transformer;
  /** fetch used to download files (default globalThis.fetch). */
  fetch?: typeof fetch;
  /** Bot API root, default https://api.telegram.org. */
  apiRoot?: string;
  clock?: { now(): number };
  /** Max bytes for fetchAttachment, default 20 MB (Bot API getFile limit). */
  maxDownloadBytes?: number;
  /** Use long polling on start (default true); false = only handleUpdate (tests / webhook later). */
  polling?: boolean;
}

export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
export const TELEGRAM_MAX_CAPTION_CHARS = 1024;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Approval nonces survive this long past the approval's expiry (late presses get a clear answer upstream). */
export const APPROVAL_NONCE_GRACE_MS = 5 * 60_000;
export const STALE_APPROVAL_TEXT =
  "This approval is no longer valid. Check Psyche for a newer card.";

const ALLOWED_UPDATES = ["message", "edited_message", "callback_query"] as const;
const DEFAULT_API_ROOT = "https://api.telegram.org";

interface ReplyExtras {
  reply_parameters?: { message_id: number; allow_sending_without_reply: boolean };
}

interface FileExtras extends ReplyExtras {
  caption?: string;
  parse_mode?: "HTML";
}

interface PendingApproval {
  approvalId: string;
  answerToken: string;
  chatId: string;
  expiresAt: number;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram" as const;

  readonly #token: string;

  #allowDestructive: boolean;
  readonly #accountOverride: string | undefined;
  readonly #bot: Bot;
  readonly #fetch: typeof fetch;
  readonly #apiRoot: string;
  readonly #clock: { now(): number };
  readonly #maxDownloadBytes: number;
  readonly #polling: boolean;

  readonly #inbound = new Set<(message: InboundMessage) => void | Promise<void>>();
  readonly #answers = new Set<(answer: ChannelApprovalAnswer) => void | Promise<void>>();
  readonly #pending = new Map<string, PendingApproval>();

  #started = false;
  #abortCleanup: (() => void) | undefined;
  #lastEventAt: number | undefined;
  #lastOkAt: number | undefined;
  #lastErrorAt: number | undefined;
  #lastErrorDetail: string | undefined;
  #fatal: string | undefined;
  #handlerErrors = 0;

  constructor(options: TelegramAdapterOptions) {
    this.#token = options.token;
    this.#allowDestructive = options.allowDestructiveApprovals === true;
    this.#accountOverride = options.account;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#apiRoot = (options.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, "");
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    this.#polling = options.polling ?? true;

    this.#bot = new Bot(options.token, {
      ...(options.botInfo === undefined ? {} : { botInfo: options.botInfo }),
      client: { apiRoot: this.#apiRoot },
    });
    // Installed first = innermost: the test transformer stands in for the network.
    if (options.transformer !== undefined) this.#bot.api.config.use(options.transformer);
    this.#bot.api.config.use(this.#pollObserver);
    this.#bot.use(async (ctx) => {
      await this.#dispatch(ctx.update);
    });
    this.#bot.catch(() => {
      this.#handlerErrors++;
    });
  }

  /** The configured label, else the bot username (empty until `start()` has called getMe). */
  get account(): string {
    if (this.#accountOverride !== undefined) return this.#accountOverride;
    return this.#bot.isInited() ? this.#bot.botInfo.username : "";
  }

  /** Inbound / approval handler exceptions swallowed so far (diagnostics; contents never logged). */
  get handlerErrors(): number {
    return this.#handlerErrors;
  }

  capabilities(): ChannelCapabilities {
    return {
      buttons: true,
      polls: false,
      reactions: false,
      voiceNotes: true,
      attachments: true,
      groups: true,
      maxMessageChars: TELEGRAM_MAX_MESSAGE_CHARS,
      typing: true,
      markdown: true,
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#started) return;
    if (aborted(signal)) throw new PsycheError("cancelled", "telegram start aborted");
    // grammY types its own AbortSignal shim, so the signal is checked around the call instead.
    await this.#call(() => this.#bot.init());
    if (aborted(signal)) throw new PsycheError("cancelled", "telegram start aborted");
    this.#started = true;
    this.#fatal = undefined;
    if (signal !== undefined) {
      const onAbort = () => {
        void this.stop();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#abortCleanup = () => signal.removeEventListener("abort", onAbort);
    }
    if (this.#polling) {
      // Not awaited: resolves when polling stops. 401 / 409 end polling; record them for health().
      this.#bot
        .start({ allowed_updates: ALLOWED_UPDATES, drop_pending_updates: false })
        .catch((err: unknown) => {
          const mapped = this.#mapError(err);
          this.#fatal = `polling stopped: ${mapped.code}`;
          this.#markError(this.#fatal);
        });
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#abortCleanup?.();
    this.#abortCleanup = undefined;
    if (this.#bot.isRunning()) {
      try {
        await this.#bot.stop();
      } catch {
        // Stopping is best effort; a failed final offset commit only re-delivers updates.
      }
    }
  }

  onInbound(handler: (message: InboundMessage) => void | Promise<void>): Unsubscribe {
    this.#inbound.add(handler);
    return () => {
      this.#inbound.delete(handler);
    };
  }

  onApprovalAnswer(handler: (answer: ChannelApprovalAnswer) => void | Promise<void>): Unsubscribe {
    this.#answers.add(handler);
    return () => {
      this.#answers.delete(handler);
    };
  }

  /** Feeds one Bot API update (tests, webhook mode). Handler errors are counted, never thrown. */
  async handleUpdate(update: Update): Promise<void> {
    this.#identity();
    await this.#dispatch(update);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      return await this.#send(message);
    } catch (error) {
      // Telegram rejects HTML it cannot parse; resend once as plain text rather than lose the reply.
      if (
        message.format === "markdown" &&
        error instanceof PsycheError &&
        error.code === "invalid_params" &&
        /parse entities/i.test(error.message)
      ) {
        return this.#send({
          ...message,
          format: "plain",
          text: renderMarkdown(message.text, "plain"),
        });
      }
      throw error;
    }
  }

  async #send(message: OutboundMessage): Promise<SendResult> {
    if (message.text.length > TELEGRAM_MAX_MESSAGE_CHARS) {
      throw new PsycheError("invalid_params", "message too long", {
        details: { max: TELEGRAM_MAX_MESSAGE_CHARS, length: message.text.length },
      });
    }
    const chatId = telegramChatId(message.chatId);
    const markdown = message.format === "markdown";
    const render = (text: string) => (markdown ? renderMarkdown(text, "telegram-html") : text);
    const parse = markdown ? { parse_mode: "HTML" as const } : {};
    const replyTo =
      message.replyToMessageId === undefined
        ? undefined
        : telegramMessageId(message.replyToMessageId);
    let reply: ReplyExtras =
      replyTo === undefined
        ? {}
        : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } };
    const takeReply = (): ReplyExtras => {
      const r = reply;
      reply = {};
      return r;
    };

    const files = message.attachments ?? [];
    for (const a of files) {
      if (a.data === undefined) {
        throw new PsycheError("invalid_params", "outbound attachment has no data", {
          details: { name: a.name },
        });
      }
    }
    if (files.length === 0 && message.text === "") {
      throw new PsycheError("invalid_params", "empty message");
    }

    let lastId: number | undefined;
    let caption: string | undefined;
    if (message.text !== "") {
      const rendered = render(message.text);
      if (files.length > 0 && message.text.length <= TELEGRAM_MAX_CAPTION_CHARS) {
        caption = rendered;
      } else {
        const sent = await this.#call(() =>
          this.#bot.api.sendMessage(chatId, rendered, {
            ...parse,
            link_preview_options: { is_disabled: true },
            ...takeReply(),
          }),
        );
        lastId = sent.message_id;
      }
    }
    for (const attachment of files) {
      const other: FileExtras = {
        ...(caption === undefined ? {} : { caption, ...parse }),
        ...takeReply(),
      };
      caption = undefined;
      const sent = await this.#sendFile(chatId, attachment, other);
      lastId = sent;
    }
    if (lastId === undefined)
      throw new PsycheError("internal", "telegram send produced no message");
    return { messageId: String(lastId) };
  }

  async sendApprovalButtons(
    chatId: string,
    approval: ApprovalRequest,
    answerToken: string,
  ): Promise<SendResult> {
    if (approval.deviceOnly) {
      throw new PsycheError("forbidden", "deviceOnly approvals are never sent to chat");
    }
    const eligibility = chatEligibility(approval, { allowDestructive: this.#allowDestructive });
    if (!eligibility.ok) {
      throw new PsycheError("forbidden", "approval cannot be answered from chat", {
        details: { reason: eligibility.reason },
      });
    }
    const now = this.#clock.now();
    const card = renderApprovalCard(approval, {
      ref: approvalRef(approval.id),
      now,
      maxChars: TELEGRAM_MAX_MESSAGE_CHARS,
    });
    const target = telegramChatId(chatId);
    // Plain text, never a parse mode (review design-12).
    const base = { link_preview_options: { is_disabled: true } };
    if (!card.answerable) {
      const sent = await this.#call(() => this.#bot.api.sendMessage(target, card.text, base));
      return { messageId: String(sent.message_id) };
    }

    this.#prune();
    const nonce = randomBytes(9).toString("base64url");
    const parsedExpiry = Date.parse(approval.expiresAt);
    this.#pending.set(nonce, {
      approvalId: approval.id,
      answerToken,
      chatId,
      expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : now,
    });
    try {
      const sent = await this.#call(() =>
        this.#bot.api.sendMessage(target, card.text, {
          ...base,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Approve", callback_data: approvalCallbackData(nonce, "approve") },
                { text: "Deny", callback_data: approvalCallbackData(nonce, "deny") },
              ],
            ],
          },
        }),
      );
      return { messageId: String(sent.message_id) };
    } catch (err) {
      this.#pending.delete(nonce);
      throw err;
    }
  }

  async sendPairingCode(chatId: string, code: string, expiresAt: number): Promise<SendResult> {
    const minutes = Math.max(1, Math.round((expiresAt - this.#clock.now()) / 60_000));
    const text = `Psyche doesn't know you yet. Your pairing code is ${code}. Ask the owner to approve it; it expires in about ${minutes} minutes.`;
    const sent = await this.#call(() =>
      this.#bot.api.sendMessage(telegramChatId(chatId), text, {
        link_preview_options: { is_disabled: true },
      }),
    );
    return { messageId: String(sent.message_id) };
  }

  async sendTyping(chatId: string, action: "typing" | "recording_voice" = "typing"): Promise<void> {
    const tgAction = action === "recording_voice" ? "record_voice" : "typing";
    await this.#call(() => this.#bot.api.sendChatAction(telegramChatId(chatId), tgAction));
  }

  async fetchAttachment(ref: string, signal?: AbortSignal): Promise<Uint8Array> {
    const file = await this.#call(() => this.#bot.api.getFile(ref));
    if (aborted(signal)) throw new PsycheError("cancelled", "attachment download aborted");
    const max = this.#maxDownloadBytes;
    if (file.file_size !== undefined && file.file_size > max) {
      throw new PsycheError("invalid_params", "attachment too large", { details: { max } });
    }
    if (file.file_path === undefined) {
      throw new PsycheError("unavailable", "attachment is not downloadable", { retryable: false });
    }
    // The URL embeds the token: it never goes into an error, a log or `cause`.
    const url = `${this.#apiRoot}/file/bot${this.#token}/${file.file_path}`;
    let res: Response;
    try {
      res = await this.#fetch(url, signal === undefined ? {} : { signal });
    } catch {
      if (aborted(signal)) throw new PsycheError("cancelled", "attachment download aborted");
      throw new PsycheError("unavailable", "attachment download failed", { retryable: true });
    }
    if (!res.ok) {
      throw new PsycheError("unavailable", `attachment download failed (HTTP ${res.status})`, {
        retryable: res.status >= 500 || res.status === 429,
        details: { status: res.status },
      });
    }
    const declared = Number(res.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel().catch(() => undefined);
      throw new PsycheError("invalid_params", "attachment too large", { details: { max } });
    }
    return readCapped(res, max, signal);
  }

  async health(): Promise<ChannelHealth> {
    const base = this.#lastEventAt === undefined ? {} : { lastEventAt: this.#lastEventAt };
    if (!this.#started) return { ok: false, detail: "stopped", ...base };
    if (this.#fatal !== undefined) return { ok: false, detail: this.#fatal, ...base };
    if (
      this.#lastErrorAt !== undefined &&
      (this.#lastOkAt === undefined || this.#lastErrorAt > this.#lastOkAt)
    ) {
      return { ok: false, detail: this.#lastErrorDetail ?? "polling error", ...base };
    }
    return { ok: true, ...base };
  }

  // ── internals ────────────────────────────────────────────────────────────

  #identity(): BotIdentity {
    if (!this.#bot.isInited()) {
      throw new PsycheError("unavailable", "telegram adapter not started");
    }
    const me = this.#bot.botInfo;
    return { id: me.id, username: me.username };
  }

  async #dispatch(update: Update): Promise<void> {
    const now = this.#clock.now();
    this.#lastEventAt = now;
    this.#lastOkAt = now;
    try {
      if (update.callback_query !== undefined) {
        await this.#onCallback(update.callback_query);
        return;
      }
      const inbound = mapUpdate(update, this.#identity(), this.account);
      if (inbound === undefined) return;
      for (const handler of [...this.#inbound]) {
        try {
          await handler(inbound);
        } catch {
          this.#handlerErrors++;
        }
      }
    } catch {
      this.#handlerErrors++;
    }
  }

  async #onCallback(query: CallbackQuery): Promise<void> {
    const parsed = parseApprovalCallback(query.data);
    if (parsed === undefined) {
      await this.#answerQuery(query.id, "Unknown button.");
      return;
    }
    this.#prune();
    const pending = this.#pending.get(parsed.nonce);
    if (pending === undefined) {
      await this.#answerQuery(query.id, STALE_APPROVAL_TEXT);
      return;
    }
    const chatId = query.message?.chat.id;
    if (chatId === undefined || String(chatId) !== pending.chatId) {
      await this.#answerQuery(query.id, STALE_APPROVAL_TEXT);
      return;
    }
    await this.#answerQuery(
      query.id,
      parsed.decision === "approve" ? "Approval sent." : "Denial sent.",
    );
    // The nonce stays: the Permission Broker rejects replays and the channel service replies.
    const answer: ChannelApprovalAnswer = {
      approvalId: pending.approvalId,
      answerToken: pending.answerToken,
      decision: parsed.decision,
      senderId: String(query.from.id),
    };
    for (const handler of [...this.#answers]) {
      try {
        await handler(answer);
      } catch {
        this.#handlerErrors++;
      }
    }
  }

  async #answerQuery(id: string, text: string): Promise<void> {
    try {
      await this.#bot.api.answerCallbackQuery(id, { text });
    } catch {
      // A query older than ~15 minutes cannot be answered; the press itself still counts.
    }
  }

  #prune(): void {
    const cutoff = this.#clock.now() - APPROVAL_NONCE_GRACE_MS;
    for (const [nonce, entry] of this.#pending) {
      if (entry.expiresAt < cutoff) this.#pending.delete(nonce);
    }
  }

  async #sendFile(
    chatId: number | string,
    attachment: ChannelAttachment,
    other: FileExtras,
  ): Promise<number> {
    const file = new InputFile(attachment.data as Uint8Array, attachment.name);
    const api = this.#bot.api;
    const sent = await this.#call<{ message_id: number }>(() => {
      switch (attachment.kind) {
        case "voice":
          return api.sendVoice(chatId, file, other);
        case "image":
          return api.sendPhoto(chatId, file, other);
        default:
          return api.sendDocument(chatId, file, other);
      }
    });
    return sent.message_id;
  }

  /** Observes getUpdates outcomes for health(); installed after the test transformer. */
  readonly #pollObserver: Transformer = async (prev, method, payload, signal) => {
    try {
      const res = await prev(method, payload, signal);
      if (method === "getUpdates") {
        if (res.ok) this.#lastOkAt = this.#clock.now();
        else this.#markError(`getUpdates failed (${res.error_code})`);
      }
      return res;
    } catch (err) {
      if (method === "getUpdates" && signal?.aborted !== true) {
        this.#markError("getUpdates network error");
      }
      throw err;
    }
  };

  #markError(detail: string): void {
    this.#lastErrorAt = this.#clock.now();
    this.#lastErrorDetail = detail;
  }

  async #call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw this.#mapError(err);
    }
  }

  #mapError(err: unknown): PsycheError {
    return mapTelegramError(err, this.#token);
  }
}

/** Replaces the bot token (and its secret half) with `<token>`. */
export function scrubToken(text: string, token: string): string {
  let out = text;
  if (token !== "") out = out.split(token).join("<token>");
  const secret = token.slice(token.indexOf(":") + 1);
  if (secret.length >= 8) out = out.split(secret).join("<token>");
  return out;
}

/** Maps grammY errors to `PsycheError`; messages are token-scrubbed and causes are dropped. */
export function mapTelegramError(err: unknown, token: string): PsycheError {
  if (err instanceof PsycheError) {
    return new PsycheError(err.code, scrubToken(err.message, token), {
      details: err.details,
      retryable: err.retryable,
    });
  }
  if (err instanceof GrammyError) {
    const description = scrubToken(err.description, token);
    const message = `telegram ${err.method} failed: ${err.error_code} ${description}`;
    const details = { method: err.method, errorCode: err.error_code };
    switch (err.error_code) {
      case 429: {
        const retryAfterSec = err.parameters.retry_after;
        return new PsycheError("rate_limited", message, {
          retryable: true,
          details: { ...details, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) },
        });
      }
      case 401:
        return new PsycheError("unauthorized", message, { details });
      case 404:
        // The Bot API answers 404 for a malformed or revoked token.
        return new PsycheError("unauthorized", message, { details });
      case 400:
        return new PsycheError("invalid_params", message, { details });
      case 403:
        return new PsycheError("forbidden", message, { details });
      case 409:
        return new PsycheError("conflict", message, { details });
      default:
        if (err.error_code >= 500) {
          return new PsycheError("unavailable", message, { retryable: true, details });
        }
        return new PsycheError("internal", message, { details });
    }
  }
  if (err instanceof HttpError) {
    return new PsycheError(
      "unavailable",
      `telegram network error: ${scrubToken(err.message, token)}`,
      {
        retryable: true,
      },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new PsycheError("internal", `telegram error: ${scrubToken(message, token)}`);
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function readCapped(res: Response, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  const tooLarge = () =>
    new PsycheError("invalid_params", "attachment too large", { details: { max } });
  if (res.body === null) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) throw tooLarge();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (aborted(signal)) {
        throw new PsycheError("cancelled", "attachment download aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw tooLarge();
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    if (err instanceof PsycheError) throw err;
    throw new PsycheError("unavailable", "attachment download failed", { retryable: true });
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
