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

/**
 * WebChat (feature N3): the web UI as a channel for the owner on other devices. It is thin: the
 * Gateway's WS API authenticates the device (pairing, `operator.write`), then calls `receive`;
 * replies fan out to `onOutbound` listeners, which the Gateway turns into events for that
 * device. The sender is always the owner identity `owner` on a strong transport. Approvals are
 * not sent here as chat cards: paired web clients get the real approval card (`approvals.*`).
 */

export const WEBCHAT_OWNER_ID = "owner";

export interface WebChatOutbound extends OutboundMessage {
  messageId: string;
}

export class WebChatAdapter implements ChannelAdapter {
  readonly type = "webchat" as const;
  readonly account: string;
  #started = false;
  #seq = 0;
  #inbound = new Set<(m: InboundMessage) => void | Promise<void>>();
  #outbound = new Set<(m: WebChatOutbound) => void>();
  #clock: { now(): number };
  #lastEventAt: number | undefined;

  constructor(options: { account?: string; clock?: { now(): number } } = {}) {
    this.account = options.account ?? "web";
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  capabilities(): ChannelCapabilities {
    return {
      buttons: false,
      polls: false,
      reactions: false,
      voiceNotes: true,
      attachments: true,
      groups: false,
      maxMessageChars: 32_000,
      typing: true,
      markdown: true,
    };
  }

  async start(): Promise<void> {
    this.#started = true;
  }

  async stop(): Promise<void> {
    this.#started = false;
  }

  async health(): Promise<ChannelHealth> {
    return {
      ok: this.#started,
      ...(this.#lastEventAt === undefined ? {} : { lastEventAt: this.#lastEventAt }),
    };
  }

  onInbound(handler: (message: InboundMessage) => void | Promise<void>): Unsubscribe {
    this.#inbound.add(handler);
    return () => this.#inbound.delete(handler);
  }

  /** Gateway → listener for replies to web clients. */
  onOutbound(listener: (message: WebChatOutbound) => void): Unsubscribe {
    this.#outbound.add(listener);
    return () => this.#outbound.delete(listener);
  }

  /**
   * Called by the Gateway for a message typed in an authenticated web client. `deviceId` is the
   * paired device; it becomes the chat id so replies reach that device.
   */
  async receive(deviceId: string, text: string, messageId?: string): Promise<void> {
    if (!this.#started) throw new PsycheError("unavailable", "webchat channel not started");
    const now = this.#clock.now();
    this.#lastEventAt = now;
    const message: InboundMessage = {
      channel: "webchat",
      account: this.account,
      messageId: messageId ?? `web-in-${++this.#seq}`,
      chatId: deviceId,
      senderId: WEBCHAT_OWNER_ID,
      senderName: "Owner",
      isGroup: false,
      text,
      receivedAt: now,
      identityStrength: "strong",
    };
    for (const h of this.#inbound) await h(message);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.#started) throw new PsycheError("unavailable", "webchat channel not started");
    const messageId = `web-out-${++this.#seq}`;
    for (const l of this.#outbound) l({ ...message, messageId });
    return { messageId };
  }

  async sendTyping(chatId: string): Promise<void> {
    for (const l of this.#outbound) l({ chatId, text: "", messageId: "typing" });
  }
}

/** A WebChat channel row: owner-only, allowlist policy, owner in `main`. */
export function webChatChannelDefaults(): {
  dmPolicy: "allowlist";
  allowFrom: string[];
  ownerIds: string[];
  dmScope: "main";
} {
  return {
    dmPolicy: "allowlist",
    allowFrom: [WEBCHAT_OWNER_ID],
    ownerIds: [WEBCHAT_OWNER_ID],
    dmScope: "main",
  };
}
