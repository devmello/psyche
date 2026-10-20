import { createHash, randomBytes } from "node:crypto";
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
import WebSocket from "ws";
import { approvalRef, chatEligibility, renderApprovalCard } from "../../format/approval-card.ts";
import { APPROVAL_NONCE_GRACE_MS, readCapped, STALE_APPROVAL_TEXT } from "../telegram/adapter.ts";
import { approvalCallbackData, parseApprovalCallback } from "../telegram/mapping.ts";
import { type DiscordMessage, discordMessageId, isSnowflake, mapMessage } from "./mapping.ts";

/**
 * Discord bot adapter (feature N8; architecture §4.10; security §9) without an SDK: the gateway
 * websocket (v10, JSON) for events and `fetch` for REST. It only maps transport events; dmPolicy,
 * pairing, owner checks and routing are the ChannelService's. Approval buttons carry a random
 * nonce only (the Telegram scheme): the approval id and answer token stay in this process.
 */

/** The bot token, alive only inside `fn` (vault- or file-backed). Never logged. */
export interface DiscordTokenSource {
  use<T>(fn: (token: string) => Promise<T>): Promise<T>;
}

export interface DiscordAdapterOptions {
  token: DiscordTokenSource;
  /** Channel account label (bot application id or name). */
  account: string;
  allowDestructiveApprovals?: boolean;
  /** Default wss://gateway.discord.gg/?v=10&encoding=json */
  gatewayUrl?: string;
  /** Default https://discord.com/api/v10 */
  apiBase?: string;
  fetch?: typeof fetch;
  clock?: { now(): number };
  /** Heartbeat and backoff jitter in [0, 1). */
  random?: () => number;
  /** Delay before reconnect attempt `n` (0-based). Default 1 s doubling to 30 s, jittered. */
  reconnectDelayMs?: (attempt: number) => number;
  /** How long a connection may take to reach READY / RESUMED. Default 30 s. */
  readyTimeoutMs?: number;
  /** Max bytes for fetchAttachment, default 25 MB. */
  maxDownloadBytes?: number;
  /** Origins fetchAttachment may download from. Default the Discord CDN. */
  attachmentOrigins?: string[];
}

export const DISCORD_MAX_MESSAGE_CHARS = 2000;
export const DISCORD_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
export const DISCORD_TOKEN_REJECTED = "Discord rejected the bot token";
const DEFAULT_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const DEFAULT_API = "https://discord.com/api/v10";
const CDN_ORIGINS = ["https://cdn.discordapp.com", "https://media.discordapp.net"];
const SUPPRESS_EMBEDS = 1 << 2;
const EPHEMERAL = 1 << 6;
/** A client close code other than 1000/1001 keeps the session resumable. */
const RESUMABLE_CLOSE = 4000;

/** Close codes after which reconnecting cannot help. */
const FATAL_CLOSE: Record<number, string> = {
  4004: DISCORD_TOKEN_REJECTED,
  4010: "Discord gateway: invalid shard",
  4011: "Discord gateway: sharding required",
  4012: "Discord gateway: invalid API version",
  4013: "Discord gateway: invalid intents",
  4014: "Discord refused the intents: enable the Message Content intent for the bot in the Discord developer portal",
};

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

interface Interaction {
  id: string;
  token: string;
  type: number;
  channel_id?: string;
  data?: { custom_id?: string };
  user?: { id: string };
  member?: { user?: { id: string } };
  message?: { content?: string };
}

interface PendingApproval {
  approvalId: string;
  answerToken: string;
  channelId: string;
  expiresAt: number;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly type = "discord" as const;
  readonly account: string;

  readonly #token: DiscordTokenSource;
  readonly #allowDestructive: boolean;
  readonly #gatewayUrl: string;
  readonly #apiBase: string;
  readonly #fetch: typeof fetch;
  readonly #clock: { now(): number };
  readonly #random: () => number;
  readonly #reconnectDelay: (attempt: number) => number;
  readonly #readyTimeoutMs: number;
  readonly #maxDownloadBytes: number;
  readonly #attachmentOrigins: string[];

  readonly #inbound = new Set<(message: InboundMessage) => void | Promise<void>>();
  readonly #answers = new Set<(answer: ChannelApprovalAnswer) => void | Promise<void>>();
  readonly #pending = new Map<string, PendingApproval>();
  /** Channels seen inbound (or opened), by kind; `channel` = posted to, kind unknown. */
  readonly #channels = new Map<string, "dm" | "guild" | "channel">();
  /** User id → DM channel id. */
  readonly #dmByUser = new Map<string, string>();

  #wanted = false;
  #ws: WebSocket | undefined;
  /** Settles the connection attempt in flight (stop() rejects it). */
  #settle: ((err?: PsycheError) => void) | undefined;
  #ready = false;
  #seq: number | null = null;
  #sessionId: string | undefined;
  #resumeUrl: string | undefined;
  #botId: string | undefined;
  #heartbeat: ReturnType<typeof setTimeout> | undefined;
  #acked = true;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #connects = 0;
  #abortCleanup: (() => void) | undefined;
  /** Fingerprint of the token used for the last IDENTIFY / RESUME, and of a rejected one. */
  #tokenPrint: string | undefined;
  #rejectedPrint: string | undefined;
  #fatal: string | undefined;
  #lastEventAt: number | undefined;
  #lastErrorDetail: string | undefined;
  #handlerErrors = 0;

  constructor(options: DiscordAdapterOptions) {
    this.#token = options.token;
    this.account = options.account;
    this.#allowDestructive = options.allowDestructiveApprovals === true;
    this.#gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY;
    this.#apiBase = (options.apiBase ?? DEFAULT_API).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#random = options.random ?? Math.random;
    this.#reconnectDelay =
      options.reconnectDelayMs ??
      ((n) => Math.min(30_000, 1000 * 2 ** n) * (0.5 + this.#random() / 2));
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    this.#maxDownloadBytes = options.maxDownloadBytes ?? DISCORD_MAX_DOWNLOAD_BYTES;
    this.#attachmentOrigins = options.attachmentOrigins ?? CDN_ORIGINS;
  }

  /** Gateway connections opened so far (diagnostics, tests). */
  get connects(): number {
    return this.#connects;
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
      groups: true,
      maxMessageChars: DISCORD_MAX_MESSAGE_CHARS,
      typing: true,
      markdown: true,
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#wanted) return;
    if (aborted(signal)) throw new PsycheError("cancelled", "discord start aborted");
    const print = await this.#token.use(async (t) => fingerprint(t));
    if (print === this.#rejectedPrint) {
      // Same token Discord already refused: fail fast instead of reconnecting (no spin).
      throw new PsycheError("unauthorized", DISCORD_TOKEN_REJECTED);
    }
    this.#fatal = undefined;
    this.#wanted = true;
    try {
      await this.#connect(true);
    } catch (err) {
      this.#wanted = false;
      this.#teardown();
      throw err;
    }
    if (aborted(signal)) {
      await this.stop();
      throw new PsycheError("cancelled", "discord start aborted");
    }
    if (signal !== undefined) {
      const onAbort = () => void this.stop();
      signal.addEventListener("abort", onAbort, { once: true });
      this.#abortCleanup = () => signal.removeEventListener("abort", onAbort);
    }
  }

  async stop(): Promise<void> {
    this.#wanted = false;
    this.#abortCleanup?.();
    this.#abortCleanup = undefined;
    // Closing with 1000 ends the session; the next start identifies afresh.
    this.#sessionId = undefined;
    this.#seq = null;
    this.#teardown(1000);
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

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.text.length > DISCORD_MAX_MESSAGE_CHARS) {
      throw new PsycheError("invalid_params", "message too long", {
        details: { max: DISCORD_MAX_MESSAGE_CHARS, length: message.text.length },
      });
    }
    const files = message.attachments ?? [];
    if (files.length > 10) throw new PsycheError("invalid_params", "at most 10 attachments");
    if (files.some((a) => a.data === undefined)) {
      throw new PsycheError("invalid_params", "outbound attachment has no data");
    }
    if (files.length === 0 && message.text === "") {
      throw new PsycheError("invalid_params", "empty message");
    }
    const replyTo =
      message.replyToMessageId === undefined
        ? undefined
        : discordMessageId(message.replyToMessageId);
    const payload: Record<string, unknown> = {
      content: message.text,
      ...(replyTo === undefined
        ? {}
        : { message_reference: { message_id: replyTo, fail_if_not_exists: false } }),
    };
    if (files.length === 0) return this.#post(message.chatId, payload);
    const form = new FormData();
    payload.attachments = files.map((a, i) => ({ id: i, filename: a.name }));
    files.forEach((a, i) => {
      form.append(
        `files[${i}]`,
        new Blob([a.data as Uint8Array<ArrayBuffer>], { type: a.mime }),
        a.name,
      );
    });
    return this.#post(message.chatId, payload, form);
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
      surface: `discord:${chatId}`,
      ref: approvalRef(approval.id),
      now,
      maxChars: DISCORD_MAX_MESSAGE_CHARS,
    });
    if (!card.answerable) return this.#post(chatId, { content: card.text });
    const channelId = await this.#target(chatId);
    this.#prune();
    const nonce = randomBytes(9).toString("base64url");
    const expiry = Date.parse(approval.expiresAt);
    this.#pending.set(nonce, {
      approvalId: approval.id,
      answerToken,
      channelId,
      expiresAt: Number.isFinite(expiry) ? expiry : now,
    });
    const button = (label: string, style: number, decision: "approve" | "deny") => ({
      type: 2,
      style,
      label,
      custom_id: approvalCallbackData(nonce, decision),
    });
    try {
      return await this.#post(channelId, {
        content: card.text,
        components: [
          { type: 1, components: [button("Approve", 3, "approve"), button("Deny", 4, "deny")] },
        ],
      });
    } catch (err) {
      this.#pending.delete(nonce);
      throw err;
    }
  }

  async sendPairingCode(chatId: string, code: string, expiresAt: number): Promise<SendResult> {
    const channelId = await this.#target(chatId);
    if (this.#channels.get(channelId) !== "dm") {
      throw new PsycheError("forbidden", "pairing codes go to a DM only");
    }
    const minutes = Math.max(1, Math.round((expiresAt - this.#clock.now()) / 60_000));
    const text = `Psyche doesn't know you yet. Your pairing code is ${code}. Ask the owner to approve it; it expires in about ${minutes} minutes.`;
    return this.#post(channelId, { content: text });
  }

  async sendTyping(chatId: string): Promise<void> {
    const channelId = await this.#target(chatId);
    await this.#rest("POST", `/channels/${channelId}/typing`, "POST /channels/:id/typing");
  }

  async fetchAttachment(ref: string, signal?: AbortSignal): Promise<Uint8Array> {
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      throw new PsycheError("invalid_params", "attachment ref is not a URL");
    }
    if (!this.#attachmentOrigins.includes(url.origin)) {
      throw new PsycheError("forbidden", "attachments download only from the Discord CDN", {
        details: { host: url.host },
      });
    }
    const max = this.#maxDownloadBytes;
    let res: Response;
    try {
      // No credentials: CDN URLs are signed. No redirects off the CDN.
      res = await this.#fetch(url, {
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
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
    if (this.#fatal !== undefined) return { ok: false, detail: this.#fatal, ...base };
    if (!this.#wanted) return { ok: false, detail: "stopped", ...base };
    if (this.#ready) return { ok: true, ...base };
    return { ok: false, detail: this.#lastErrorDetail ?? "reconnecting", ...base };
  }

  // ── gateway ──────────────────────────────────────────────────────────────

  /** Opens one connection; resolves on READY / RESUMED, rejects if it closes first. */
  #connect(initial: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const resume = this.#sessionId !== undefined && this.#seq !== null;
      const url =
        resume && this.#resumeUrl !== undefined ? gatewayQuery(this.#resumeUrl) : this.#gatewayUrl;
      let settled = false;
      let wasReady = false;
      const settle = (err?: PsycheError) => {
        if (settled) return;
        settled = true;
        if (this.#settle === settle) this.#settle = undefined;
        clearTimeout(timer);
        if (err === undefined) {
          wasReady = true;
          resolve();
        } else reject(err);
      };
      const timer = setTimeout(() => {
        this.#lastErrorDetail = "Discord gateway did not become ready";
        ws.terminate();
      }, this.#readyTimeoutMs);
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        clearTimeout(timer);
        reject(new PsycheError("invalid_params", "invalid Discord gateway URL"));
        return;
      }
      this.#connects++;
      this.#ws = ws;
      this.#settle = settle;
      ws.on("message", (data) => {
        if (ws !== this.#ws) return;
        let payload: GatewayPayload;
        try {
          payload = JSON.parse(String(data)) as GatewayPayload;
        } catch {
          return;
        }
        this.#onPayload(ws, payload, resume, settle);
      });
      ws.on("error", () => {
        // A close event always follows.
      });
      ws.on("close", (code) => {
        if (ws !== this.#ws) return;
        this.#ws = undefined;
        this.#ready = false;
        this.#stopHeartbeat();
        const fatal = FATAL_CLOSE[code];
        if (fatal !== undefined) {
          this.#fatal = fatal;
          if (code === 4004) this.#rejectedPrint = this.#tokenPrint;
          settle(new PsycheError(code === 4004 ? "unauthorized" : "invalid_params", fatal));
          return;
        }
        // Invalid seq / session timed out: the next connection identifies afresh.
        if (code === 4007 || code === 4009) this.#clearSession();
        this.#lastErrorDetail ??= `Discord gateway closed (${code})`;
        settle(
          new PsycheError("unavailable", this.#lastErrorDetail, {
            retryable: true,
            details: { closeCode: code },
          }),
        );
        if (this.#wanted && (wasReady || !initial)) this.#scheduleReconnect();
      });
    });
  }

  #onPayload(
    ws: WebSocket,
    payload: GatewayPayload,
    resume: boolean,
    settle: (err?: PsycheError) => void,
  ): void {
    if (typeof payload.s === "number") this.#seq = payload.s;
    switch (payload.op) {
      case 10: {
        const interval = Number((payload.d as { heartbeat_interval?: number })?.heartbeat_interval);
        this.#startHeartbeat(ws, Number.isFinite(interval) && interval > 0 ? interval : 41_250);
        this.#authenticate(ws, resume).catch(() => {
          this.#lastErrorDetail = "Discord bot token unavailable";
          ws.terminate();
        });
        return;
      }
      case 11:
        this.#acked = true;
        return;
      case 1:
        this.#sendRaw(ws, { op: 1, d: this.#seq });
        return;
      case 7:
        this.#lastErrorDetail = "Discord asked to reconnect";
        ws.close(RESUMABLE_CLOSE);
        return;
      case 9:
        if (payload.d !== true) this.#clearSession();
        this.#lastErrorDetail = "Discord invalidated the session";
        ws.close(RESUMABLE_CLOSE);
        return;
      case 0:
        this.#lastEventAt = this.#clock.now();
        this.#dispatch(payload.t ?? "", payload.d, settle);
        return;
    }
  }

  async #authenticate(ws: WebSocket, resume: boolean): Promise<void> {
    await this.#token.use(async (token) => {
      this.#tokenPrint = fingerprint(token);
      if (resume) {
        this.#sendRaw(ws, {
          op: 6,
          d: { token, session_id: this.#sessionId, seq: this.#seq },
        });
      } else {
        this.#clearSession();
        this.#sendRaw(ws, {
          op: 2,
          d: {
            token,
            intents: DISCORD_INTENTS,
            properties: { os: process.platform, browser: "psyche", device: "psyche" },
          },
        });
      }
    });
  }

  #dispatch(type: string, data: unknown, settle: (err?: PsycheError) => void): void {
    switch (type) {
      case "READY": {
        const d = data as { session_id: string; resume_gateway_url?: string; user: { id: string } };
        this.#sessionId = d.session_id;
        this.#resumeUrl = d.resume_gateway_url;
        this.#botId = d.user.id;
        this.#onReady(settle);
        return;
      }
      case "RESUMED":
        this.#onReady(settle);
        return;
      case "MESSAGE_CREATE":
      case "MESSAGE_UPDATE":
        void this.#onMessage(data as DiscordMessage, type === "MESSAGE_UPDATE");
        return;
      case "INTERACTION_CREATE":
        void this.#onInteraction(data as Interaction).catch(() => {
          this.#handlerErrors++;
        });
        return;
    }
  }

  #onReady(settle: (err?: PsycheError) => void): void {
    this.#ready = true;
    this.#attempt = 0;
    this.#fatal = undefined;
    this.#lastErrorDetail = undefined;
    settle();
  }

  async #onMessage(message: DiscordMessage, edited: boolean): Promise<void> {
    const botId = this.#botId;
    if (botId === undefined || typeof message?.channel_id !== "string") return;
    const isDm = message.guild_id === undefined;
    this.#channels.set(message.channel_id, isDm ? "dm" : "guild");
    const author = message.author;
    if (isDm && author !== undefined && author.bot !== true && author.id !== botId) {
      this.#dmByUser.set(author.id, message.channel_id);
    }
    const inbound = mapMessage(message, botId, this.account, { edited });
    if (inbound === undefined) return;
    for (const handler of [...this.#inbound]) {
      try {
        await handler(inbound);
      } catch {
        this.#handlerErrors++;
      }
    }
  }

  async #onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.type !== 3) return; // MESSAGE_COMPONENT only
    const callback = (body: unknown) =>
      this.#rest(
        "POST",
        `/interactions/${interaction.id}/${interaction.token}/callback`,
        "POST /interactions/:id/:token/callback",
        body,
      ).catch(() => {
        this.#handlerErrors++;
      });
    const ephemeral = (content: string) =>
      callback({ type: 4, data: { content, flags: EPHEMERAL } });
    const parsed = parseApprovalCallback(interaction.data?.custom_id);
    if (parsed === undefined) {
      await ephemeral("Unknown button.");
      return;
    }
    this.#prune();
    const pending = this.#pending.get(parsed.nonce);
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    if (
      pending === undefined ||
      interaction.channel_id !== pending.channelId ||
      userId === undefined
    ) {
      await ephemeral(STALE_APPROVAL_TEXT);
      return;
    }
    // Ack within Discord's 3 s: update the card and drop its buttons.
    const note = parsed.decision === "approve" ? "Approval sent." : "Denial sent.";
    const content = `${interaction.message?.content ?? ""}\n\n${note}`;
    await callback({
      type: 7,
      data: { components: [], ...(content.length <= DISCORD_MAX_MESSAGE_CHARS ? { content } : {}) },
    });
    // The nonce stays: the Permission Broker rejects replays; the service checks the owner.
    const answer: ChannelApprovalAnswer = {
      approvalId: pending.approvalId,
      answerToken: pending.answerToken,
      decision: parsed.decision,
      senderId: userId,
    };
    for (const handler of [...this.#answers]) {
      try {
        await handler(answer);
      } catch {
        this.#handlerErrors++;
      }
    }
  }

  #startHeartbeat(ws: WebSocket, interval: number): void {
    this.#stopHeartbeat();
    this.#acked = true;
    const beat = () => {
      if (!this.#acked) {
        // A zombie connection: drop it and resume.
        this.#lastErrorDetail = "Discord heartbeat not acknowledged";
        ws.terminate();
        return;
      }
      this.#acked = false;
      this.#sendRaw(ws, { op: 1, d: this.#seq });
      this.#heartbeat = setTimeout(beat, interval);
    };
    this.#heartbeat = setTimeout(beat, interval * this.#random());
  }

  #stopHeartbeat(): void {
    clearTimeout(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  #scheduleReconnect(): void {
    clearTimeout(this.#reconnect);
    const delay = this.#reconnectDelay(this.#attempt++);
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      if (this.#wanted) this.#connect(false).catch(() => undefined);
    }, delay);
  }

  #teardown(code = RESUMABLE_CLOSE): void {
    clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    this.#stopHeartbeat();
    this.#ready = false;
    this.#settle?.(new PsycheError("cancelled", "discord adapter stopped"));
    this.#settle = undefined;
    const ws = this.#ws;
    this.#ws = undefined;
    if (ws !== undefined && ws.readyState === WebSocket.OPEN) ws.close(code);
    else ws?.terminate();
  }

  #clearSession(): void {
    this.#sessionId = undefined;
    this.#seq = null;
  }

  #sendRaw(ws: WebSocket, payload: GatewayPayload): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  #prune(): void {
    const cutoff = this.#clock.now() - APPROVAL_NONCE_GRACE_MS;
    for (const [nonce, entry] of this.#pending) {
      if (entry.expiresAt < cutoff) this.#pending.delete(nonce);
    }
  }

  // ── REST ─────────────────────────────────────────────────────────────────

  async #post(
    chatId: string,
    payload: Record<string, unknown>,
    form?: FormData,
  ): Promise<SendResult> {
    const channelId = await this.#target(chatId);
    // No pings from model text; no link unfurls (as Telegram disables previews).
    const body = { allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS, ...payload };
    form?.append("payload_json", JSON.stringify(body));
    const sent = await this.#rest<{ id: string }>(
      "POST",
      `/channels/${channelId}/messages`,
      "POST /channels/:id/messages",
      form ?? body,
    );
    return { messageId: sent.id };
  }

  /**
   * The channel to post to. A DM channel or guild channel seen inbound is used as is; a user id
   * (the owner's, for approval cards) maps to its DM channel, opened on first use.
   */
  async #target(chatId: string): Promise<string> {
    if (!isSnowflake(chatId)) {
      throw new PsycheError("invalid_params", "Discord ids are numeric snowflakes");
    }
    const dm = this.#dmByUser.get(chatId);
    if (dm !== undefined) return dm;
    if (this.#channels.has(chatId)) return chatId;
    try {
      const opened = await this.#rest<{ id: string }>(
        "POST",
        "/users/@me/channels",
        "POST /users/@me/channels",
        { recipient_id: chatId },
      );
      this.#dmByUser.set(chatId, opened.id);
      this.#channels.set(opened.id, "dm");
      return opened.id;
    } catch (err) {
      // Not a user: treat it as a channel id.
      if (
        err instanceof PsycheError &&
        (err.code === "invalid_params" || err.code === "not_found")
      ) {
        this.#channels.set(chatId, "channel");
        return chatId;
      }
      throw err;
    }
  }

  async #rest<T>(method: string, path: string, route: string, body?: unknown): Promise<T> {
    return this.#token.use(async (token) => {
      const isForm = body instanceof FormData;
      let res: Response;
      try {
        res = await this.#fetch(`${this.#apiBase}${path}`, {
          method,
          headers: {
            Authorization: `Bot ${token}`,
            "User-Agent": "DiscordBot (https://github.com/devmello/psyche, 0.0.0)",
            ...(body === undefined || isForm ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new PsycheError(
          "unavailable",
          scrubToken(`discord ${route} network error: ${detail}`, token),
          {
            retryable: true,
          },
        );
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json().catch(() => ({}))) as T;
      }
      const data = (await res.json().catch(() => ({}))) as DiscordErrorBody;
      const retryHeader = Number(res.headers.get("retry-after") ?? Number.NaN);
      throw mapDiscordError(res.status, data, route, token, retryHeader);
    });
  }
}

export interface DiscordErrorBody {
  message?: string;
  code?: number;
  retry_after?: number;
  global?: boolean;
}

/** Replaces the token and each of its segments with `<token>`. */
export function scrubToken(text: string, token: string): string {
  let out = text;
  if (token === "") return out;
  out = out.split(token).join("<token>");
  for (const part of token.split(".")) {
    if (part.length >= 6) out = out.split(part).join("<token>");
  }
  return out;
}

/** Maps a REST error to `PsycheError`; the message is token-scrubbed. */
export function mapDiscordError(
  status: number,
  body: DiscordErrorBody,
  route: string,
  token: string,
  retryAfterHeader = Number.NaN,
): PsycheError {
  const description = scrubToken(String(body.message ?? "").slice(0, 200), token);
  const message = `discord ${route} failed: ${status}${description === "" ? "" : ` ${description}`}`;
  const details = { route, status, ...(body.code === undefined ? {} : { discordCode: body.code }) };
  if (status === 429) {
    const retryAfterSec =
      typeof body.retry_after === "number" ? body.retry_after : retryAfterHeader;
    return new PsycheError("rate_limited", message, {
      retryable: true,
      details: {
        ...details,
        ...(Number.isFinite(retryAfterSec) ? { retryAfterSec } : {}),
        ...(body.global === true ? { global: true } : {}),
      },
    });
  }
  if (status === 401) return new PsycheError("unauthorized", DISCORD_TOKEN_REJECTED, { details });
  if (status === 403) return new PsycheError("forbidden", message, { details });
  if (status === 404) return new PsycheError("not_found", message, { details });
  if (status === 400) return new PsycheError("invalid_params", message, { details });
  if (status >= 500) return new PsycheError("unavailable", message, { retryable: true, details });
  return new PsycheError("internal", message, { details });
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function gatewayQuery(url: string): string {
  return url.includes("?") ? url : `${url.replace(/\/+$/, "")}/?v=10&encoding=json`;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
