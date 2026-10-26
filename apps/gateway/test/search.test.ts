import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelEvent, SearchHit } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** S1: the Gateway indexes chats from its own events and answers `search.query` (owner scope). */

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

async function start() {
  home = mkdtempSync(join(tmpdir(), "psyche-search-"));
  const model = new FakeModelProvider({ capabilities: { contextWindow: 200_000 } });
  model.script([say("Booked the dentist for Thursday at 3 pm.")]);
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: model, model: "fake/model" },
  });
  const owner = await adminClient(composed.gateway);
  clients.push(owner);
  return { gw: composed, owner };
}

describe("search.query (S1)", () => {
  it("finds a chat by its messages, collapsed to one hit per thread, with a deep link", async () => {
    const { gw, owner } = await start();
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main", title: "Errands" },
      ik(),
    );
    await owner.call("chat.send", { threadId: thread.id, content: "Book the dentist" }, ik());
    await gw.gateway.context.sessions.idle();
    await gw.search.idle();

    const res = await owner.call<{ hits: SearchHit[]; total?: number }>("search.query", {
      query: "dentist thursday",
    });
    // One result for the chat: its best message, which opens the chat at that message.
    expect(res.hits).toHaveLength(1);
    const [hit] = res.hits;
    expect(hit?.threadId).toBe(thread.id);
    expect(hit?.route).toBe(`/chat/${thread.id}?message=${hit?.id}`);
    expect(hit?.provenance).toBe("agent");
    expect(hit?.snippetHighlights?.length).toBeGreaterThan(0);

    // `in:` filters and wire scopes narrow it; an unrelated word finds nothing.
    const messages = await owner.call<{ hits: SearchHit[] }>("search.query", {
      query: "dentist",
      scopes: ["messages"],
    });
    expect(messages.hits.length).toBe(2);
    expect(messages.hits.every((h) => h.threadId === thread.id)).toBe(true);
    const none = await owner.call<{ hits: SearchHit[] }>("search.query", { query: "zebra" });
    expect(none.hits).toEqual([]);
  });

  it("drops a deleted thread from the index", async () => {
    const { gw, owner } = await start();
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main", title: "Dentist plans" },
      ik(),
    );
    await gw.search.idle();
    expect(
      (await owner.call<{ hits: SearchHit[] }>("search.query", { query: "dentist" })).hits,
    ).toHaveLength(1);
    await owner.call("threads.delete", { threadId: thread.id }, ik());
    await gw.search.idle();
    expect(
      (await owner.call<{ hits: SearchHit[] }>("search.query", { query: "dentist" })).hits,
    ).toEqual([]);
  });

  it("keeps designated-person scopes apart for delegated viewers", async () => {
    const { gw } = await start();
    await gw.search.index.indexMany([
      {
        id: "t-owner",
        kind: "thread",
        title: "Owner budget",
        text: "budget",
        provenance: "owner",
        createdAt: 1,
      },
      {
        id: "t-alice",
        kind: "thread",
        title: "Alice budget",
        text: "budget",
        provenance: "owner",
        createdAt: 1,
        scopeKey: "persona:alice",
      },
    ]);
    const as = async (viewer?: { kind: "delegated"; scopeKey: string }) =>
      (await gw.search.index.search({ q: "budget", ...(viewer ? { viewer } : {}) })).hits.map(
        (h) => h.id,
      );
    expect((await as()).sort()).toEqual(["t-alice", "t-owner"]);
    expect(await as({ kind: "delegated", scopeKey: "persona:alice" })).toEqual(["t-alice"]);
    expect(await as({ kind: "delegated", scopeKey: "persona:bob" })).toEqual([]);
  });
});
