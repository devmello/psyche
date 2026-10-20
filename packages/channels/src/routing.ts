import type { Channel, ChannelIdentity, Provenance } from "@psyche/protocol";
import { OWNER_IDENTITY_ID } from "./identity.ts";

/**
 * Inbound routing to sessions (architecture §4.10, security §9 "Isolation", feature N1/N10).
 *
 * Session keys:
 * - groups: `channel:<type>:<account>:group:<chatId>`, always their own session;
 * - owner DMs: `main` under `dmScope: main`, `peer:owner` under `per-peer`,
 *   `channel:<type>:<account>:dm:<senderId>` under `per-channel-peer`;
 * - everyone else: never `main`. `per-peer` keys by linked identity (`peer:<identityId>`) or the
 *   qualified sender; `main` is coerced to `per-channel-peer` (two non-owner peers never share a
 *   session, and no non-owner ever shares the owner's);
 * - designated persons always get their own per-peer session (`peer:<identityId>`).
 */

export type SenderRole = "owner" | "designated" | "allowed";

export interface RouteContext {
  channelId: string;
  channelType: Channel["type"];
  account: string;
  chatId: string;
  senderId: string;
  isGroup: boolean;
  role: SenderRole;
  /** Linked identity, `owner` for owners. */
  identityId?: string;
  sessionKey: string;
  /** Provenance of the sender's own text (forwarded / quoted parts carry their own). */
  provenance: Provenance;
  /** `MEMORY.md` is injected only into the owner's private sessions (security §9, §8). */
  injectMemory: boolean;
  /** Delegated persona overlay name (feature N10). */
  personaOverlay?: string;
  /**
   * Tool allowlist (globs). Absent only for the owner (their normal tool set); a delegated
   * persona's list from its identity; `[]` for an allowlisted sender, who has no delegation:
   * a chat-only turn that reads none of the owner's sources (security §9, #293).
   */
  toolAllow?: string[];
  /**
   * Subject for the Permission Broker's per-sender grant matrix (S05 owns the matrix): the identity
   * id when linked, else `<type>:<senderId>`.
   */
  grantSubject: string;
  /** Approvals raised by this session always go to the owner, never to this sender. */
  approvalsToOwner: true;
}

export interface RouteInput {
  channel: Channel;
  chatId: string;
  senderId: string;
  isGroup: boolean;
  role: SenderRole;
  identity?: ChannelIdentity;
  /** Identity whose delegated persona serves a designated group. */
  groupIdentity?: ChannelIdentity;
}

export function sessionKeyFor(input: RouteInput): string {
  const { channel, chatId, senderId } = input;
  const base = `channel:${channel.type}:${channel.account}`;
  if (input.isGroup) return `${base}:group:${chatId}`;
  if (input.role === "owner") {
    if (channel.dmScope === "main") return "main";
    if (channel.dmScope === "per-peer") return `peer:${OWNER_IDENTITY_ID}`;
    return `${base}:dm:${senderId}`;
  }
  if (input.role === "designated" && input.identity !== undefined)
    return `peer:${input.identity.id}`;
  if (channel.dmScope === "per-peer") {
    return input.identity !== undefined
      ? `peer:${input.identity.id}`
      : `peer:${channel.type}:${senderId}`;
  }
  return `${base}:dm:${senderId}`;
}

export function buildRoute(input: RouteInput): RouteContext {
  const { channel } = input;
  const persona = input.isGroup ? input.groupIdentity : input.identity;
  const delegated = input.role === "designated" ? persona : undefined;
  const identityId = input.role === "owner" ? OWNER_IDENTITY_ID : (input.identity?.id ?? undefined);
  return {
    channelId: channel.id,
    channelType: channel.type,
    account: channel.account,
    chatId: input.chatId,
    senderId: input.senderId,
    isGroup: input.isGroup,
    role: input.role,
    ...(identityId === undefined ? {} : { identityId }),
    sessionKey: sessionKeyFor(input),
    provenance: input.role === "owner" ? "owner" : "untrusted",
    injectMemory: input.role === "owner" && !input.isGroup,
    ...(delegated?.delegatedPersona == null ? {} : { personaOverlay: delegated.delegatedPersona }),
    ...(delegated !== undefined
      ? { toolAllow: delegated.toolAllow ?? [] }
      : input.role === "owner"
        ? {}
        : { toolAllow: [] }),
    grantSubject: identityId ?? `${channel.type}:${input.senderId}`,
    approvalsToOwner: true,
  };
}
