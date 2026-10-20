import { createHash } from "node:crypto";
import { bindingFor } from "@psyche/permissions";
import {
  type ApprovalRequest,
  type ChannelAdapter,
  type ChannelApprovalAnswer,
  type ChannelCapabilities,
  type ChannelHealth,
  type ErrorPayload,
  type InboundMessage,
  type MessagesMessage,
  type MessagesSendParams,
  type MessagesStatus,
  type MessagesWatchEvent,
  type NodeClient,
  type OutboundMessage,
  PsycheError,
  type SendResult,
  type Unsubscribe,
} from "@psyche/protocol";
import { approvalRef, chatEligibility, renderApprovalCard } from "../../format/approval-card.ts";
import {
  canonicalHandle,
  dmPeer,
  isBareHandle,
  isGroupChat,
  isStrongRow,
  type KnownRow,
  mapRow,
} from "./mapping.ts";

/**
 * iMessage channel adapter (feature N5; architecture §4.10; security §3.5, §9, §12) over the mac
 * helper's `messages.*` node capabilities. Inbound is one long `messages.watch` invocation from a
 * persisted chat.db cursor; outbound is `messages.send` into the conversation being answered.
 *
 * `messages.send` is destructive (it speaks as the Apple ID signed in to Messages on the Mac), so
 * the node refuses it without an `approvalId`. The adapter never invents one: every send goes
 * through `authorizeSend`, a port the Gateway implements with its Permission Broker (kind
 * `message_send`, scope `once`, bound to `{channel, account, recipient, bodySha256}`).
 */

export type IMessageSendPurpose = "reply" | "pairing_code" | "approval_card";

/** What `authorizeSend` is asked to approve: one text, to one conversation. */
export interface IMessageSendIntent {
  channel: "imessage";
  account: string;
  /** The chat guid being answered, or the bare handle of a 1:1 peer. The only recipient. */
  recipient: string;
  /** `sha256:<hex>` of the exact text. */
  bodySha256: string;
  /** `message_send` binding (security §3.5) of the fields above; what the approval must bind. */
  bindingHash: string;
  grantKey: string;
  purpose: IMessageSendPurpose;
}

/** Resolves the id of an approved `message_send` approval for exactly this intent, or throws. */
export type IMessageSendAuthorizer = (
  intent: IMessageSendIntent,
  signal?: AbortSignal,
) => Promise<string>;

/** Where the chat.db cursor (`message.ROWID`) survives restarts. */
export interface IMessageCursorStore {
  load(): Promise<number | null>;
  save(cursor: number): Promise<void>;
}

export class MemoryCursorStore implements IMessageCursorStore {
  value: number | null;
  constructor(initial: number | null = null) {
    this.value = initial;
  }
  async load(): Promise<number | null> {
    return this.value;
  }
  async save(cursor: number): Promise<void> {
    this.value = cursor;
  }
}

export interface IMessageAdapterOptions {
  /** Channel account label (the Mac's Messages account, e.g. its Apple ID email). */
  account: string;
  /** The connected Messages-capable node (mac helper), if any. */
  node: () => NodeClient | undefined;
  authorizeSend: IMessageSendAuthorizer;
  cursor: IMessageCursorStore;
  /** Mirror of the channel's `config.allowDestructiveApprovals` (default false). */
  allowDestructiveApprovals?: boolean;
  /** chat.db poll interval passed to `messages.watch` (default: the helper's 2 s). */
  intervalMs?: number;
  clock?: { now(): number };
}

export const IMESSAGE_MAX_MESSAGE_CHARS = 4000;
export const FULL_DISK_ACCESS_DETAIL =
  "Grant Full Disk Access to Psyche Helper (System Settings → Privacy & Security → Full Disk Access), then reconnect the channel.";
export const TAPBACK_HINT = "Or tap 👍 to approve or 👎 to deny.";
const APPROVAL_GRACE_MS = 5 * 60_000;
const KNOWN_ROWS = 500;
const SEND_TIMEOUT_MS = 30_000;
/** A watch runs until cancelled; the registry's default invoke timeout would end it. */
const WATCH_TIMEOUT_MS = 0x7fffffff;

interface PendingCard {
  approvalId: string;
  answerToken: string;
  /** The chat guid the card landed in (from its echo). */
  chatId: string;
  expiresAt: number;
}

interface AwaitingEcho {
  recipient: string;
  text: string;
  card: PendingCard;
}

export class IMessageAdapter implements ChannelAdapter {
  readonly type = "imessage" as const;
  readonly account: string;

  readonly #node: () => NodeClient | undefined;
  readonly #authorize: IMessageSendAuthorizer;
  readonly #cursorStore: IMessageCursorStore;
  readonly #allowDestructive: boolean;
  readonly #intervalMs: number | undefined;
  readonly #clock: { now(): number };

  readonly #inbound = new Set<(message: InboundMessage) => void | Promise<void>>();
  readonly #answers = new Set<(answer: ChannelApprovalAnswer) => void | Promise<void>>();
  readonly #known = new Map<string, KnownRow>();
  /** Conversations seen inbound; outbound chat guids must be one of them. */
  readonly #chats = new Set<string>();
  /** 1:1 peer handle → its chat guid, so a bare-handle target lands in the existing chat. */
  readonly #dmChats = new Map<string, string>();
  readonly #cards = new Map<string, PendingCard>();
  #awaiting: AwaitingEcho[] = [];
  readonly #queues = new Map<string, Promise<void>>();

  #started = false;
  #abort: AbortController | undefined;
  #watch: Promise<void> | undefined;
  #cursor = 0;
  #saving: Promise<void> = Promise.resolve();
  #fatal: string | undefined;
  #ended: string | undefined;
  #degraded: string | undefined;
  #lastEventAt: number | undefined;
  #sent = 0;
  #handlerErrors = 0;

  constructor(options: IMessageAdapterOptions) {
    this.account = options.account;
    this.#node = options.node;
    this.#authorize = options.authorizeSend;
    this.#cursorStore = options.cursor;
    this.#allowDestructive = options.allowDestructiveApprovals === true;
    this.#intervalMs = options.intervalMs;
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  get handlerErrors(): number {
    return this.#handlerErrors;
  }

  capabilities(): ChannelCapabilities {
    return {
      buttons: false,
      polls: false,
      // 👍 / 👎 tapbacks answer approval cards.
      reactions: true,
      // Outbound is text only (`messages.send`); inbound voice bubbles arrive as metadata.
      voiceNotes: false,
      attachments: false,
      groups: true,
      maxMessageChars: IMESSAGE_MAX_MESSAGE_CHARS,
      typing: false,
      markdown: false,
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#started) return;
    if (signal?.aborted === true) throw new PsycheError("cancelled", "imessage start aborted");
    const node = this.#requireNode();
    const status = await node.invoke("messages.status", {}, { timeoutMs: SEND_TIMEOUT_MS });
    if (!status.ok) throw nodeError(status.error, "messages.status failed");
    const preflight = status.result as MessagesStatus;
    if (!preflight.fullDiskAccess) {
      this.#fatal = FULL_DISK_ACCESS_DETAIL;
      throw new PsycheError("forbidden", FULL_DISK_ACCESS_DETAIL);
    }
    let cursor = await this.#cursorStore.load();
    if (cursor === null) {
      // First start: begin at the newest row, never replay the history.
      cursor = preflight.lastCursor ?? 0;
      await this.#cursorStore.save(cursor);
    }
    this.#cursor = cursor;
    this.#fatal = undefined;
    this.#ended = undefined;
    this.#degraded = undefined;
    const abort = new AbortController();
    signal?.addEventListener("abort", () => abort.abort(), { once: true });
    this.#abort = abort;
    this.#started = true;
    this.#watch = node
      .invoke(
        "messages.watch",
        {
          sinceCursor: cursor,
          includeFromMe: true,
          ...(this.#intervalMs === undefined ? {} : { intervalMs: this.#intervalMs }),
        },
        {
          signal: abort.signal,
          timeoutMs: WATCH_TIMEOUT_MS,
          onEvent: (e) => this.#onEvent(e.data),
        },
      )
      .then((res) => {
        if (abort.signal.aborted) return;
        const message = res.error?.message ?? "";
        if (/full_disk_access/.test(message)) this.#fatal = FULL_DISK_ACCESS_DETAIL;
        this.#ended = res.ok ? "watch ended" : `watch ended: ${res.error?.code ?? "internal"}`;
      });
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#abort?.abort();
    this.#abort = undefined;
    await this.#watch?.catch(() => undefined);
    this.#watch = undefined;
    await this.#saving;
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

  /** Resolves once every queued inbound row has been handled (tests, orderly shutdown). */
  async idle(): Promise<void> {
    while (this.#queues.size > 0) await Promise.all([...this.#queues.values()]);
    await this.#saving;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if ((message.attachments ?? []).length > 0) {
      throw new PsycheError("not_implemented", "iMessage attachments are not sent yet");
    }
    return this.#deliver(message.chatId, message.text, "reply");
  }

  async sendPairingCode(chatId: string, code: string, expiresAt: number): Promise<SendResult> {
    const minutes = Math.max(1, Math.round((expiresAt - this.#clock.now()) / 60_000));
    const text = `Psyche doesn't know you yet. Your pairing code is ${code}. Ask the owner to approve it; it expires in about ${minutes} minutes.`;
    return this.#deliver(chatId, text, "pairing_code");
  }

  /**
   * Approval card as plain text with the `/approve` fallback; a 👍 / 👎 tapback on the card (from
   * the owner's iMessage identity) answers it. The token stays in this process.
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
    const now = this.#clock.now();
    const card = renderApprovalCard(approval, {
      surface: `imessage:${chatId}`,
      ref: approvalRef(approval.id),
      now,
      commandFallback: true,
      maxChars: IMESSAGE_MAX_MESSAGE_CHARS - TAPBACK_HINT.length - 1,
    });
    if (!card.answerable) return this.#deliver(chatId, card.text, "approval_card");
    this.#prune();
    const text = `${card.text}\n${TAPBACK_HINT}`;
    const expiry = Date.parse(approval.expiresAt);
    const pending: PendingCard = {
      approvalId: approval.id,
      answerToken,
      chatId: "",
      expiresAt: Number.isFinite(expiry) ? expiry : now,
    };
    return this.#deliver(chatId, text, "approval_card", pending);
  }

  async health(): Promise<ChannelHealth> {
    const base = this.#lastEventAt === undefined ? {} : { lastEventAt: this.#lastEventAt };
    if (this.#fatal !== undefined) return { ok: false, detail: this.#fatal, ...base };
    if (!this.#started) return { ok: false, detail: "stopped", ...base };
    if (this.#ended !== undefined) return { ok: false, detail: this.#ended, ...base };
    if (this.#degraded !== undefined) return { ok: true, detail: this.#degraded, ...base };
    return { ok: true, ...base };
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  #onEvent(data: unknown): void {
    const event = data as MessagesWatchEvent | undefined;
    if (event?.type === "messages.watch_error") {
      if (event.reason === "full_disk_access_missing") this.#fatal = FULL_DISK_ACCESS_DETAIL;
      else if (!event.retryable) this.#fatal = `watch error: ${event.reason}`;
      else this.#degraded = `watch error: ${event.reason}`;
      return;
    }
    if (event?.type !== "messages.new" || !Array.isArray(event.messages)) return;
    this.#lastEventAt = this.#clock.now();
    this.#degraded = undefined;
    for (const row of event.messages) {
      // The backfill and the live stream may overlap after a restart: each ROWID once.
      if (row.cursor <= this.#cursor) continue;
      this.#cursor = row.cursor;
      this.#onRow(row);
    }
    // Persisted on receipt (at most once): a crash mid-batch drops it rather than re-running it.
    const cursor = Math.max(this.#cursor, event.cursor);
    this.#cursor = cursor;
    this.#saving = this.#saving
      .then(() => this.#cursorStore.save(cursor))
      .catch(() => {
        this.#handlerErrors++;
      });
  }

  #onRow(row: MessagesMessage): void {
    this.#remember(row);
    if (row.isFromMe) {
      // Our own sends (and anything else sent from the Mac's account) are never inbound.
      this.#bindEcho(row);
      return;
    }
    if (row.reaction != null) {
      this.#enqueue(row.chatId, () => this.#onTapback(row));
      return;
    }
    const inbound = mapRow(row, this.account, (guid) => this.#known.get(guid));
    if (inbound === undefined) return;
    this.#chats.add(row.chatId);
    // Only an iMessage identity names the 1:1 chat a bare handle resolves to (never an SMS one).
    if (!inbound.isGroup && inbound.identityStrength !== "weak") {
      this.#dmChats.set(inbound.senderId, row.chatId);
    }
    this.#enqueue(row.chatId, async () => {
      for (const handler of [...this.#inbound]) {
        try {
          await handler(inbound);
        } catch {
          this.#handlerErrors++;
        }
      }
    });
  }

  /** Per-chat FIFO: a send waiting on its approval in one chat never stalls the others. */
  #enqueue(chatId: string, fn: () => Promise<void>): void {
    const next = (this.#queues.get(chatId) ?? Promise.resolve()).then(fn).catch(() => {
      this.#handlerErrors++;
    });
    this.#queues.set(chatId, next);
    void next.then(() => {
      if (this.#queues.get(chatId) === next) this.#queues.delete(chatId);
    });
  }

  #remember(row: MessagesMessage): void {
    if (row.reaction != null || row.text == null) return;
    this.#known.set(row.guid, {
      text: row.text,
      fromSelf: row.isFromMe,
      ...(row.sender == null ? {} : { senderId: canonicalHandle(row.sender.handle) }),
    });
    if (this.#known.size > KNOWN_ROWS) {
      const oldest = this.#known.keys().next().value;
      if (oldest !== undefined) this.#known.delete(oldest);
    }
  }

  #bindEcho(row: MessagesMessage): void {
    const i = this.#awaiting.findIndex(
      (e) => e.text === (row.text ?? "") && sameConversation(e.recipient, row.chatId),
    );
    if (i < 0) return;
    const [echo] = this.#awaiting.splice(i, 1);
    if (echo === undefined) return;
    echo.card.chatId = row.chatId;
    this.#cards.set(row.guid, echo.card);
  }

  async #onTapback(row: MessagesMessage): Promise<void> {
    const reaction = row.reaction;
    if (reaction == null || reaction.removed || row.sender == null) return;
    const decision =
      reaction.kind === "like" ? "approve" : reaction.kind === "dislike" ? "deny" : undefined;
    // Only a strong (iMessage) identity in a 1:1 chat may answer; SMS / RCS handles are forgeable.
    if (decision === undefined || !isStrongRow(row) || isGroupChat(row.chatId)) return;
    this.#prune();
    const card = this.#cards.get(reaction.targetGuid);
    if (card === undefined || card.chatId !== row.chatId) return;
    const answer: ChannelApprovalAnswer = {
      approvalId: card.approvalId,
      answerToken: card.answerToken,
      decision,
      senderId: canonicalHandle(row.sender.handle),
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
    for (const [guid, card] of this.#cards) if (card.expiresAt < cutoff) this.#cards.delete(guid);
    this.#awaiting = this.#awaiting.filter((e) => e.card.expiresAt >= cutoff);
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  #requireNode(): NodeClient {
    const node = this.#node();
    if (node === undefined) {
      throw new PsycheError("unavailable", "no Mac with Messages is connected", {
        retryable: true,
      });
    }
    return node;
  }

  /** The recipient a target resolves to: a known chat guid, or a 1:1 peer's bare handle. */
  #resolve(target: string): string {
    if (isBareHandle(target)) {
      const handle = canonicalHandle(target);
      return this.#dmChats.get(handle) ?? handle;
    }
    if (!this.#chats.has(target)) {
      throw new PsycheError("forbidden", "iMessage sends go only to conversations Psyche is in");
    }
    return target;
  }

  async #deliver(
    target: string,
    text: string,
    purpose: IMessageSendPurpose,
    card?: PendingCard,
  ): Promise<SendResult> {
    if (text.trim() === "") throw new PsycheError("invalid_params", "empty message");
    if (text.length > IMESSAGE_MAX_MESSAGE_CHARS) {
      throw new PsycheError("invalid_params", "message too long", {
        details: { max: IMESSAGE_MAX_MESSAGE_CHARS, length: text.length },
      });
    }
    const node = this.#requireNode();
    const recipient = this.#resolve(target);
    const bodySha256 = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
    const binding = bindingFor("message_send", {
      channel: "imessage",
      account: this.account,
      recipient,
      bodySha256,
    });
    const approvalId = await this.#authorize({
      channel: "imessage",
      account: this.account,
      recipient,
      bodySha256,
      bindingHash: binding.bindingHash,
      grantKey: binding.grantKey,
      purpose,
    });
    const params: MessagesSendParams = isBareHandle(recipient)
      ? { to: recipient, text, service: "imessage" }
      : { chatId: recipient, text };
    // Registered before the send: the helper's watcher may report the echo before it returns.
    const echo = card === undefined ? undefined : { recipient, text, card };
    if (echo !== undefined) this.#awaiting.push(echo);
    const res = await node.invoke("messages.send", params, {
      approvalId,
      timeoutMs: SEND_TIMEOUT_MS,
    });
    if (!res.ok) {
      if (echo !== undefined) this.#awaiting = this.#awaiting.filter((e) => e !== echo);
      throw nodeError(res.error, "messages.send failed");
    }
    this.#sent++;
    return { messageId: `imessage-out-${this.#sent}` };
  }
}

function sameConversation(recipient: string, chatId: string): boolean {
  return recipient === chatId || (isBareHandle(recipient) && dmPeer(chatId) === recipient);
}

function nodeError(error: ErrorPayload | undefined, fallback: string): PsycheError {
  if (error === undefined) return new PsycheError("unavailable", fallback, { retryable: true });
  if (/full_disk_access/.test(error.message)) {
    return new PsycheError("forbidden", FULL_DISK_ACCESS_DETAIL);
  }
  return new PsycheError(error.code, error.message, {
    retryable: error.retryable ?? error.code === "unavailable",
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}
