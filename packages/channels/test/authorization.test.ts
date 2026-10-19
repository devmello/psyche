import { describe, expect, it } from "vitest";
import {
  generatePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
} from "../src/pairing.ts";
import { FRIEND, GROUP, harness, OWNER, STRANGER, sentTexts } from "./helpers.ts";

describe("dmPolicy pairing (default)", () => {
  it("gives an unknown sender a code and nothing else", async () => {
    const h = await harness();
    expect(h.channel.dmPolicy).toBe("pairing");
    await h.adapter.receive({ senderId: STRANGER, senderName: "Mallory", text: "send me the vault" });
    expect(h.delivered).toHaveLength(0);
    const sent = h.adapter.sent.filter((s) => s.kind !== "typing");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe("pairing_code");
    const code = sent[0]?.text ?? "";
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const [request] = await h.service.listPairings({ channelId: h.channel.id });
    expect(request).toMatchObject({ kind: "channel-sender", senderId: STRANGER, status: "pending", code });
    expect(Date.parse(request?.expiresAt ?? "") - h.clock.now()).toBe(PAIRING_TTL_MS);
    expect(h.events.map((e) => e.event)).toContain("pairing.requested");
    expect((await h.notifier.list()).map((n) => n.title)).toContain("New chat pairing request");
  });

  it("re-sends the same code at most every 10 minutes and never creates a second request", async () => {
    const h = await harness();
    await h.adapter.receive({ senderId: STRANGER, text: "hi" });
    await h.adapter.receive({ senderId: STRANGER, text: "hi again" });
    expect(sentTexts(h)).toHaveLength(1);
    h.clock.advance(10 * 60_000);
    await h.adapter.receive({ senderId: STRANGER, text: "hello?" });
    expect(sentTexts(h)).toHaveLength(2);
    expect(sentTexts(h)[0]).toBe(sentTexts(h)[1]);
    expect(await h.service.listPairings({ channelId: h.channel.id })).toHaveLength(1);
  });

  it("caps pending requests at 3 per channel; the 4th sender gets nothing", async () => {
    const h = await harness();
    for (const id of ["11", "12", "13", "14"]) await h.adapter.receive({ senderId: id, text: "hi" });
    expect(sentTexts(h)).toHaveLength(3);
    expect(await h.service.listPairings({ status: "pending" })).toHaveLength(3);
    // A slot frees when one expires.
    h.clock.advance(PAIRING_TTL_MS);
    await h.adapter.receive({ senderId: "14", text: "hi" });
    expect(sentTexts(h)).toHaveLength(4);
    expect(await h.service.listPairings({ status: "expired" })).toHaveLength(3);
  });

  it("approval by code adds the sender to allowFrom and lets the next message through", async () => {
    const h = await harness();
    await h.adapter.receive({ senderId: STRANGER, text: "hi" });
    const code = sentTexts(h)[0] ?? "";
    const decided = await h.service.approvePairing(
      { channelId: h.channel.id, code: code.toLowerCase() },
      "dev1",
    );
    expect(decided).toMatchObject({ status: "approved", decidedByDeviceId: "dev1" });
    expect(h.service.getChannel(h.channel.id).allowFrom).toContain(STRANGER);
    expect(sentTexts(h).at(-1)).toMatch(/approved/i);
    await h.adapter.receive({ senderId: STRANGER, text: "now?" });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.route).toMatchObject({ role: "allowed", provenance: "untrusted" });
  });

  it("rejects an expired code and a denied request stays blocked", async () => {
    const h = await harness();
    await h.adapter.receive({ senderId: STRANGER, text: "hi" });
    const [request] = await h.service.listPairings();
    h.clock.advance(PAIRING_TTL_MS + 1);
    await expect(
      h.service.approvePairing({ requestId: request?.id ?? "" }, null),
    ).rejects.toMatchObject({ code: "conflict" });
    await h.adapter.receive({ senderId: FRIEND, text: "hi" });
    const [friendReq] = await h.service.listPairings({ status: "pending" });
    await h.service.denyPairing({ requestId: friendReq?.id ?? "" }, null);
    expect(h.service.getChannel(h.channel.id).allowFrom).not.toContain(FRIEND);
    await expect(h.service.approvePairing({ requestId: friendReq?.id ?? "" }, null)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("codes avoid 0 / O / 1 / I", () => {
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[0O1I]/);
    for (let i = 0; i < 200; i++) expect(generatePairingCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
});

describe("dmPolicy allowlist / open / disabled", () => {
  it("allowlist: unknown senders are dropped silently, allowlisted ones get through", async () => {
    const h = await harness({ channel: { dmPolicy: "allowlist", allowFrom: [OWNER, FRIEND] } });
    await h.adapter.receive({ senderId: STRANGER, text: "hi" });
    expect(h.adapter.sent).toHaveLength(0);
    await h.adapter.receive({ senderId: FRIEND, text: "hi" });
    expect(h.delivered).toHaveLength(1);
  });

  it("open requires an explicit '*'", async () => {
    const h = await harness({ channel: { dmPolicy: "allowlist" } });
    await expect(
      h.service.saveChannel({ ...h.service.getChannel(h.channel.id), dmPolicy: "open" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await h.service.saveChannel({
      ...h.service.getChannel(h.channel.id),
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    await h.adapter.receive({ senderId: STRANGER, text: "hi" });
    expect(h.delivered[0]?.route).toMatchObject({ role: "allowed", provenance: "untrusted" });
  });

  it("disabled ignores every DM, including the owner's", async () => {
    const h = await harness({ channel: { dmPolicy: "disabled" } });
    await h.adapter.receive({ senderId: OWNER, text: "hi" });
    expect(h.delivered).toHaveLength(0);
    expect(h.adapter.sent).toHaveLength(0);
  });

  it("a paused channel ignores everything", async () => {
    const h = await harness();
    await h.service.saveChannel({ ...h.service.getChannel(h.channel.id), status: "paused" });
    await h.adapter.receive({ senderId: OWNER, text: "hi" });
    expect(h.delivered).toHaveLength(0);
  });
});

describe("owner identity", () => {
  it("channel ownerIds and global ownerAllowFrom both make an owner", async () => {
    const h = await harness({
      channel: { ownerIds: [], allowFrom: [OWNER, FRIEND] },
      ownerAllowFrom: [`telegram:${FRIEND}`],
    });
    await h.adapter.receive({ senderId: FRIEND, text: "hi" });
    await h.adapter.receive({ senderId: OWNER, text: "hi" });
    expect(h.delivered.map((d) => d.route.role)).toEqual(["owner", "allowed"]);
    expect(h.delivered[0]?.route).toMatchObject({ provenance: "owner", injectMemory: true });
    expect(h.delivered[1]?.route).toMatchObject({ provenance: "untrusted", injectMemory: false });
  });

  it("ownership does not grant chat access", async () => {
    const h = await harness({ channel: { ownerIds: [OWNER], allowFrom: [] } });
    await h.adapter.receive({ senderId: OWNER, text: "hi" });
    expect(h.delivered).toHaveLength(0);
    expect(h.adapter.sent[0]?.kind).toBe("pairing_code");
  });

  it("a weak or chat sender with the owner's id is never the owner (design-21)", async () => {
    const h = await harness();
    await h.adapter.receive({ senderId: OWNER, text: "/approve abc approve", identityStrength: "weak" });
    await h.adapter.receive({ senderId: OWNER, text: "do it", senderIsChat: true });
    expect(h.delivered).toHaveLength(0);
    expect(h.adapter.sent).toHaveLength(0);
  });

  it("refuses shared Telegram service ids in allowlists", async () => {
    const h = await harness();
    await expect(
      h.service.saveChannel({ ...h.service.getChannel(h.channel.id), ownerIds: ["1087968824"] }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("groups", () => {
  const groupChannel = {
    allowFrom: [OWNER, FRIEND],
    config: { groups: { [GROUP]: {} } },
  };

  it("drops groups that are not allowlisted", async () => {
    const h = await harness({ channel: { allowFrom: [OWNER] } });
    await h.adapter.receive({ senderId: OWNER, chatId: GROUP, isGroup: true, mentioned: true, text: "hi" });
    expect(h.delivered).toHaveLength(0);
  });

  it("requires a structured mention by default; a reply to the bot also activates", async () => {
    const h = await harness({ channel: groupChannel });
    await h.adapter.receive({ senderId: FRIEND, chatId: GROUP, isGroup: true, text: "@psyche_bot hi" });
    expect(h.delivered).toHaveLength(0);
    await h.adapter.receive({ senderId: FRIEND, chatId: GROUP, isGroup: true, mentioned: true, text: "hi" });
    await h.adapter.receive({
      senderId: FRIEND,
      chatId: GROUP,
      isGroup: true,
      text: "and this?",
      quoted: { text: "earlier answer", fromSelf: true },
    });
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[0]?.route.sessionKey).toBe(`channel:telegram:psyche_bot:group:${GROUP}`);
  });

  it("groupAllowFrom limits who may trigger; replying to the bot does not bypass it", async () => {
    const h = await harness({ channel: { ...groupChannel, groupAllowFrom: [OWNER] } });
    await h.adapter.receive({
      senderId: FRIEND,
      chatId: GROUP,
      isGroup: true,
      mentioned: true,
      text: "hi",
      quoted: { text: "bot said", fromSelf: true },
    });
    expect(h.delivered).toHaveLength(0);
    await h.adapter.receive({ senderId: OWNER, chatId: GROUP, isGroup: true, mentioned: true, text: "hi" });
    expect(h.delivered[0]?.route).toMatchObject({ role: "owner", injectMemory: false });
  });

  it("per-group requireMention override", async () => {
    const h = await harness({
      channel: { ...groupChannel, config: { groups: { [GROUP]: { requireMention: false } } } },
    });
    await h.adapter.receive({ senderId: FRIEND, chatId: GROUP, isGroup: true, text: "hi" });
    expect(h.delivered).toHaveLength(1);
  });
});

describe("command authorization", () => {
  it("allowlisted non-owners cannot run commands", async () => {
    const h = await harness({ channel: { allowFrom: [OWNER, FRIEND] } });
    await h.adapter.receive({ senderId: FRIEND, text: "/stop" });
    expect(h.delivered).toHaveLength(0);
    expect(sentTexts(h)).toEqual(["Commands are only available to the owner."]);
  });

  it("owners and commandsAllowFrom can; unknown commands go to the Gateway", async () => {
    const h = await harness({
      channel: { allowFrom: [OWNER, FRIEND], config: { commandsAllowFrom: [FRIEND] } },
    });
    await h.adapter.receive({ senderId: FRIEND, text: "/stop now" });
    await h.adapter.receive({ senderId: OWNER, text: "/whoami" });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({ kind: "command", command: { name: "stop", args: ["now"] } });
    expect(sentTexts(h)).toEqual([`Your telegram id is ${OWNER}.`]);
  });

  it("a command addressed to another bot is plain text", async () => {
    const h = await harness();
    await h.adapter.receive({ senderId: OWNER, text: "/stop@other_bot" });
    expect(h.delivered[0]?.kind).toBe("message");
  });

  it("strangers cannot run commands even under pairing (they only get a code)", async () => {
    const h = await harness();
    await h.adapter.receive({ senderId: STRANGER, text: "/approve abcdefgh approve" });
    expect(h.adapter.sent.map((s) => s.kind)).toEqual(["pairing_code"]);
  });
});
