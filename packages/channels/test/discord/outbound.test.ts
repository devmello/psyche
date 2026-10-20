import { PsycheError } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordAdapter } from "../../src/adapters/discord/index.ts";
import { adapterOptions, FakeDiscord, message, OWNER, OWNER_DM, TOKEN, until } from "./helpers.ts";

let fake: FakeDiscord;
let adapter: DiscordAdapter | undefined;

async function started(extra: Partial<ConstructorParameters<typeof DiscordAdapter>[0]> = {}) {
  fake = await FakeDiscord.create();
  adapter = new DiscordAdapter({ ...adapterOptions(fake), ...extra });
  await adapter.start();
  return adapter;
}

async function caught(p: Promise<unknown>): Promise<PsycheError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PsycheError) return err;
    throw err;
  }
  throw new Error("expected a rejection");
}

afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
  await fake?.close();
});

const HMAC = TOKEN.split(".")[2] ?? "";

describe("DiscordAdapter outbound", () => {
  it("posts to a DM channel seen inbound, as a reply, with the bot token and no pings", async () => {
    const a = await started();
    a.onInbound(() => undefined);
    fake.dispatch("MESSAGE_CREATE", message());
    await until(() => fake.received.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    const res = await a.send({
      chatId: OWNER_DM,
      text: "**hi**",
      format: "markdown",
      replyToMessageId: "600000000000000001:e1",
    });
    expect(res.messageId).toMatch(/^\d+$/);
    const [call] = fake.calls("POST", `/channels/${OWNER_DM}/messages`);
    expect(call?.headers.authorization).toBe(`Bot ${TOKEN}`);
    expect(call?.body).toEqual({
      content: "**hi**",
      allowed_mentions: { parse: [] },
      flags: 4,
      message_reference: { message_id: "600000000000000001", fail_if_not_exists: false },
    });
    // The owner's user id resolves to the same DM channel without opening one.
    await a.send({ chatId: OWNER, text: "to the user id" });
    expect(fake.calls("POST", "/users/@me/channels")).toHaveLength(0);
    await a.sendTyping(OWNER);
    expect(fake.calls("POST", `/channels/${OWNER_DM}/typing`)).toHaveLength(1);
  });

  it("opens a DM for a user id it has not seen", async () => {
    const a = await started();
    await a.send({ chatId: OWNER, text: "hello" });
    expect(fake.calls("POST", "/users/@me/channels")[0]?.body).toEqual({ recipient_id: OWNER });
    expect(fake.calls("POST", `/channels/${OWNER_DM}/messages`)).toHaveLength(1);
    expect(a.capabilities()).toMatchObject({
      maxMessageChars: 2000,
      markdown: true,
      buttons: true,
    });
    expect((await caught(a.send({ chatId: OWNER, text: "x".repeat(2001) }))).code).toBe(
      "invalid_params",
    );
    expect((await caught(a.send({ chatId: "not-a-snowflake", text: "x" }))).code).toBe(
      "invalid_params",
    );
  });

  it("uploads attachments as multipart with payload_json", async () => {
    const a = await started();
    await a.send({
      chatId: OWNER,
      text: "file",
      attachments: [
        { name: "a.txt", mime: "text/plain", size: 3, data: new Uint8Array([1, 2, 3]) },
      ],
    });
    const [call] = fake.calls("POST", `/channels/${OWNER_DM}/messages`);
    expect(String(call?.headers["content-type"])).toMatch(/^multipart\/form-data/);
    expect(String(call?.body)).toContain('name="files[0]"; filename="a.txt"');
    expect(String(call?.body)).toContain('"attachments":[{"id":0,"filename":"a.txt"}]');
  });

  it("429 → rate_limited, retryable, with retry_after", async () => {
    const a = await started();
    fake.respond((c) =>
      c.path.endsWith("/messages")
        ? {
            status: 429,
            body: { message: "You are being rate limited.", retry_after: 1.5, global: false },
          }
        : undefined,
    );
    const err = await caught(a.send({ chatId: OWNER, text: "hi" }));
    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
    expect(err.details).toMatchObject({ retryAfterSec: 1.5, status: 429 });
  });

  it("never puts the token in an error message", async () => {
    const a = await started();
    fake.respond((c) =>
      c.path.endsWith("/messages")
        ? { status: 400, body: { message: `bad request for ${TOKEN} (${HMAC})`, code: 50035 } }
        : undefined,
    );
    const err = await caught(a.send({ chatId: OWNER, text: "hi" }));
    expect(err.code).toBe("invalid_params");
    expect(err.message).toContain("<token>");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(HMAC);
    expect(JSON.stringify(err.details)).not.toContain(HMAC);
    fake.respond(() => ({ status: 401, body: { message: TOKEN } }));
    const auth = await caught(a.send({ chatId: OWNER, text: "hi" }));
    expect(auth.code).toBe("unauthorized");
    expect(auth.message).not.toContain(HMAC);
  });

  it("fetchAttachment refuses non-Discord hosts and caps the size", async () => {
    const a = await started();
    for (const ref of [
      "https://evil.example/attachments/1/2/a.png",
      "http://cdn.discordapp.com/attachments/1/2/a.png",
      "https://cdn.discordapp.com.evil.example/a.png",
    ]) {
      expect((await caught(a.fetchAttachment(ref))).code).toBe("forbidden");
    }
    expect((await caught(a.fetchAttachment("not a url"))).code).toBe("invalid_params");
    expect(fake.rest).toHaveLength(0);

    await a.stop();
    const origin = new URL(fake.apiBase).origin;
    adapter = new DiscordAdapter({
      ...adapterOptions(fake),
      attachmentOrigins: [origin],
      maxDownloadBytes: 16,
    });
    fake.respond((c) =>
      c.path.startsWith("/big") ? { status: 200, body: "x".repeat(64) } : undefined,
    );
    fake.respond((c) => (c.path.startsWith("/small") ? { status: 200, body: "ok" } : undefined));
    expect((await caught(adapter.fetchAttachment(`${origin}/big`))).code).toBe("invalid_params");
    const small = await adapter.fetchAttachment(`${origin}/small`);
    expect(Buffer.from(small).toString()).toBe('"ok"');
    // The CDN never sees the bot token.
    expect(fake.rest.every((c) => c.headers.authorization === undefined)).toBe(true);
  });
});
