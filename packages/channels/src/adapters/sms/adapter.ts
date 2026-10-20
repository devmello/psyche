import {
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelHealth,
  type InboundMessage,
  type OutboundMessage,
  PsycheError,
  type SendResult,
  type Unsubscribe,
} from "@psyche/protocol";
import { readCapped } from "../telegram/adapter.ts";
import { mapSms, parseForm, signatureMatches, twilioSignature } from "./mapping.ts";

/**
 * SMS over Twilio (feature N9; security §9). No SDK: the webhook is verified with node:crypto and
 * sends are a form POST with `fetch`. The Gateway binds to loopback (security §10), so Twilio
 * reaches `POST /channels/sms/twilio` through the owner's tunnel or reverse proxy; the URL the
 * signature covers is the configured `publicUrl`, never the request's Host or X-Forwarded headers.
 * Every sender is weak: SMS chats as a non-owner (chat-only, no tools) and never answers approvals.
 */

/** The auth token, lent to `fn` only (a vault item or a Compose secret). Never logged. */
export interface SmsSecretSource {
  use<T>(fn: (token: string) => Promise<T>): Promise<T>;
}

export interface SmsAdapterOptions {
  accountSid: string;
  authToken: SmsSecretSource;
  /** Psyche's Twilio number (E.164): the channel's `account` and the inbound `To`. */
  from: string;
  /** The exact URL Twilio posts to (what the signature covers), e.g. `https://host/channels/sms/twilio`. */
  publicUrl: string;
  /** Send through a Messaging Service instead of `From`. */
  messagingServiceSid?: string;
  /** Default https://api.twilio.com. */
  apiBase?: string;
  fetch?: typeof fetch;
  clock?: { now(): number };
  /** fetchAttachment cap, default 5 MB (Twilio's MMS limit). */
  maxDownloadBytes?: number;
  /**
   * Every refused webhook request, with the sender it claims (unverified; empty when the body
   * could not be read). The Gateway counts it against the inbound limit (#254) under its own key,
   * so forged requests are counted and audited without spending a real sender's budget.
   */
  onRejected?: (rejection: SmsWebhookRejection) => void;
}

export type SmsRejectReason =
  | "too_large"
  | "unsigned"
  | "bad_signature"
  | "wrong_account"
  | "replayed";

export interface SmsWebhookRejection {
  reason: SmsRejectReason;
  claimedFrom: string;
}

export interface SmsWebhookRequest {
  /** The request path; ignored for the signature, which covers `publicUrl`. */
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string | Uint8Array;
}

export interface SmsWebhookResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const SMS_MAX_MESSAGE_CHARS = 1600;
export const SMS_WEBHOOK_MAX_BYTES = 64 * 1024;
export const SMS_REPLAY_WINDOW_MS = 24 * 60 * 60_000;
const MAX_REMEMBERED = 10_000;
const TWILIO_API = "https://api.twilio.com";
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

const reply = (status: number, body: string, type: string): SmsWebhookResponse => ({
  status,
  headers: { "content-type": type, "cache-control": "no-store" },
  body,
});
/** A refusal says nothing: no body, so a prober learns only the status. */
const FORBIDDEN = (): SmsWebhookResponse => ({
  status: 403,
  headers: { "cache-control": "no-store" },
  body: "",
});

export class SmsAdapter implements ChannelAdapter {
  readonly type = "sms" as const;
  readonly account: string;
  readonly #o: SmsAdapterOptions;
  readonly #apiBase: string;
  readonly #fetch: typeof fetch;
  readonly #clock: { now(): number };
  readonly #inbound = new Set<(message: InboundMessage) => void | Promise<void>>();
  /** MessageSid → first seen (replay window). */
  readonly #seen = new Map<string, number>();
  readonly #inflight = new Set<Promise<void>>();
  #started = false;
  #lastEventAt: number | undefined;
  #handlerErrors = 0;

  constructor(options: SmsAdapterOptions) {
    this.#o = options;
    this.account = options.from;
    this.#apiBase = (options.apiBase ?? TWILIO_API).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#clock = options.clock ?? { now: () => Date.now() };
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
      maxMessageChars: SMS_MAX_MESSAGE_CHARS,
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

  /**
   * `POST /channels/sms/twilio`. The signature is checked before anything in the body is used;
   * then the account, the number it was sent to and the replay window. Handlers run after the
   * reply (Twilio times out at 15 s and sends are rate limited).
   */
  async handleWebhook(request: SmsWebhookRequest): Promise<SmsWebhookResponse> {
    const raw =
      typeof request.body === "string" ? request.body : Buffer.from(request.body).toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > SMS_WEBHOOK_MAX_BYTES) {
      return this.#reject("too_large", "");
    }
    const params = parseForm(raw);
    const map = new Map(params);
    const claimed = map.get("From") ?? "";
    const header = request.headers["x-twilio-signature"];
    const given = Array.isArray(header) ? header[0] : header;
    if (given === undefined || given === "") return this.#reject("unsigned", claimed);
    const expected = await this.#o.authToken.use(async (token) =>
      twilioSignature(token, this.#o.publicUrl, params),
    );
    if (!signatureMatches(expected, given)) return this.#reject("bad_signature", claimed);

    if (map.get("AccountSid") !== this.#o.accountSid || map.get("To") !== this.#o.from) {
      return this.#reject("wrong_account", claimed);
    }
    const now = this.#clock.now();
    const sid = map.get("MessageSid") ?? map.get("SmsSid") ?? "";
    this.#prune(now);
    if (sid === "" || this.#seen.has(sid)) return this.#reject("replayed", claimed);
    if (!this.#started) return reply(503, "unavailable", "text/plain; charset=utf-8");
    this.#seen.set(sid, now);
    this.#lastEventAt = now;
    const message = mapSms(params, this.account, now);
    if (message !== undefined) {
      const job = this.#dispatch(message).finally(() => this.#inflight.delete(job));
      this.#inflight.add(job);
    }
    return reply(200, EMPTY_TWIML, "text/xml; charset=utf-8");
  }

  #reject(reason: SmsRejectReason, claimedFrom: string): SmsWebhookResponse {
    try {
      this.#o.onRejected?.({ reason, claimedFrom: claimedFrom.slice(0, 32) });
    } catch {
      // Counting is best effort; the refusal stands.
    }
    return FORBIDDEN();
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.text.length > SMS_MAX_MESSAGE_CHARS) {
      throw new PsycheError("invalid_params", "message too long", {
        details: { max: SMS_MAX_MESSAGE_CHARS, length: message.text.length },
      });
    }
    if ((message.attachments ?? []).length > 0) {
      throw new PsycheError("not_implemented", "outbound MMS media is not supported");
    }
    if (message.text === "") throw new PsycheError("invalid_params", "empty message");
    const form = new URLSearchParams({ To: message.chatId, Body: message.text });
    if (this.#o.messagingServiceSid !== undefined) {
      form.set("MessagingServiceSid", this.#o.messagingServiceSid);
    } else form.set("From", this.#o.from);
    const sid = encodeURIComponent(this.#o.accountSid);
    const url = `${this.#apiBase}/2010-04-01/Accounts/${sid}/Messages.json`;
    const res = await this.#authed(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: unknown; code?: unknown };
    if (!res.ok) throw twilioError(res, json.code);
    return { messageId: typeof json.sid === "string" ? json.sid : "" };
  }

  async sendPairingCode(chatId: string, code: string, expiresAt: number): Promise<SendResult> {
    const minutes = Math.max(1, Math.round((expiresAt - this.#clock.now()) / 60_000));
    return this.send({
      chatId,
      text: `Psyche doesn't know you yet. Your pairing code is ${code}. Ask the owner to approve it; it expires in about ${minutes} minutes.`,
    });
  }

  /** MMS media, only from the Twilio API host (or the configured `apiBase`), size-capped. */
  async fetchAttachment(ref: string, signal?: AbortSignal): Promise<Uint8Array> {
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      throw new PsycheError("forbidden", "attachment is not a Twilio media URL");
    }
    const base = new URL(this.#apiBase);
    const twilio = url.protocol === "https:" && url.hostname === "api.twilio.com";
    if (!(twilio || url.origin === base.origin) || url.username !== "" || url.password !== "") {
      throw new PsycheError("forbidden", "attachment is not a Twilio media URL");
    }
    const init = { redirect: "manual" as const, ...(signal === undefined ? {} : { signal }) };
    let res = await this.#authed(url.toString(), init);
    // Twilio redirects media to a signed CDN URL: follow once, without the credentials.
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location !== null) {
      const next = new URL(location, url);
      if (next.protocol !== "https:" && next.origin !== base.origin) {
        throw new PsycheError("forbidden", "attachment redirect is not https");
      }
      res = await this.#request(next.toString(), { ...init, redirect: "error" });
    }
    if (!res.ok) throw twilioError(res, undefined);
    const max = this.#o.maxDownloadBytes ?? 5 * 1024 * 1024;
    const declared = Number(res.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel().catch(() => undefined);
      throw new PsycheError("invalid_params", "attachment too large", { details: { max } });
    }
    return readCapped(res, max, signal);
  }

  async health(): Promise<ChannelHealth> {
    const base = this.#lastEventAt === undefined ? {} : { lastEventAt: this.#lastEventAt };
    return this.#started ? { ok: true, ...base } : { ok: false, detail: "stopped", ...base };
  }

  // ── internals ────────────────────────────────────────────────────────────

  async #dispatch(message: InboundMessage): Promise<void> {
    for (const handler of [...this.#inbound]) {
      try {
        await handler(message);
      } catch {
        this.#handlerErrors++;
      }
    }
  }

  #prune(now: number): void {
    for (const [sid, at] of this.#seen) {
      if (at + SMS_REPLAY_WINDOW_MS > now && this.#seen.size <= MAX_REMEMBERED) break;
      this.#seen.delete(sid);
    }
  }

  /** Basic auth inside the secret source; the credentials never reach an error or a log. */
  #authed(url: string, init: RequestInit): Promise<Response> {
    return this.#o.authToken.use(async (token) => {
      const basic = Buffer.from(`${this.#o.accountSid}:${token}`).toString("base64");
      const headers = {
        ...(init.headers as Record<string, string>),
        authorization: `Basic ${basic}`,
      };
      return this.#request(url, { ...init, headers });
    });
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch {
      if (init.signal?.aborted === true)
        throw new PsycheError("cancelled", "twilio request aborted");
      // No cause: a fetch error can echo the URL, which names the account.
      throw new PsycheError("unavailable", "twilio network error", { retryable: true });
    }
  }
}

/** HTTP status (and Twilio error code) → `PsycheError`; never Twilio's own message text. */
export function twilioError(res: Response, code: unknown): PsycheError {
  const twilioCode = typeof code === "number" ? code : undefined;
  const details = { status: res.status, ...(twilioCode === undefined ? {} : { twilioCode }) };
  const suffix = twilioCode === undefined ? "" : ` (Twilio ${twilioCode})`;
  if (res.status === 429) {
    const retryAfterSec = Number(res.headers.get("retry-after") ?? Number.NaN);
    return new PsycheError("rate_limited", `twilio rate limited${suffix}`, {
      retryable: true,
      details: { ...details, ...(Number.isFinite(retryAfterSec) ? { retryAfterSec } : {}) },
    });
  }
  if (res.status >= 500) {
    return new PsycheError("unavailable", `twilio unavailable (HTTP ${res.status})`, {
      retryable: true,
      details,
    });
  }
  if (twilioCode === 21610) {
    return new PsycheError("forbidden", "the recipient unsubscribed (replied STOP)", { details });
  }
  if (res.status === 401 || res.status === 403) {
    return new PsycheError("unauthorized", `twilio refused the credentials${suffix}`, { details });
  }
  return new PsycheError(
    "invalid_params",
    `twilio rejected the request (HTTP ${res.status})${suffix}`,
    {
      details,
    },
  );
}
