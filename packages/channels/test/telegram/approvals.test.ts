import { PsycheError } from "@psyche/protocol";
import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import { STALE_APPROVAL_TEXT } from "../../src/adapters/telegram/index.ts";
import { approval, harness, OWNER_CHAT, OWNER_ID, update } from "./helpers.ts";

const TOKEN = "answer-token-for-tests";

interface Button {
  text: string;
  callback_data: string;
}

function keyboard(payload: Record<string, unknown>): Button[][] {
  const markup = payload.reply_markup as { inline_keyboard: Button[][] } | undefined;
  if (markup === undefined) throw new Error("no keyboard");
  return markup.inline_keyboard;
}

function press(data: string, chatId = Number(OWNER_CHAT)): Update {
  const u = update("callbackQuery");
  const q = u.callback_query;
  if (q === undefined || q.message === undefined) throw new Error("fixture");
  q.data = data;
  q.message.chat = { ...q.message.chat, id: chatId } as typeof q.message.chat;
  return u;
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

describe("TelegramAdapter approval buttons", () => {
  it("sends a plain-text card with opaque, short callback data", async () => {
    const { adapter, api } = await harness();
    const res = await adapter.sendApprovalButtons(OWNER_CHAT, approval(), TOKEN);
    expect(res).toEqual({ messageId: "901" });
    const [call] = api.calls;
    expect(call?.method).toBe("sendMessage");
    expect(call?.payload).not.toHaveProperty("parse_mode");
    expect(call?.payload.text).toContain("Approval needed: Send an email [write]");
    expect(call?.payload.text).toContain("Expires in 15 min · ref abcdefgh");
    const rows = keyboard(call?.payload ?? {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.map((b) => b.text)).toEqual(["Approve", "Deny"]);
    for (const button of rows[0] ?? []) {
      expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
      expect(button.callback_data).toMatch(/^a:[A-Za-z0-9_-]{12}:[yn]$/);
      expect(button.callback_data).not.toContain(TOKEN);
      expect(button.callback_data).not.toContain("apr_01J9ZK4Q7WABCDEFGH");
      expect(button.callback_data.toLowerCase()).not.toContain("abcdefgh");
    }
  });

  it("emits the answer with the stored token on each press and answers the query", async () => {
    const { adapter, api, answers } = await harness();
    await adapter.sendApprovalButtons(OWNER_CHAT, approval(), TOKEN);
    const [approve, deny] = keyboard(api.calls[0]?.payload ?? {})[0] ?? [];
    if (approve === undefined || deny === undefined) throw new Error("buttons");

    await adapter.handleUpdate(press(approve.callback_data));
    expect(answers).toEqual([
      {
        approvalId: "apr_01J9ZK4Q7WABCDEFGH",
        answerToken: TOKEN,
        decision: "approve",
        senderId: OWNER_ID,
      },
    ]);
    const acks = api.callsTo("answerCallbackQuery");
    expect(acks).toHaveLength(1);
    expect(acks[0]?.payload.callback_query_id).toBe("4382195732918475123");

    // A second press is emitted again; the Permission Broker rejects the replay upstream.
    await adapter.handleUpdate(press(deny.callback_data));
    expect(answers.map((a) => a.decision)).toEqual(["approve", "deny"]);
    expect(api.callsTo("answerCallbackQuery")).toHaveLength(2);
  });

  it("answers unknown nonces with the stale-card text and emits nothing", async () => {
    const { adapter, api, answers } = await harness();
    await adapter.handleUpdate(press("a:AAAAAAAAAAAA:y"));
    expect(answers).toEqual([]);
    expect(api.calls).toEqual([
      {
        method: "answerCallbackQuery",
        payload: { callback_query_id: "4382195732918475123", text: STALE_APPROVAL_TEXT },
      },
    ]);
  });

  it("ignores a press from a different chat than the card was sent to", async () => {
    const { adapter, api, answers } = await harness();
    await adapter.sendApprovalButtons(OWNER_CHAT, approval(), TOKEN);
    const data = keyboard(api.calls[0]?.payload ?? {})[0]?.[0]?.callback_data ?? "";
    await adapter.handleUpdate(press(data, -1001987654321));
    expect(answers).toEqual([]);
    expect(api.callsTo("answerCallbackQuery")).toHaveLength(1);
  });

  it("forgets nonces once the approval is past expiry plus the grace period", async () => {
    const { adapter, api, answers, clock } = await harness();
    await adapter.sendApprovalButtons(OWNER_CHAT, approval(), TOKEN);
    const data = keyboard(api.calls[0]?.payload ?? {})[0]?.[0]?.callback_data ?? "";
    clock.t = Date.parse("2026-10-18T22:31:00.000Z");
    await adapter.handleUpdate(press(data));
    expect(answers).toEqual([]);
    expect(api.callsTo("answerCallbackQuery")[0]?.payload.text).toBe(STALE_APPROVAL_TEXT);
  });

  it("answers callback queries even when no approval handler is registered", async () => {
    const { adapter, api } = await harness();
    await adapter.handleUpdate(press("garbage"));
    expect(api.callsTo("answerCallbackQuery")).toHaveLength(1);
  });

  it("refuses deviceOnly, financial and purchase approvals", async () => {
    const { adapter, api } = await harness();
    expect(
      (await caught(adapter.sendApprovalButtons(OWNER_CHAT, approval({ deviceOnly: true }), TOKEN)))
        .code,
    ).toBe("forbidden");
    expect(
      (
        await caught(
          adapter.sendApprovalButtons(OWNER_CHAT, approval({ sideEffect: "financial" }), TOKEN),
        )
      ).code,
    ).toBe("forbidden");
    expect(
      (await caught(adapter.sendApprovalButtons(OWNER_CHAT, approval({ kind: "purchase" }), TOKEN)))
        .code,
    ).toBe("forbidden");
    expect(api.calls).toEqual([]);
  });

  it("sends an oversized card as a device pointer with no keyboard", async () => {
    const { adapter, api } = await harness();
    await adapter.sendApprovalButtons(
      OWNER_CHAT,
      approval({ details: { body: "lorem ipsum ".repeat(500) } }),
      TOKEN,
    );
    const [call] = api.calls;
    expect(call?.payload).not.toHaveProperty("reply_markup");
    expect(call?.payload).not.toHaveProperty("parse_mode");
    expect(call?.payload.text).toContain("review it in Psyche on a paired device");
  });

  it("never puts the answer token in any outgoing payload", async () => {
    const { adapter, api } = await harness();
    await adapter.sendApprovalButtons(OWNER_CHAT, approval(), TOKEN);
    expect(JSON.stringify(api.calls)).not.toContain(TOKEN);
  });
});
