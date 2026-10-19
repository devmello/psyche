import type { ChannelType } from "../schemas/integrations.ts";
import type { ApprovalRequest } from "../schemas/permissions.ts";
import type { Unsubscribe } from "./Clock.ts";

/**
 * Channel adapter contract (architecture §4.10; security §9; owner S10). Inbound messages from
 * anyone but the owner are `untrusted`. Approval buttons may be sent only for requests that
 * are not `deviceOnly`; adapters throw `forbidden` otherwise.
 */

export interface ChannelCapabilities {
  buttons: boolean;
  polls: boolean;
  reactions: boolean;
  voiceNotes: boolean;
  attachments: boolean;
  groups: boolean;
  maxMessageChars?: number;
  /** Typing / recording indicators (`sendTyping`). */
  typing?: boolean;
  /** Rich text the adapter renders from Markdown; absent means plain text only. */
  markdown?: boolean;
}

export type ChannelAttachmentKind = "image" | "voice" | "audio" | "video" | "file";

export interface ChannelAttachment {
  name: string;
  mime: string;
  size: number;
  /** Library item once ingested. */
  libraryItemId?: string;
  /** `voice` = a voice note (sent as one, transcribed on receipt). Default `file`. */
  kind?: ChannelAttachmentKind;
  /** Inbound: adapter-opaque handle for `fetchAttachment` (never a URL carrying credentials). */
  ref?: string;
  durationMs?: number;
  /** Outbound, in-process only: the bytes to send. */
  data?: Uint8Array;
}

/** Original author of forwarded content (review design-22: it is not the sender). */
export interface ForwardedFrom {
  senderId?: string;
  senderName?: string;
}

/** The message this one quotes or replies to; context only, never an instruction. */
export interface QuotedMessage {
  text: string;
  senderId?: string;
  /** The quoted message was sent by this bot / account. */
  fromSelf?: boolean;
}

export interface InboundMessage {
  channel: ChannelType;
  account: string;
  messageId: string;
  /** Conversation id (DM peer or group). */
  chatId: string;
  senderId: string;
  senderName?: string;
  isGroup: boolean;
  mentioned?: boolean;
  text: string;
  attachments?: ChannelAttachment[];
  replyToMessageId?: string;
  /** Epoch ms. */
  receivedAt: number;
  /**
   * `weak`: the transport identity is forgeable or shared (SMS / RCS behind an iMessage handle,
   * email `From:`, Telegram anonymous admins and channel posts). A weak sender never matches an
   * owner identity (review design-21). Default `strong`.
   */
  identityStrength?: "strong" | "weak";
  /** Set when the content was forwarded from someone else. */
  forwardedFrom?: ForwardedFrom;
  quoted?: QuotedMessage;
  /** This is an edit of the earlier inbound message `editOf` (never a new instruction). */
  editOf?: string;
  /** Telegram anonymous admin, channel post or similar: the sender is a chat, not a person. */
  senderIsChat?: boolean;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  attachments?: ChannelAttachment[];
  replyToMessageId?: string;
  /** `markdown`: adapters with `capabilities().markdown` render it; others get plain text. Default `plain`. */
  format?: "plain" | "markdown";
}

export interface ChannelHealth {
  ok: boolean;
  detail?: string;
  /** Epoch ms of the last event received from the transport. */
  lastEventAt?: number;
}

export interface SendResult {
  messageId: string;
}

export interface ChannelApprovalAnswer {
  approvalId: string;
  answerToken: string;
  decision: "approve" | "deny";
  senderId: string;
}

export interface ChannelAdapter {
  readonly type: ChannelType;
  readonly account: string;
  capabilities(): ChannelCapabilities;
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  onInbound(handler: (message: InboundMessage) => void | Promise<void>): Unsubscribe;
  send(message: OutboundMessage): Promise<SendResult>;
  sendApprovalButtons?(
    chatId: string,
    approval: ApprovalRequest,
    answerToken: string,
  ): Promise<SendResult>;
  onApprovalAnswer?(handler: (answer: ChannelApprovalAnswer) => void | Promise<void>): Unsubscribe;
  /** Pairing (dmPolicy `pairing`): deliver the code an unknown sender must have approved. */
  sendPairingCode?(chatId: string, code: string, expiresAt: number): Promise<SendResult>;
  sendTyping?(chatId: string, action?: "typing" | "recording_voice"): Promise<void>;
  /** Download an inbound attachment by its `ref`. */
  fetchAttachment?(ref: string, signal?: AbortSignal): Promise<Uint8Array>;
  health?(): Promise<ChannelHealth>;
}
