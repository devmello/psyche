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
  mapMessageEvent,
  SLACK_USER_ID,
  type SlackIdentity,
  type SlackMessageEvent,
} from "./mapping.ts";

/**
 * Slack channel adapter (feature N8, owner S10) over Socket Mode: `apps.connections.open` with the
 * app-level token returns a WebSocket URL; events and button clicks arrive on it as envelopes that
 * are acknowledged at once; replies go through the Web API with the bot token. No public HTTP
 * endpoint is needed, which suits a loopback-bound Gateway (security §10). Approval buttons carry
 * only a random nonce: the approval id and answer token stay in this process (security §9).
 * Policy (dmPolicy, pairing, owners, routes) is the channel service's; this file only maps.
 */

/** The WHATWG WebSocket surface used here (Node 22+ global, or a test double). */
export interface SlackWebSocket {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SlackAdapterOptions {
  /** `xoxb-…`: Web API calls. Read per call; never logged, never in error messages. */
  botToken: SecretSource;
  /** `xapp-…` with `connections:write`: opens Socket Mode connections. */
  appToken: SecretSource;
  /** Channel account label (the workspace, e.g. `acme`); default the team id from auth.test. */
  account?: string;
  /** Mirror of the channel's `config.allowDestructiveApprovals` (default false). */
  allowDestructiveApprovals?: boolean;
  /** Web API root, default https://slack.com/api. */
  apiBase?: string;
  fetch?: typeof fetch;
  webSocket?: (url: string) => SlackWebSocket;
  /** Hosts `fetchAttachment` may download from (default files.slack.com). */
  fileHosts?: string[];
  clock?: { now(): number };
  /** Reconnect wait (tests); default a real timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxDownloadBytes?: number;
}

export const SLACK_MAX_MESSAGE_CHARS = 4000;
/** A `section` block's plain_text limit. */
export const SLACK_MAX_SECTION_CHARS = 3000;
export const APPROVAL_NONCE_GRACE_MS = 5 * 60_000;
export const SLACK_DEFAULT_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const APPROVE_ACTION = "psyche_approval_approve";
const DENY_ACTION = "psyche_approval_deny";
/** Web API errors that no retry fixes: the tokens are wrong, revoked or lack a scope. */
const FATAL_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
  "missing_scope",
  "team_access_not_granted",
]);
const MAX_BACKOFF_MS = 30_000;

interface PendingApproval {
  approvalId: string;
  answerToken: string;
  chatId: string;
  expiresAt: number;
  text: string;
}

interface Envelope {
  envelope_id?: string;
  type?: string;
  reason?: string;
  payload?: {
    event?: SlackMessageEvent;
    type?: string;
    user?: { id?: string };
    channel?: { id?: string };
    container?: { channel_id?: string; message_ts?: string };
    message?: { ts?: string };
    actions?: { action_id?: string; value?: string }[];
  };
}

export class SlackAdapter implements ChannelAdapter {
  readonly type = "slack" as const;

  readonly #bot: SecretSource;
  readonly #app: SecretSource;
  readonly #accountOverride: string | undefined;
  readonly #allowDestructive: boolean;
  readonly #apiBase: string;
  readonly #fetch: typeof fetch;
  readonly #webSocket: (url: string) => SlackWebSocket;
  readonly #fileHosts: Set<string>;
  readonly #clock: { now(): number };
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #maxDownloadBytes: number;

  readonly #inbound = new Set<(message: InboundMessage) => void | Promise<void>>();
  readonly #answers = new Set<(answer: ChannelApprovalAnswer) => void | Promise<void>>();
  readonly #pending = new Map<string, PendingApproval>();
  /** Where a reply to a chat goes: the thread of the latest addressed message there. */
  readonly #threads = new Map<string, string>();
  /** A user id's DM channel with the bot (`conversations.open`). */
  readonly #dms = new Map<string, string>();

  #me: SlackIdentity | undefined;
  #team = "";
  #run: AbortController | undefined;
  #socket: SlackWebSocket | undefined;
  #connected = false;
  #fatal: string | undefined;
  #lastEventAt: number | undefined;
  #handlerErrors = 0;

  constructor(options: SlackAdapterOptions) {
    this.#bot = options.botToken;
    this.#app = options.appToken;
    this.#accountOverride = options.account;
    this.#allowDestructive = options.allowDestructiveApprovals === true;
    this.#apiBase = (options.apiBase ?? "https://slack.com/api").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#webSocket =
      options.webSocket ?? ((url) => new globalThis.WebSocket(url) as unknown as SlackWebSocket);
    this.#fileHosts = new Set(options.fileHosts ?? ["files.slack.com"]);
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#sleep = options.sleep ?? sleep;
    this.#maxDownloadBytes = options.maxDownloadBytes ?? SLACK_DEFAULT_MAX_DOWNLOAD_BYTES;
  }

  get account(): string {
    return this.#accountOverride ?? this.#team;
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
      maxMessageChars: SLACK_MAX_MESSAGE_CHARS,
      typing: false,
      markdown: false,
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#run !== undefined) return;
    if (signal?.aborted === true) throw new PsycheError("cancelled", "slack start aborted");
    const auth = await this.#api<{ user_id?: string; bot_id?: string; team_id?: string }>(
      "auth.test",
      {},
    );
    if (auth.user_id === undefined) throw new PsycheError("unavailable", "auth.test gave no user");
    this.#me = {
      userId: auth.user_id,
      ...(auth.bot_id === undefined ? {} : { botId: auth.bot_id }),
    };
    this.#team = auth.team_id ?? "";
    this.#fatal = undefined;
    const run = new AbortController();
    this.#run = run;
    signal?.addEventListener("abort", () => void this.stop(), { once: true });
    void this.#loop(run.signal);
  }

  async stop(): Promise<void> {
    this.#run?.abort();
    this.#run = undefined;
    this.#connected = false;
    const socket = this.#socket;
    this.#socket = undefined;
    try {
      socket?.close(1000, "stop");
    } catch {
      // Already closed.
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

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.text.trim() === "") throw new PsycheError("invalid_params", "empty message");
    if (message.text.length > SLACK_MAX_MESSAGE_CHARS) {
      throw new PsycheError("invalid_params", "message too long", {
        details: { max: SLACK_MAX_MESSAGE_CHARS, length: message.text.length },
      });
    }
    if ((message.attachments ?? []).length > 0) {
      throw new PsycheError("invalid_params", "Slack file uploads are not supported yet");
    }
    const thread = message.replyToMessageId ?? this.#threads.get(message.chatId);
    return this.#post(message.chatId, message.text, thread);
  }

  async sendPairingCode(chatId: string, code: string, expiresAt: number): Promise<SendResult> {
    const minutes = Math.max(1, Math.round((expiresAt - this.#clock.now()) / 60_000));
    return this.#post(
      chatId,
      `Psyche doesn't know you yet. Your pairing code is ${code}. Ask the owner to approve it; it expires in about ${minutes} minutes.`,
      undefined,
    );
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
      surface: `slack:${chatId}`,
      ref: approvalRef(approval.id),
      now,
      maxChars: SLACK_MAX_SECTION_CHARS,
    });
    if (!card.answerable) return this.#post(chatId, card.text, undefined);
    const channel = await this.#resolveChat(chatId);
    this.#prune();
    const nonce = randomBytes(9).toString("base64url");
    const expiry = Date.parse(approval.expiresAt);
    this.#pending.set(nonce, {
      approvalId: approval.id,
      answerToken,
      chatId: channel,
      expiresAt: Number.isFinite(expiry) ? expiry : now,
      text: card.text,
    });
    try {
      const res = await this.#api<{ ts?: string }>("chat.postMessage", {
        channel,
        text: card.text,
        unfurl_links: false,
        unfurl_media: false,
        blocks: [
          section(card.text),
          {
            type: "actions",
            elements: [
              button("Approve", APPROVE_ACTION, nonce, "primary"),
              button("Deny", DENY_ACTION, nonce, "danger"),
            ],
          },
        ],
      });
      return { messageId: res.ts ?? "" };
    } catch (err) {
      this.#pending.delete(nonce);
      throw err;
    }
  }

  async fetchAttachment(ref: string, signal?: AbortSignal): Promise<Uint8Array> {
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      throw new PsycheError("invalid_params", "not a Slack file URL");
    }
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (!this.#fileHosts.has(url.host) || (url.protocol !== "https:" && !local)) {
      throw new PsycheError("forbidden", "attachments download only from Slack's file host");
    }
    let res: Response;
    try {
      res = await this.#bot.use((token) =>
        this.#fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    } catch {
      if (signal?.aborted === true) throw new PsycheError("cancelled", "download aborted");
      throw new PsycheError("unavailable", "attachment download failed", { retryable: true });
    }
    if (!res.ok) {
      throw new PsycheError("unavailable", `attachment download failed (HTTP ${res.status})`, {
        retryable: res.status >= 500 || res.status === 429,
        details: { status: res.status },
      });
    }
    return readCapped(res, this.#maxDownloadBytes, signal);
  }

  async health(): Promise<ChannelHealth> {
    const base = this.#lastEventAt === undefined ? {} : { lastEventAt: this.#lastEventAt };
    if (this.#fatal !== undefined) return { ok: false, detail: this.#fatal, ...base };
    if (this.#run === undefined) return { ok: false, detail: "stopped", ...base };
    if (!this.#connected) return { ok: false, detail: "connecting to Slack", ...base };
    return { ok: true, ...base };
  }

  // ── Socket Mode ──────────────────────────────────────────────────────────

  async #loop(signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      let url: string;
      try {
        const res = await this.#api<{ url?: string }>("apps.connections.open", {}, this.#app);
        if (res.url === undefined) throw new PsycheError("unavailable", "no Socket Mode URL");
        url = res.url;
      } catch {
        if (this.#fatal !== undefined || signal.aborted) return;
        await this.#sleep(backoff, signal).catch(() => undefined);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
      const clean = await this.#session(url, signal);
      if (clean) backoff = 1000;
      else {
        await this.#sleep(backoff, signal).catch(() => undefined);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /** One connection. Resolves true when Slack asked to reconnect (no back-off needed). */
  #session(url: string, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let refresh = false;
      let socket: SlackWebSocket;
      try {
        socket = this.#webSocket(url);
      } catch {
        resolve(false);
        return;
      }
      this.#socket = socket;
      const done = () => {
        this.#connected = false;
        if (this.#socket === socket) this.#socket = undefined;
        resolve(refresh);
      };
      const onAbort = () => {
        try {
          socket.close(1000, "stop");
        } catch {
          // ignore
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      socket.onclose = () => {
        signal.removeEventListener("abort", onAbort);
        done();
      };
      socket.onerror = () => undefined;
      socket.onmessage = (ev) => {
        const env = parseEnvelope(ev.data);
        if (env === undefined) return;
        if (env.envelope_id !== undefined) {
          try {
            socket.send(JSON.stringify({ envelope_id: env.envelope_id }));
          } catch {
            // The socket is going away; Slack redelivers unacknowledged envelopes.
          }
        }
        if (env.type === "hello") {
          this.#connected = true;
          return;
        }
        if (env.type === "disconnect") {
          refresh = env.reason !== "link_disabled";
          if (env.reason === "link_disabled") this.#fatal = "Socket Mode is disabled for this app";
          socket.close(1000, "refresh");
          return;
        }
        void this.#dispatch(env);
      };
    });
  }

  async #dispatch(env: Envelope): Promise<void> {
    this.#lastEventAt = this.#clock.now();
    try {
      if (env.type === "events_api" && env.payload?.event !== undefined) {
        await this.#onEvent(env.payload.event);
      } else if (env.type === "interactive" && env.payload?.type === "block_actions") {
        await this.#onAction(env.payload);
      }
    } catch {
      this.#handlerErrors++;
    }
  }

  async #onEvent(event: SlackMessageEvent): Promise<void> {
    const me = this.#me;
    if (me === undefined) return;
    const inbound = mapMessageEvent(event, me, this.account, this.#clock.now());
    if (inbound === undefined) return;
    // Reply in the thread the person wrote in; in a channel, a root mention starts a thread.
    const raw = event.subtype === "message_changed" ? event.message : event;
    const thread = raw?.thread_ts ?? (inbound.isGroup && inbound.mentioned ? raw?.ts : undefined);
    if (inbound.editOf === undefined) {
      if (thread !== undefined) this.#threads.set(inbound.chatId, thread);
      else if (!inbound.isGroup) this.#threads.delete(inbound.chatId);
    }
    for (const handler of [...this.#inbound]) {
      try {
        await handler(inbound);
      } catch {
        this.#handlerErrors++;
      }
    }
  }

  async #onAction(payload: NonNullable<Envelope["payload"]>): Promise<void> {
    const action = payload.actions?.[0];
    const decision =
      action?.action_id === APPROVE_ACTION
        ? "approve"
        : action?.action_id === DENY_ACTION
          ? "deny"
          : undefined;
    if (decision === undefined || action?.value === undefined) return;
    this.#prune();
    const pending = this.#pending.get(action.value);
    const channel = payload.channel?.id ?? payload.container?.channel_id;
    const ts = payload.message?.ts ?? payload.container?.message_ts;
    const senderId = payload.user?.id;
    if (pending === undefined || channel !== pending.chatId || senderId === undefined) return;
    // Remove the buttons so the card cannot be pressed again; the broker rejects replays anyway.
    if (ts !== undefined) {
      await this.#api("chat.update", {
        channel,
        ts,
        text: pending.text,
        blocks: [
          section(`${pending.text}\n\n${decision === "approve" ? "Approval" : "Denial"} sent.`),
        ],
      }).catch(() => undefined);
    }
    const answer: ChannelApprovalAnswer = {
      approvalId: pending.approvalId,
      answerToken: pending.answerToken,
      decision,
      senderId,
    };
    for (const handler of [...this.#answers]) {
      try {
        await handler(answer);
      } catch {
        this.#handlerErrors++;
      }
    }
  }

  #prune(): void {
    const cutoff = this.#clock.now() - APPROVAL_NONCE_GRACE_MS;
    for (const [nonce, entry] of this.#pending) {
      if (entry.expiresAt < cutoff) this.#pending.delete(nonce);
    }
  }

  // ── Web API ──────────────────────────────────────────────────────────────

  /** A user id (an owner surface, `slack:<user>`) means the bot's DM with them. */
  async #resolveChat(chatId: string): Promise<string> {
    if (!SLACK_USER_ID.test(chatId)) return chatId;
    const known = this.#dms.get(chatId);
    if (known !== undefined) return known;
    const res = await this.#api<{ channel?: { id?: string } }>("conversations.open", {
      users: chatId,
    });
    const id = res.channel?.id;
    if (id === undefined) throw new PsycheError("unavailable", "Slack gave no DM channel");
    this.#dms.set(chatId, id);
    return id;
  }

  async #post(chatId: string, text: string, thread: string | undefined): Promise<SendResult> {
    const res = await this.#api<{ ts?: string }>("chat.postMessage", {
      channel: await this.#resolveChat(chatId),
      text,
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
      ...(thread === undefined ? {} : { thread_ts: thread }),
    });
    return { messageId: res.ts ?? "" };
  }

  /** One Web API call. Errors carry Slack's error code, never a token. */
  async #api<T>(method: string, body: Record<string, unknown>, secret = this.#bot): Promise<T> {
    let res: Response;
    try {
      res = await secret.use((token) =>
        this.#fetch(`${this.#apiBase}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
        }),
      );
    } catch {
      throw new PsycheError("unavailable", `Slack ${method} failed (network)`, { retryable: true });
    }
    if (res.status === 429) {
      const after = Number(res.headers.get("retry-after") ?? "1");
      throw new PsycheError("rate_limited", `Slack ${method} rate limited`, {
        retryable: true,
        details: { retryAfterMs: (Number.isFinite(after) ? after : 1) * 1000 },
      });
    }
    let json: { ok?: boolean; error?: string } & Record<string, unknown>;
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new PsycheError("unavailable", `Slack ${method} failed (HTTP ${res.status})`, {
        retryable: res.status >= 500,
      });
    }
    if (json.ok !== true) {
      const code = typeof json.error === "string" ? json.error : "unknown_error";
      if (FATAL_ERRORS.has(code)) {
        this.#fatal = `Slack rejected the token (${code})`;
        throw new PsycheError("forbidden", `Slack ${method}: ${code}`, {
          details: { slack: code },
        });
      }
      if (code === "ratelimited") {
        throw new PsycheError("rate_limited", `Slack ${method} rate limited`, { retryable: true });
      }
      throw new PsycheError("unavailable", `Slack ${method}: ${code}`, {
        retryable: res.status >= 500,
        details: { slack: code },
      });
    }
    return json as T;
  }
}

function section(text: string) {
  return { type: "section", text: { type: "plain_text", text, emoji: false } };
}

function button(label: string, actionId: string, value: string, style: "primary" | "danger") {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    action_id: actionId,
    value,
    style,
  };
}

function parseEnvelope(data: unknown): Envelope | undefined {
  const text = typeof data === "string" ? data : data instanceof Buffer ? data.toString() : "";
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null ? (v as Envelope) : undefined;
  } catch {
    return undefined;
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
