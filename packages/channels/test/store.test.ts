import { openDb } from "@psyche/db";
import type { Channel } from "@psyche/protocol";
import { FakeClock, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  WEBCHAT_OWNER_ID,
  WebChatAdapter,
  webChatChannelDefaults,
} from "../src/adapters/webchat.ts";
import { ChannelService } from "../src/service.ts";
import { MemoryChannelStore } from "../src/store/memory.ts";
import { SqliteChannelStore } from "../src/store/sqlite.ts";
import type { ChannelStore } from "../src/store/types.ts";

function channel(id: string): Channel {
  return {
    id,
    type: "telegram",
    account: "bot",
    dmPolicy: "pairing",
    allowFrom: ["1"],
    groupAllowFrom: [],
    requireMention: true,
    ownerIds: ["1"],
    dmScope: "per-channel-peer",
    nodeId: null,
    status: "active",
    config: { groups: { "-1": { requireMention: false } } },
    createdAt: "2026-10-18T20:00:00.000Z",
    updatedAt: "2026-10-18T20:00:00.000Z",
  };
}

const stores: [string, (clock: FakeClock) => ChannelStore][] = [
  ["memory", (clock) => new MemoryChannelStore({ clock })],
  [
    "sqlite",
    (clock) => {
      let n = 0;
      return new SqliteChannelStore(
        openDb(":memory:", {
          now: () => new Date(clock.now()).toISOString(),
          newId: () => `01J9ZK4Q7W${String(++n).padStart(16, "0")}`,
        }),
      );
    },
  ],
];

describe.each(stores)("ChannelStore (%s)", (_name, make) => {
  it("round-trips channels and identities", async () => {
    const store = make(new FakeClock());
    await store.saveChannel(channel("c1"));
    await store.saveChannel({ ...channel("c1"), allowFrom: ["1", "2"], requireMention: false });
    expect(await store.listChannels()).toEqual([
      { ...channel("c1"), allowFrom: ["1", "2"], requireMention: false },
    ]);
    const identity = {
      id: "i1",
      display: "Alex",
      links: ["telegram:2"],
      delegatedPersona: null,
      toolAllow: ["calendar.*"],
      createdAt: "2026-10-18T20:00:00.000Z",
      updatedAt: "2026-10-18T20:00:00.000Z",
    };
    await store.saveIdentity(identity);
    expect(await store.listIdentities()).toEqual([identity]);
    expect(await store.deleteIdentity("i1")).toBe(true);
    expect(await store.deleteIdentity("i1")).toBe(false);
  });

  it("creates, lists, decides and expires channel-sender pairings", async () => {
    const clock = new FakeClock();
    const store = make(clock);
    await store.saveChannel(channel("c1"));
    const expiresAt = new Date(clock.now() + 3_600_000).toISOString();
    const a = await store.createPairing({
      channelId: "c1",
      senderId: "7",
      code: "ABCDEFGH",
      display: "A",
      expiresAt,
    });
    const b = await store.createPairing({
      channelId: "c1",
      senderId: "8",
      code: "JKLMNPQR",
      display: "B",
      expiresAt,
    });
    expect(
      (await store.listPairings({ channelId: "c1", status: "pending" })).map((p) => p.id),
    ).toEqual([b.id, a.id]);
    expect(await store.decidePairing(a.id, "approved", null)).toMatchObject({ status: "approved" });
    await expect(store.decidePairing(a.id, "denied", null)).rejects.toMatchObject({
      code: "conflict",
    });
    clock.advance(3_600_000);
    expect(await store.expirePairings(new Date(clock.now()).toISOString())).toBe(1);
    expect((await store.getPairing(b.id))?.status).toBe("expired");
  });
});

describe("WebChat (N3)", () => {
  it("routes the owner's web messages into main and replies to the device", async () => {
    const clock = new FakeClock();
    const delivered: string[] = [];
    const service = new ChannelService({
      store: new MemoryChannelStore({ clock }),
      broker: new FakePermissionBroker({ clock }),
      clock,
      sink: { deliver: async (e) => void delivered.push(e.route.sessionKey) },
    });
    await service.init();
    await service.saveChannel({
      ...service.newChannel("webchat", "web"),
      ...webChatChannelDefaults(),
    });
    const web = new WebChatAdapter({ clock });
    const replies: string[] = [];
    web.onOutbound((m) => {
      if (m.messageId !== "typing") replies.push(`${m.chatId}:${m.text}`);
    });
    const { id } = service.attach(web);
    await service.start(id);
    await web.receive("device-1", "hello from the browser");
    expect(delivered).toEqual(["main"]);
    await service.send({ channelId: id, chatId: "device-1" }, "**hi**");
    expect(replies).toEqual(["device-1:**hi**"]);
    expect(
      service.isOwner(id, {
        channel: "webchat",
        account: "web",
        messageId: "m",
        chatId: "device-1",
        senderId: WEBCHAT_OWNER_ID,
        isGroup: false,
        text: "",
        receivedAt: 0,
      }),
    ).toBe(true);
  });
});
