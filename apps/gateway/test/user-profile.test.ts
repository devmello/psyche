import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMessagesPage } from "@psyche/db";
import type { LearnedFact, ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { LEARN_SYSTEM, parseProposals, USER_PROFILE_SETTING } from "../src/compose/user-profile.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Learning about the owner (#509), scripted: the owner says two durable things, the utility
 * model proposes them (plus one it must not keep), both land in USER.md's dated Learned
 * section with the thread id, the chat gets a `learned` note, the write is audited, Undo
 * removes one, and with `memory.userProfile` off nothing more is learned.
 */

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const reply = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  {
    type: "usage",
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

/** The main model just answers; the learn prompt answers from what the owner said. */
function scripted(): ModelProvider & { learnCalls: string[] } {
  const p = {
    id: "scripted",
    learnCalls: [] as string[],
    capabilities: async () => ({ contextWindow: 64_000 }) as never,
    async *stream(req: ModelRequest) {
      if (req.system === LEARN_SYSTEM) {
        const part = req.messages[0]?.parts[0];
        const text = part?.type === "text" ? part.text : "";
        p.learnCalls.push(text);
        const facts = text.includes("Avery")
          ? [
              { text: "Goes by Avery", kind: "name" },
              { text: "Prefers tea over coffee", kind: "preference" },
              // A health detail the model should not have proposed: memory refuses it.
              { text: "Takes insulin every morning", kind: "routine" },
            ]
          : [{ text: "Has a sister named Maya", kind: "person" }];
        yield* reply(JSON.stringify({ facts }));
        return;
      }
      yield* reply("Got it.");
    },
  };
  return p;
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, ms = 3_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("parseProposals", () => {
  it("keeps well-formed facts, defaults the kind and ignores anything else", () => {
    expect(parseProposals('Here: {"facts":[{"text":" Likes jazz ","kind":"x"}]}')).toEqual([
      { text: "Likes jazz", kind: "other" },
    ]);
    expect(parseProposals("nothing")).toEqual([]);
    expect(parseProposals('{"facts":"no"}')).toEqual([]);
  });
});

describe("learning about the owner (Gateway)", () => {
  it("writes two facts with the thread id, notes them with Undo, and stops when switched off", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-user-profile-"));
    const model = scripted();
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: model, model: "scripted/main", utilityModel: "scripted/utility" },
    });
    const gw = composed;
    const owner = await adminClient(gw.gateway);
    clients.push(owner);
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      ik(),
    );
    const turn = async (content: string) => {
      await owner.call("chat.send", { threadId: thread.id, content }, ik());
      await gw.gateway.context.sessions.idle();
    };
    const learnedNote = () =>
      listMessagesPage(gw.db, thread.id, { limit: 100 }).messages.find((m) =>
        m.blocks.some((b) => b.type === "learned"),
      );

    // 1. Two facts land; the health detail is refused.
    await turn("I'm Avery, and I always prefer tea over coffee.");
    const note = await waitFor(learnedNote);
    const items = (note.blocks[0] as { items: LearnedFact[] }).items;
    expect(items.map((i) => i.text)).toEqual(["Goes by Avery", "Prefers tea over coffee"]);
    expect(items.every((i) => i.threadId === thread.id)).toBe(true);
    const user = (await gw.memory.readFile("USER.md"))?.content ?? "";
    expect(user).toContain("## Learned");
    expect(user).toContain(`thread:${thread.id}`);
    expect(user).toContain("Prefers tea over coffee");
    expect(user).not.toContain("insulin");
    const audits = await gw.audit.list({ kind: "memory.user_profile.learned" });
    expect(audits).toHaveLength(1);
    // The audit names ids and reasons, never the text.
    expect(JSON.stringify(audits[0])).not.toContain("tea");

    // 2. Undo.
    const tea = items.find((i) => i.text.includes("tea"));
    const undone = await owner.call<{ removed: boolean }>(
      "memory.forgetLearned",
      { factId: tea?.factId },
      ik(),
    );
    expect(undone.removed).toBe(true);
    const after = (await gw.memory.readFile("USER.md"))?.content ?? "";
    expect(after).not.toContain("Prefers tea over coffee");
    expect(after).toContain("Goes by Avery");

    // 3. Switched off: the owner says something durable and nothing is learned.
    await owner.call(
      "settings.set",
      { key: USER_PROFILE_SETTING, value: { enabled: false } },
      ik(),
    );
    const calls = model.learnCalls.length;
    await turn("My sister Maya is visiting next month, she lives in Lisbon.");
    await new Promise((r) => setTimeout(r, 50));
    expect(model.learnCalls.length).toBe(calls);
    expect((await gw.memory.readFile("USER.md"))?.content).not.toContain("Maya");
  }, 30_000);
});
