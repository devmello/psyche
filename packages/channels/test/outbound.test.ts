import { fixtureSecret } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { FRIEND, GROUP, harness, OWNER, sentTexts } from "./helpers.ts";

const CARD = fixtureSecret("link-virtual-card").replace(/\D/g, "");
const KEY = ["sk-", "ant-", "x".repeat(30)].join("");
const spaced = CARD.replace(/(\d{4})(?=\d)/g, "$1 ");

describe("outbound check on ChannelService.send", () => {
  it("owner's own chat: the value is cut out, the rest is sent, only kinds are reported", async () => {
    const h = await harness();
    await h.service.send(
      { channelId: h.channel.id, chatId: OWNER },
      `Your card is ${spaced}, key ${KEY}.`,
    );
    const [text] = sentTexts(h);
    expect(text).toContain("open Psyche to see it");
    expect(text).not.toContain(CARD.slice(0, 8));
    expect(text).not.toContain(KEY);
    expect(h.withheld[0]).toMatchObject({ action: "redact", chatId: OWNER });
    expect(JSON.stringify(h.withheld)).not.toContain(CARD);
  });

  it("anyone else, and a group: held, nothing sent", async () => {
    const h = await harness();
    for (const chatId of [FRIEND, GROUP]) {
      await h.service.send({ channelId: h.channel.id, chatId }, `pay with ${spaced}`);
    }
    expect(sentTexts(h)).toEqual([]);
    expect(h.withheld.map((w) => w.action)).toEqual(["hold", "hold"]);
  });

  it("an email thread is held even for the owner's address", async () => {
    const h = await harness({
      type: "email",
      channel: {
        ownerIds: ["me@example.com"],
        allowFrom: ["me@example.com"],
        dmPolicy: "allowlist",
      },
    });
    await h.service.send({ channelId: h.channel.id, chatId: "me@example.com" }, `card ${spaced}`);
    expect(sentTexts(h)).toEqual([]);
    expect(h.withheld[0]?.action).toBe("hold");
  });

  it("catches a card that Markdown joins and one that chunking would split", async () => {
    const h = await harness({ capabilities: { markdown: false, maxMessageChars: 60 } });
    await h.service.send(
      { channelId: h.channel.id, chatId: FRIEND },
      CARD.replace(/(\d{4})/g, "**$1**"),
    );
    await h.service.send(
      { channelId: h.channel.id, chatId: FRIEND },
      `${"word ".repeat(10)}${CARD}`,
    );
    expect(sentTexts(h)).toEqual([]);
  });

  it("ordinary text passes untouched", async () => {
    const h = await harness();
    await h.service.send(
      { channelId: h.channel.id, chatId: FRIEND },
      "Order 1234567890 ships 2026-11-18 for $12.50",
    );
    expect(sentTexts(h)).toEqual(["Order 1234567890 ships 2026-11-18 for $12.50"]);
    expect(h.withheld).toEqual([]);
  });

  it("owner's own DM: a one-time code goes through, a card is still cut out", async () => {
    const h = await harness();
    const target = { channelId: h.channel.id, chatId: OWNER };
    await h.service.send(target, "Your verification code is 482913");
    expect(sentTexts(h)).toEqual(["Your verification code is 482913"]);
    await h.service.send(target, `code 482913 and card ${spaced}`);
    expect(sentTexts(h)[1]).toContain("open Psyche to see it");
    expect(sentTexts(h)[1]).not.toContain(CARD.slice(0, 8));
    // To anyone else the same code is held.
    await h.service.send(
      { channelId: h.channel.id, chatId: FRIEND },
      "Your verification code is 482913",
    );
    expect(sentTexts(h)).toHaveLength(2);
  });

  it("the redacted text keeps everything else as written (marks, emoji, fractions)", async () => {
    const h = await harness();
    const original = `\u200fשלום ½ 👨\u200d👩\u200d👧 x² ${spaced} end`;
    await h.service.send({ channelId: h.channel.id, chatId: OWNER }, original);
    const [text] = sentTexts(h);
    expect(text).toBe(`\u200fשלום ½ 👨\u200d👩\u200d👧 x² [withheld: open Psyche to see it] end`);
  });

  it("a number split across two messages to the same chat is caught", async () => {
    const h = await harness();
    const to = { channelId: h.channel.id, chatId: FRIEND };
    await h.service.send(to, `my card is ${CARD.slice(0, 8)}`);
    await h.service.send(to, CARD.slice(8));
    expect(sentTexts(h)).toEqual([`my card is ${CARD.slice(0, 8)}`]);
    expect(h.withheld.at(-1)?.action).toBe("hold");
    // After the window the earlier message no longer counts.
    const later = await harness();
    await later.service.send(
      { channelId: later.channel.id, chatId: FRIEND },
      `a ${CARD.slice(0, 8)}`,
    );
    later.clock.advance(120_000);
    await later.service.send({ channelId: later.channel.id, chatId: FRIEND }, CARD.slice(8));
    expect(sentTexts(later)).toHaveLength(2);
  });

  it("Arabic-Indic digits do not get a card past the check", async () => {
    const h = await harness();
    const arabic = [...CARD].map((d) => String.fromCodePoint(0x660 + Number(d))).join("");
    await h.service.send({ channelId: h.channel.id, chatId: FRIEND }, arabic);
    expect(sentTexts(h)).toEqual([]);
  });

  describe("who the owner's own chat is, per channel", () => {
    const secret = `card ${spaced}`;
    // Slack ids are user ids; the others take the numeric owner id.
    const ownerOf = (type: string) =>
      type === "slack" ? { ownerIds: ["U012ABCDEF"], allowFrom: ["U012ABCDEF"] } : {};

    it("iMessage: a DM guid whose peer is the owner is the owner; a group guid is not", async () => {
      const h = await harness({
        type: "imessage",
        channel: { ownerIds: ["+15551234567"], allowFrom: ["+15551234567"] },
      });
      await h.service.send({ channelId: h.channel.id, chatId: "iMessage;-;+15551234567" }, secret);
      expect(sentTexts(h)[0]).toContain("open Psyche to see it");
      await h.service.send({ channelId: h.channel.id, chatId: "iMessage;+;chat123" }, secret);
      await h.service.send({ channelId: h.channel.id, chatId: "iMessage;-;+15559999999" }, secret);
      expect(sentTexts(h)).toHaveLength(1);
    });

    for (const type of ["discord", "slack"] as const) {
      it(`${type}: a DM channel id is the owner's once the owner has written in it`, async () => {
        const h = await harness({ type, channel: ownerOf(type) });
        const owner = ownerOf(type).ownerIds?.[0] ?? OWNER;
        const dm = "D0DM123";
        // Not yet known: held.
        await h.service.send({ channelId: h.channel.id, chatId: dm }, secret);
        expect(sentTexts(h)).toEqual([]);
        await h.adapter.receive({ senderId: owner, chatId: dm, text: "hello" });
        await h.service.send({ channelId: h.channel.id, chatId: dm }, secret);
        expect(sentTexts(h).at(-1)).toContain("open Psyche to see it");
      });

      it(`${type}: a group the owner wrote in stays held`, async () => {
        const h = await harness({ type, channel: ownerOf(type) });
        await h.adapter.receive({
          senderId: ownerOf(type).ownerIds?.[0] ?? OWNER,
          chatId: "C0GROUP",
          isGroup: true,
          mentioned: true,
          text: "hi",
        });
        await h.service.send({ channelId: h.channel.id, chatId: "C0GROUP" }, secret);
        expect(sentTexts(h)).toEqual([]);
      });
    }

    it("WebChat: the paired device's chat is the owner's", async () => {
      const h = await harness({ type: "webchat" });
      await h.service.send({ channelId: h.channel.id, chatId: "device-abc" }, secret);
      expect(sentTexts(h)[0]).toContain("open Psyche to see it");
    });
  });
});
