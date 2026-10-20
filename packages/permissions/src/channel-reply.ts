import type { PolicyContext } from "./types.ts";

/**
 * Reply authority for chat channels (feature N5, security §3.5, §9). A channel send that the
 * transport gates on an approval (iMessage's `messages.send` speaks as the owner's Apple ID) gets
 * a system-decided `message_send` approval, scope `once`, only for the conversation an
 * authorized sender just wrote in. A human approval per reply is unusable, and for the owner's
 * own chat it would loop: the card asking to send would itself need a send.
 */

export type ChannelReplyPurpose = "reply" | "pairing_code" | "approval_card";

/** What the channel layer knows about one conversation from its inbound policy decisions. */
export interface ChannelConversation {
  /** The sender whose latest inbound message the channel accepted here. */
  senderId: string;
  /** When that message arrived (epoch ms). */
  lastInboundAt: number;
  /**
   * What the channel's policy allows back: `reply` for a routed sender (owner, paired,
   * allowlisted), `pairing_code` for an unknown sender under the pairing DM policy.
   */
  allows: "reply" | "pairing_code";
  /** The owner's own conversation; approval cards may go here without a fresh message. */
  owner: boolean;
  isGroup: boolean;
}

export type ChannelConversationLookup = (ref: {
  channel: string;
  account: string;
  conversation: string;
}) => ChannelConversation | undefined | Promise<ChannelConversation | undefined>;

export interface ChannelReplyInput {
  channel: string;
  account: string;
  /** The conversation the text goes to: the only recipient. */
  recipient: string;
  /** `sha256:<hex>` of the exact text. */
  bodySha256: string;
  /** When given, must equal the `message_send` binding of the fields above. */
  bindingHash?: string;
  purpose: ChannelReplyPurpose;
  /**
   * The agent turn whose text a `reply` carries; absent for Gateway-composed text (`/status`,
   * "Stopped.", pairing codes, approval cards). With a turn, the reply must go to the
   * conversation the turn's request came from, and the turn's mode, deny rules, requester and
   * taint are evaluated as for a tool call (security §3.3, §3.6).
   */
  turn?: ChannelReplyTurn;
}

export interface ChannelReplyTurn {
  /** The conversation the turn's request (its inbound message) came from. */
  requestRecipient: string;
  /** The turn's decision context: run, thread, task, mode, taint and requester. */
  context: PolicyContext;
}

/** A reply may answer a message this recent (an agent turn with tools can take a while). */
export const CHANNEL_REPLY_WINDOW_MS = 60 * 60_000;
/** A pairing code answers the unknown sender's message right away. */
export const CHANNEL_PAIRING_WINDOW_MS = 5 * 60_000;
/** The issued approval is for one send now, not a standing authority. */
export const CHANNEL_REPLY_TTL_MS = 5 * 60_000;
/** Per conversation, so a runaway loop cannot flood a chat. */
export const CHANNEL_REPLIES_PER_MINUTE = 30;
