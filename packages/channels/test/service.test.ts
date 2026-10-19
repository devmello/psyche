import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { createChannelsApi } from "../src/api.ts";
import { harness, OWNER, STRANGER, sentTexts } from "./helpers.ts";

describe("voice notes (N11)", () => {
  it("receive: downloads, transcribes with the speech engine and ingests into the Library", async () => {
    const h = await harness();
    h.speech.transcript("remind me to call mom");
    h.adapter.files.set("file-1", new Uint8Array([1, 2, 3]));
    await h.adapter.receive({
      senderId: OWNER,
      text: "",
      attachments: [
        { kind: "voice", name: "voice.ogg", mime: "audio/ogg", size: 3, ref: "file-1" },
      ],
    });
    expect(h.delivered[0]?.parts).toEqual([
      { text: "remind me to call mom", provenance: "owner", label: "voice" },
    ]);
    expect(h.delivered[0]?.attachments).toEqual([{ libraryItemId: "lib1" }]);
    expect(h.ingested[0]).toMatchObject({ mime: "audio/ogg", provenance: "owner" });
  });

  it("receive: oversized and undownloadable attachments become system notes", async () => {
    const h = await harness();
    await h.adapter.receive({
      senderId: OWNER,
      text: "see attached",
      attachments: [
        { kind: "file", name: "big.bin", mime: "application/octet-stream", size: 50e6, ref: "big" },
        { kind: "file", name: "gone.pdf", mime: "application/pdf", size: 10, ref: "missing" },
      ],
    });
    expect(h.delivered[0]?.parts.map((p) => p.provenance)).toEqual(["owner", "system", "system"]);
    expect(h.ingested).toHaveLength(0);
  });

  it("send: synthesizes once and transcodes once per container", async () => {
    const h = await harness();
    await h.service.sendVoice({ channelId: h.channel.id, chatId: OWNER }, "Dinner is at seven.");
    await h.service.sendVoice({ channelId: h.channel.id, chatId: OWNER }, "Dinner is at seven.");
    expect(h.speech.synthesized).toEqual(["Dinner is at seven."]);
    expect(h.transcoder.calls.map((c) => c.target)).toEqual(["ogg_opus"]);
    const voice = h.adapter.sent.filter((s) => s.attachments !== undefined);
    expect(voice).toHaveLength(2);
    expect(voice[0]?.attachments?.[0]).toMatchObject({
      kind: "voice",
      mime: "audio/ogg",
      name: "voice.ogg",
    });
    expect(h.adapter.sent.some((s) => s.kind === "typing" && s.text === "recording_voice")).toBe(
      true,
    );
  });
});

describe("outbound", () => {
  it("flattens markdown for channels without markdown and chunks to the limit", async () => {
    const h = await harness({ capabilities: { maxMessageChars: 100, markdown: false } });
    const text = Array.from({ length: 8 }, (_, i) => `**Para ${i}** ${"word ".repeat(10)}`).join(
      "\n\n",
    );
    const results = await h.service.send({ channelId: h.channel.id, chatId: OWNER }, text);
    expect(results.length).toBeGreaterThan(1);
    for (const s of h.adapter.sent) {
      expect(s.text.length).toBeLessThanOrEqual(100);
      expect(s.text).not.toContain("**");
      expect(s.format).toBe("plain");
    }
  });

  it("keeps markdown for markdown channels", async () => {
    const h = await harness({ capabilities: { markdown: true } });
    await h.service.send({ channelId: h.channel.id, chatId: OWNER }, "**hi**");
    expect(h.adapter.sent[0]).toMatchObject({ text: "**hi**", format: "markdown" });
  });

  it("rate-limits per chat", async () => {
    const h = await harness({ channel: { config: { rateLimit: { perChatPerSec: 1, burst: 1 } } } });
    const target = { channelId: h.channel.id, chatId: OWNER };
    await h.service.send(target, "one");
    await h.service.send(target, "two");
    await h.service.send(target, "three");
    expect(sentTexts(h)).toEqual(["one", "two", "three"]);
    expect(h.sleeps).toEqual([1000, 1000]);
  });

  it("retries rate_limited sends after retryAfterSec", async () => {
    const h = await harness();
    const original = h.adapter.send.bind(h.adapter);
    let calls = 0;
    h.adapter.send = async (m) => {
      calls++;
      if (calls === 1)
        throw new PsycheError("rate_limited", "429", { details: { retryAfterSec: 7 } });
      return original(m);
    };
    await h.service.send({ channelId: h.channel.id, chatId: OWNER }, "hello");
    expect(calls).toBe(2);
    expect(h.sleeps).toContain(7000);
  });
});

describe("adapter supervision", () => {
  it("retries a failing start with backoff and reports status", async () => {
    const h = await harness({ start: false });
    const original = h.adapter.start.bind(h.adapter);
    let attempts = 0;
    h.adapter.start = async () => {
      attempts++;
      if (attempts < 3) throw new Error("network down");
      return original();
    };
    await h.service.start(h.channel.id);
    expect(attempts).toBe(3);
    expect(h.sleeps).toEqual([750, 1500]);
    const statuses = h.events
      .filter((e) => e.event === "channels.updated")
      .map((e) => (e.payload as { channel: { status: string } }).channel.status);
    expect(statuses).toEqual(["active", "error", "active"]);
  });

  it("restarts an unhealthy adapter", async () => {
    const h = await harness();
    h.adapter.healthy = false;
    await h.service.checkHealth();
    expect(h.service.getChannel(h.channel.id).status).toBe("active");
    expect(
      h.events.some(
        (e) =>
          e.event === "channels.updated" &&
          (e.payload as { detail?: string }).detail === "unhealthy",
      ),
    ).toBe(true);
  });
});

describe("channels.* API", () => {
  it("configure, allowlist, pairing and identities", async () => {
    const h = await harness();
    let n = 0;
    const api = createChannelsApi(h.service, { newId: () => `x${++n}`, now: () => h.clock.now() });
    const ctx = { deviceId: "dev1" };

    const created = await api["channels.configure"]({ type: "webchat", account: "web" }, ctx);
    expect(created.channel).toMatchObject({
      type: "webchat",
      dmPolicy: "pairing",
      requireMention: true,
    });
    await expect(
      api["channels.configure"]({ channelId: created.channel.id, type: "telegram" }, ctx),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const updated = await api["channels.configure"](
      { channelId: h.channel.id, dmScope: "main", config: { contextVisibility: "all" } },
      ctx,
    );
    expect(updated.channel).toMatchObject({
      dmScope: "main",
      config: { contextVisibility: "all" },
    });

    const allow = await api["channels.allowlist.update"](
      { channelId: h.channel.id, list: "allowFrom", add: ["42", "42"], remove: [OWNER] },
      ctx,
    );
    expect(allow.channel.allowFrom).toEqual(["42"]);

    await h.adapter.receive({ senderId: STRANGER, text: "hi" });
    const { requests } = await api["channels.pairing.list"]({ status: "pending" }, ctx);
    expect(requests).toHaveLength(1);
    const approved = await api["channels.pairing.approve"](
      { requestId: requests[0]?.id ?? "" },
      ctx,
    );
    expect(approved.pairingRequest).toMatchObject({
      status: "approved",
      decidedByDeviceId: "dev1",
    });
    await expect(api["channels.pairing.approve"]({}, ctx)).rejects.toMatchObject({
      code: "invalid_params",
    });

    const { identity } = await api["channels.identities.upsert"](
      { display: "Alex", links: ["telegram:42"], delegatedPersona: "helper" },
      ctx,
    );
    expect(identity).toMatchObject({ id: "x1", delegatedPersona: "helper", toolAllow: null });
    const cleared = await api["channels.identities.upsert"](
      { identityId: identity.id, display: "Alex", links: ["telegram:42"], delegatedPersona: null },
      ctx,
    );
    expect(cleared.identity.delegatedPersona).toBeNull();
    expect((await api["channels.identities.list"]({}, ctx)).identities).toHaveLength(1);
    await api["channels.identities.delete"]({ identityId: identity.id }, ctx);
    await expect(
      api["channels.identities.delete"]({ identityId: identity.id }, ctx),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
