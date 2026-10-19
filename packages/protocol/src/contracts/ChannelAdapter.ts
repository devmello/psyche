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
}

export interface ChannelAttachment {
  name: string;
  mime: string;
  size: number;
  /** Library item once ingested. */
  libraryItemId?: string;
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
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  attachments?: ChannelAttachment[];
  replyToMessageId?: string;
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
}
