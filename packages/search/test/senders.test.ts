import type { Message } from "@psyche/protocol";
import { SAMPLE_THREAD } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { messageDoc } from "../src/adapters.ts";
import { SearchIndexer } from "../src/indexer.ts";
import { messageSender, senderKeyOf, senderNeedle } from "../src/senders.ts";
import { doc, setup } from "./helpers.ts";

const peerThread = { title: "Alex Rivera", sessionKey: "telegram:peer:12345" };
const ownerThread = { title: "Plans", sessionKey: "owner:main" };

describe("messageSender: who wrote a chat message", () => {
  it.each([
    [
      "owner's own turn, with the profile name",
      { role: "user", provenance: "owner" } as const,
      ownerThread,
      { owner: "Jane Ortiz" },
      { name: "Jane Ortiz", aliases: ["me"] },
    ],
    [
      "owner's own turn, no profile name",
      { role: "user", provenance: "owner" } as const,
      ownerThread,
      {},
      { name: "Me", aliases: ["me"] },
    ],
    [
      "assistant turn is the agent",
      { role: "agent", provenance: "agent" } as const,
      ownerThread,
      { owner: "Jane Ortiz" },
      { name: "Psyche" },
    ],
    [
      "channel peer's turn: chat title, peer id as alias",
      { role: "user", provenance: "untrusted" } as const,
      peerThread,
      { owner: "Jane Ortiz" },
      { name: "Alex Rivera", aliases: ["12345"] },
    ],
    [
      "channel peer with no title: the id",
      { role: "user", provenance: "untrusted" } as const,
      { title: "  ", sessionKey: "telegram:peer:12345" },
      {},
      { name: "12345" },
    ],
    [
      "untrusted turn in an imported export has no known sender",
      { role: "user", provenance: "untrusted" } as const,
      { title: "Old chat", sessionKey: "import:claude:abc" },
      {},
      undefined,
    ],
    [
      "system turn has no sender",
      { role: "system", provenance: "system" } as const,
      ownerThread,
      {},
      undefined,
    ],
  ])("%s", (_name, message, thread, names, expected) => {
    expect(messageSender(message, thread, names)).toEqual(expected);
  });
});

describe("from: keys", () => {
  it("keeps the plain name as the key when there are no aliases (as before)", () => {
    expect(senderKeyOf("Alice Chen")).toBe("alice chen");
    expect(senderKeyOf(undefined)).toBeNull();
  });

  it("`me` needs the alias mark, so names that contain the letters do not match", () => {
    const emerson = senderKeyOf("Emerson Lake") ?? "";
    const owner = senderKeyOf("Jane Ortiz", ["me"]) ?? "";
    expect(emerson.includes(senderNeedle("me"))).toBe(false);
    expect(owner.includes(senderNeedle("me"))).toBe(true);
    // Any other term is the plain substring, as before.
    expect(emerson.includes(senderNeedle("EMERSON"))).toBe(true);
  });
});

describe("indexing chat messages with a sender", () => {
  const ownerMsg = {
    id: "M-owner",
    threadId: SAMPLE_THREAD.id,
    seq: 1,
    role: "user",
    blocks: [{ type: "text", md: "invoice for the dentist" }],
    provenance: "owner",
    createdAt: "2026-11-20T09:00:00Z",
  } as unknown as Message;
  const agentMsg = {
    ...ownerMsg,
    id: "M-agent",
    seq: 2,
    role: "agent",
    provenance: "agent",
    blocks: [{ type: "text", md: "invoice drafted for the dentist" }],
  } as unknown as Message;

  it("from:me finds the owner's messages; the agent's name finds the assistant's", async () => {
    const { index } = setup();
    const indexer = new SearchIndexer(index, {
      lookupThread: async () => ({ ...SAMPLE_THREAD }),
      senderOf: (m, t) => messageSender(m, t, { owner: "Jane Ortiz" }),
    });
    await indexer.handle("chat.message", { message: ownerMsg });
    await indexer.handle("chat.message", { message: agentMsg });
    await index.index(
      doc({
        id: "mail-emerson",
        kind: "connector",
        title: "Invoice",
        text: "invoice",
        from: "Emerson Lake",
      }),
    );

    const ids = async (q: string) => (await index.query({ q })).hits.map((h) => h.id).sort();
    expect(await ids("invoice from:me")).toEqual(["M-owner"]);
    expect(await ids("invoice from:jane")).toEqual(["M-owner"]);
    expect(await ids("invoice from:psyche")).toEqual(["M-agent"]);
    expect(await ids("invoice from:emerson")).toEqual(["mail-emerson"]);
    // `me` must not pick up "Emerson" or the agent.
    expect(await ids("invoice from:me")).not.toContain("mail-emerson");
  });

  it("a document indexed before senders existed gets its sender on the next index", async () => {
    const { index } = setup();
    // The pre-version-2 shape: the same message, no sender.
    await index.index(messageDoc(ownerMsg, { thread: { ...SAMPLE_THREAD } }));
    expect((await index.query({ q: "invoice from:me" })).hits).toEqual([]);

    // The backfill re-indexes every message in place (an upsert).
    await index.index(
      messageDoc(ownerMsg, {
        thread: { ...SAMPLE_THREAD },
        sender: "Jane Ortiz",
        senderAliases: ["me"],
      }),
    );
    expect((await index.query({ q: "invoice from:me" })).hits.map((h) => h.id)).toEqual([
      "M-owner",
    ]);
  });
});
