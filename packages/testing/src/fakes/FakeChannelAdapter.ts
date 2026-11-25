import type {
  ApprovalRequest,
  ChannelAdapter,
  ChannelApprovalAck,
  ChannelApprovalAnswer,
  ChannelAttachment,
  ChannelCapabilities,
  ChannelHealth,
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
  Unsubscribe,
} from "@psyche/protocol";
import { captureModelVisible } from "../capture.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";
import { fail } from "./errors.ts";

export interface SentRecord {
  kind: "message" | "approval_buttons" | "pairing_code" | "typing";
  chatId: string;
  text: string;
  messageId: string;
  approvalId?: string;
  answerToken?: string;
  attachments?: ChannelAttachment[];
  format?: "plain" | "markdown";
}

/**
 * Loopback channel. Tests push inbound traffic with `receive(...)` and button presses with
 * `press(...)`; everything the adapter would send is recorded in `sent`. Refuses approval
 * buttons for `deviceOnly` requests, like every real adapter must.
 */
export class FakeChannelAdapter implements ChannelAdapter {
  readonly type: ChannelType;
  readonly account: string;
  readonly sent: SentRecord[] = [];
  /** Bytes served by `fetchAttachment`, keyed by attachment `ref`. */
  readonly files = new Map<string, Uint8Array>();
  started = false;
  healthy = true;
  #caps: ChannelCapabilities;
  #ids: IdGenerator;
  #inbound = new Set<(m: InboundMessage) => void | Promise<void>>();
  #answers = new Set<
    (
      a: ChannelApprovalAnswer,
    ) => void | ChannelApprovalAck | undefined | Promise<undefined | ChannelApprovalAck>
  >();
  /** Cards edited by `retireApproval` (only when constructed with `canEdit`). */
  readonly edits: { chatId: string; messageId: string; text: string; approvalId: string }[] = [];
  retireApproval?: (
    chatId: string,
    messageId: string,
    text: string,
    approvalId: string,
  ) => Promise<void>;
  /** The acks the handlers returned to each `press`, in order. */
  readonly acks: (ChannelApprovalAck | undefined)[] = [];

  constructor(
    options: {
      type?: ChannelType;
      account?: string;
      capabilities?: Partial<ChannelCapabilities>;
      ids?: IdGenerator;
      /** Edits cards when they are settled (Telegram, Slack, Discord); off: follow-ups only. */
      canEdit?: boolean;
    } = {},
  ) {
    this.type = options.type ?? "telegram";
    this.account = options.account ?? "fake-bot";
    this.#ids = options.ids ?? createIdGenerator();
    if (options.canEdit === true) {
      this.retireApproval = async (chatId, messageId, text, approvalId) => {
        this.edits.push({ chatId, messageId, text, approvalId });
      };
    }
    this.#caps = {
      buttons: true,
      polls: false,
      reactions: true,
      voiceNotes: true,
      attachments: true,
      groups: true,
      maxMessageChars: 4096,
      typing: true,
      markdown: false,
      ...options.capabilities,
    };
  }

  capabilities(): ChannelCapabilities {
    return { ...this.#caps };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  onInbound(handler: (message: InboundMessage) => void | Promise<void>): Unsubscribe {
    this.#inbound.add(handler);
    return () => this.#inbound.delete(handler);
  }

  onApprovalAnswer(
    handler: (
      answer: ChannelApprovalAnswer,
    ) => void | ChannelApprovalAck | undefined | Promise<undefined | ChannelApprovalAck>,
  ): Unsubscribe {
    this.#answers.add(handler);
    return () => this.#answers.delete(handler);
  }

  /** Deliver an inbound message to every handler (awaits them). */
  async receive(
    message: Partial<InboundMessage> & { text: string; senderId: string },
  ): Promise<void> {
    if (!this.started) fail("unavailable", "channel not started");
    const full: InboundMessage = {
      channel: this.type,
      account: this.account,
      messageId: this.#ids.next("in"),
      chatId: message.senderId,
      isGroup: false,
      receivedAt: 0,
      ...message,
    };
    for (const h of this.#inbound) await h(full);
  }

  /** Simulate a button press on an approval card. */
  async press(answer: ChannelApprovalAnswer): Promise<void> {
    for (const h of this.#answers) {
      const ack = await h(answer);
      this.acks.push(ack === undefined ? undefined : (ack as ChannelApprovalAck));
    }
  }

  #record(rec: Omit<SentRecord, "messageId">): SendResult {
    if (!this.started) fail("unavailable", "channel not started");
    const messageId = this.#ids.next("out");
    this.sent.push({ ...rec, messageId });
    return { messageId };
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const max = this.#caps.maxMessageChars;
    if (max !== undefined && message.text.length > max) fail("invalid_params", "message too long");
    captureModelVisible("transcript", message, { where: `FakeChannelAdapter(${this.type}).send` });
    return this.#record({
      kind: "message",
      chatId: message.chatId,
      text: message.text,
      ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
      ...(message.format === undefined ? {} : { format: message.format }),
    });
  }

  async sendApprovalButtons(
    chatId: string,
    approval: ApprovalRequest,
    answerToken: string,
  ): Promise<SendResult> {
    if (approval.deviceOnly)
      return fail("forbidden", "deviceOnly approvals are never sent to chat");
    if (!this.#caps.buttons) return fail("not_implemented", "channel has no buttons");
    return this.#record({
      kind: "approval_buttons",
      chatId,
      text: approval.summary,
      approvalId: approval.id,
      answerToken,
    });
  }

  async sendPairingCode(chatId: string, code: string): Promise<SendResult> {
    return this.#record({ kind: "pairing_code", chatId, text: code });
  }

  async sendTyping(chatId: string, action: "typing" | "recording_voice" = "typing"): Promise<void> {
    if (this.#caps.typing === false) fail("not_implemented", "channel has no typing indicator");
    this.#record({ kind: "typing", chatId, text: action });
  }

  async fetchAttachment(ref: string): Promise<Uint8Array> {
    const data = this.files.get(ref);
    return data ?? fail("not_found", `no attachment ${ref}`);
  }

  async health(): Promise<ChannelHealth> {
    return this.healthy && this.started
      ? { ok: true }
      : { ok: false, detail: this.started ? "unhealthy" : "stopped" };
  }
}
