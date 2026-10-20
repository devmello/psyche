import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMessagesPage } from "@psyche/db";
import type { ModelEvent, ModelRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { OTHER_CHATS_SETTING, relatedQuery } from "../src/compose/other-chats.ts";
import { CROSS_THREAD_SETTING } from "../src/compose/thread-tools.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * E12 scenario: the main chat settles the launch plan; with the owner's standing grant
 * (`threads.otherChats`), a side chat asking about the launch gets the main chat's digest as
 * untrusted context and a "From your other chats" block, and the sharing is audited. Without the
 * grant nothing crosses.
 */

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const say = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "usage", usage },
  { type: "finish", reason: "stop" },
];

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function turn(owner: TestClient, threadId: string, content: string) {
  await owner.call("chat.send", { threadId, content }, ik());
  await composed?.gateway.context.sessions.idle();
}

describe("From your other chats (E12)", () => {
  it("brings the main chat's plan into a side chat only with the owner's grant, audited", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-other-chats-"));
    const model = new FakeModelProvider({ capabilities: { contextWindow: 200_000 } });
    model.script([
      say("Noted: the launch ships on November 3 with Maya; press goes out on the 4th."),
      say("I don't see a launch date in this chat."),
      say("The launch is on November 3, with Maya."),
    ]);
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: model, model: "fake/model" },
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    const thread = async (kind: "main" | "side", title: string) =>
      (await owner.call<{ thread: { id: string } }>("threads.create", { kind, title }, ik())).thread
        .id;

    // 1. The main chat settles the plan; its digest lands in the index.
    const main = await thread("main", "Launch plan");
    await turn(owner, main, "Plan for the launch: ship on November 3 with Maya, press on the 4th.");
    await vi.waitFor(async () => {
      const { hits } = await (composed as ComposedGateway).otherChats.index.query({
        q: "launch",
        filters: { kinds: ["thread"] },
      });
      expect(hits.map((h) => h.id)).toContain(`thread-digest:${main}`);
    });

    // 2. Without the grant, a side chat gets nothing from it.
    const side = await thread("side", "Errands");
    await turn(owner, side, "When is the launch again?");
    expect((model.requests[1] as ModelRequest).system).not.toContain("From your other chats");

    // 3. With the grant: untrusted context, a block in the reply, an audit entry.
    await owner.call("settings.set", { key: OTHER_CHATS_SETTING, value: true }, ik());
    await turn(owner, side, "When is the launch again?");
    const system = (model.requests[2] as ModelRequest).system ?? "";
    expect(system).toContain('source="context:other-chats" provenance="untrusted"');
    expect(system).toContain(`"Launch plan"`);
    expect(system).toContain("November 3");
    const reply = listMessagesPage(composed.db, side, { limit: 10 }).messages.at(-1);
    const block = reply?.blocks.find((b) => b.type === "related_threads");
    expect(block).toMatchObject({
      type: "related_threads",
      items: [{ threadId: main, title: "Launch plan" }],
    });
    const audit = await composed.audit.list({ kind: "threads.other_chats_shared" });
    expect(audit.map((e) => [e.subject, e.data])).toEqual([
      [{ threadId: side }, { threadIds: [main] }],
    ]);

    // 4. Only digests cross: the raw chat needs thread_read, whose first read asks.
    await owner.call("settings.set", { key: CROSS_THREAD_SETTING, value: true }, ik());
    await vi.waitFor(() => expect(composed?.loop.registry.get("thread_read")).toBeDefined());
    const read = composed.loop.registry.get("thread_read");
    const desc = read?.describeCall?.({ threadId: main });
    expect(desc?.target).toEqual({ kind: "account", value: `thread:${main}` });
    const decision = await composed.broker.decide(
      {
        tool: "thread_read",
        sideEffect: "read",
        targetKind: "account",
        ...(desc?.target === undefined ? {} : { target: desc.target }),
        ...(desc?.kind === undefined ? {} : { kind: desc.kind }),
        params: { threadId: main },
        paramsHash: `sha256:${"0".repeat(64)}`,
      },
      { threadId: side, runId: "run_check", permissionMode: "balanced", taint: false },
    );
    expect(decision.decision).toBe("ask");
  }, 30_000);

  it("turns the owner's words into an OR query of content words", () => {
    expect(relatedQuery("When is the launch again?")).toBe("launch");
    expect(relatedQuery("ok, thanks")).toBe("thanks");
    expect(relatedQuery("is it?")).toBeUndefined();
  });
});
