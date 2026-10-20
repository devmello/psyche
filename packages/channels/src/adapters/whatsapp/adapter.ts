import { randomBytes } from "node:crypto";
import {
  type ApprovalRequest,
  type ChannelAdapter,
  type ChannelApprovalAnswer,
  type ChannelCapabilities,
  type ChannelHealth,
  type InboundMessage,
  type OutboundMessage,
  PsycheError,
  type SendResult,
  type Unsubscribe,
} from "@psyche/protocol";
import { approvalRef, chatEligibility, renderApprovalCard } from "../../format/approval-card.ts";
import type { SecretSource } from "../../ports.ts";
import { readCapped } from "../read-capped.ts";
import {
  approvalButtonId,
  changeValues,
  constantTimeEqual,
  E164,
  hubSignature,
  MEDIA_ID,
  mapWaMessage,
  parseApprovalButtonId,
  type WaNotification,
} from "./mapping.ts";

/**
 * WhatsApp over Meta's Cloud API (feature N6; security §9 "Webhook channels"). No SDK: the webhook
 * is verified with node:crypto and sends are Graph API calls with `fetch`. The Gateway binds to
 * loopback (security §10), so Meta reaches `/channels/whatsapp/webhook` through the owner's tunnel
 * or reverse proxy. `GET` is the subscription handshake (verify token); `POST` carries
 * notifications signed with the app secret, checked over the raw bytes before any JSON is parsed.
 * Free-form messages are allowed only inside WhatsApp's 24-hour customer-service window; templates
 * (needed outside it) are not implemented. Unofficial clients (Baileys) are not supported.
 */

export interface WhatsAppAdapterOptions {
  /** Psyche's WhatsApp business number (E.164): the channel's `account`. */
  number: string;
  /** Graph phone number id (digits): the sender for Graph calls and the webhook's metadata. */
  phoneNumberId: string;
  /** System-user or app access token for Graph calls. Read per call; never logged. */
  accessToken: SecretSource;
  /** App secret: the HMAC key of `X-Hub-Signature-256`. */
  appSecret: SecretSource;
  /** The verify token the owner typed into the Meta app's webhook settings. */
  verifyToken: SecretSource;
  /** Mirror of the channel's `config.allowDestructiveApprovals` (default false). */
  allowDestructiveApprovals?: boolean;
  /** Default https://graph.facebook.com. */
  apiBase?: string;
  /** Graph API version, default v21.0. */
  apiVersion?: string;
  /** Hosts `fetchAttachment` downloads media from (https only), default lookaside.fbsbx.com. */
  mediaHosts?: string[];
  fetch?: typeof fetch;
  clock?: { now(): number };
  /** fetchAttachment cap, default 16 MB (the Cloud API's audio / video limit). */
  maxDownloadBytes?: number;
  /**
   * Every refused webhook request, with the sender it claims. Empty when the signature did not
   * verify: an unsigned body is never parsed, so it names no one. The Gateway counts each against
   * the inbound limit (#254) under its own `whatsapp-webhook-rejected|…` key.
   */
  onRejected?: (rejection: WhatsAppWebhookRejection) => void;
}

export type WhatsAppRejectReason =
  | "too_large"
  | "unsigned"
  | "bad_signature"
  | "malformed"
  | "wrong_account"
  | "replayed"
  | "bad_verify_token";

export interface WhatsAppWebhookRejection {
  reason: WhatsAppRejectReason;
  claimedFrom: string;
}

export interface WhatsAppWebhookRequest {
  /** `GET` (subscription handshake) or `POST` (notifications); default `POST`. */
  method?: string;
  /** Path and query as received. */
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string | Uint8Array;
}

export interface WhatsAppWebhookResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const WHATSAPP_MAX_MESSAGE_CHARS = 4096;
/** Interactive message body limit (the approval card). */
export const WHATSAPP_MAX_INTERACTIVE_CHARS = 1024;
export const WHATSAPP_WEBHOOK_MAX_BYTES = 64 * 1024;
export const WHATSAPP_REPLAY_WINDOW_MS = 24 * 60 * 60_000;
/** WhatsApp's customer-service window: free-form messages only this long after the last inbound. */
export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60_000;
export const WHATSAPP_DEFAULT_MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
export const APPROVAL_NONCE_GRACE_MS = 5 * 60_000;
export const WINDOW_CLOSED_TEXT =
  "outside WhatsApp's 24-hour window: the owner must message first (templates are not supported)";
export const TOKEN_REJECTED_TEXT = "WhatsApp rejected the access token";

const GRAPH_API = "https://graph.facebook.com";
const GRAPH_VERSION = "v21.0";
const MEDIA_HOST = "lookaside.fbsbx.com";
const MAX_REMEMBERED = 10_000;
const MAX_OWN_TEXTS = 500;
/** Graph throttling codes (application, account, pair and spam rate limits). */
const RATE_CODES = new Set([4, 80007, 130429, 131048, 131056]);

const FORBIDDEN = (): WhatsAppWebhookResponse => ({
  status: 403,
  headers: { "cache-control": "no-store" },
  body: "",
});
const EMPTY = (status: number): WhatsAppWebhookResponse => ({
  status,
  headers: { "cache-control": "no-store" },
  body: "",
});

interface PendingApproval {
  approvalId: string;
  answerToken: string;
  chatId: string;
  expiresAt: number;
}

type Dispatch =
  | { kind: "message"; message: InboundMessage }
  | { kind: "button"; chatId: string; buttonId: string };

export class WhatsAppAdapter implements ChannelAdapter {
  readonly type = "whatsapp" as const;
  readonly account: string;
  readonly #o: WhatsAppAdapterOptions;
  readonly #apiBase: string;
  readonly #version: string;
  readonly #mediaHosts: Set<string>;
  readonly #fetch: typeof fetch;
  readonly #clock: { now(): number };
  readonly #inbound = new Set<(message: InboundMessage) => void | Promise<void>>();
  readonly #answers = new Set<(answer: ChannelApprovalAnswer) => void | Promise<void>>();
  readonly #pending = new Map<string, PendingApproval>();
  /** wamid → first seen (replay window). */
  readonly #seen = new Map<string, number>();
  /** chatId → last verified inbound (the 24-hour customer-service window). */
  readonly #lastInbound = new Map<string, number>();
  /** Our own sent messages' text by wamid, so a quote of one carries it as `fromSelf`. */
  readonly #ownTexts = new Map<string, string>();
  readonly #inflight = new Set<Promise<void>>();
  #started = false;
  #lastEventAt: number | undefined;
  #lastStatusAt: number | undefined;
  #fatal: string | undefined;
  #handlerErrors = 0;

  constructor(options: WhatsAppAdapterOptions) {
    if (!E164.test(options.number)) {
      throw new PsycheError("invalid_params", "the WhatsApp number must be E.164 (+1555…)");
    }
    if (!/^\d{1,32}$/.test(options.phoneNumberId)) {
      throw new PsycheError("invalid_params", "the WhatsApp phone number id is digits only");
    }
    this.#o = options;
    this.account = options.number;
    this.#apiBase = (options.apiBase ?? GRAPH_API).replace(/\/+$/, "");
    this.#version = options.apiVersion ?? GRAPH_VERSION;
    this.#mediaHosts = new Set(options.mediaHosts ?? [MEDIA_HOST]);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  get handlerErrors(): number {
    return this.#handlerErrors;
  }

  capabilities(): ChannelCapabilities {
    return {
      buttons: true,
      polls: false,
      reactions: false,
      voiceNotes: false,
      attachments: true,
      groups: false,
      maxMessageChars: WHATSAPP_MAX_MESSAGE_CHARS,
      typing: false,
      markdown: false,
    };
  }

  async start(): Promise<void> {
    this.#started = true;
  }

  async stop(): Promise<void> {
    this.#started = false;
    await this.drain();
  }

  /** Resolves when every dispatched inbound message has been handled (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all([...this.#inflight]);
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

  /** Epoch ms of the chat's last verified inbound message (the service window), if any. */
  lastInboundAt(chatId: string): number | undefined {
    return this.#lastInbound.get(chatId);
  }

  /** `GET` → subscription handshake; anything else → a signed notification. */
  async handleWebhook(request: WhatsAppWebhookRequest): Promise<WhatsAppWebhookResponse> {
    const method = (request.method ?? "POST").toUpperCase();
    if (method === "GET") return this.#handshake(request.url);
    if (method !== "POST") return FORBIDDEN();
    return this.#notification(request);
  }

  /**
   * Meta's subscription check: `hub.mode=subscribe`, the configured verify token (constant time)
   * and a numeric `hub.challenge` (≤ 64 chars), echoed as text/plain. Anything else: empty 403.
   */
  async #handshake(url: string): Promise<WhatsAppWebhookResponse> {
    let query: URLSearchParams;
    try {
      query = new URL(url, "http://webhook.invalid").searchParams;
    } catch {
      return this.#reject("bad_verify_token", "");
    }
    const mode = query.get("hub.mode");
    const given = query.get("hub.verify_token") ?? "";
    const challenge = query.get("hub.challenge") ?? "";
    let ok = false;
    try {
      ok = await this.#o.verifyToken.use(
        async (token) => token !== "" && constantTimeEqual(token, given),
      );
    } catch {
      // No verify token yet (vault empty or locked): the handshake cannot succeed.
      return FORBIDDEN();
    }
    if (mode !== "subscribe" || !ok || !/^\d{1,64}$/.test(challenge)) {
      return this.#reject("bad_verify_token", "");
    }
    return {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
      body: challenge,
    };
  }

  /**
   * A notification. Order: size cap, signature over the raw bytes (constant time), and only then
   * JSON; then `object`, every change's `phone_number_id`, and the 24 h wamid replay window. The
   * reply is sent before any handler runs.
   */
  async #notification(request: WhatsAppWebhookRequest): Promise<WhatsAppWebhookResponse> {
    const raw = typeof request.body === "string" ? Buffer.from(request.body, "utf8") : request.body;
    if (raw.byteLength > WHATSAPP_WEBHOOK_MAX_BYTES) return this.#reject("too_large", "");
    const header = request.headers["x-hub-signature-256"];
    const given = Array.isArray(header) ? header[0] : header;
    if (given === undefined || given === "") return this.#reject("unsigned", "");
    let signed: boolean;
    try {
      signed = await this.#o.appSecret.use(async (secret) =>
        constantTimeEqual(hubSignature(secret, raw), given.trim().toLowerCase()),
      );
    } catch {
      // No app secret available: nothing can be verified; Meta retries a 503.
      return EMPTY(503);
    }
    // Nothing in an unverified body is read: it names no sender, not even for the refusal.
    if (!signed) return this.#reject("bad_signature", "");

    let body: WaNotification;
    try {
      body = JSON.parse(Buffer.from(raw).toString("utf8")) as WaNotification;
    } catch {
      return this.#reject("malformed", "");
    }
    if (body === null || typeof body !== "object") return this.#reject("malformed", "");
    const values = changeValues(body);
    const messages = values.flatMap((v) => (Array.isArray(v.messages) ? v.messages : []));
    const first = messages[0]?.from;
    const claimed = typeof first === "string" ? `+${first.replace(/\D/g, "").slice(0, 15)}` : "";
    if (body.object !== "whatsapp_business_account") return this.#reject("wrong_account", claimed);
    if (values.some((v) => v.metadata?.phone_number_id !== this.#o.phoneNumberId)) {
      return this.#reject("wrong_account", claimed);
    }

    const now = this.#clock.now();
    this.#prune(now);
    const ids: string[] = [];
    for (const m of messages) {
      const id = typeof m.id === "string" ? m.id : "";
      if (id === "") continue;
      const ts = Number(m.timestamp) * 1000;
      // Seen before, twice in one body, or older than the window (so pruning cannot reopen it).
      if (
        this.#seen.has(id) ||
        ids.includes(id) ||
        (Number.isFinite(ts) && ts > 0 && ts + WHATSAPP_REPLAY_WINDOW_MS <= now)
      ) {
        return this.#reject("replayed", claimed);
      }
      ids.push(id);
    }
    if (!this.#started) return EMPTY(503);
    for (const id of ids) this.#seen.set(id, now);
    this.#lastEventAt = now;
    if (values.some((v) => Array.isArray(v.statuses) && v.statuses.length > 0)) {
      // Delivery receipts: proof Graph is delivering for this number, nothing more.
      this.#lastStatusAt = now;
    }

    const jobs: Dispatch[] = [];
    for (const value of values) {
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        const mapped = mapWaMessage(m, {
          account: this.account,
          receivedAt: now,
          contacts,
          ownText: (id) => this.#ownTexts.get(id),
        });
        if (mapped.kind === "ignored") {
          // Still a verified message from the person: it opens the service window.
          const chat = typeof m.from === "string" ? `+${m.from}` : "";
          if (E164.test(chat)) this.#lastInbound.set(chat, now);
          continue;
        }
        const chat = mapped.kind === "message" ? mapped.message.chatId : mapped.chatId;
        this.#lastInbound.set(chat, now);
        jobs.push(mapped);
      }
    }
    if (jobs.length > 0) {
      const job = this.#dispatchAll(jobs).finally(() => this.#inflight.delete(job));
      this.#inflight.add(job);
    }
    return EMPTY(200);
  }

  #reject(reason: WhatsAppRejectReason, claimedFrom: string): WhatsAppWebhookResponse {
    try {
      this.#o.onRejected?.({ reason, claimedFrom: claimedFrom.slice(0, 32) });
    } catch {
      // Counting is best effort; the refusal stands.
    }
    return FORBIDDEN();
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.text.length > WHATSAPP_MAX_MESSAGE_CHARS) {
      throw new PsycheError("invalid_params", "message too long", {
        details: { max: WHATSAPP_MAX_MESSAGE_CHARS, length: message.text.length },
      });
    }
    if ((message.attachments ?? []).length > 0) {
      throw new PsycheError("not_implemented", "outbound WhatsApp media is not supported");
    }
    if (message.text === "") throw new PsycheError("invalid_params", "empty message");
    const to = this.#recipient(message.chatId);
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: message.text, preview_url: false },
      ...(message.replyToMessageId === undefined
        ? {}
        : { context: { message_id: message.replyToMessageId } }),
    };
    return this.#post(payload, message.text);
  }

  async sendPairingCode(chatId: string, code: string, expiresAt: number): Promise<SendResult> {
    const minutes = Math.max(1, Math.round((expiresAt - this.#clock.now()) / 60_000));
    return this.send({
      chatId,
      text: `Psyche doesn't know you yet. Your pairing code is ${code}. Ask the owner to approve it; it expires in about ${minutes} minutes.`,
    });
  }

  async sendApprovalButtons(
    chatId: string,
    approval: ApprovalRequest,
    answerToken: string,
  ): Promise<SendResult> {
    if (approval.deviceOnly) {
      throw new PsycheError("forbidden", "deviceOnly approvals are never sent to chat");
    }
    const eligibility = chatEligibility(approval, {
      allowDestructive: this.#o.allowDestructiveApprovals === true,
    });
    if (!eligibility.ok) {
      throw new PsycheError("forbidden", "approval cannot be answered from chat", {
        details: { reason: eligibility.reason },
      });
    }
    const to = this.#recipient(chatId);
    const now = this.#clock.now();
    const card = renderApprovalCard(approval, {
      surface: `whatsapp:${chatId}`,
      ref: approvalRef(approval.id),
      now,
      maxChars: WHATSAPP_MAX_INTERACTIVE_CHARS,
    });
    if (!card.answerable) return this.send({ chatId, text: card.text });

    this.#prunePending();
    const nonce = randomBytes(12).toString("base64url");
    const expiry = Date.parse(approval.expiresAt);
    this.#pending.set(nonce, {
      approvalId: approval.id,
      answerToken,
      chatId,
      expiresAt: Number.isFinite(expiry) ? expiry : now,
    });
    try {
      return await this.#post(
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: card.text },
            action: {
              buttons: [
                {
                  type: "reply",
                  reply: { id: approvalButtonId(nonce, "approve"), title: "Approve" },
                },
                { type: "reply", reply: { id: approvalButtonId(nonce, "deny"), title: "Deny" } },
              ],
            },
          },
        },
        card.text,
      );
    } catch (err) {
      this.#pending.delete(nonce);
      throw err;
    }
  }

  /**
   * Inbound media by Graph media id: `GET /{version}/{media-id}` gives a short-lived URL, which is
   * downloaded with the bearer token only from an allowed media host (https), with no redirect to
   * any other host, capped at 16 MB.
   */
  async fetchAttachment(ref: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!MEDIA_ID.test(ref)) throw new PsycheError("forbidden", "not a WhatsApp media id");
    const max = this.#o.maxDownloadBytes ?? WHATSAPP_DEFAULT_MAX_DOWNLOAD_BYTES;
    const init = signal === undefined ? {} : { signal };
    const meta = await this.#authed(`${this.#apiBase}/${this.#version}/${ref}`, {
      ...init,
      method: "GET",
      redirect: "error",
    });
    const info = (await meta.json().catch(() => ({}))) as {
      url?: unknown;
      file_size?: unknown;
      error?: { code?: unknown };
    };
    if (!meta.ok) throw this.#graphError(meta, info.error?.code);
    if (typeof info.file_size === "number" && info.file_size > max) {
      throw new PsycheError("invalid_params", "attachment too large", { details: { max } });
    }
    let url = this.#mediaUrl(info.url);
    let res = await this.#authed(url.toString(), { ...init, method: "GET", redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400) {
      // One hop, and only to another allowed media host.
      url = this.#mediaUrl(location === null ? undefined : new URL(location, url).toString());
      await res.body?.cancel().catch(() => undefined);
      res = await this.#authed(url.toString(), { ...init, method: "GET", redirect: "error" });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw this.#graphError(res, undefined);
    }
    return readCapped(res, max, signal);
  }

  async health(): Promise<ChannelHealth> {
    const last = Math.max(this.#lastEventAt ?? 0, this.#lastStatusAt ?? 0);
    const base = last === 0 ? {} : { lastEventAt: last };
    if (!this.#started) return { ok: false, detail: "stopped", ...base };
    if (this.#fatal !== undefined) return { ok: false, detail: this.#fatal, ...base };
    return { ok: true, ...base };
  }

  // ── internals ────────────────────────────────────────────────────────────

  #mediaUrl(value: unknown): URL {
    let url: URL;
    try {
      url = new URL(String(value));
    } catch {
      throw new PsycheError("forbidden", "attachment is not a WhatsApp media URL");
    }
    if (
      url.protocol !== "https:" ||
      !this.#mediaHosts.has(url.hostname) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new PsycheError("forbidden", "attachment is not a WhatsApp media URL");
    }
    return url;
  }

  /** `+<digits>` → Graph `to` (digits), after the 24-hour window check. */
  #recipient(chatId: string): string {
    if (!E164.test(chatId)) {
      throw new PsycheError("invalid_params", "WhatsApp chats are E.164 numbers");
    }
    const last = this.#lastInbound.get(chatId);
    if (last === undefined || last + WHATSAPP_SERVICE_WINDOW_MS <= this.#clock.now()) {
      throw new PsycheError("forbidden", WINDOW_CLOSED_TEXT, {
        details: { reason: "outside_service_window" },
      });
    }
    return chatId.slice(1);
  }

  async #post(payload: unknown, text: string): Promise<SendResult> {
    const url = `${this.#apiBase}/${this.#version}/${encodeURIComponent(this.#o.phoneNumberId)}/messages`;
    const res = await this.#authed(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
    });
    const json = (await res.json().catch(() => ({}))) as {
      messages?: { id?: unknown }[];
      error?: { code?: unknown };
    };
    if (!res.ok) throw this.#graphError(res, json.error?.code);
    this.#fatal = undefined;
    const id = json.messages?.[0]?.id;
    const messageId = typeof id === "string" ? id : "";
    if (messageId !== "") this.#rememberOwn(messageId, text);
    return { messageId };
  }

  #rememberOwn(id: string, text: string): void {
    this.#ownTexts.set(id, text);
    for (const key of this.#ownTexts.keys()) {
      if (this.#ownTexts.size <= MAX_OWN_TEXTS) break;
      this.#ownTexts.delete(key);
    }
  }

  async #dispatchAll(jobs: Dispatch[]): Promise<void> {
    for (const job of jobs) {
      if (job.kind === "button") await this.#onButton(job.chatId, job.buttonId);
      else await this.#dispatch(job.message);
    }
  }

  async #dispatch(message: InboundMessage): Promise<void> {
    for (const handler of [...this.#inbound]) {
      try {
        await handler(message);
      } catch {
        this.#handlerErrors++;
      }
    }
  }

  /** A reply button press: only a live nonce, from the chat the card went to, is relayed. */
  async #onButton(chatId: string, buttonId: string): Promise<void> {
    const parsed = parseApprovalButtonId(buttonId);
    if (parsed === undefined) return;
    this.#prunePending();
    const pending = this.#pending.get(parsed.nonce);
    if (pending === undefined || pending.chatId !== chatId) return;
    // The nonce stays: the Permission Broker rejects replays and the channel service replies.
    const answer: ChannelApprovalAnswer = {
      approvalId: pending.approvalId,
      answerToken: pending.answerToken,
      decision: parsed.decision,
      senderId: chatId,
    };
    for (const handler of [...this.#answers]) {
      try {
        await handler(answer);
      } catch {
        this.#handlerErrors++;
      }
    }
  }

  #prune(now: number): void {
    for (const [id, at] of this.#seen) {
      if (at + WHATSAPP_REPLAY_WINDOW_MS > now && this.#seen.size <= MAX_REMEMBERED) break;
      this.#seen.delete(id);
    }
    for (const [chat, at] of this.#lastInbound) {
      if (at + WHATSAPP_SERVICE_WINDOW_MS <= now) this.#lastInbound.delete(chat);
    }
  }

  #prunePending(): void {
    const cutoff = this.#clock.now() - APPROVAL_NONCE_GRACE_MS;
    for (const [nonce, entry] of this.#pending) {
      if (entry.expiresAt < cutoff) this.#pending.delete(nonce);
    }
  }

  /** The bearer token exists only inside the secret source; it never reaches an error or a log. */
  #authed(url: string, init: RequestInit): Promise<Response> {
    return this.#o.accessToken.use(async (token) => {
      const headers = {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
      };
      return this.#request(url, { ...init, headers });
    });
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch {
      if (init.signal?.aborted === true) {
        throw new PsycheError("cancelled", "whatsapp request aborted");
      }
      // No cause: a fetch error can echo request details.
      throw new PsycheError("unavailable", "whatsapp network error", { retryable: true });
    }
  }

  #graphError(res: Response, code: unknown): PsycheError {
    const error = whatsappError(res, code);
    if (error.code === "unauthorized") this.#fatal = TOKEN_REJECTED_TEXT;
    return error;
  }
}

/** HTTP status (and Graph error code) → `PsycheError`; never Graph's own message text. */
export function whatsappError(res: Response, code: unknown): PsycheError {
  const graphCode = typeof code === "number" ? code : undefined;
  const details = { status: res.status, ...(graphCode === undefined ? {} : { graphCode }) };
  const suffix = graphCode === undefined ? "" : ` (Graph ${graphCode})`;
  if (graphCode === 131047) {
    return new PsycheError("forbidden", WINDOW_CLOSED_TEXT, {
      details: { ...details, reason: "outside_service_window" },
    });
  }
  if (res.status === 401 || graphCode === 190) {
    return new PsycheError("unauthorized", TOKEN_REJECTED_TEXT, { details });
  }
  if (res.status === 429 || (graphCode !== undefined && RATE_CODES.has(graphCode))) {
    const retryAfterSec = Number(res.headers.get("retry-after") ?? Number.NaN);
    return new PsycheError("rate_limited", `whatsapp rate limited${suffix}`, {
      retryable: true,
      details: { ...details, ...(Number.isFinite(retryAfterSec) ? { retryAfterSec } : {}) },
    });
  }
  if (res.status >= 500) {
    return new PsycheError("unavailable", `whatsapp unavailable (HTTP ${res.status})`, {
      retryable: true,
      details,
    });
  }
  if (res.status === 403) {
    return new PsycheError("forbidden", `whatsapp refused the request${suffix}`, { details });
  }
  return new PsycheError(
    "invalid_params",
    `whatsapp rejected the request (HTTP ${res.status})${suffix}`,
    { details },
  );
}
