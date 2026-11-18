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
});
