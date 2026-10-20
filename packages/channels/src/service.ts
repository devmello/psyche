import { randomUUID } from "node:crypto";
import {
  type Channel,
  type ChannelAdapter,
  type ChannelApprovalAnswer,
  type ChannelAttachment,
  type ChannelIdentity,
  type Clock,
  type InboundMessage,
  type IssuedApproval,
  type Notifier,
  type PairingRequest,
  type PermissionBroker,
  PsycheError,
  type SendResult,
  type SpeechEngine,
  type TaintSource,
  type Unsubscribe,
} from "@psyche/protocol";
import { ChatApprovals, type DeliveryReport } from "./approvals.ts";
import { type BUILTIN_COMMANDS, parseApprovalCommand, parseCommand } from "./commands.ts";
import { chunkMessage } from "./format/chunk.ts";
import { renderMarkdown } from "./format/markdown.ts";
import { sanitizeValue } from "./format/sanitize.ts";
import { assertDisjointLinks, IdentityDirectory } from "./identity.ts";
import { PairingService } from "./pairing.ts";
import { authorizeInbound, mayRunCommands, senderRef } from "./policy.ts";
import type { ChannelLogger, EmitEvent, InboundPart, InboundSink, LibraryIngest } from "./ports.ts";
import { backoffDelay, RateLimiter, realSleep, type Sleep } from "./ratelimit.ts";
import type { RouteContext } from "./routing.ts";
import { channelSettings, isWeakTransport, validateChannel } from "./settings.ts";
import type { ChannelStore } from "./store/types.ts";
import { INBOUND_VOICE_FORMAT, type VoiceNotes } from "./voice.ts";

/**
 * The channel framework (feature N1–N4, N10, N11; architecture §4.10). Owns adapters, runs the
 * inbound pipeline (authorize → pair / command / route → sink), formats, chunks and rate-limits
 * outbound sends, delivers approvals to the owner's chats, and supervises adapters with
 * reconnect backoff. The Gateway (S01) constructs one, attaches adapters, and mounts
 * `createChannelsApi(service)` for the `channels.*` methods.
 */

export interface ChannelServiceOptions {
  store: ChannelStore;
  broker: PermissionBroker;
  sink: InboundSink;
  clock?: Clock;
  sleep?: Sleep;
  emit?: EmitEvent;
  notifier?: Notifier;
  speech?: SpeechEngine;
  voice?: VoiceNotes;
  library?: LibraryIngest;
  logger?: ChannelLogger;
  /** `commands.ownerAllowFrom` (qualified ids, `telegram:123`). */
  ownerAllowFrom?: string[];
  newId?: () => string;
  /** Jitter source for reconnect backoff. */
  random?: () => number;
  pairingRandom?: (max: number) => number;
  /**
   * Every inbound message the channel's policy accepted (`deliver`, with its route) or answers
   * with a pairing code (`pair`). The Gateway feeds the broker's channel reply authority with it.
   */
  onInboundDecision?: (event: InboundDecisionEvent) => void;
  /**
   * The owner approved or denied a pairing request, before the sender is told. The Gateway moves
   * that DM from "pairing code only" to "answerable" in the broker's channel reply authority, so
   * the "You're approved" confirmation is a reply to a now-routed sender (issue #277).
   */
  onPairingDecided?: (event: PairingDecidedEvent) => void;
  /**
   * Admission control before any policy runs (security §10: inbound chat 30/minute/sender).
   * `false` drops the message silently; the Gateway counts and audits it.
   */
  admitInbound?: (channel: Channel, message: InboundMessage) => boolean;
}

export interface InboundDecisionEvent {
  channel: Channel;
  message: InboundMessage;
  action: "deliver" | "pair";
  route?: RouteContext;
}

export interface PairingDecidedEvent {
  channel: Channel;
  senderId: string;
  decision: "approved" | "denied";
}

export interface OutboundTarget {
  channelId: string;
  chatId: string;
  replyToMessageId?: string;
}

interface Attached {
  adapter: ChannelAdapter;
  unsubscribe: Unsubscribe[];
  abort?: AbortController;
  running: boolean;
}

const MAX_SEND_RETRIES = 3;

export class ChannelService {
  readonly pairing: PairingService;
  readonly approvals: ChatApprovals;
  #store: ChannelStore;
  #sink: InboundSink;
  #clock: Clock;
  #sleep: Sleep;
  #emit: EmitEvent;
  #notifier: Notifier | undefined;
  #speech: SpeechEngine | undefined;
  #voice: VoiceNotes | undefined;
  #library: LibraryIngest | undefined;
  #logger: ChannelLogger;
  #newId: () => string;
  #random: () => number;
  #limiter: RateLimiter;
  #identities = new IdentityDirectory();
  #ownerAllowFrom: string[];
  #onInboundDecision: ((event: InboundDecisionEvent) => void) | undefined;
  #onPairingDecided: ((event: PairingDecidedEvent) => void) | undefined;
  #admitInbound: ((channel: Channel, message: InboundMessage) => boolean) | undefined;
  #channels = new Map<string, Channel>();
  #attached = new Map<string, Attached>();

  constructor(options: ChannelServiceOptions) {
    this.#store = options.store;
    this.#sink = options.sink;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#sleep = options.sleep ?? realSleep;
    this.#emit = options.emit ?? (() => {});
    this.#notifier = options.notifier;
    this.#speech = options.speech;
    this.#voice = options.voice;
    this.#library = options.library;
    this.#logger = options.logger ?? { warn: () => {} };
    this.#newId = options.newId ?? (() => randomUUID());
    this.#random = options.random ?? Math.random;
    this.#ownerAllowFrom = options.ownerAllowFrom ?? [];
    this.#onInboundDecision = options.onInboundDecision;
    this.#onPairingDecided = options.onPairingDecided;
    this.#admitInbound = options.admitInbound;
    this.#limiter = new RateLimiter({ clock: this.#clock, sleep: this.#sleep });
    this.pairing = new PairingService({
      store: options.store,
      clock: this.#clock,
      ...(options.pairingRandom === undefined ? {} : { random: options.pairingRandom }),
    });
    this.approvals = new ChatApprovals({
      broker: options.broker,
      host: {
        channelsOfType: (type) =>
          [...this.#attached.entries()].flatMap(([id, a]) => {
            const channel = this.#channels.get(id);
            return channel !== undefined && channel.type === type && channel.status !== "paused"
              ? [{ channel, adapter: a.adapter }]
              : [];
          }),
        isOwner: (channel, senderId) =>
          this.#identities.isOwner(
            { type: channel.type, senderId, strong: !isWeakTransport(channel.type) },
            channel.ownerIds,
          ),
        sendText: async (channel, chatId, text) => {
          await this.send({ channelId: channel.id, chatId }, text, { format: "plain" });
        },
        now: () => this.#clock.now(),
      },
    });
  }

  // --- configuration -----------------------------------------------------------------------

  /** Loads channels and identities from the store. Call once before attaching adapters. */
  async init(): Promise<void> {
    for (const channel of await this.#store.listChannels()) this.#channels.set(channel.id, channel);
    await this.#reloadIdentities();
  }

  async #reloadIdentities(): Promise<void> {
    this.#identities.replace(await this.#store.listIdentities(), this.#ownerAllowFrom);
  }

  /** `commands.ownerAllowFrom` changed (settings are S01's). */
  setOwnerAllowFrom(list: string[]): void {
    this.#ownerAllowFrom = [...list];
    this.#identities.replace(this.#identities.list(), this.#ownerAllowFrom);
  }

  listChannels(): Channel[] {
    return [...this.#channels.values()].map((c) => structuredClone(c));
  }

  getChannel(channelId: string): Channel {
    const channel = this.#channels.get(channelId);
    if (channel === undefined) throw new PsycheError("not_found", `channel ${channelId} not found`);
    return structuredClone(channel);
  }

  /** Validates and persists a channel (create or replace). */
  async saveChannel(channel: Channel): Promise<Channel> {
    const problems = validateChannel(channel);
    if (problems.length > 0) {
      throw new PsycheError("invalid_params", problems.join("; "), { details: { problems } });
    }
    for (const other of this.#channels.values()) {
      if (
        other.id !== channel.id &&
        other.type === channel.type &&
        other.account === channel.account
      ) {
        throw new PsycheError(
          "conflict",
          `channel ${channel.type}:${channel.account} already exists`,
        );
      }
    }
    const saved = await this.#store.saveChannel(channel);
    this.#channels.set(saved.id, saved);
    this.#emit("channels.updated", { channel: saved });
    return structuredClone(saved);
  }

  newChannel(type: Channel["type"], account: string): Channel {
    const now = new Date(this.#clock.now()).toISOString();
    return {
      id: this.#newId(),
      type,
      account,
      dmPolicy: "pairing",
      allowFrom: [],
      groupAllowFrom: [],
      requireMention: true,
      ownerIds: [],
      dmScope: "per-channel-peer",
      nodeId: null,
      status: "active",
      config: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  listIdentities(): ChannelIdentity[] {
    return this.#identities.list();
  }

  async saveIdentity(identity: ChannelIdentity): Promise<ChannelIdentity> {
    const next = [...this.#identities.list().filter((i) => i.id !== identity.id), identity];
    assertDisjointLinks(next);
    const saved = await this.#store.saveIdentity(identity);
    await this.#reloadIdentities();
    return saved;
  }

  async deleteIdentity(identityId: string): Promise<void> {
    if (!(await this.#store.deleteIdentity(identityId))) {
      throw new PsycheError("not_found", `identity ${identityId} not found`);
    }
    await this.#reloadIdentities();
  }

  /** Surfaces (`<channel>:<peerId>`) where the owner can receive approval cards. */
  ownerSurfaces(): string[] {
    const out = new Set<string>();
    for (const [id] of this.#attached) {
      const channel = this.#channels.get(id);
      // WebChat clients answer on the device approval card (operator.approvals), not in chat.
      if (channel === undefined || channel.status === "paused" || channel.type === "webchat") {
        continue;
      }
      for (const ownerId of channel.ownerIds) out.add(`${channel.type}:${ownerId}`);
      for (const q of this.#ownerAllowFrom) {
        if (q.startsWith(`${channel.type}:`)) out.add(q);
      }
    }
    return [...out];
  }

  // --- pairing -------------------------------------------------------------------------------

  async listPairings(filter: { channelId?: string; status?: PairingRequest["status"] } = {}) {
    await this.pairing.expire();
    return this.#store.listPairings(filter);
  }

  async #findPairing(ref: { requestId?: string; channelId?: string; code?: string }) {
    if (ref.requestId !== undefined) {
      const found = await this.#store.getPairing(ref.requestId);
      if (found === undefined || found.kind !== "channel-sender") {
        throw new PsycheError("not_found", `pairing request ${ref.requestId} not found`);
      }
      return found;
    }
    if (ref.channelId !== undefined && ref.code !== undefined) {
      const found = await this.pairing.findByCode(ref.channelId, ref.code);
      if (found === undefined)
        throw new PsycheError("not_found", "no pending request with that code");
      return found;
    }
    throw new PsycheError("invalid_params", "pass requestId, or channelId and code");
  }

  /** Approves a pairing request: the sender joins `allowFrom` and is told so. */
  async approvePairing(
    ref: { requestId?: string; channelId?: string; code?: string },
    decidedByDeviceId: string | null,
  ): Promise<PairingRequest> {
    const request = await this.#findPairing(ref);
    const decided = await this.pairing.decide(request.id, "approved", decidedByDeviceId);
    const channelId = decided.channelId ?? "";
    const channel = this.#channels.get(channelId);
    const senderId = decided.senderId ?? undefined;
    if (channel !== undefined && senderId !== undefined) {
      if (!channel.allowFrom.includes(senderId)) {
        await this.saveChannel({
          ...channel,
          allowFrom: [...channel.allowFrom, senderId],
          updatedAt: new Date(this.#clock.now()).toISOString(),
        });
      }
      this.#pairingDecided(channel, senderId, "approved");
      await this.send({ channelId, chatId: senderId }, "You're approved. Say hi!", {
        format: "plain",
      }).catch((error: unknown) => this.#logger.warn("pairing.notify_failed", errorData(error)));
    }
    return decided;
  }

  async denyPairing(
    ref: { requestId?: string; channelId?: string; code?: string },
    decidedByDeviceId: string | null,
  ): Promise<PairingRequest> {
    const request = await this.#findPairing(ref);
    const decided = await this.pairing.decide(request.id, "denied", decidedByDeviceId);
    const channel = this.#channels.get(decided.channelId ?? "");
    if (channel !== undefined && decided.senderId != null) {
      this.#pairingDecided(channel, decided.senderId, "denied");
    }
    return decided;
  }

  #pairingDecided(channel: Channel, senderId: string, decision: "approved" | "denied"): void {
    try {
      this.#onPairingDecided?.({ channel, senderId, decision });
    } catch (error) {
      this.#logger.warn("channel.pairing_decision_hook_failed", errorData(error));
    }
  }

  // --- adapters ------------------------------------------------------------------------------

  /** Binds an adapter to its configured channel (matched on type + account). */
  attach(adapter: ChannelAdapter): Channel {
    const channel = [...this.#channels.values()].find(
      (c) => c.type === adapter.type && c.account === adapter.account,
    );
    if (channel === undefined) {
      throw new PsycheError(
        "not_found",
        `no channel configured for ${adapter.type}:${adapter.account}`,
      );
    }
    if (this.#attached.has(channel.id)) {
      throw new PsycheError("conflict", `channel ${channel.id} already has an adapter`);
    }
    const unsubscribe = [adapter.onInbound((message) => this.handleInbound(channel.id, message))];
    if (adapter.onApprovalAnswer !== undefined) {
      unsubscribe.push(
        adapter.onApprovalAnswer((answer) => this.#handleApprovalAnswer(channel.id, answer)),
      );
    }
    this.#attached.set(channel.id, { adapter, unsubscribe, running: false });
    return structuredClone(channel);
  }

  async detach(channelId: string): Promise<void> {
    const attached = this.#attached.get(channelId);
    if (attached === undefined) return;
    await this.stop(channelId);
    for (const u of attached.unsubscribe) u();
    this.#attached.delete(channelId);
  }

  async #setStatus(channelId: string, status: Channel["status"], detail?: string): Promise<void> {
    const channel = this.#channels.get(channelId);
    if (channel === undefined || channel.status === status || channel.status === "paused") return;
    const next = { ...channel, status, updatedAt: new Date(this.#clock.now()).toISOString() };
    const saved = await this.#store.saveChannel(next);
    this.#channels.set(channelId, saved);
    this.#emit("channels.updated", { channel: saved, ...(detail === undefined ? {} : { detail }) });
  }

  /**
   * Starts an adapter, retrying with exponential backoff until it starts or `stop` is called.
   * Resolves once started (or stopped). Paused channels are not started.
   */
  async start(channelId: string): Promise<void> {
    const attached = this.#attached.get(channelId);
    const channel = this.#channels.get(channelId);
    if (attached === undefined || channel === undefined) {
      throw new PsycheError("not_found", `channel ${channelId} has no adapter`);
    }
    if (channel.status === "paused" || attached.running) return;
    const abort = new AbortController();
    attached.abort = abort;
    for (let attempt = 0; !abort.signal.aborted; attempt++) {
      try {
        await attached.adapter.start(abort.signal);
        attached.running = true;
        await this.#setStatus(channelId, "active");
        return;
      } catch (error) {
        this.#logger.warn("channel.start_failed", { channelId, attempt, ...errorData(error) });
        await this.#setStatus(channelId, "error", errorMessage(error));
        try {
          await this.#sleep(backoffDelay(attempt, { random: this.#random }), abort.signal);
        } catch {
          return;
        }
      }
    }
  }

  async startAll(): Promise<void> {
    await Promise.all([...this.#attached.keys()].map((id) => this.start(id)));
  }

  async stop(channelId: string): Promise<void> {
    const attached = this.#attached.get(channelId);
    if (attached === undefined) return;
    attached.abort?.abort(new PsycheError("cancelled", "channel stopped"));
    if (attached.running) {
      attached.running = false;
      await attached.adapter.stop();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#attached.keys()].map((id) => this.stop(id)));
  }

  /**
   * Polls adapter health; an unhealthy adapter is marked `disconnected` and restarted with
   * backoff; resolves when the restarts finish. The Gateway calls this on a timer.
   */
  async checkHealth(): Promise<void> {
    const restarts: Promise<void>[] = [];
    for (const [channelId, attached] of this.#attached) {
      if (!attached.running || attached.adapter.health === undefined) continue;
      const health = await attached.adapter.health().catch((error: unknown) => ({
        ok: false,
        detail: errorMessage(error),
      }));
      if (health.ok) continue;
      await this.#setStatus(channelId, "disconnected", health.detail);
      await this.stop(channelId);
      restarts.push(this.start(channelId));
    }
    await Promise.all(restarts);
  }

  #adapterFor(channelId: string): { channel: Channel; adapter: ChannelAdapter } {
    const channel = this.#channels.get(channelId);
    const attached = this.#attached.get(channelId);
    if (channel === undefined || attached === undefined) {
      throw new PsycheError("not_found", `channel ${channelId} has no adapter`);
    }
    return { channel, adapter: attached.adapter };
  }

  // --- outbound ------------------------------------------------------------------------------

  /**
   * Sends text: Markdown is rendered by adapters that support it and flattened to plain text for
   * the rest, then chunked to the channel limit and rate-limited per channel and per chat.
   * `rate_limited` errors are retried after the transport's `retryAfterSec`.
   */
  async send(
    target: OutboundTarget,
    text: string,
    options: {
      format?: "plain" | "markdown";
      attachments?: ChannelAttachment[];
      signal?: AbortSignal;
    } = {},
  ): Promise<SendResult[]> {
    const { channel, adapter } = this.#adapterFor(target.channelId);
    const caps = adapter.capabilities();
    const settings = channelSettings(channel);
    let format = options.format ?? "markdown";
    let body = text;
    if (format === "markdown" && caps.markdown !== true) {
      body = renderMarkdown(text, "plain");
      format = "plain";
    }
    const limit = caps.maxMessageChars ?? 4000;
    const flavor = format === "markdown" && channel.type === "telegram" ? "telegram-html" : "plain";
    const chunks = chunkMessage(body, limit, { format, flavor });
    const results: SendResult[] = [];
    const attachments = options.attachments ?? [];
    const pieces = chunks.length === 0 && attachments.length > 0 ? [""] : chunks;
    for (const [i, chunk] of pieces.entries()) {
      const last = i === pieces.length - 1;
      await this.#limiter.take(
        [
          {
            key: `channel:${channel.id}`,
            ratePerSec: settings.rateLimit.perChannelPerSec,
            burst: settings.rateLimit.burst,
          },
          {
            key: `chat:${channel.id}:${target.chatId}`,
            ratePerSec: settings.rateLimit.perChatPerSec,
            burst: settings.rateLimit.burst,
          },
        ],
        options.signal,
      );
      results.push(
        await this.#withRetry(
          () =>
            adapter.send({
              chatId: target.chatId,
              text: chunk,
              format,
              ...(i === 0 && target.replyToMessageId !== undefined
                ? { replyToMessageId: target.replyToMessageId }
                : {}),
              ...(last && attachments.length > 0 ? { attachments } : {}),
            }),
          options.signal,
        ),
      );
    }
    return results;
  }

  async #withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (
          !(error instanceof PsycheError) ||
          error.code !== "rate_limited" ||
          attempt >= MAX_SEND_RETRIES
        ) {
          throw error;
        }
        const retryAfter = (error.details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
        await this.#sleep(
          typeof retryAfter === "number"
            ? retryAfter * 1000
            : backoffDelay(attempt, { random: this.#random }),
          signal,
        );
      }
    }
  }

  /** Typing indicator, best effort. */
  async typing(
    target: OutboundTarget,
    action: "typing" | "recording_voice" = "typing",
  ): Promise<void> {
    const { adapter } = this.#adapterFor(target.channelId);
    if (adapter.sendTyping === undefined || adapter.capabilities().typing === false) return;
    await adapter.sendTyping(target.chatId, action).catch(() => undefined);
  }

  /** Speaks `text` as a voice note in the channel's container (feature N11). */
  async sendVoice(target: OutboundTarget, text: string, caption = ""): Promise<SendResult[]> {
    const { channel, adapter } = this.#adapterFor(target.channelId);
    if (this.#voice === undefined || !adapter.capabilities().voiceNotes) {
      throw new PsycheError("not_implemented", "voice notes are not available on this channel");
    }
    await this.typing(target, "recording_voice");
    const attachment = await this.#voice.attachmentFor(text, channel.type);
    return this.send(target, caption, { format: "plain", attachments: [attachment] });
  }

  /** Delivers an issued (or re-issued) approval to the owner's chats. */
  deliverApproval(issued: IssuedApproval): Promise<DeliveryReport[]> {
    return this.approvals.deliver(issued);
  }

  // --- inbound -------------------------------------------------------------------------------

  async #handleApprovalAnswer(channelId: string, answer: ChannelApprovalAnswer): Promise<void> {
    const channel = this.#channels.get(channelId);
    if (channel === undefined) return;
    await this.approvals.answerFromButton(channel, answer);
  }

  /** The inbound pipeline; adapters call it through `onInbound`. */
  async handleInbound(channelId: string, message: InboundMessage): Promise<void> {
    const channel = this.#channels.get(channelId);
    const attached = this.#attached.get(channelId);
    if (channel === undefined || attached === undefined) return;
    // Before authorization: unknown senders flooding pairing requests count too.
    if (this.#admitInbound?.(channel, message) === false) {
      this.#logger.info?.("channel.inbound_rate_limited", { channelId });
      return;
    }
    const decision = authorizeInbound(channel, message, this.#identities);
    if (decision.action === "drop") {
      this.#logger.info?.("channel.inbound_dropped", { channelId, reason: decision.reason });
      return;
    }
    try {
      this.#onInboundDecision?.(
        decision.action === "pair"
          ? { channel, message, action: "pair" }
          : { channel, message, action: "deliver", route: decision.route },
      );
    } catch (error) {
      this.#logger.warn("channel.inbound_decision_hook_failed", errorData(error));
    }
    if (decision.action === "pair") {
      await this.#pair(channel, attached.adapter, message);
      return;
    }
    const { route } = decision;
    // Forwarded or edited text is never a command (design-22): only words the sender typed.
    const command =
      message.forwardedFrom === undefined && message.editOf === undefined
        ? parseCommand(message.text, attached.adapter.account)
        : undefined;
    if (command !== undefined) {
      await this.#command(channel, route, message, command);
      return;
    }
    const { parts, attachments, taintSources } = await this.#collect(
      channel,
      attached.adapter,
      route,
      message,
    );
    if (message.editOf !== undefined) {
      await this.#sink.deliver({ kind: "edit", route, message, parts, attachments, taintSources });
      return;
    }
    if (parts.length === 0 && attachments.length === 0) return;
    await this.typing({ channelId, chatId: message.chatId });
    await this.#sink.deliver({
      kind: "message",
      route,
      message,
      parts,
      attachments,
      taintSources,
    });
  }

  async #pair(channel: Channel, adapter: ChannelAdapter, message: InboundMessage): Promise<void> {
    if (adapter.sendPairingCode === undefined) return;
    const display = sanitizeValue(message.senderName ?? message.senderId).slice(0, 120);
    const outcome = await this.pairing.request(channel.id, message.senderId, display);
    if (outcome.kind === "capped") {
      this.#logger.info?.("pairing.capped", { channelId: channel.id });
      return;
    }
    if (outcome.kind === "existing" && !outcome.resend) return;
    const { request } = outcome;
    await adapter.sendPairingCode(message.chatId, request.code, Date.parse(request.expiresAt));
    if (outcome.kind === "created") {
      this.#emit("pairing.requested", { pairingRequest: request });
      await this.#notifier
        ?.notify({
          kind: "system",
          title: "New chat pairing request",
          body: `${channel.type} sender ${display} (${sanitizeValue(message.senderId)}) wants to talk to Psyche.`,
          route: `/settings/channels/${channel.id}`,
          dedupeKey: `pairing:${request.id}`,
        })
        .catch((error: unknown) => this.#logger.warn("pairing.notify_failed", errorData(error)));
    }
  }

  async #command(
    channel: Channel,
    route: RouteContext,
    message: InboundMessage,
    command: NonNullable<ReturnType<typeof parseCommand>>,
  ): Promise<void> {
    const reply = (text: string) =>
      this.send({ channelId: channel.id, chatId: message.chatId }, text, { format: "plain" });
    if (!mayRunCommands(channel, message, this.#identities)) {
      if (channelSettings(channel).replyToUnauthorizedCommands) {
        await reply("Commands are only available to the owner.");
      }
      return;
    }
    switch (command.name as (typeof BUILTIN_COMMANDS)[number] | string) {
      case "approve":
      case "deny": {
        const parsed = parseApprovalCommand(command);
        if (!parsed.ok) {
          await reply(parsed.usage);
          return;
        }
        await this.approvals.answerFromCommand(
          channel,
          message.chatId,
          message.senderId,
          parsed.ref,
          parsed.decision,
        );
        return;
      }
      case "whoami":
        await reply(`Your ${channel.type} id is ${sanitizeValue(message.senderId)}.`);
        return;
      case "help":
        await reply(
          "Commands: /approve <ref> approve|deny, /new (fresh session), /stop (cancel the running task), /status, /whoami.",
        );
        return;
      default:
        await this.#sink.deliver({
          kind: "command",
          route,
          message,
          parts: [{ text: command.raw, provenance: route.provenance }],
          attachments: [],
          command,
        });
    }
  }

  /** Builds provenance-tagged parts: quoted context, own / forwarded text, voice, attachments. */
  async #collect(
    channel: Channel,
    adapter: ChannelAdapter,
    route: RouteContext,
    message: InboundMessage,
  ): Promise<{
    parts: InboundPart[];
    attachments: { libraryItemId: string }[];
    taintSources: TaintSource[];
  }> {
    const settings = channelSettings(channel);
    const parts: InboundPart[] = [];
    const attachments: { libraryItemId: string }[] = [];
    const forwarded = message.forwardedFrom !== undefined;
    const ownProvenance = forwarded ? "untrusted" : route.provenance;
    // One source per kind and author (security §3.6: `{sourceKind, origin or sender}`).
    const taintSources: TaintSource[] = [];
    const origin = `${channel.type}:${message.chatId}`;
    const taint = (sourceKind: string, sender: string | undefined) => {
      if (taintSources.some((t) => t.sourceKind === sourceKind && t.sender === sender)) return;
      taintSources.push({ sourceKind, origin, ...(sender === undefined ? {} : { sender }) });
    };
    // The author of the message's own text, voice and attachments when they are untrusted.
    const ownTaint = () =>
      forwarded
        ? taint("channel_forwarded", message.forwardedFrom?.senderId)
        : taint("channel_message", message.senderId);

    const quoted = message.quoted;
    if (quoted !== undefined && quoted.text.trim() !== "") {
      if (quoted.fromSelf === true) {
        parts.push({ text: quoted.text, provenance: "agent", label: "quoted" });
      } else {
        const author =
          quoted.senderId === undefined
            ? undefined
            : { type: channel.type, senderId: quoted.senderId, strong: true };
        const authorIsOwner =
          author !== undefined && this.#identities.isOwner(author, channel.ownerIds);
        const authorAllowed =
          authorIsOwner ||
          (quoted.senderId !== undefined && channel.allowFrom.includes(quoted.senderId));
        if (settings.contextVisibility === "all" || authorAllowed) {
          parts.push({
            text: quoted.text,
            provenance: authorIsOwner ? "owner" : "untrusted",
            label: "quoted",
          });
          if (!authorIsOwner) taint("channel_quoted", quoted.senderId);
        }
      }
    }
    if (message.text.trim() !== "") {
      parts.push({
        text: message.text,
        provenance: ownProvenance,
        ...(forwarded ? { label: "forwarded" as const } : {}),
      });
      if (ownProvenance === "untrusted") ownTaint();
    }

    for (const attachment of message.attachments ?? []) {
      if (attachment.ref === undefined || adapter.fetchAttachment === undefined) continue;
      if (attachment.size > settings.maxAttachmentBytes) {
        parts.push({
          text: `[${attachment.kind ?? "file"} too large to receive]`,
          provenance: "system",
        });
        continue;
      }
      let data: Uint8Array;
      try {
        data = await adapter.fetchAttachment(attachment.ref);
      } catch (error) {
        this.#logger.warn("attachment.fetch_failed", {
          channelId: channel.id,
          ...errorData(error),
        });
        parts.push({ text: "[attachment could not be downloaded]", provenance: "system" });
        continue;
      }
      if (attachment.kind === "voice" && this.#speech !== undefined) {
        try {
          const transcript = await this.#speech.transcribeFile(data, INBOUND_VOICE_FORMAT);
          if (transcript.text.trim() !== "") {
            parts.push({ text: transcript.text, provenance: ownProvenance, label: "voice" });
            if (ownProvenance === "untrusted") ownTaint();
          }
        } catch (error) {
          this.#logger.warn("voice.transcribe_failed", {
            channelId: channel.id,
            ...errorData(error),
          });
          parts.push({ text: "[voice note could not be transcribed]", provenance: "system" });
        }
      }
      if (this.#library !== undefined) {
        const item = await this.#library.ingest({
          name: attachment.name,
          mime: attachment.mime,
          data,
          provenance: ownProvenance === "owner" ? "owner" : "untrusted",
          source: {
            channel: channel.type,
            channelId: channel.id,
            chatId: message.chatId,
            messageId: message.messageId,
          },
        });
        attachments.push(item);
        if (ownProvenance !== "owner") {
          taint(
            "channel_attachment",
            forwarded ? message.forwardedFrom?.senderId : message.senderId,
          );
        }
      }
    }
    return { parts, attachments, taintSources };
  }

  /** For tests and the Gateway: is this sender an owner on this channel? */
  isOwner(channelId: string, message: InboundMessage): boolean {
    const channel = this.getChannel(channelId);
    return this.#identities.isOwner(senderRef(channel, message), channel.ownerIds);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorData(error: unknown): Record<string, unknown> {
  return error instanceof PsycheError ? { code: error.code } : { error: errorMessage(error) };
}
