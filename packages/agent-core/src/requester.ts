import type { Requester } from "@psyche/protocol";

/**
 * The fields that name who sent a message from outside the owner's devices (the removed chat
 * channels' route, 2026-11-25). Nothing builds one now; the non-owner requester it produces is
 * still what the broker and the loop refuse and taint, so it stays with its tests.
 */
export interface RouteLike {
  role: Requester["role"];
  /** Linked identity (`owner` for the owner). */
  identityId?: string;
  channelType: string;
  senderId: string;
  chatId: string;
  /** Tool allowlist globs of a delegated persona. */
  toolAllow?: string[];
}

/** Extra facts from the sender's `ChannelIdentity`, when the caller has it. */
export interface RouteIdentityLike {
  display?: string;
  /** `<channel>:<senderId>` links: every chat that reaches this person. */
  links?: string[];
}

/**
 * `StartTurnInput.requester` for a channel turn (security §9): the broker decides every call of
 * the turn as this person's, keeps their standing grants apart from the owner's, and never
 * delivers the resulting cards to their own chats. The owner's own messages map to `role:
 * owner`, which the broker treats exactly like a turn without a requester.
 */
export function requesterFromRoute(route: RouteLike, identity?: RouteIdentityLike): Requester {
  return {
    role: route.role,
    ...(route.identityId === undefined ? {} : { identityId: route.identityId }),
    ...(identity?.display === undefined ? {} : { display: identity.display }),
    channel: route.channelType,
    senderId: route.senderId,
    chatId: route.chatId,
    ...(identity?.links === undefined ? {} : { links: [...identity.links] }),
    ...(route.toolAllow === undefined ? {} : { toolAllow: [...route.toolAllow] }),
  };
}
