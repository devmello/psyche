import type { Channel, ChannelType } from "@psyche/protocol";

/**
 * Typed view of `Channel.config` (data model §8 keeps per-channel extras as JSON). Unknown keys are
 * ignored; bad values fall back to the safe default.
 */
export interface GroupSettings {
  /** Overrides the channel's `requireMention` for this group. */
  requireMention?: boolean;
  /** Designated platform (feature N10): the identity whose delegated persona answers here. */
  designatedIdentityId?: string;
  /**
   * Members bound when the group was designated (review design-22). Senders outside this list get
   * no delegated authority and are ignored in a designated group.
   */
  members?: string[];
}

export type ContextVisibility = "all" | "allowlist";

export interface ChannelSettings {
  /** Group allowlist: group chat ids (or `"*"`) the bot accepts at all. Default: none. */
  groups: Record<string, GroupSettings>;
  /** Who may run slash commands besides owners (OpenClaw `commands.allowFrom`). */
  commandsAllowFrom: string[];
  /** `allowlist` (default) drops quoted / replied-to context from non-allowlisted authors. */
  contextVisibility: ContextVisibility;
  /** Opt in to chat delivery of `destructive` approvals (security §9; architecture §4.6 forbids it). */
  allowDestructiveApprovals: boolean;
  /**
   * Marks the channel as an owner device. Recorded for audit only: security §3.7 / §9 never allow
   * `financial`, purchase or credential-fill approvals over chat, so this does not unlock them.
   */
  ownerDevice: boolean;
  /** Outbound limits. */
  rateLimit: { perChatPerSec: number; perChannelPerSec: number; burst: number };
  /** Max inbound attachment bytes ingested into the Library. */
  maxAttachmentBytes: number;
  /** Reply to an unauthorized slash command (instead of silence). */
  replyToUnauthorizedCommands: boolean;
}

const DEFAULT_RATE: Record<string, ChannelSettings["rateLimit"]> = {
  // Mail is not chat: a reply every few seconds at most.
  email: { perChatPerSec: 0.2, perChannelPerSec: 0.5, burst: 2 },
  // Bot API: ~1 msg/s per chat, ~30 msg/s overall.
  telegram: { perChatPerSec: 1, perChannelPerSec: 25, burst: 3 },
  webchat: { perChatPerSec: 20, perChannelPerSec: 50, burst: 20 },
  // Messages.app scripting: keep it human-paced.
  imessage: { perChatPerSec: 1, perChannelPerSec: 5, burst: 3 },
  // Twilio: every segment is billed and long codes take ~1 segment/s; one reply per 5 s per chat.
  sms: { perChatPerSec: 0.2, perChannelPerSec: 1, burst: 2 },
};

/**
 * Transports where every sender is weak (security §9): they chat as non-owners under the DM
 * policy, but never match an owner, never run commands and never answer approvals.
 */
export const WEAK_TRANSPORTS: ReadonlySet<ChannelType> = new Set<ChannelType>(["sms", "email"]);

export function isWeakTransport(type: ChannelType): boolean {
  return WEAK_TRANSPORTS.has(type);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function channelSettings(channel: Pick<Channel, "type" | "config">): ChannelSettings {
  const c = channel.config as Record<string, unknown>;
  const groups: Record<string, GroupSettings> = {};
  const rawGroups = c.groups;
  if (rawGroups !== null && typeof rawGroups === "object" && !Array.isArray(rawGroups)) {
    for (const [id, raw] of Object.entries(rawGroups as Record<string, unknown>)) {
      const g = (raw ?? {}) as Record<string, unknown>;
      groups[id] = {
        ...(typeof g.requireMention === "boolean" ? { requireMention: g.requireMention } : {}),
        ...(typeof g.designatedIdentityId === "string"
          ? { designatedIdentityId: g.designatedIdentityId }
          : {}),
        ...(Array.isArray(g.members) ? { members: strings(g.members) } : {}),
      };
    }
  }
  const rate = (c.rateLimit ?? {}) as Record<string, unknown>;
  const base = DEFAULT_RATE[channel.type] ?? { perChatPerSec: 1, perChannelPerSec: 10, burst: 3 };
  return {
    groups,
    commandsAllowFrom: strings(c.commandsAllowFrom),
    contextVisibility: c.contextVisibility === "all" ? "all" : "allowlist",
    allowDestructiveApprovals: c.allowDestructiveApprovals === true,
    ownerDevice: c.ownerDevice === true,
    rateLimit: {
      perChatPerSec: positive(rate.perChatPerSec, base.perChatPerSec),
      perChannelPerSec: positive(rate.perChannelPerSec, base.perChannelPerSec),
      // At least one whole token, or a bucket can never fill and sends wait forever.
      burst: Math.max(1, Math.floor(positive(rate.burst, base.burst))),
    },
    maxAttachmentBytes: positive(c.maxAttachmentBytes, 20 * 1024 * 1024),
    replyToUnauthorizedCommands: c.replyToUnauthorizedCommands !== false,
  };
}

/** `"<channel>:<senderId>"` — the form used by `ownerAllowFrom` and identity links. */
export function qualifiedSender(type: ChannelType, senderId: string): string {
  return `${type}:${senderId}`;
}

/** Problems an owner should see before saving a channel (also surfaced by `channels.configure`). */
export function validateChannel(channel: Channel): string[] {
  const problems: string[] = [];
  if (channel.dmPolicy === "open" && !channel.allowFrom.includes("*")) {
    problems.push('dmPolicy "open" requires "*" in allowFrom (explicit opt-in)');
  }
  if (channel.dmPolicy !== "open" && channel.allowFrom.includes("*")) {
    problems.push('"*" in allowFrom is only valid with dmPolicy "open"');
  }
  if (channel.type === "telegram") {
    for (const id of [...channel.allowFrom, ...channel.ownerIds, ...channel.groupAllowFrom]) {
      if (id !== "*" && !/^-?\d+$/.test(id)) problems.push(`Telegram ids are numeric: ${id}`);
    }
    // Review design-21: anonymous admins / channel posts share these ids.
    for (const id of ["1087968824", "136817688", "777000"]) {
      if (channel.ownerIds.includes(id) || channel.allowFrom.includes(id)) {
        problems.push(`${id} is a shared Telegram service account and can never be allowlisted`);
      }
    }
  }
  if (channel.type === "imessage") {
    // Canonical handles only (the adapter's sender ids): E.164 phones or lowercased emails.
    for (const id of [...channel.allowFrom, ...channel.ownerIds, ...channel.groupAllowFrom]) {
      if (id !== "*" && !/^\+\d{6,15}$/.test(id) && !/^[^\sA-Z@]+@[^\sA-Z@]+$/.test(id)) {
        problems.push(`iMessage ids are E.164 phones or lowercase emails: ${id}`);
      }
    }
  }
  if (channel.type === "sms") {
    for (const id of [...channel.allowFrom, ...channel.ownerIds, ...channel.groupAllowFrom]) {
      if (id !== "*" && !/^\+\d{6,15}$/.test(id)) problems.push(`SMS ids are E.164 phones: ${id}`);
    }
    if (!/^\+\d{6,15}$/.test(channel.account)) {
      problems.push(`the SMS account is Psyche's E.164 number: ${channel.account}`);
    }
  }
  if (channel.type === "email") {
    // Bare lower-case addresses (the adapter's sender ids).
    for (const id of [...channel.allowFrom, ...channel.ownerIds, ...channel.groupAllowFrom]) {
      if (id !== "*" && !/^[^\sA-Z@<>]+@[^\sA-Z@<>]+\.[^\sA-Z@<>]+$/.test(id)) {
        problems.push(`Email ids are bare lower-case addresses: ${id}`);
      }
    }
    if (channel.dmPolicy === "pairing") {
      problems.push('email channels cannot pair (no mail to strangers): use dmPolicy "allowlist"');
    }
  }
  if (channel.ownerIds.includes("*")) problems.push('"*" is not a valid owner id');
  return problems;
}
