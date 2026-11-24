import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMessage, createThread, openDb, type PsycheDb } from "@psyche/db";
import { createSearchIndex, type SearchDoc } from "@psyche/search";
import { afterEach, describe, expect, it } from "vitest";
import { searchSources } from "../src/compose/search-sources.ts";

const dirs: string[] = [];
const dbs: PsycheDb[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.sqlite.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A database with one owner chat, one assistant reply, and one channel peer's message. */
function seeded(): PsycheDb {
  const home = mkdtempSync(join(tmpdir(), "psyche-senders-"));
  dirs.push(home);
  const db = openDb(join(home, "psyche.sqlite"));
  dbs.push(db);
  createThread(db, {
    id: "T-owner",
    kind: "side",
    sessionKey: "owner:side:T-owner",
    title: "Dentist",
  });
  createThread(db, {
    id: "T-peer",
    kind: "side",
    sessionKey: "telegram:peer:12345",
    title: "Alex Rivera",
  });
  const text = (md: string) => [{ type: "text" as const, md }];
  appendMessage(
    db,
    {
      threadId: "T-owner",
      role: "user",
      blocks: text("invoice for the dentist"),
      provenance: "owner",
    },
    { expectedWriterRunId: null },
  );
  appendMessage(
    db,
    { threadId: "T-owner", role: "agent", blocks: text("invoice drafted"), provenance: "agent" },
    { expectedWriterRunId: null },
  );
  appendMessage(
    db,
    {
      threadId: "T-peer",
      role: "user",
      blocks: text("invoice from my landlord"),
      provenance: "untrusted",
    },
    { expectedWriterRunId: null },
  );
  return db;
}

/** The backfill's messages source, paged to the end, over the seeded database. */
async function messageDocs(db: PsycheDb, ownerName: string | undefined): Promise<SearchDoc[]> {
  const source = searchSources({
    db,
    home: "/unused",
    tasks: { get: async () => undefined, actions: async () => [] },
    ownerName: () => ownerName,
  }).find((s) => s.name === "messages");
  if (source === undefined) throw new Error("no messages source");
  const docs: SearchDoc[] = [];
  let cursor: string | undefined;
  do {
    const page = await source.page(cursor);
    docs.push(...page.docs);
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  return docs;
}

describe("chat messages carry their sender into the search index", () => {
  it("from:me, the owner's name and the agent's name each find their own messages", async () => {
    const db = seeded();
    const index = createSearchIndex({ now: () => Date.parse("2026-11-23T10:00:00Z") });
    await index.indexMany(await messageDocs(db, "Jane Ortiz"));

    const ids = async (q: string) => (await index.query({ q })).hits.map((h) => h.id).sort();
    const owner = await ids("invoice from:me");
    expect(owner).toHaveLength(1);
    expect(await ids("invoice from:jane")).toEqual(owner);
    expect(await ids("invoice from:psyche")).toHaveLength(1);
    expect(await ids("invoice from:psyche")).not.toEqual(owner);
    expect(await ids("invoice from:alex")).toHaveLength(1);
  });

  it("an existing message that was indexed without a sender gets one on re-index", async () => {
    const db = seeded();
    const index = createSearchIndex({ now: () => Date.parse("2026-11-23T10:00:00Z") });
    // What an index built before this change holds: the same documents, no senders.
    const before = (await messageDocs(db, "Jane Ortiz")).map(
      ({ from: _f, fromAliases: _a, ...d }) => d,
    );
    await index.indexMany(before);
    expect((await index.query({ q: "invoice from:me" })).hits).toEqual([]);

    // The backfill runs again over the same rows and upserts them in place.
    await index.indexMany(await messageDocs(db, "Jane Ortiz"));
    expect((await index.query({ q: "invoice from:me" })).hits).toHaveLength(1);
  });
});
