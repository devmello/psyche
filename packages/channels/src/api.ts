import {
  type Channel,
  type ChannelIdentity,
  type MethodParams,
  type MethodResult,
  PsycheError,
} from "@psyche/protocol";
import type { ChannelService } from "./service.ts";

/**
 * `channels.*` method handlers (protocol `ChannelsMethods`). The Gateway validates params and the
 * caller's scope (`operator.admin` for every change) before calling these, and passes the
 * calling device for `pairing_requests.decided_by_device_id`.
 */

export interface ChannelsApiContext {
  deviceId: string | null;
}

type ChannelsMethod =
  | "channels.list"
  | "channels.get"
  | "channels.configure"
  | "channels.allowlist.update"
  | "channels.pairing.list"
  | "channels.pairing.approve"
  | "channels.pairing.deny"
  | "channels.identities.list"
  | "channels.identities.upsert"
  | "channels.identities.delete";

export type ChannelsApi = {
  [M in ChannelsMethod]: (
    params: MethodParams<M>,
    ctx: ChannelsApiContext,
  ) => Promise<MethodResult<M>>;
};

export function createChannelsApi(
  service: ChannelService,
  options: { newId: () => string; now: () => number },
): ChannelsApi {
  const iso = () => new Date(options.now()).toISOString();
  return {
    "channels.list": async () => ({ channels: service.listChannels() }),
    "channels.get": async ({ channelId }) => ({ channel: service.getChannel(channelId) }),
    "channels.configure": async (params) => {
      let base: Channel;
      if (params.channelId !== undefined) {
        base = service.getChannel(params.channelId);
        if (params.type !== undefined && params.type !== base.type) {
          throw new PsycheError("invalid_params", "a channel's type cannot change");
        }
      } else {
        if (params.type === undefined || params.account === undefined) {
          throw new PsycheError(
            "invalid_params",
            "type and account are required to create a channel",
          );
        }
        base = service.newChannel(params.type, params.account);
      }
      const channel: Channel = {
        ...base,
        ...(params.account === undefined ? {} : { account: params.account }),
        ...(params.dmPolicy === undefined ? {} : { dmPolicy: params.dmPolicy }),
        ...(params.allowFrom === undefined ? {} : { allowFrom: unique(params.allowFrom) }),
        ...(params.groupAllowFrom === undefined
          ? {}
          : { groupAllowFrom: unique(params.groupAllowFrom) }),
        ...(params.requireMention === undefined ? {} : { requireMention: params.requireMention }),
        ...(params.ownerIds === undefined ? {} : { ownerIds: unique(params.ownerIds) }),
        ...(params.dmScope === undefined ? {} : { dmScope: params.dmScope }),
        ...(params.nodeId === undefined ? {} : { nodeId: params.nodeId }),
        ...(params.status === undefined ? {} : { status: params.status }),
        config: params.config === undefined ? base.config : { ...base.config, ...params.config },
        updatedAt: iso(),
      };
      return { channel: await service.saveChannel(channel) };
    },
    "channels.allowlist.update": async ({ channelId, list, add = [], remove = [] }) => {
      const channel = service.getChannel(channelId);
      const next = unique([...channel[list].filter((id) => !remove.includes(id)), ...add]);
      return { channel: await service.saveChannel({ ...channel, [list]: next, updatedAt: iso() }) };
    },
    "channels.pairing.list": async (params) => ({
      requests: await service.listPairings({
        ...(params.channelId === undefined ? {} : { channelId: params.channelId }),
        ...(params.status === undefined ? {} : { status: params.status }),
      }),
    }),
    "channels.pairing.approve": async (params, ctx) => ({
      pairingRequest: await service.approvePairing(pairingRef(params), ctx.deviceId),
    }),
    "channels.pairing.deny": async (params, ctx) => ({
      pairingRequest: await service.denyPairing(pairingRef(params), ctx.deviceId),
    }),
    "channels.identities.list": async () => ({ identities: service.listIdentities() }),
    "channels.identities.upsert": async (params) => {
      const existing =
        params.identityId === undefined
          ? undefined
          : service.listIdentities().find((i) => i.id === params.identityId);
      const now = iso();
      const identity: ChannelIdentity = {
        id: params.identityId ?? options.newId(),
        display: params.display,
        links: unique(params.links),
        delegatedPersona:
          params.delegatedPersona !== undefined
            ? params.delegatedPersona
            : (existing?.delegatedPersona ?? null),
        toolAllow:
          params.toolAllow !== undefined ? params.toolAllow : (existing?.toolAllow ?? null),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      return { identity: await service.saveIdentity(identity) };
    },
    "channels.identities.delete": async ({ identityId }) => {
      await service.deleteIdentity(identityId);
      return { ok: true as const };
    },
  };
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}

function pairingRef(params: { requestId?: string; channelId?: string; code?: string }) {
  return {
    ...(params.requestId === undefined ? {} : { requestId: params.requestId }),
    ...(params.channelId === undefined ? {} : { channelId: params.channelId }),
    ...(params.code === undefined ? {} : { code: params.code }),
  };
}
