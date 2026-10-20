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
import { checkSignalSocket, SIGNAL_REQUEST_TIMEOUT_MS, SignalRpcClient } from "./client.ts";
import {
  E164_RE,
  mapReceive,
  reactionDecision,
  type SignalReactionEvent,
  type SignalReceiveParams,
  type SignalSelf,
  signalTarget,
} from "./mapping.ts";

/**
 * Signal channel adapter (feature N7; architecture §4.10; security §9). Psyche connects to the
 * owner's own signal-cli JSON-RPC daemon over its UNIX socket; it never registers, verifies or
 * links a number (a separate number for Psyche is recommended). Inbound `receive` notifications
 * are mapped by `mapReceive`; replies go out with `send`. Approvals are 👍 / 👎 reactions on the
 * card only (security §9): the approval id and answer token stay in this process, keyed by the
 * card's sent timestamp. Policy (dmPolicy, pairing, owners, routes) is the channel service's.
 */

export interface SignalAdapterOptions {
  /** signal-cli's `--socket` path. */
  socketPath: string;
  /** Psyche's Signal number (E.164): the channel account. */
  account: string;
  /** The account's ACI uuid, when known: mentions and quotes may name it instead of the number. */
  accountUuid?: string;
  /** Mirror of the channel's `config.allowDestructiveApprovals` (default false). */
  allowDestructiveApprovals?: boolean;
  /** Per-request timeout (default 15 s). */
  requestTimeoutMs?: number;
  /** `fetchAttachment` cap in bytes (default 25 MB). */
  maxAttachmentBytes?: number;
  /** The uid that must own the socket (default the current process's). */
  uid?: number;
  clock?: { now(): number };
  /** Reconnect wait (tests); default a real timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const SIGNAL_MAX_MESSAGE_CHARS = 2000;
export const SIGNAL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const SIGNAL_REACTION_HINT = "React 👍 to approve or 👎 to deny.";
export const SIGNAL_RECONNECT_MAX_MS = 60_000;
const APPROVAL_GRACE_MS = 5 * 60_000;
const ATTACHMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

interface PendingCard {
  approvalId: string;
  answerToken: string;
  chatId: string;
  expiresAt: number;
}

export class SignalAdapter implements ChannelAdapter {
  readonly type = "signal" as const;
  readonly account: string;

  readonly #path: string;
  readonly #self: SignalSelf;
  readonly #allowDestructive: boolean;
  readonly #timeoutMs: number;
  readonly #maxAttachment: number;
  readonly #uid: number | undefined;
  readonly #clock: { now(): number };
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  readonly #inbound = new Set<(message: InboundMessage) => void | Promise<void>>();
  readonly #answers = new Set<(answer: ChannelApprovalAnswer) => void | Promise<void>>();
  /** Card sent timestamp → the approval it carries. */
  readonly #cards = new Map<string, PendingCard>();
  readonly #queues = new Map<string, Promise<void>>();

  #run: AbortController | undefined;
  #client: SignalRpcClient | undefined;
  #reconnecting: Promise<void> | undefined;
  #fatal: string | undefined;
  #detail: string | undefined;
  #lastEventAt: number | undefined;
  #reconnects = 0;
  #handlerErrors = 0;

  constructor(options: SignalAdapterOptions) {
    if (!E164_RE.test(options.account)) {
      throw new PsycheError("invalid_params", "the Signal account is an E.164 number (+1555…)");
    }
    this.account = options.account;
    this.#path = options.socketPath;
    this.#self = {
      number: options.account,
      ...(options.accountUuid === undefined ? {} : { uuid: options.accountUuid.toLowerCase() }),
    };
    this.#allowDestructive = options.allowDestructiveApprovals === true;
    this.#timeoutMs = options.requestTimeoutMs ?? SIGNAL_REQUEST_TIMEOUT_MS;
    this.#maxAttachment = options.maxAttachmentBytes ?? SIGNAL_MAX_ATTACHMENT_BYTES;
    this.#uid = options.uid ?? process.getuid?.();
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#sleep = options.sleep ?? sleep;
  }

  get handlerErrors(): number {
    return this.#handlerErrors;
  }

  /** Successful reconnects after a dropped connection. */
  get reconnects(): number {
    return this.#reconnects;
  }

  capabilities(): ChannelCapabilities {
    return {
      buttons: false,
      polls: false,
      // 👍 / 👎 reactions answer approval cards.
      reactions: true,
      voiceNotes: false,
      // Inbound attachments only (metadata + `fetchAttachment`); outbound is text.
      attachments: false,
      groups: true,
      maxMessageChars: SIGNAL_MAX_MESSAGE_CHARS,
      typing: true,
      markdown: false,
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#run !== undefined) return;
    if (signal?.aborted === true) throw new PsycheError("cancelled", "signal start aborted");
    const run = new AbortController();
    this.#run = run;
    try {
      await this.#connect(run);
    } catch (error) {
      if (this.#run === run) this.#run = undefined;
      throw error;
    }
    signal?.addEventListener("abort", () => void this.stop(), { once: true });
  }

  async stop(): Promise<void> {
    this.#run?.abort();
    this.#run = undefined;
    this.#detail = undefined;
    const client = this.#client;
    this.#client = undefined;
    client?.close();
    await this.#reconnecting?.catch(() => undefined);
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

  /** Resolves once every queued inbound event has been handled (tests, orderly shutdown). */
  async idle(): Promise<void> {
    while (this.#queues.size > 0) await Promise.all([...this.#queues.values()]);
  }

  async health(): Promise<ChannelHealth> {
    const base = this.#lastEventAt === undefined ? {} : { lastEventAt: this.#lastEventAt };
    if (this.#fatal !== undefined) return { ok: false, detail: this.#fatal, ...base };
    // After a failed start, say why (the service retries the start).
    if (this.#run === undefined) return { ok: false, detail: this.#detail ?? "stopped", ...base };
    if (this.#client?.connected !== true) {
      return {
        ok: false,
        detail: this.#detail ?? `cannot reach signal-cli at ${this.#path}`,
        ...base,
      };
    }
    return { ok: true, ...base };
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if ((message.attachments ?? []).length > 0) {
      throw new PsycheError("not_implemented", "Signal attachments are not sent yet");
    }
    return this.#send(message.chatId, message.text);
  }

  async sendPairingCode(chatId: string, code: string, expiresAt: number): Promise<SendResult> {
    const minutes = Math.max(1, Math.round((expiresAt - this.#clock.now()) / 60_000));
    return this.#send(
      chatId,
      `Psyche doesn't know you yet. Your pairing code is ${code}. Ask the owner to approve it; it expires in about ${minutes} minutes.`,
    );
  }

  async sendTyping(chatId: string): Promise<void> {
    const target = signalTarget(chatId);
    if (target === undefined) return;
    await this.#rpc("sendTyping", { ...target });
  }

  /**
   * The approval card as plain text plus a fixed hint; a 👍 / 👎 reaction on it from the same chat
   * answers it (the service checks that the reactor is the owner). No `/approve` lines: Signal
   * answers by reaction only (security §9). A card that does not fit is a pointer to the Mac.
   */
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
    if (signalTarget(chatId) === undefined || chatId.startsWith("group:")) {
      throw new PsycheError("forbidden", "Signal approval cards go to the owner's DM only");
    }
    const now = this.#clock.now();
    const card = renderApprovalCard(approval, {
      surface: `signal:${chatId}`,
      ref: approvalRef(approval.id),
      now,
      maxChars: SIGNAL_MAX_MESSAGE_CHARS - SIGNAL_REACTION_HINT.length - 1,
    });
    if (!card.answerable) return this.#send(chatId, card.text);
    this.#prune();
    const sent = await this.#send(chatId, `${card.text}\n${SIGNAL_REACTION_HINT}`);
    const expiry = Date.parse(approval.expiresAt);
    this.#cards.set(sent.messageId, {
      approvalId: approval.id,
      answerToken,
      chatId,
      expiresAt: Number.isFinite(expiry) ? expiry : now,
    });
    return sent;
  }

  async fetchAttachment(ref: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!ATTACHMENT_ID_RE.test(ref) || ref.includes("..")) {
      throw new PsycheError("invalid_params", "not a Signal attachment id");
    }
    if (signal?.aborted === true) throw new PsycheError("cancelled", "download aborted");
    const tooLarge = () =>
      new PsycheError("invalid_params", "attachment too large", {
        details: { max: this.#maxAttachment },
      });
    const result = await this.#rpc("getAttachment", { id: ref });
    const data =
      typeof result === "string"
        ? result
        : result !== null && typeof result === "object"
          ? (result as { data?: unknown }).data
          : undefined;
    if (typeof data !== "string") {
      throw new PsycheError("unavailable", "signal-cli returned no attachment data");
    }
    // Checked before decoding: base64 is 4 characters per 3 bytes.
    if (Math.floor((data.length * 3) / 4) - 2 > this.#maxAttachment) throw tooLarge();
    const bytes = Buffer.from(data, "base64");
    if (bytes.byteLength > this.#maxAttachment) throw tooLarge();
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // ── connection ───────────────────────────────────────────────────────────

  async #connect(run: AbortController): Promise<void> {
    const uid = this.#uid;
    if (uid === undefined) {
      this.#fatal = "the signal-cli socket needs a POSIX system (no uid to check ownership)";
      throw new PsycheError("forbidden", this.#fatal);
    }
    const problem = await checkSignalSocket(this.#path, uid);
    if (problem === "missing") {
      this.#detail = `cannot reach signal-cli at ${this.#path} (no socket; is the daemon running?)`;
      throw new PsycheError("unavailable", this.#detail, { retryable: true });
    }
    if (problem !== undefined) {
      this.#fatal = problem;
      throw new PsycheError("forbidden", problem);
    }
    const client: SignalRpcClient = new SignalRpcClient({
      socketPath: this.#path,
      timeoutMs: this.#timeoutMs,
      // A base64 attachment at the cap, plus room for the envelope.
      maxLineBytes: Math.ceil((this.#maxAttachment * 4) / 3) + 1024 * 1024,
      onNotification: (method, params) => this.#onNotification(method, params),
      onClose: () => this.#onDisconnect(client, run),
    });
    try {
      await client.connect();
    } catch (error) {
      this.#detail = `cannot reach signal-cli at ${this.#path}`;
      throw error;
    }
    if (run.signal.aborted) {
      client.close();
      throw new PsycheError("cancelled", "signal start aborted");
    }
    this.#client = client;
    this.#fatal = undefined;
    this.#detail = undefined;
  }

  #onDisconnect(client: SignalRpcClient, run: AbortController): void {
    if (this.#client !== client) return;
    this.#client = undefined;
    if (run.signal.aborted || this.#run !== run) return;
    this.#detail = `lost the connection to signal-cli at ${this.#path}; reconnecting`;
    this.#reconnecting ??= this.#reconnect(run).finally(() => {
      this.#reconnecting = undefined;
    });
  }

  /** Back-off 1 s, 2 s, 4 s … capped at 60 s, until connected or stopped. */
  async #reconnect(run: AbortController): Promise<void> {
    let backoff = 1000;
    while (!run.signal.aborted) {
      try {
        await this.#sleep(backoff, run.signal);
      } catch {
        return;
      }
      if (run.signal.aborted) return;
      try {
        await this.#connect(run);
        this.#reconnects++;
        return;
      } catch {
        backoff = Math.min(backoff * 2, SIGNAL_RECONNECT_MAX_MS);
      }
    }
  }

  async #rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const client = this.#client;
    if (client === undefined) {
      throw new PsycheError("unavailable", `cannot reach signal-cli at ${this.#path}`, {
        retryable: true,
      });
    }
    return client.request(method, params);
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  #onNotification(method: string, params: unknown): void {
    if (method !== "receive") return;
    const now = this.#clock.now();
    this.#lastEventAt = now;
    const event = mapReceive(params as SignalReceiveParams, this.#self, now);
    if (event.kind === "ignore") return;
    if (event.kind === "reaction") {
      const { reaction } = event;
      this.#enqueue(reaction.chatId, () => this.#onReaction(reaction));
      return;
    }
    const { message } = event;
    this.#enqueue(message.chatId, async () => {
      for (const handler of [...this.#inbound]) {
        try {
          await handler(message);
        } catch {
          this.#handlerErrors++;
        }
      }
    });
  }

  /** Per-chat FIFO: one slow turn never stalls the other chats. */
  #enqueue(chatId: string, fn: () => Promise<void>): void {
    const next = (this.#queues.get(chatId) ?? Promise.resolve()).then(fn).catch(() => {
      this.#handlerErrors++;
    });
    this.#queues.set(chatId, next);
    void next.then(() => {
      if (this.#queues.get(chatId) === next) this.#queues.delete(chatId);
    });
  }

  async #onReaction(reaction: SignalReactionEvent): Promise<void> {
    // Other reactions (and taking one back) are ignored, never inbound turns.
    if (reaction.isRemove || !reaction.targetIsSelf || reaction.isGroup) return;
    const decision = reactionDecision(reaction.emoji);
    if (decision === undefined) return;
    this.#prune();
    const card = this.#cards.get(String(reaction.targetSentTimestamp));
    if (card === undefined || card.chatId !== reaction.chatId) return;
    const answer: ChannelApprovalAnswer = {
      approvalId: card.approvalId,
      answerToken: card.answerToken,
      decision,
      senderId: reaction.senderId,
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
    const cutoff = this.#clock.now() - APPROVAL_GRACE_MS;
    for (const [ts, card] of this.#cards) if (card.expiresAt < cutoff) this.#cards.delete(ts);
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  async #send(chatId: string, text: string): Promise<SendResult> {
    if (text.trim() === "") throw new PsycheError("invalid_params", "empty message");
    if (text.length > SIGNAL_MAX_MESSAGE_CHARS) {
      throw new PsycheError("invalid_params", "message too long", {
        details: { max: SIGNAL_MAX_MESSAGE_CHARS, length: text.length },
      });
    }
    const target = signalTarget(chatId);
    if (target === undefined) {
      throw new PsycheError("invalid_params", "not a Signal chat (E.164, uuid:… or group:…)");
    }
    const result = (await this.#rpc("send", { ...target, message: text })) as
      | { timestamp?: unknown }
      | undefined;
    const ts = result?.timestamp;
    if (typeof ts !== "number" && typeof ts !== "string") {
      throw new PsycheError("unavailable", "signal-cli send returned no timestamp");
    }
    return { messageId: String(ts) };
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
