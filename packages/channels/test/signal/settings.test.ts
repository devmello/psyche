import type { Channel } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { channelSettings, validateChannel } from "../../src/settings.ts";
import { ACCOUNT, GROUP_ID, OWNER } from "./helpers.ts";

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "c1",
    type: "signal",
    account: ACCOUNT,
    dmPolicy: "pairing",
    allowFrom: [OWNER],
    groupAllowFrom: [],
    requireMention: true,
    ownerIds: [OWNER],
    dmScope: "per-channel-peer",
    nodeId: null,
    status: "active",
    config: {},
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("Signal channel settings", () => {
  it("rate-limits at 1/s per chat, 5/s per channel, burst 3", () => {
    expect(channelSettings(channel()).rateLimit).toEqual({
      perChatPerSec: 1,
      perChannelPerSec: 5,
      burst: 3,
    });
  });

  it("accepts E.164 and uuid: ids, and group ids in groupAllowFrom", () => {
    expect(
      validateChannel(
        channel({
          allowFrom: [OWNER, "uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
          groupAllowFrom: [`group:${GROUP_ID}`, OWNER],
          config: { groups: { [`group:${GROUP_ID}`]: {} } },
        }),
      ),
    ).toEqual([]);
  });

  it("rejects other ids and a non-E.164 account", () => {
    expect(
      validateChannel(channel({ account: "psyche", allowFrom: ["alice"], ownerIds: ["5551111"] })),
    ).toEqual([
      "Signal ids are E.164 numbers or uuid:<uuid>: alice",
      "Signal ids are E.164 numbers or uuid:<uuid>: 5551111",
      "the Signal account is Psyche's E.164 number: psyche",
    ]);
  });
});
