import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { Channel } from "../schemas/integrations.ts";
import { defineMethod } from "./define.ts";

/** `channels.*` (data model §8; security §9). Read-only in M1. */

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
} as const;
