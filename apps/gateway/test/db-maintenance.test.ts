import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, createThread, openDb, type PsycheDb } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { composeGateway } from "../src/compose/index.ts";
import type { GatewayContext } from "../src/context.ts";
import {
  compactDatabase,
  compactEstimate,
  pruneHistory,
  runDbMaintenance,
  safeCutoff,
} from "../src/db-maintenance.ts";
import { silentLogger } from "../src/log.ts";

const DAY = 86_400_000;
const NOW = new Date("2027-03-01T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const BIG = JSON.stringify({ blob: "x".repeat(2000) });

const dirs: string[] = [];
const dbs: PsycheDb[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "psyche-dbm-"));
  dirs.push(d);
  return d;
}
function memDb(): PsycheDb {
  const db = openDb(":memory:");
  dbs.push(db);
  return db;
}
function fileDb(): PsycheDb {
  const db = openDb(join(tmp(), "p.db"));
  dbs.push(db);
  return db;
}
const ctxOf = (db: PsycheDb) =>
  ({
    db,
    log: silentLogger,
    now: () => NOW,
    bus: { bumpStateVersion: () => 1 },
  }) as unknown as GatewayContext;

function addTask(db: PsycheDb, threadId: string, id: string, status: string, at: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO tasks (id, thread_id, title, goal, status, created_from, created_at, updated_at, completed_at)
       VALUES (?, ?, 't', 'g', ?, 'chat', ?, ?, ?)`,
    )
    .run(id, threadId, status, at, at, status === "running" ? null : at);
  db.sqlite
    .prepare(
      `INSERT INTO task_checkpoints (id, task_id, step_id, idx, replay_safe, status, payload, created_at, updated_at)
       VALUES (?, ?, 's', 0, 1, 'done', ?, ?, ?)`,
    )
    .run(`cp_${id}`, id, BIG, at, at);
  db.sqlite
    .prepare(
      `INSERT INTO task_actions (id, task_id, idx, level1, level2, created_at)
       VALUES (?, ?, 0, 'summary line', ?, ?)`,
    )
    .run(`ac_${id}`, id, JSON.stringify({ tool: "web.fetch", params: "x".repeat(2000) }), at);
}

const one = <T>(db: PsycheDb, sql: string, ...p: unknown[]) =>
  db.sqlite.prepare(sql).get(...p) as T;
const count = (db: PsycheDb, table: string): number =>
  one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`).n;
const payloadOf = (db: PsycheDb, id: string) =>
  one<{ payload: string | null }>(
    db,
    "SELECT payload FROM task_checkpoints WHERE id = ?",
    `cp_${id}`,
  ).payload;
const level2Of = (db: PsycheDb, id: string) =>
  one<{ level2: string }>(db, "SELECT level2 FROM task_actions WHERE id = ?", `ac_${id}`).level2;

describe("history trimming keeps every row", () => {
  it("trims checkpoint payloads of tasks finished over 30 days ago, nothing else", () => {
    const db = memDb();
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    addTask(db, thread.id, "old_done", "done", ago(40));
    addTask(db, thread.id, "old_failed", "failed", ago(40));
    addTask(db, thread.id, "recent_done", "done", ago(5));
    addTask(db, thread.id, "old_running", "running", ago(40));
    addTask(db, thread.id, "old_paused", "paused", ago(40));
    // The clock guard needs recent activity.
    addTask(db, thread.id, "now_task", "queued", ago(0));
    const run = createRun(db, { threadId: thread.id, modelRef: "fake/model" }).id;
    db.sqlite.prepare("UPDATE runs SET task_id = 'old_done' WHERE id = ?").run(run);
    const tasksBefore = count(db, "tasks");

    const r = pruneHistory(db, NOW);
    expect(r.checkpoints).toBe(2);
    expect(payloadOf(db, "old_done")).toBeNull();
    expect(payloadOf(db, "old_failed")).toBeNull();
    for (const id of ["recent_done", "old_running", "old_paused", "now_task"])
      expect(payloadOf(db, id)).toBe(BIG);
    // Rows stay, and so do the pointers to them.
    expect(count(db, "tasks")).toBe(tasksBefore);
    expect(count(db, "task_checkpoints")).toBe(tasksBefore);
    expect(one<{ task_id: string }>(db, "SELECT task_id FROM runs WHERE id = ?", run).task_id).toBe(
      "old_done",
    );
  });

  it("trims action detail after 90 days but keeps the row, summary and tool name", () => {
    const db = memDb();
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    addTask(db, thread.id, "ancient", "done", ago(100));
    addTask(db, thread.id, "month", "done", ago(40));
    addTask(db, thread.id, "now_task", "queued", ago(0));
    expect(pruneHistory(db, NOW).actions).toBe(1);
    expect(JSON.parse(level2Of(db, "ancient"))).toEqual({ tool: "web.fetch" });
    expect(level2Of(db, "month").length).toBeGreaterThan(512);
    expect(
      one<{ level1: string }>(db, "SELECT level1 FROM task_actions WHERE id = 'ac_ancient'").level1,
    ).toBe("summary line");
    expect(count(db, "task_actions")).toBe(3);
  });

  it("trims event lists of finished scheduler runs, not running ones", () => {
    const db = memDb();
    db.sqlite.pragma("foreign_keys = OFF");
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    addTask(db, thread.id, "now_task", "queued", ago(0));
    const ins = db.sqlite.prepare(
      `INSERT INTO automation_runs (id, automation_id, trigger, scheduled_for, started_at, status, created_at, events)
       VALUES (?, 'au', 'event', ?, ?, ?, ?, '[{"a":1}]')`,
    );
    ins.run("done_old", ago(100), ago(100), "done", ago(100));
    ins.run("running_old", ago(100), ago(100), "running", ago(100));
    ins.run("done_new", ago(5), ago(5), "done", ago(5));
    expect(pruneHistory(db, NOW).runEvents).toBe(1);
    const ev = (id: string) =>
      one<{ events: string | null }>(db, "SELECT events FROM automation_runs WHERE id = ?", id)
        .events;
    expect(ev("done_old")).toBeNull();
    expect(ev("running_old")).not.toBeNull();
    expect(ev("done_new")).not.toBeNull();
    expect(count(db, "automation_runs")).toBe(3);
  });

  it("a batch on 20k tasks with references walks an index and stays under 250 ms", () => {
    const db = memDb();
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    db.sqlite.transaction(() => {
      for (let i = 0; i < 20_000; i++) {
        const id = `t${i}`;
        const at = ago(60 + (i % 20));
        addTask(db, thread.id, id, "done", at);
        db.sqlite
          .prepare(
            `INSERT INTO receipts (id, kind, task_id, outcome, summary, created_at, updated_at)
             VALUES (?, 'k', ?, 'ok', 's', ?, ?)`,
          )
          .run(`rc${i}`, id, at, at);
      }
    })();
    addTask(db, thread.id, "now_task", "queued", ago(0));
    const plan = db.sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT rowid, updated_at, id FROM task_checkpoints INDEXED BY task_checkpoints_bulky_idx
         WHERE payload IS NOT NULL AND length(payload) > 512 AND updated_at < ? ORDER BY updated_at, rowid LIMIT 200`,
      )
      .all(ago(30)) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("task_checkpoints_bulky_idx");
    expect(plan.map((p) => p.detail).join(" ")).not.toContain("TEMP B-TREE");

    const t0 = performance.now();
    const r = pruneHistory(db, NOW, {
      batch: 200,
      budgetMs: 1,
      clock: (() => {
        let n = 0;
        return () => (n++ < 3 ? 0 : 99);
      })(),
    });
    const ms = performance.now() - t0;
    expect(r.checkpoints).toBeGreaterThanOrEqual(200);
    expect(ms).toBeLessThan(250);
    // Real clock: one pass is bounded by its budget and the next passes make progress.
    const t1 = performance.now();
    const r2 = pruneHistory(db, NOW, { batch: 200, budgetMs: 100 });
    expect(performance.now() - t1).toBeLessThan(600);
    expect(r2.checkpoints).toBeGreaterThan(0);
  });
});

describe("clock safety", () => {
  it("a forward clock jump of a year prunes nothing", () => {
    const db = memDb();
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    addTask(db, thread.id, "recent", "done", ago(5));
    addTask(db, thread.id, "mid", "done", ago(20));
    const jumped = new Date(NOW.getTime() + 365 * DAY);
    const r = pruneHistory(db, jumped);
    expect(r.skipped).toBe("clock");
    expect(r.checkpoints + r.actions + r.runEvents).toBe(0);
    expect(payloadOf(db, "recent")).toBe(BIG);
    expect(payloadOf(db, "mid")).toBe(BIG);
  });

  it("a stored cutoff advances by at most elapsed time plus a day per pass", () => {
    const db = memDb();
    let mono = 1000;
    const first = safeCutoff(db, "x", NOW, 30, () => mono);
    expect(first).toBe(ago(30));
    mono += 3_600_000; // one hour passed on the monotonic clock
    const later = new Date(NOW.getTime() + 200 * DAY);
    const next = Date.parse(safeCutoff(db, "x", later, 30, () => mono));
    expect(next).toBeLessThanOrEqual(Date.parse(first) + 3_600_000 + DAY);
    expect(next).toBeGreaterThan(Date.parse(first));
  });
});

describe("maintenance, vacuum and compaction", () => {
  it("new databases are INCREMENTAL with a WAL size limit; maintenance reclaims pages", () => {
    const db = fileDb();
    expect(db.sqlite.pragma("auto_vacuum", { simple: true })).toBe(2);
    expect(db.sqlite.pragma("journal_size_limit", { simple: true })).toBe(67108864);
    db.sqlite.exec("CREATE TABLE bulk (v BLOB)");
    const ins = db.sqlite.prepare("INSERT INTO bulk VALUES (?)");
    db.sqlite.transaction(() => {
      for (let i = 0; i < 400; i++) ins.run(Buffer.alloc(8192, 1));
    })();
    db.sqlite.exec("DELETE FROM bulk");
    const free = () => db.sqlite.pragma("freelist_count", { simple: true }) as number;
    const before = free();
    runDbMaintenance(ctxOf(db));
    expect(free()).toBeLessThan(before);
  });

  it("never runs a full VACUUM on its own: a legacy database keeps its free pages", () => {
    const db = fileDb();
    db.sqlite.pragma("auto_vacuum = NONE");
    db.sqlite.exec("VACUUM");
    db.sqlite.exec("CREATE TABLE bulk (v BLOB)");
    const ins = db.sqlite.prepare("INSERT INTO bulk VALUES (?)");
    db.sqlite.transaction(() => {
      for (let i = 0; i < 200; i++) ins.run(Buffer.alloc(8192, 1));
    })();
    db.sqlite.exec("DELETE FROM bulk");
    const before = db.sqlite.pragma("freelist_count", { simple: true }) as number;
    runDbMaintenance(ctxOf(db));
    expect(db.sqlite.pragma("freelist_count", { simple: true })).toBe(before);
  });

  it("compaction is refused when the disk can't hold a full copy", () => {
    const db = fileDb();
    db.sqlite.pragma("auto_vacuum = NONE");
    db.sqlite.exec("VACUUM");
    expect(compactDatabase(ctxOf(db), () => 1024)).toEqual({ ok: false, reason: "disk" });
    expect(db.sqlite.pragma("auto_vacuum", { simple: true })).toBe(0);
  });

  it("compaction is refused while a run is active and reclaims space when idle", () => {
    const db = fileDb();
    // A legacy database: the owner's Compact converts it to INCREMENTAL.
    db.sqlite.pragma("auto_vacuum = NONE");
    db.sqlite.exec("VACUUM");
    expect(db.sqlite.pragma("auto_vacuum", { simple: true })).toBe(0);
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    db.sqlite.exec("CREATE TABLE bulk (v BLOB)");
    const ins = db.sqlite.prepare("INSERT INTO bulk VALUES (?)");
    db.sqlite.transaction(() => {
      for (let i = 0; i < 400; i++) ins.run(Buffer.alloc(8192, 1));
    })();
    db.sqlite.exec("DELETE FROM bulk");
    const live = createRun(db, { threadId: thread.id, modelRef: "fake/model" });
    db.sqlite.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(live.id);
    expect(compactEstimate(db).idle).toBe(false);
    expect(compactDatabase(ctxOf(db))).toEqual({ ok: false, reason: "busy" });
    db.sqlite.prepare("UPDATE runs SET status = 'done' WHERE id = ?").run(live.id);
    const est = compactEstimate(db);
    expect(est.reclaimableBytes).toBeGreaterThan(1_000_000);
    const r = compactDatabase(ctxOf(db));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.savedBytes).toBeGreaterThan(1_000_000);
    expect(compactEstimate(db).reclaimableBytes).toBe(0);
    expect(db.sqlite.pragma("auto_vacuum", { simple: true })).toBe(2);
  });

  it("the audit chain verifies identically after history trimming", async () => {
    const home = tmp();
    const composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      now: () => NOW,
      config: { home, port: 0, dbPath: join(home, "psyche.db") },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    try {
      for (let i = 0; i < 3; i++)
        await composed.audit.append({
          kind: "config.changed",
          actor: { type: "system" },
          data: { key: `k${i}` },
        });
      const ctx = composed.gateway.context;
      const thread = createThread(ctx.db, { kind: "main", sessionKey: "owner:main" });
      addTask(ctx.db, thread.id, "t_old", "done", ago(100));
      addTask(ctx.db, thread.id, "t_now", "queued", ago(0));
      const before = await composed.audit.verify();
      expect(before.ok).toBe(true);
      expect(runDbMaintenance(ctx).checkpoints).toBe(1);
      expect(await composed.audit.verify()).toEqual(before);
    } finally {
      await composed.stop("test");
    }
  });
});
