import type { ApprovalRequest } from "@psyche/protocol";
import type { PolicyContext } from "./types.ts";

/**
 * The channel reply authority (security §3.4–3.7, §9; S10 N5). A channel whose transport is a
 * destructive node capability (iMessage `messages.send`) needs a `message_send` approval id for
 * every outbound text, including the replies that *are* the channel. A human approval per reply
 * is unusable and loops (the card to the owner's chat is itself a send), so the broker issues an
 * already-decided `once` approval itself, but only for the narrow cases below. Every other send
 * (the agent writing to anyone else) keeps going through the normal `message_send` ask.
 */

export type ChannelSendPurpose = "reply" | "pairing_code" | "approval_card";

/** One text to one conversation, as the adapter will send it. */
export interface ChannelSendIntent {
  channel: string;
  account: string;
  /** Canonical recipient (a chat id seen inbound, or a 1:1 peer's handle). */
  recipient: string;
  /** `sha256:<hex>` of the exact text. */
  bodySha256: string;
  /** `bindingFor("message_send", {channel, account, recipient, bodySha256})`; recomputed here. */
  bindingHash: string;
  grantKey: string;
  purpose: ChannelSendPurpose;
}

/** What the channel service reports about the recipient conversation right now. */
export interface ChannelConversationReport {
  channel: string;
  account: string;
  /** The conversation, named as the intent names it. */
  recipient: string;
  /** Who wrote there last (or, for a 1:1 conversation nobody wrote in yet, its peer). */
  senderId: string;
  isGroup: boolean;
  /** The service routed that sender's last message as an accepted turn (owner, allowed, designated). */
  authorized: boolean;
  /** A pending pairing request from `senderId` on this channel. */
  pairingPending?: boolean;
  /** Last inbound message from `senderId` here; absent when there is none. */
  inboundMessageId?: string;
  receivedAt?: number;
}

/** The turn whose text a `reply` carries. */
export interface ChannelReplyTurn {
  /** The conversation the owner's request (the turn's inbound message) came from. */
  requestRecipient: string;
  /** The turn's decision context: run, thread, task, mode, taint and requester. */
  context: PolicyContext;
}

export interface ChannelReplyInput {
  intent: ChannelSendIntent;
  conversation: ChannelConversationReport | undefined;
  /**
   * The agent turn being answered. Absent for text the Gateway itself composed (`/status`,
   * "Stopped.", pairing codes, approval cards); a `reply` without it is a system notice.
   */
  turn?: ChannelReplyTurn;
}

export type ChannelReplyRefusal =
  | "binding_mismatch"
  | "no_conversation"
  | "recipient_mismatch"
  | "sender_not_authorized"
  | "stale_conversation"
  | "not_requesting_conversation"
  | "taint_new_target"
  | "policy_denied"
  | "no_pairing"
  | "group_chat"
  | "not_owner"
  | "unexpected_turn";

export type ChannelReplyAuthorization =
  | { ok: true; approval: ApprovalRequest }
  | { ok: false; reason: ChannelReplyRefusal; message: string; rule?: string };

/** How long after the sender's message a reply into their conversation is still a reply. */
export const CHANNEL_REPLY_WINDOW_MS = 6 * 3_600_000;
/** Pairing codes go out right after the unknown sender wrote (the request lives 1 h). */
export const CHANNEL_PAIRING_WINDOW_MS = 3_600_000;
/** A reply authority is consumed at dispatch; it never outlives the send attempt by much. */
export const CHANNEL_REPLY_TTL_MS = 2 * 60_000;
