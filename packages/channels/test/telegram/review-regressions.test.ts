import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import { approval, harness, OWNER_CHAT, update } from "./helpers.ts";

// Regressions for the S10 pre-PR security review (findings 1, 5, 7, 9).

describe("Telegram review regressions", () => {
  it("a reply quoting a forwarded message has no quoted author (finding 1)", async () => {
    const { adapter, inbound } = await harness();
    const forwarded = update("forwardUser").message;
    const reply = structuredClone(update("dmText")) as Update;
    if (reply.message === undefined || forwarded === undefined) throw new Error("fixture");
    reply.message.text = "thoughts?";
    reply.message.reply_to_message = forwarded as never;
    await adapter.handleUpdate(reply);
    expect(inbound[0]?.quoted).toEqual({ text: forwarded.text, fromSelf: false });
  });

  it("a forwarded mention entity is not a mention (finding 7)", async () => {
    const { adapter, inbound } = await harness();
    const u = structuredClone(update("groupMention")) as Update;
    if (u.message === undefined) throw new Error("fixture");
    (u.message as unknown as Record<string, unknown>).forward_origin = {
      type: "hidden_user",
      date: 1792357200,
      sender_user_name: "Someone",
    };
    await adapter.handleUpdate(u);
    expect(inbound[0]?.mentioned).toBe(false);
    expect(inbound[0]?.forwardedFrom).toEqual({ senderName: "Someone" });
  });

  it("destructive approvals follow the channel opt-in (finding 5)", async () => {
    const strict = await harness();
    await expect(
      strict.adapter.sendApprovalButtons(
        OWNER_CHAT,
        approval({ sideEffect: "destructive" }),
        "tok",
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const optIn = await harness({ allowDestructiveApprovals: true });
    await optIn.adapter.sendApprovalButtons(
      OWNER_CHAT,
      approval({ sideEffect: "destructive" }),
      "tok",
    );
    expect(optIn.api.callsTo("sendMessage")).toHaveLength(1);
  });

  it("resends as plain text when Telegram cannot parse the HTML (finding 9)", async () => {
    const { adapter, api } = await harness();
    let first = true;
    const ok = { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } };
    api.override("sendMessage", () => {
      if (first) {
        first = false;
        return {
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities: unexpected end tag",
        };
      }
      return ok;
    });
    await adapter.send({ chatId: OWNER_CHAT, text: "**bold** text", format: "markdown" });
    const calls = api.callsTo("sendMessage");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.payload.parse_mode).toBe("HTML");
    expect(calls[1]?.payload.parse_mode).toBeUndefined();
    expect(calls[1]?.payload.text).toBe("bold text");
  });
});
