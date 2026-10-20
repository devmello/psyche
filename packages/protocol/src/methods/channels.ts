import { Type } from "@sinclair/typebox";
import { Id, JsonObject, Nullable, StringEnum } from "../common.ts";
import { PairingRequest, PairingStatus } from "../schemas/identity.ts";
import { Channel, ChannelIdentity, ChannelType, DmPolicy } from "../schemas/integrations.ts";
import { defineMethod, OkResult } from "./define.ts";

/**
 * `channels.*` (data model §1 `pairing_requests`, §8; security §9; owner S10). Every change is
 * `operator.admin`: channel access, pairing and identity links are policy (security §9 and review
 * design-22 — identity links change only from a paired device, never from chat or a tool).
 */

const SenderList = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 1000 });

export const ChannelsMethods = {
  "channels.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ channels: Type.Array(Channel) }),
    scope: "operator.read",
    description: "Lists configured channels.",
  }),
  "channels.get": defineMethod({
    params: Type.Object({ channelId: Id }),
    result: Type.Object({ channel: Channel }),
    scope: "operator.read",
    description: "Returns one channel.",
  }),
  "channels.configure": defineMethod({
    params: Type.Object({
      /** Absent: create a channel of `type` / `account`. */
      channelId: Type.Optional(Id),
      type: Type.Optional(ChannelType),
      account: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      dmPolicy: Type.Optional(DmPolicy),
      allowFrom: Type.Optional(SenderList),
      groupAllowFrom: Type.Optional(SenderList),
      requireMention: Type.Optional(Type.Boolean()),
      ownerIds: Type.Optional(SenderList),
      dmScope: Type.Optional(StringEnum(["main", "per-peer", "per-channel-peer"])),
      nodeId: Type.Optional(Nullable(Id)),
      status: Type.Optional(StringEnum(["active", "paused"])),
      /** Merged into `Channel.config` (groups, contextVisibility, commandsAllowFrom, rate limits). */
      config: Type.Optional(JsonObject),
      /** Fresh presence: the approved `policy_change` card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ channel: Channel }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Creates a channel or changes its access policy and settings. Side-effecting.",
  }),
  "channels.allowlist.update": defineMethod({
    params: Type.Object({
      channelId: Id,
      list: StringEnum(["allowFrom", "groupAllowFrom", "ownerIds"]),
      add: Type.Optional(SenderList),
      remove: Type.Optional(SenderList),
      /** Fresh presence: the approved `policy_change` card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ channel: Channel }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Adds or removes sender / group ids on one of a channel's allowlists. Side-effecting.",
  }),
  "channels.pairing.list": defineMethod({
    params: Type.Object({
      channelId: Type.Optional(Id),
      status: Type.Optional(PairingStatus),
    }),
    result: Type.Object({ requests: Type.Array(PairingRequest) }),
    scope: "operator.read",
    description: "Lists channel-sender pairing requests, newest first.",
  }),
  "channels.pairing.approve": defineMethod({
    params: Type.Object({
      requestId: Type.Optional(Id),
      /** Alternative to `requestId`: the code the sender received, on `channelId`. */
      channelId: Type.Optional(Id),
      code: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
      /** Fresh presence: the approved `policy_change` card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ pairingRequest: PairingRequest }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Approves a pending pairing request; the sender joins the channel's allowFrom. Side-effecting.",
  }),
  "channels.pairing.deny": defineMethod({
    params: Type.Object({
      requestId: Type.Optional(Id),
      channelId: Type.Optional(Id),
      code: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    }),
    result: Type.Object({ pairingRequest: PairingRequest }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Denies a pending pairing request. Side-effecting.",
  }),
  "channels.identities.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ identities: Type.Array(ChannelIdentity) }),
    scope: "operator.read",
    description: "Lists identities (identity links and designated persons).",
  }),
  "channels.identities.upsert": defineMethod({
    params: Type.Object({
      identityId: Type.Optional(Id),
      display: Type.String({ minLength: 1, maxLength: 200 }),
      links: SenderList,
      delegatedPersona: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
      toolAllow: Type.Optional(Nullable(Type.Array(Type.String({ maxLength: 200 })))),
      /** Fresh presence: the approved `policy_change` card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ identity: ChannelIdentity }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Creates or replaces an identity; a sender id may belong to one identity only. Side-effecting.",
  }),
  "channels.identities.delete": defineMethod({
    params: Type.Object({ identityId: Id }),
    result: OkResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Deletes an identity; its senders fall back to per-sender sessions. Side-effecting.",
  }),
} as const;
