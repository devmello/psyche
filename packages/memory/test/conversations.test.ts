import { describe, expect, it } from "vitest";
import { CONVERSATION_LIMITS, parseConversations } from "../src/conversations.ts";

// Small synthetic exports only.
const claudeExport = JSON.stringify([
  {
    uuid: "c1",
    name: "Trip ideas",
    created_at: "2025-03-01T10:00:00.000Z",
    updated_at: "2025-03-01T10:05:00.000Z",
    chat_messages: [
      { uuid: "m1", sender: "human", text: "Where to?", created_at: "2025-03-01T10:00:00.000Z" },
      {
        uuid: "m2",
        sender: "assistant",
        text: "ignored when content exists",
        content: [{ type: "text", text: "Lisbon." }],
        created_at: "2025-03-01T10:01:00.000Z",
      },
      { uuid: "m3", sender: "system", text: "skip me", created_at: "2025-03-01T10:02:00.000Z" },
    ],
  },
  { uuid: "c2", name: "Empty", chat_messages: [] },
  { name: "No id", chat_messages: [] },
]);

const node = (
  parent: string | null,
  children: string[],
  role?: string,
  text?: string,
  t?: number,
) => ({
  parent,
  children,
  message:
    role === undefined
      ? null
      : { author: { role }, content: { content_type: "text", parts: [text] }, create_time: t },
});

const chatgptExport = JSON.stringify([
  {
    id: "g1",
    title: "Recipe",
    create_time: 1_740_000_000,
    update_time: 1_740_000_100,
    current_node: "n3b",
    mapping: {
      root: node(null, ["n1"]),
      n1: node("root", ["n2"], "user", "How do I bake bread?", 1_740_000_001),
      n2: node("n1", ["n3a", "n3b"], "assistant", "Mix flour.", 1_740_000_002),
      n3a: node("n2", [], "assistant", "OLD BRANCH", 1_740_000_003),
      n3b: node("n2", [], "assistant", "Then knead.", 1_740_000_004),
      sys: node("root", [], "system", "hidden", 1_740_000_000),
    },
  },
]);

describe("parseConversations", () => {
  it("reads a claude.ai export with roles, titles and original timestamps", () => {
    const { conversations, skipped } = parseConversations("claude", claudeExport);
    expect(conversations).toHaveLength(1);
    const c = conversations[0];
    expect(c?.key).toBe("claude:c1");
    expect(c?.title).toBe("Trip ideas");
    expect(c?.createdAt).toBe("2025-03-01T10:00:00.000Z");
    expect(c?.messages).toEqual([
      { role: "user", text: "Where to?", at: "2025-03-01T10:00:00.000Z" },
      { role: "agent", text: "Lisbon.", at: "2025-03-01T10:01:00.000Z" },
    ]);
    expect(skipped.map((s) => s.reason).sort()).toEqual(["empty", "invalid"]);
  });

  it("reads a ChatGPT export along the branch the owner saw", () => {
    const { conversations } = parseConversations("chatgpt", chatgptExport);
    const c = conversations[0];
    expect(c?.key).toBe("chatgpt:g1");
    expect(c?.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:How do I bake bread?",
      "agent:Mix flour.",
      "agent:Then knead.",
    ]);
    expect(c?.messages[0]?.at).toBe(new Date(1_740_000_001 * 1000).toISOString());
    expect(c?.createdAt).toBe(new Date(1_740_000_000 * 1000).toISOString());
  });

  it("caps the number of conversations and reports the rest as skipped", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      uuid: `c${i}`,
      name: `T${i}`,
      chat_messages: [{ sender: "human", text: "hi", created_at: "2025-01-01T00:00:00Z" }],
    }));
    const { conversations, skipped } = parseConversations("claude", JSON.stringify(many), {
      conversations: 2,
    });
    expect(conversations.map((c) => c.title)).toEqual(["T0", "T1"]);
    expect(skipped).toEqual([
      { title: "T2", reason: "too_many" },
      { title: "T3", reason: "too_many" },
      { title: "T4", reason: "too_many" },
    ]);
  });

  it("skips an over-long conversation and cuts an over-long message", () => {
    const msg = (text: string) => ({ sender: "human", text, created_at: "2025-01-01T00:00:00Z" });
    const big = {
      uuid: "big",
      name: "Big",
      chat_messages: Array.from({ length: CONVERSATION_LIMITS.messagesPerConversation + 1 }, () =>
        msg("x"),
      ),
    };
    const long = {
      uuid: "long",
      name: "Long",
      chat_messages: [msg("y".repeat(CONVERSATION_LIMITS.messageChars + 50))],
    };
    const { conversations, skipped } = parseConversations("claude", JSON.stringify([big, long]));
    expect(skipped).toEqual([{ title: "Big", reason: "too_large" }]);
    expect(conversations[0]?.messages[0]?.text).toContain("[truncated: 50 more characters]");
  });

  it("refuses text that is not an export, and oversized input", () => {
    expect(() => parseConversations("claude", "not json")).toThrow();
    expect(() => parseConversations("claude", '{"a":1}')).toThrow();
    expect(() =>
      parseConversations("claude", " ".repeat(CONVERSATION_LIMITS.inputChars + 1)),
    ).toThrow();
  });

  it("counts the cap after dedupe: 205 then the next batch of 5", () => {
    const many = Array.from({ length: 205 }, (_, i) => ({
      uuid: `c${i}`,
      name: `T${i}`,
      chat_messages: [{ sender: "human", text: "hi", created_at: "2025-01-01T00:00:00Z" }],
    }));
    const text = JSON.stringify(many);
    const first = parseConversations("claude", text, { conversations: 200 });
    expect(first.conversations).toHaveLength(200);
    expect(first.skipped).toHaveLength(5);
    const known = new Set(first.conversations.map((c) => c.key));
    const second = parseConversations("claude", text, {
      conversations: 200,
      isKnown: (k) => known.has(k),
    });
    expect(second.duplicates).toBe(200);
    expect(second.conversations.map((c) => c.title)).toEqual([
      "T200",
      "T201",
      "T202",
      "T203",
      "T204",
    ]);
    expect(second.skipped).toEqual([]);
  });

  it("clamps times, fixes lone surrogates, strips bidi from titles, reports repeated ids", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const m = (at: string, text: string) => ({ sender: "human", text, created_at: at });
    const text = JSON.stringify([
      {
        uuid: "a",
        name: "Re\u202Eport\u200B",
        chat_messages: [m("5138-01-01T00:00:00Z", "x\uD800y")],
      },
      { uuid: "a", name: "Again", chat_messages: [m("2025-01-01T00:00:00Z", "z")] },
      { uuid: "b", name: "Old", chat_messages: [m("1801-01-01T00:00:00Z", "z")] },
    ]);
    const { conversations, skipped } = parseConversations("claude", text, { now });
    expect(conversations[0]?.title).toBe("Report");
    expect(conversations[0]?.messages[0]?.text).toBe("x\uFFFDy");
    expect(Date.parse(conversations[0]?.messages[0]?.at ?? "")).toBeLessThanOrEqual(
      now.getTime() + 86_400_000,
    );
    expect(conversations[1]?.messages[0]?.at).toBe("1990-01-01T00:00:00.000Z");
    expect(skipped).toEqual([{ title: "Again", reason: "invalid" }]);
  });
});
