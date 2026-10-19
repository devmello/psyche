import type { Channel, InboundMessage } from "@psyche/protocol";
import type { IdentityDirectory, SenderRef } from "./identity.ts";
import { buildRoute, type RouteContext, type SenderRole } from "./routing.ts";
import { channelSettings } from "./settings.ts";

/**
 * Inbound authorization (ADR-011, security §9, OpenClaw access control). Evaluation order:
 * channel status → DM policy, or group allowlist → group sender allowlist → mention gate. An
 * unknown DM sender under `pairing` gets a code and nothing else; every other refusal is silent.
 * Ownership does not grant chat access: an owner id still has to be allowed by the DM policy.
 */

export type InboundDecision =
  | { action: "deliver"; route: RouteContext }
  | { action: "pair" }
  | { action: "drop"; reason: string };

export function senderRef(channel: Channel, message: InboundMessage): SenderRef {
  return {
    type: channel.type,
    senderId: message.senderId,
    strong: message.identityStrength !== "weak" && message.senderIsChat !== true,
  };
}

function listed(list: readonly string[], senderId: string): boolean {
  return list.includes(senderId) || list.includes("*");
}

export function authorizeInbound(
  channel: Channel,
  message: InboundMessage,
  identities: IdentityDirectory,
): InboundDecision {
  if (channel.status === "paused") return { action: "drop", reason: "channel_paused" };
  const sender = senderRef(channel, message);
  const owner = identities.isOwner(sender, channel.ownerIds);
  const identity = identities.identityOf(sender);
  const settings = channelSettings(channel);

  if (!message.isGroup) {
    // DMs: weak or chat senders never reach the agent (they cannot pair either).
    if (!sender.strong) return { action: "drop", reason: "weak_identity" };
    switch (channel.dmPolicy) {
      case "disabled":
        return { action: "drop", reason: "dm_disabled" };
      case "open":
        if (!channel.allowFrom.includes("*") && !channel.allowFrom.includes(message.senderId)) {
          return { action: "drop", reason: "open_without_wildcard" };
        }
        break;
      case "allowlist":
        if (!channel.allowFrom.includes(message.senderId)) {
          return { action: "drop", reason: "not_allowlisted" };
        }
        break;
      case "pairing":
        if (!channel.allowFrom.includes(message.senderId)) return { action: "pair" };
        break;
    }
    const role: SenderRole = owner
      ? "owner"
      : identity?.delegatedPersona != null
        ? "designated"
        : "allowed";
    return {
      action: "deliver",
      route: buildRoute({
        channel,
        chatId: message.chatId,
        senderId: message.senderId,
        isGroup: false,
        role,
        ...(identity === undefined ? {} : { identity }),
      }),
    };
  }

  // Groups: the group itself must be allowlisted, then the sender, then the mention gate.
  const group = settings.groups[message.chatId] ?? settings.groups["*"];
  if (group === undefined) return { action: "drop", reason: "group_not_allowlisted" };
  const senders = channel.groupAllowFrom.length > 0 ? channel.groupAllowFrom : channel.allowFrom;
  // Replying to a bot message does not bypass the sender allowlist (OpenClaw, security §9).
  if (!listed(senders, message.senderId)) return { action: "drop", reason: "group_sender_denied" };
  if (!sender.strong && !listed(senders, "*")) return { action: "drop", reason: "weak_identity" };
  const requireMention = group.requireMention ?? channel.requireMention;
  const activated = message.mentioned === true || message.quoted?.fromSelf === true;
  if (requireMention && !activated) return { action: "drop", reason: "not_mentioned" };

  let role: SenderRole = owner ? "owner" : "allowed";
  let groupIdentity: ReturnType<IdentityDirectory["get"]>;
  if (group.designatedIdentityId !== undefined) {
    groupIdentity = identities.get(group.designatedIdentityId);
    // Review design-22: only the members bound at designation time get delegated authority.
    const members = group.members ?? [];
    if (!owner && !members.includes(message.senderId)) {
      return { action: "drop", reason: "not_designated_member" };
    }
    if (!owner && groupIdentity !== undefined) role = "designated";
  }
  return {
    action: "deliver",
    route: buildRoute({
      channel,
      chatId: message.chatId,
      senderId: message.senderId,
      isGroup: true,
      role,
      ...(identity === undefined ? {} : { identity }),
      ...(groupIdentity === undefined ? {} : { groupIdentity }),
    }),
  };
}

/** May this sender run slash commands? Owners, plus `commandsAllowFrom` (never `"*"` implicitly). */
export function mayRunCommands(
  channel: Channel,
  message: InboundMessage,
  identities: IdentityDirectory,
): boolean {
  const sender = senderRef(channel, message);
  if (!sender.strong) return false;
  if (identities.isOwner(sender, channel.ownerIds)) return true;
  return channelSettings(channel).commandsAllowFrom.includes(message.senderId);
}
