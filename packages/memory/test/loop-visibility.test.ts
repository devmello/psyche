import { openDb, type PsycheDb } from "@psyche/db";
import { PsycheError } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGraphHandlers } from "../src/graph/handlers.ts";
import { createLoopVisibility, scrubLoopForRemote } from "../src/graph/loop-visibility.ts";
import { GraphStore } from "../src/graph/store.ts";

/**
 * The remote-viewer scrub on `memory.loops.*` and `memory.entities.get`
 * (docs/design/promise-ledger-2026.md section 7.2), on a real migrated SQLite database.
 */

let db: PsycheDb;
let g: GraphStore;
let sam: string;
const ids: Record<string, string> = {};

const NOW = "2026-11-24T10:00:00.000Z";

function citation(loopId: string, source: string, n: number): void {
  db.sqlite
    .prepare(
      `INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, "end",
         source_hash, provenance, observed_at, created_at)
       VALUES (?, 'loop', ?, ?, 'ref', 'I will send the deck on Friday', 0, 5, 'h', 'untrusted', ?, ?)`,
    )
    .run(`cit_${n}`, loopId, source, NOW, NOW);
}

/** One loop per source mix, each with a quote, a person and a project, then the ledger columns. */
function loop(
  name: string,
  opts: { kind: string | null; visible: 0 | 1; cite?: string; interaction?: "message" | "mail" },
  n: number,
): void {
  let sourceInteractionId: string | null = null;
  if (opts.interaction !== undefined) {
    sourceInteractionId = `int_${n}`;
    db.sqlite
      .prepare(
        `INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, created_at)
         VALUES (?, ?, 'apple:x', ?, ?, 'in', ?)`,
      )
      .run(sourceInteractionId, opts.interaction, `ref${n}`, NOW, NOW);
  }
  const added = g.addLoop({
    direction: "i_owe",
    text: `Send the deck ${name}`,
    evidence: "I will send the deck on Friday",
    counterpartId: sam,
    status: "open",
    sourceInteractionId,
    provenance: "owner",
    detectedBy: "owner",
  });
  if (added === undefined) throw new Error("loop not added");
  ids[name] = added.id;
  db.sqlite
    .prepare("UPDATE graph_loops SET source_kind = ?, remote_visible = ? WHERE id = ?")
    .run(opts.kind, opts.visible, added.id);
  if (opts.cite !== undefined) citation(added.id, opts.cite, n);
}

beforeEach(() => {
  db = openDb(":memory:");
  g = new GraphStore({ sqlite: db.sqlite, clock: new FakeClock() });
  sam = g.createEntity({ kind: "person", name: "Sam Lee", linkedBy: "rule", source: "mail" }).id;
  loop("mail", { kind: "mail", visible: 1, cite: "mail" }, 1);
  loop("messages", { kind: "messages", visible: 0, cite: "messages" }, 2);
  // Mixed: the row says visible, but one citation is Messages. The citation wins.
  loop("mixed", { kind: "mail", visible: 1, cite: "messages" }, 3);
  loop("meeting", { kind: "meeting", visible: 1, cite: "transcripts" }, 4);
  loop("chat", { kind: "chat", visible: 1, cite: "chats" }, 5);
  // A legacy row: the migration default is 0, so it is hidden.
  loop("legacy", { kind: "mail", visible: 0, cite: "mail" }, 6);
  // The source interaction is a Messages thread, whatever the row says.
  loop("fromMessage", { kind: null, visible: 1, interaction: "message" }, 7);
  loop("fromMail", { kind: null, visible: 1, interaction: "mail" }, 8);
});
afterEach(() => db.close());

const VISIBLE = ["mail", "meeting", "chat", "fromMail"];
const HIDDEN = ["messages", "mixed", "legacy", "fromMessage"];

describe("which loops a remote viewer may see", () => {
  it.each(VISIBLE)("%s: visible", (name) => {
    const vis = createLoopVisibility(db.sqlite);
    expect(vis.remoteVisible([ids[name] as string]).has(ids[name] as string)).toBe(true);
  });

  it.each(HIDDEN)("%s: hidden", (name) => {
    const vis = createLoopVisibility(db.sqlite);
    expect(vis.remoteVisible([ids[name] as string]).size).toBe(0);
  });

  it("an id with no row is hidden, and a read error hides everything", () => {
    const vis = createLoopVisibility(db.sqlite);
    expect(vis.remoteVisible(["loop_missing"]).size).toBe(0);
    const all = Object.values(ids);
    expect([...vis.remoteVisible(all)].sort()).toEqual(VISIBLE.map((n) => ids[n]).sort());
    db.sqlite.exec("ALTER TABLE graph_loops RENAME COLUMN remote_visible TO rv_gone");
    expect(vis.remoteVisible(all).size).toBe(0);
  });

  it("scrubbing removes the quote, the person, the project and the source", () => {
    const l = g.getLoop(ids.mail as string);
    if (l === undefined) throw new Error("no loop");
    expect(l.evidence).toBe("I will send the deck on Friday");
    expect(l.counterpartId).toBe(sam);
    const s = scrubLoopForRemote({ ...l, projectId: "proj_1", sourceInteractionId: "int_x" });
    expect(s).toMatchObject({
      evidence: null,
      counterpartId: null,
      projectId: null,
      sourceInteractionId: null,
      text: l.text,
    });
  });
});

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return "ok";
  } catch (err) {
    return err instanceof PsycheError ? err.code : String(err);
  }
};

describe("memory.loops.* and memory.entities.get by viewer", () => {
  const handlers = () =>
    createGraphHandlers(g, { loopVisibility: createLoopVisibility(db.sqlite) });
  const list = (viewer?: { full: boolean }) =>
    handlers()["memory.loops.list"]({ status: ["suggested", "open"], limit: 50 }, viewer);

  it("the desktop shell sees every loop with its quote (positive control)", async () => {
    const out = await list({ full: true });
    expect(out.loops).toHaveLength(8);
    expect(out.loops.find((l) => l.id === ids.messages)?.evidence).toBe(
      "I will send the deck on Friday",
    );
    expect(out.loops.find((l) => l.id === ids.mail)?.counterpartId).toBe(sam);
  });

  it("an in-process caller with no viewer sees every loop", async () => {
    expect((await list()).loops).toHaveLength(8);
  });

  it("a remote viewer sees the visible loops, stripped, and none of the others", async () => {
    const out = await list({ full: false });
    expect(out.loops.map((l) => l.id).sort()).toEqual(VISIBLE.map((n) => ids[n] as string).sort());
    for (const l of out.loops)
      expect(l).toMatchObject({ evidence: null, counterpartId: null, sourceInteractionId: null });
  });

  it("a remote viewer with no visibility reader sees nothing (fail closed)", async () => {
    const bare = createGraphHandlers(g);
    expect((await bare["memory.loops.list"]({ limit: 50 }, { full: false })).loops).toEqual([]);
    expect(
      await codeOf(() =>
        bare["memory.loops.update"]({ id: ids.mail as string, status: "done" }, { full: false }),
      ),
    ).toBe("not_found");
  });

  it.each(HIDDEN)("update on hidden loop %s refuses and changes nothing", async (name) => {
    const id = ids[name] as string;
    expect(
      await codeOf(() =>
        handlers()["memory.loops.update"]({ id, status: "done" }, { full: false }),
      ),
    ).toBe("not_found");
    expect(g.getLoop(id)?.status).toBe("open");
    // Positive control: the desktop shell can.
    const done = await handlers()["memory.loops.update"]({ id, status: "done" }, { full: true });
    expect(done.loop.status).toBe("done");
  });

  it.each(VISIBLE)("update on visible loop %s works and answers scrubbed", async (name) => {
    const id = ids[name] as string;
    const out = await handlers()["memory.loops.update"]({ id, status: "done" }, { full: false });
    expect(out.loop).toMatchObject({ status: "done", evidence: null, counterpartId: null });
  });

  it("the person's open loops follow the same scrub", async () => {
    const full = await handlers()["memory.entities.get"]({ id: sam }, { full: true });
    expect(full.openLoops).toHaveLength(8);
    const remote = await handlers()["memory.entities.get"]({ id: sam }, { full: false });
    expect(remote.openLoops.map((l) => l.id).sort()).toEqual(
      VISIBLE.map((n) => ids[n] as string).sort(),
    );
    expect(remote.openLoops.every((l) => l.evidence === null)).toBe(true);
  });
});
