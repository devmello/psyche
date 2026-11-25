import { openDb, type PsycheDb } from "@psyche/db";
import { PsycheError } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGraphHandlers } from "../src/graph/handlers.ts";
import {
  backfillLoopRemoteVisible,
  createLoopVisibility,
  scrubLoopForRemote,
} from "../src/graph/loop-visibility.ts";
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

  it("scrubbing removes the quote, the person and the source, and keeps the project", () => {
    const l = g.getLoop(ids.mail as string);
    if (l === undefined) throw new Error("no loop");
    expect(l.evidence).toBe("I will send the deck on Friday");
    expect(l.counterpartId).toBe(sam);
    const s = scrubLoopForRemote({ ...l, projectId: "proj_1", sourceInteractionId: "int_x" });
    expect(s).toMatchObject({
      evidence: null,
      counterpartId: null,
      projectId: "proj_1",
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

const rv = (id: string): number =>
  (
    db.sqlite.prepare("SELECT remote_visible AS v FROM graph_loops WHERE id = ?").get(id) as {
      v: number;
    }
  ).v;

describe("the owner's own devices keep their loops (iOS-shaped)", () => {
  const handlers = () =>
    createGraphHandlers(g, { loopVisibility: createLoopVisibility(db.sqlite) });
  const remote = { full: false };
  let project = "";

  /** An owner loop and a legacy mail loop, written the way the store writes them. */
  function seedIos(): { owner: string; legacy: string; message: string } {
    project = g.createEntity({
      kind: "project",
      name: "Kitchen",
      linkedBy: "rule",
      source: "notes",
    }).id;
    const owner = g.addLoop({
      direction: "i_owe",
      text: "Book the plumber",
      projectId: project,
      status: "open",
      provenance: "owner",
      detectedBy: "owner",
    });
    const legacy = g.addLoop({
      direction: "waiting_on",
      text: "Quote from the electrician",
      evidence: "I will send the quote",
      counterpartId: sam,
      projectId: project,
      status: "open",
      provenance: "untrusted",
      detectedBy: "rule",
    });
    // A loop whose source interaction is a Messages thread.
    db.sqlite
      .prepare(
        `INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, created_at)
         VALUES ('int_m', 'message', 'apple:messages', 'mref', ?, 'in', ?)`,
      )
      .run(NOW, NOW);
    const message = g.addLoop({
      direction: "i_owe",
      text: "Text Sam back",
      status: "open",
      sourceInteractionId: "int_m",
      provenance: "owner",
      detectedBy: "owner",
    });
    if (owner === undefined || legacy === undefined || message === undefined)
      throw new Error("no loop");
    return { owner: owner.id, legacy: legacy.id, message: message.id };
  }

  it("addLoop sets remote_visible from the rule: 1 without a Messages marker, 0 with one", () => {
    const { owner, legacy, message } = seedIos();
    expect(rv(owner)).toBe(1);
    expect(rv(legacy)).toBe(1);
    expect(rv(message)).toBe(0);
  });

  it("a remote list, a tick-done and a project filter work on an owner loop and a legacy mail loop", async () => {
    const { owner, legacy, message } = seedIos();
    const list = await handlers()["memory.loops.list"]({ projectId: project, limit: 50 }, remote);
    expect(list.loops.map((l) => l.id).sort()).toEqual([owner, legacy].sort());
    // The project stays on the loop; the person and the quote do not.
    expect(list.loops.every((l) => l.projectId === project)).toBe(true);
    expect(list.loops.find((l) => l.id === legacy)).toMatchObject({
      counterpartId: null,
      evidence: null,
    });
    for (const id of [owner, legacy]) {
      const done = await handlers()["memory.loops.update"]({ id, status: "done" }, remote);
      expect(done.loop.status).toBe("done");
    }
    expect(
      await codeOf(() =>
        handlers()["memory.loops.update"]({ id: message, status: "done" }, remote),
      ),
    ).toBe("not_found");
  });

  it("the backfill gives old loops the same answer, once, and leaves Messages loops hidden", () => {
    const { owner, legacy, message } = seedIos();
    db.sqlite.prepare("UPDATE graph_loops SET remote_visible = 0").run();
    citation(owner, "messages", 99);
    const changed = backfillLoopRemoteVisible(db.sqlite);
    expect(rv(owner)).toBe(0);
    expect(rv(legacy)).toBe(1);
    expect(rv(message)).toBe(0);
    // Positive control: the loops from the seed section above were all 0 and are mostly 1 now.
    expect(changed).toBeGreaterThan(0);
    expect(backfillLoopRemoteVisible(db.sqlite)).toBe(0);
  });

  it("a remote page never hands out the id of a loop it may not see", async () => {
    // Visible loops interleaved with hidden ones, created in this order.
    const made: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const l = g.addLoop({
        direction: "i_owe",
        text: `Task number ${i}`,
        status: "open",
        provenance: "owner",
        detectedBy: "owner",
      });
      if (l === undefined) throw new Error("no loop");
      made.push(l.id);
      // 1, 3 and 5 are Messages loops.
      if (i % 2 === 1)
        db.sqlite.prepare("UPDATE graph_loops SET remote_visible = 0 WHERE id = ?").run(l.id);
    }
    const hidden = new Set([made[1], made[3], made[5]]);
    const base = await handlers()["memory.loops.list"](
      { limit: 100, status: ["open"] },
      { full: true },
    );
    const seenVisible = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = await handlers()["memory.loops.list"](
        { limit: 2, status: ["open"], ...(cursor === undefined ? {} : { cursor }) },
        remote,
      );
      for (const l of page.loops) seenVisible.add(l.id);
      if (page.nextCursor !== null) {
        expect(hidden.has(page.nextCursor)).toBe(false);
        expect(page.loops.map((l) => l.id)).toContain(page.nextCursor);
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const wantVisible = base.loops
      .map((l) => l.id)
      .filter(
        (id) =>
          !hidden.has(id) &&
          id !== ids.messages &&
          id !== ids.mixed &&
          id !== ids.legacy &&
          id !== ids.fromMessage,
      );
    expect([...seenVisible].sort()).toEqual([...new Set(wantVisible)].sort());
    // Positive control: the shell's cursor is the plain last id of its page.
    const full = await handlers()["memory.loops.list"](
      { limit: 2, status: ["open"] },
      { full: true },
    );
    expect(full.nextCursor).toBe(full.loops.at(-1)?.id);
  });
});
