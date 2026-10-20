import { afterEach, describe, expect, it } from "vitest";
import { mapDiscordMessage } from "../../src/adapters/discord/index.ts";
import { channelSettings, validateChannel } from "../../src/settings.ts";
import {
  BOT_ID,
  GUILD,
  GUILD_CHANNEL,
  type Harness,
  harness,
  message,
  OWNER,
  OWNER_DM,
  STRANGER,
  STRANGER_DM,
  until,
} from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("Discord inbound through ChannelService", () => {
  it("routes the owner's DM as an owner turn in a private session", async () => {
    h = await harness();
    h.fake.dispatch("MESSAGE_CREATE", message());
    await until(() => h?.delivered.length === 1);
    const [event] = h.delivered;
    expect(event?.kind).toBe("message");
    expect(event?.message).toMatchObject({
      channel: "discord",
      account: "psyche",
      chatId: OWNER_DM,
      senderId: OWNER,
      senderName: "Owner",
      isGroup: false,
      text: "hello psyche",
    });
    expect(event?.route).toMatchObject({ role: "owner", isGroup: false, injectMemory: true });
  });

  it("an unknown sender gets a pairing code in their DM and nothing reaches the agent", async () => {
    h = await harness();
    h.fake.dispatch(
      "MESSAGE_CREATE",
      message({ channel_id: STRANGER_DM, author: { id: STRANGER, username: "stranger" } }),
    );
    await until(() => (h?.fake.calls("POST", `/channels/${STRANGER_DM}/messages`).length ?? 0) > 0);
    const [sent] = h.fake.calls("POST", `/channels/${STRANGER_DM}/messages`);
    expect((sent?.body as { content?: string } | undefined)?.content).toMatch(
      /Your pairing code is \w+/,
    );
    expect(sent?.body).toMatchObject({ allowed_mentions: { parse: [] } });
    expect(h.delivered).toHaveLength(0);
    expect(await h.service.listPairings({ status: "pending" })).toHaveLength(1);
  });

  it("a guild message reaches the agent only when it mentions the bot", async () => {
    h = await harness({
      channel: { requireMention: true, config: { groups: { [GUILD_CHANNEL]: {} } } },
    });
    const inGuild = { channel_id: GUILD_CHANNEL, guild_id: GUILD };
    h.fake.dispatch("MESSAGE_CREATE", message({ ...inGuild, content: "no mention" }));
    h.fake.dispatch(
      "MESSAGE_CREATE",
      message({
        ...inGuild,
        id: "600000000000000002",
        content: `<@${BOT_ID}> hi`,
        mentions: [{ id: BOT_ID, username: "psyche", bot: true }],
      }),
    );
    await until(() => h?.delivered.length === 1);
    await settle();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.message).toMatchObject({
      isGroup: true,
      mentioned: true,
      chatId: GUILD_CHANNEL,
    });
  });

  it("ignores the bot's own messages, other bots and webhooks", async () => {
    h = await harness();
    h.fake.dispatch(
      "MESSAGE_CREATE",
      message({ author: { id: BOT_ID, bot: true }, content: "self" }),
    );
    h.fake.dispatch(
      "MESSAGE_CREATE",
      message({ author: { id: "200000000000000009", bot: true }, content: "bot" }),
    );
    h.fake.dispatch("MESSAGE_CREATE", message({ webhook_id: "1", content: "hook" }));
    h.fake.dispatch("MESSAGE_CREATE", message({ id: "600000000000000009", content: "owner" }));
    await until(() => h?.delivered.length === 1);
    await settle();
    expect(h.delivered.map((e) => e.message.text)).toEqual(["owner"]);
  });

  it("an edit arrives as editOf the original; embed-only updates are ignored", async () => {
    h = await harness();
    h.fake.dispatch("MESSAGE_UPDATE", { id: "600000000000000001", channel_id: OWNER_DM });
    h.fake.dispatch(
      "MESSAGE_UPDATE",
      message({ content: "hello, edited", edited_timestamp: "2026-10-20T10:01:00.000Z" }),
    );
    await until(() => h?.delivered.length === 1);
    await settle();
    expect(h.delivered[0]?.kind).toBe("edit");
    expect(h.delivered[0]?.message).toMatchObject({
      editOf: "600000000000000001",
      messageId: `600000000000000001:e${Date.parse("2026-10-20T10:01:00.000Z")}`,
      text: "hello, edited",
    });
  });
});

describe("mapDiscordMessage", () => {
  it("maps replies to the bot, attachments and forwards", () => {
    const reply = mapDiscordMessage(
      message({
        type: 19,
        message_reference: { message_id: "600000000000000000" },
        referenced_message: message({
          id: "600000000000000000",
          author: { id: BOT_ID, bot: true },
          content: "earlier answer",
        }),
        attachments: [
          {
            id: "1",
            filename: "a.png",
            size: 12,
            url: "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1",
            content_type: "image/png",
          },
          {
            id: "2",
            filename: "voice-message.ogg",
            size: 99,
            url: "https://cdn.discordapp.com/attachments/1/3/v.ogg",
            content_type: "audio/ogg",
            duration_secs: 2.5,
          },
        ],
        flags: 1 << 13,
      }) as never,
      BOT_ID,
      "psyche",
    );
    expect(reply).toMatchObject({
      replyToMessageId: "600000000000000000",
      quoted: { text: "earlier answer", senderId: BOT_ID, fromSelf: true },
      attachments: [
        {
          kind: "image",
          name: "a.png",
          ref: "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1",
        },
        { kind: "voice", durationMs: 2500 },
      ],
    });
    const forwarded = mapDiscordMessage(
      message({
        content: "",
        message_reference: { type: 1, message_id: "1" },
        message_snapshots: [{ message: { content: "someone else's words" } }],
        mentions: [{ id: BOT_ID }],
      }) as never,
      BOT_ID,
      "psyche",
    );
    expect(forwarded).toMatchObject({
      text: "someone else's words",
      forwardedFrom: {},
      mentioned: false,
    });
    expect(forwarded?.replyToMessageId).toBeUndefined();
    expect(mapDiscordMessage(message({ type: 7 }) as never, BOT_ID, "psyche")).toBeUndefined();
  });
});

describe("Discord channel settings", () => {
  it("ids are numeric snowflakes; the default rate fits the Discord limits", async () => {
    h = await harness();
    const bad = { ...h.channel, ownerIds: ["owner#1234"], allowFrom: [OWNER] };
    expect(validateChannel(bad)).toEqual(["Discord ids are numeric snowflakes: owner#1234"]);
    expect(validateChannel(h.channel)).toEqual([]);
    expect(channelSettings(h.channel).rateLimit).toEqual({
      perChatPerSec: 1,
      perChannelPerSec: 10,
      burst: 5,
    });
  });
});
