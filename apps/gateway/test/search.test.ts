import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteLibraryItem, insertLibraryItem } from "@psyche/db";
import type { ModelEvent, SearchHit, SearchIndexStatus } from "@psyche/protocol";
import { fakeEmbedder } from "@psyche/search";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import type { SemanticEngines } from "../src/compose/search-semantic.ts";
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

async function start(reuseHome = false, semanticEngines?: SemanticEngines) {
  if (!reuseHome) home = mkdtempSync(join(tmpdir(), "psyche-search-"));
  const model = new FakeModelProvider({ capabilities: { contextWindow: 200_000 } });
  model.script([say("Booked the dentist for Thursday at 3 pm.")]);
  composed = await composeGateway({
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: model, model: "fake/model" },
    ...(semanticEngines === undefined ? {} : { semanticEngines }),
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

describe("search backfill, status and reindex (S2)", () => {
  it("fills a new index from the stores at start and reports status", async () => {
    let { gw, owner } = await start();
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main", title: "Errands" },
      ik(),
    );
    await owner.call("chat.send", { threadId: thread.id, content: "Book the dentist" }, ik());
    await gw.gateway.context.sessions.idle();
    for (const c of clients.splice(0)) c.close();
    await gw.stop("test");
    composed = null;
    // The index is derived data: delete it, as an upgrade from a build without S1 looks.
    for (const f of ["search.sqlite", "search.sqlite-wal", "search.sqlite-shm"])
      rmSync(join(home, "state", f), { force: true });

    ({ gw, owner } = await start(true));
    await gw.search.backfill.start().done;
    const res = await owner.call<{ hits: SearchHit[] }>("search.query", { query: "dentist" });
    expect(res.hits.map((h) => h.threadId)).toContain(thread.id);
    const status = await owner.call<SearchIndexStatus>("search.status", {});
    expect(status.backfill.state).toBe("done");
    expect(status.docs).toBeGreaterThanOrEqual(3);
  });

  it("reindex drops rows whose store row is gone; Library items are reconciled", async () => {
    const { gw, owner } = await start();
    await gw.search.backfill.start().done;
    // A Library file with text, written outside any event.
    mkdirSync(join(home, "library", "docs"), { recursive: true });
    writeFileSync(join(home, "library", "docs", "lisbon.md"), "Hotel near the Alfama, 3 nights");
    const item = insertLibraryItem(gw.db, {
      kind: "document",
      name: "lisbon.md",
      mime: "text/markdown",
      path: "docs/lisbon.md",
      size: 31,
      sha256: "sha256:0",
      origin: "upload",
    });
    await gw.search.syncLibrary();
    const find = async (q: string) =>
      (await owner.call<{ hits: SearchHit[] }>("search.query", { query: q })).hits.map((h) => h.id);
    expect(await find("alfama")).toEqual([item.id]);

    // A stale row the index never heard about being deleted.
    await gw.search.index.index({
      id: "msg_gone",
      kind: "message",
      title: "Old",
      text: "alfama tram",
      provenance: "owner",
      createdAt: 1,
    });
    expect((await find("tram")).length).toBe(1);
    const { started } = await owner.call<{ started: boolean }>("search.reindex", {}, ik());
    expect(started).toBe(true);
    await gw.search.backfill.start().done;
    await owner.waitForEvent(
      (f) =>
        f.event === "search.status.updated" &&
        (f.payload as SearchIndexStatus).backfill.state === "done",
    );
    expect(await find("tram")).toEqual([]);
    expect(await find("alfama")).toEqual([item.id]);

    deleteLibraryItem(gw.db, item.id);
    await gw.search.syncLibrary();
    expect(await find("alfama")).toEqual([]);
  });
});

describe("semantic search (S3)", () => {
  const GROUPS = [
    ["budget", "spend", "money"],
    ["trip", "lisbon", "travel"],
  ];

  it("turns on from settings, downloads with progress, and finds paraphrases", async () => {
    const downloads: number[] = [];
    const engines: SemanticEngines = {
      async builtin(spec, onDownload) {
        // Stands in for the verified download; no model is fetched or run.
        onDownload(0, spec.model.sizeBytes);
        onDownload(spec.model.sizeBytes, spec.model.sizeBytes);
        downloads.push(spec.model.sizeBytes);
        return fakeEmbedder(GROUPS, { floor: 0.5 });
      },
      router: () => ({ blocked: "cloud_not_allowed" }),
    };
    const { gw, owner } = await start(false, engines);
    await gw.search.backfill.start().done;
    const { thread } = await owner.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main", title: "Plans" },
      ik(),
    );
    await owner.call(
      "chat.send",
      { threadId: thread.id, content: "How much can we spend in Lisbon next month?" },
      ik(),
    );
    await gw.gateway.context.sessions.idle();
    await gw.search.idle();
    const query = async () =>
      (await owner.call<{ hits: SearchHit[] }>("search.query", { query: "trip budget" })).hits;
    expect(await query()).toEqual([]);

    await owner.call("settings.set", { key: "search.semantic.enabled", value: true }, ik());
    await gw.search.idle();
    await gw.search.semanticReady();
    await gw.search.semantic.idle();
    expect(downloads).toHaveLength(1);
    const hits = await query();
    expect(hits.map((h) => [h.threadId, h.match])).toEqual([[thread.id, "semantic"]]);
    expect(hits[0]?.snippet).toContain("Lisbon");
    const status = await owner.call<SearchIndexStatus>("search.status", {});
    expect(status.semantic).toMatchObject({ enabled: true, engine: "builtin", state: "ready" });
    expect(status.semantic?.vectors).toBeGreaterThan(0);

    // The router engine refuses a cloud-bound embedding role.
    await owner.call("settings.set", { key: "search.semantic.engine", value: "router" }, ik());
    await gw.search.idle();
    await gw.search.semanticReady();
    expect((await owner.call<SearchIndexStatus>("search.status", {})).semantic).toMatchObject({
      state: "blocked",
      blocked: "cloud_not_allowed",
    });
    expect(await query()).toEqual([]);

    // Off drops every vector.
    await owner.call("settings.set", { key: "search.semantic.enabled", value: false }, ik());
    await gw.search.idle();
    await gw.search.semanticReady();
    const n = gw.search.index.db.prepare("SELECT count(*) AS n FROM search_vectors").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
    expect((await owner.call<SearchIndexStatus>("search.status", {})).semantic?.state).toBe("off");
  });
});
