import { PsycheError } from "@psyche/protocol";
import { HttpError, InputFile } from "grammy";
import { describe, expect, it } from "vitest";
import { TelegramAdapter } from "../../src/adapters/telegram/index.ts";
import { FAKE_TOKEN, FakeBotApi, harness, OWNER_CHAT, response, update } from "./helpers.ts";

async function caught(p: Promise<unknown>): Promise<PsycheError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PsycheError) return err;
    throw err;
  }
  throw new Error("expected a rejection");
}

describe("TelegramAdapter send", () => {
  it("renders markdown to Telegram HTML with parse_mode HTML and no link previews", async () => {
    const { adapter, api } = await harness();
    const res = await adapter.send({
      chatId: OWNER_CHAT,
      text: "**Done**: moved <the> meeting, see [agenda](https://example.com/a)",
      format: "markdown",
    });
    expect(res).toEqual({ messageId: "901" });
    expect(api.calls).toEqual([
      {
        method: "sendMessage",
        payload: {
          chat_id: 48151623,
          text: '<b>Done</b>: moved &lt;the&gt; meeting, see <a href="https://example.com/a">agenda</a>',
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
  });

  it("sends plain text without a parse mode and with reply parameters", async () => {
    const { adapter, api } = await harness();
    await adapter.send({
      chatId: OWNER_CHAT,
      text: "**not bold** <b>",
      replyToMessageId: "501:e1",
    });
    const [call] = api.calls;
    expect(call?.payload).toEqual({
      chat_id: 48151623,
      text: "**not bold** <b>",
      link_preview_options: { is_disabled: true },
      reply_parameters: { message_id: 501, allow_sending_without_reply: true },
    });
    expect(call?.payload).not.toHaveProperty("parse_mode");
  });

  it("rejects text over 4096 characters with invalid_params and sends nothing", async () => {
    const { adapter, api } = await harness();
    const err = await caught(adapter.send({ chatId: OWNER_CHAT, text: "x".repeat(4097) }));
    expect(err.code).toBe("invalid_params");
    expect(api.calls).toEqual([]);
  });

  it("sends a voice attachment as sendVoice with an InputFile and caption", async () => {
    const { adapter, api } = await harness();
    const res = await adapter.send({
      chatId: OWNER_CHAT,
      text: "here's the summary",
      attachments: [
        {
          kind: "voice",
          name: "reply.ogg",
          mime: "audio/ogg",
          size: 3,
          data: new Uint8Array([1, 2, 3]),
        },
      ],
    });
    expect(api.calls.map((c) => c.method)).toEqual(["sendVoice"]);
    const payload = api.calls[0]?.payload ?? {};
    expect(payload.voice).toBeInstanceOf(InputFile);
    expect((payload.voice as InputFile).filename).toBe("reply.ogg");
    expect(payload.caption).toBe("here's the summary");
    expect(payload).not.toHaveProperty("parse_mode");
    expect(res).toEqual({ messageId: "901" });
  });

  it("sends long text separately before media and routes images and files", async () => {
    const { adapter, api } = await harness();
    const res = await adapter.send({
      chatId: OWNER_CHAT,
      text: "y".repeat(1500),
      format: "markdown",
      replyToMessageId: "509",
      attachments: [
        { kind: "image", name: "chart.png", mime: "image/png", size: 1, data: new Uint8Array([1]) },
        { kind: "file", name: "notes.txt", mime: "text/plain", size: 1, data: new Uint8Array([2]) },
      ],
    });
    expect(api.calls.map((c) => c.method)).toEqual(["sendMessage", "sendPhoto", "sendDocument"]);
    expect(api.calls[0]?.payload.parse_mode).toBe("HTML");
    expect(api.calls[0]?.payload.reply_parameters).toEqual({
      message_id: 509,
      allow_sending_without_reply: true,
    });
    expect(api.calls[1]?.payload.photo).toBeInstanceOf(InputFile);
    expect(api.calls[1]?.payload).not.toHaveProperty("caption");
    expect(api.calls[1]?.payload).not.toHaveProperty("reply_parameters");
    expect(api.calls[2]?.payload.document).toBeInstanceOf(InputFile);
    expect(res).toEqual({ messageId: "903" });
  });

  it("refuses outbound attachments without bytes", async () => {
    const { adapter } = await harness();
    const err = await caught(
      adapter.send({
        chatId: OWNER_CHAT,
        text: "x",
        attachments: [{ name: "a.txt", mime: "text/plain", size: 1 }],
      }),
    );
    expect(err.code).toBe("invalid_params");
  });
});

describe("TelegramAdapter pairing and typing", () => {
  it("sends the pairing code as plain text", async () => {
    const { adapter, api, clock } = await harness();
    await adapter.sendPairingCode("99887766", "K7QP-2M", clock.now() + 10 * 60_000);
    expect(api.calls).toEqual([
      {
        method: "sendMessage",
        payload: {
          chat_id: 99887766,
          text: "Psyche doesn't know you yet. Your pairing code is K7QP-2M. Ask the owner to approve it; it expires in about 10 minutes.",
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
  });

  it("maps typing actions to sendChatAction", async () => {
    const { adapter, api } = await harness();
    await adapter.sendTyping(OWNER_CHAT);
    await adapter.sendTyping("-1001987654321", "recording_voice");
    expect(api.calls).toEqual([
      { method: "sendChatAction", payload: { chat_id: 48151623, action: "typing" } },
      { method: "sendChatAction", payload: { chat_id: -1001987654321, action: "record_voice" } },
    ]);
  });
});

describe("TelegramAdapter errors", () => {
  it("maps 429 to a retryable rate_limited error with retryAfterSec", async () => {
    const { adapter, api } = await harness();
    api.override("sendMessage", response("error429"));
    const err = await caught(adapter.send({ chatId: OWNER_CHAT, text: "hi" }));
    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
    expect(err.details).toMatchObject({ retryAfterSec: 17 });
  });

  it("maps 403, 400 and 401 to forbidden, invalid_params and unauthorized", async () => {
    const { adapter, api } = await harness();
    api.override("sendMessage", response("error403"));
    expect((await caught(adapter.send({ chatId: OWNER_CHAT, text: "hi" }))).code).toBe("forbidden");
    api.override("sendMessage", response("error400"));
    expect((await caught(adapter.send({ chatId: OWNER_CHAT, text: "hi" }))).code).toBe(
      "invalid_params",
    );
    api.override("sendChatAction", response("error401"));
    expect((await caught(adapter.sendTyping(OWNER_CHAT))).code).toBe("unauthorized");
  });

  it("maps network failures to retryable unavailable and never leaks the token", async () => {
    const { adapter, api } = await harness();
    api.override("sendMessage", () => {
      // What grammY's client throws when fetch fails (the inner error may carry the URL).
      throw new HttpError(
        "Network request for 'sendMessage' failed!",
        new Error(`connect ECONNREFUSED https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`),
      );
    });
    const err = await caught(adapter.send({ chatId: OWNER_CHAT, text: "hi" }));
    expect(err.code).toBe("unavailable");
    expect(err.retryable).toBe(true);
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify({ m: err.message, d: err.details, s: err.stack })).not.toContain(
      "TEST-TOKEN",
    );
  });

  it("scrubs the token from Bot API error descriptions", async () => {
    const { adapter, api } = await harness();
    api.override("sendMessage", {
      ok: false,
      error_code: 400,
      description: `Bad Request: token ${FAKE_TOKEN} echoed`,
    });
    const err = await caught(adapter.send({ chatId: OWNER_CHAT, text: "hi" }));
    expect(err.message).not.toContain("TEST-TOKEN");
    expect(err.message).toContain("<token>");
  });
});

describe("TelegramAdapter lifecycle", () => {
  it("starts with botInfo and polling off without any API call", async () => {
    const { adapter, api } = await harness();
    expect(api.calls).toEqual([]);
    expect(adapter.type).toBe("telegram");
    expect(adapter.account).toBe("psyche_bot");
    expect(adapter.capabilities()).toEqual({
      buttons: true,
      polls: false,
      reactions: false,
      voiceNotes: true,
      attachments: true,
      groups: true,
      maxMessageChars: 4096,
      typing: true,
      markdown: true,
    });
    expect(await adapter.health()).toEqual({ ok: true });
    await adapter.handleUpdate(update("dmText"));
    expect((await adapter.health()).lastEventAt).toBeTypeOf("number");
    await adapter.stop();
    expect((await adapter.health()).ok).toBe(false);
  });

  it("calls getMe on start when botInfo is absent and uses the username as account", async () => {
    const api = new FakeBotApi();
    const adapter = new TelegramAdapter({
      token: FAKE_TOKEN,
      transformer: api.transformer,
      polling: false,
    });
    expect(adapter.account).toBe("");
    await expect(adapter.handleUpdate(update("dmText"))).rejects.toMatchObject({
      code: "unavailable",
    });
    await adapter.start();
    expect(api.calls.map((c) => c.method)).toEqual(["getMe"]);
    expect(adapter.account).toBe("psyche_bot");
    await adapter.stop();
  });

  it("prefers an explicit account label", async () => {
    const { adapter, inbound } = await harness({ account: "family-bot" });
    await adapter.handleUpdate(update("dmText"));
    expect(adapter.account).toBe("family-bot");
    expect(inbound[0]?.account).toBe("family-bot");
  });

  it("surfaces an unauthorized getMe as a scrubbed PsycheError from start()", async () => {
    const api = new FakeBotApi();
    api.override("getMe", response("error401"));
    const adapter = new TelegramAdapter({
      token: FAKE_TOKEN,
      transformer: api.transformer,
      polling: false,
    });
    const err = await caught(adapter.start());
    expect(err.code).toBe("unauthorized");
    expect(err.message).not.toContain("TEST-TOKEN");
  });

  it("long-polls with the allowed update types and reports polling errors in health()", async () => {
    const api = new FakeBotApi();
    let polls = 0;
    api.override("deleteWebhook", { ok: true, result: true });
    api.override("getUpdates", () => {
      polls++;
      if (polls === 1) return { ok: true, result: [update("dmText")] };
      return { ok: false, error_code: 401, description: "Unauthorized" };
    });
    const { adapter, inbound } = await harness({ transformer: api.transformer, polling: true });
    await waitFor(() => inbound.length === 1 && polls >= 2);
    await waitFor(async () => !(await adapter.health()).ok);
    const first = api.callsTo("getUpdates")[0];
    expect(first?.payload.allowed_updates).toEqual(["message", "edited_message", "callback_query"]);
    expect(api.callsTo("deleteWebhook")[0]?.payload).toEqual({ drop_pending_updates: false });
    const health = await adapter.health();
    expect(health.detail).toBe("polling stopped: unauthorized");
    await adapter.stop();
  });

  it("stops when the start signal aborts", async () => {
    const api = new FakeBotApi();
    api.override("deleteWebhook", { ok: true, result: true });
    api.override("getUpdates", () => ({ ok: true, result: [] }));
    const controller = new AbortController();
    const { adapter } = await harness({ transformer: api.transformer, polling: false });
    await adapter.stop();
    await adapter.start(controller.signal);
    expect((await adapter.health()).ok).toBe(true);
    controller.abort();
    await waitFor(async () => (await adapter.health()).detail === "stopped");
  });
});

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}
