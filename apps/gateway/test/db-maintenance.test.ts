import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, createThread, insertLibraryItem, openDb, type PsycheDb } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { composeGateway } from "../src/compose/index.ts";
import type { GatewayContext } from "../src/context.ts";
import {
  HISTORY_RETENTION_DAYS,
  maybeVacuum,
  pruneHistory,
  runDbMaintenance,
} from "../src/db-maintenance.ts";
import { silentLogger } from "../src/log.ts";
import { runRetention } from "../src/retention.ts";

const DAY = 86_400_000;
const NOW = new Date("2027-03-01T12:00:00.000Z");
const old = new Date(NOW.getTime() - (HISTORY_RETENTION_DAYS + 5) * DAY).toISOString();
const recent = new Date(NOW.getTime() - 10 * DAY).toISOString();

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

function addTask(db: PsycheDb, threadId: string, id: string, status: string, at: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO tasks (id, thread_id, title, goal, status, created_from, created_at, updated_at, completed_at)
       VALUES (?, ?, 't', 'g', ?, 'chat', ?, ?, ?)`,
    )
    .run(id, threadId, status, at, at, status === "running" ? null : at);
  db.sqlite
    .prepare(
      `INSERT INTO task_checkpoints (id, task_id, step_id, idx, replay_safe, status, created_at, updated_at)
       VALUES (?, ?, 's', 0, 1, 'done', ?, ?)`,
    )
    .run(`cp_${id}`, id, at, at);
}

function addNotification(
  db: PsycheDb,
  id: string,
  at: string,
  o: { read?: boolean; resolved?: boolean; kind?: string; taskId?: string } = {},
): void {
  db.sqlite
    .prepare(
      `INSERT INTO notifications (id, kind, title, body, task_id, read_at, resolved_at, seq, created_at, updated_at)
       VALUES (?, ?, 't', 'b', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      o.kind ?? "system",
      o.taskId ?? null,
      o.read ? at : null,
      o.resolved ? at : null,
      Math.floor(Math.random() * 1e9),
      at,
      at,
    );
}

const count = (db: PsycheDb, table: string): number =>
  (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const has = (db: PsycheDb, table: string, id: string): boolean =>
  db.sqlite.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;

describe("history retention", () => {
  it("deletes old terminal tasks with their checkpoints and keeps everything referenced or live", () => {
    const db = memDb();
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    for (const id of ["old_done", "old_failed", "old_cancelled"])
      addTask(db, thread.id, id, id.slice(4), old);
    addTask(db, thread.id, "recent_done", "done", recent);
    addTask(db, thread.id, "old_running", "running", old);
    addTask(db, thread.id, "old_paused", "paused", old);
    addTask(db, thread.id, "old_receipt", "done", old);
    addTask(db, thread.id, "old_library", "done", old);
    addTask(db, thread.id, "old_open_notice", "done", old);
    db.sqlite
      .prepare(
        `INSERT INTO receipts (id, kind, task_id, outcome, summary, created_at, updated_at)
         VALUES ('rc1', 'email.send', 'old_receipt', 'ok', 's', ?, ?)`,
      )
      .run(old, old);
    insertLibraryItem(db, {
      kind: "document",
      name: "report.pdf",
      mime: "application/pdf",
      path: "agent/report.pdf",
      size: 1,
      sha256: "x",
      origin: "agent",
      taskId: "old_library",
    });
    addNotification(db, "n_open", old, { kind: "approval", taskId: "old_open_notice" });
    // A run that points at a pruned task is cleared, never left dangling.
    const run = createRun(db, { threadId: thread.id, modelRef: "fake/model" }).id;
    db.sqlite
      .prepare("UPDATE runs SET status = 'done', task_id = 'old_done' WHERE id = ?")
      .run(run);

    const r = pruneHistory(db, NOW);
    expect(r.tasks).toBe(3);
    for (const id of ["old_done", "old_failed", "old_cancelled"]) {
      expect(has(db, "tasks", id)).toBe(false);
      expect(has(db, "task_checkpoints", `cp_${id}`)).toBe(false);
    }
    for (const id of [
      "recent_done",
      "old_running",
      "old_paused",
      "old_receipt",
      "old_library",
      "old_open_notice",
    ]) {
      expect(has(db, "tasks", id)).toBe(true);
      expect(has(db, "task_checkpoints", `cp_${id}`)).toBe(true);
    }
    expect(has(db, "receipts", "rc1")).toBe(true);
    expect(count(db, "library_items")).toBe(1);
    expect(count(db, "threads")).toBe(1);
    const runRow = db.sqlite.prepare("SELECT task_id FROM runs WHERE id = ?").get(run) as {
      task_id: string | null;
    };
    expect(runRow.task_id).toBeNull();
  });

  it("deletes read or resolved notifications, keeps unresolved approvals and recent ones", () => {
    const db = memDb();
    addNotification(db, "n_resolved", old, { resolved: true, kind: "approval" });
    addNotification(db, "n_read", old, { read: true });
    addNotification(db, "n_unread", old);
    addNotification(db, "n_read_approval", old, { read: true, kind: "approval" });
    addNotification(db, "n_recent", recent, { resolved: true });
    expect(pruneHistory(db, NOW).notifications).toBe(2);
    expect(has(db, "notifications", "n_resolved")).toBe(false);
    expect(has(db, "notifications", "n_read")).toBe(false);
    for (const id of ["n_unread", "n_read_approval", "n_recent"])
      expect(has(db, "notifications", id)).toBe(true);
  });

  it("prunes finished scheduler runs but keeps the newest per automation and running ones", () => {
    const db = memDb();
    db.sqlite.pragma("foreign_keys = OFF");
    const ins = db.sqlite.prepare(
      `INSERT INTO automation_runs (id, automation_id, trigger, scheduled_for, started_at, status, created_at)
       VALUES (?, ?, 'schedule', ?, ?, ?, ?)`,
    );
    const at = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
    ins.run("a1", "auto1", at(200), at(200), "done", at(200));
    ins.run("a2", "auto1", at(150), at(150), "failed", at(150));
    ins.run("a3", "auto1", at(120), at(120), "done", at(120)); // newest of auto1: kept
    ins.run("b1", "auto2", at(300), at(300), "running", at(300));
    ins.run("c1", "auto3", at(10), at(10), "done", at(10));
    expect(pruneHistory(db, NOW).automationRuns).toBe(2);
    expect(["a1", "a2"].some((id) => has(db, "automation_runs", id))).toBe(false);
    for (const id of ["a3", "b1", "c1"]) expect(has(db, "automation_runs", id)).toBe(true);
  });

  it("is batched and bounded in time on a large database", () => {
    const db = memDb();
    const ins = db.sqlite.prepare(
      `INSERT INTO notifications (id, kind, title, body, read_at, seq, created_at, updated_at)
       VALUES (?, 'system', 't', 'b', ?, ?, ?, ?)`,
    );
    db.sqlite.transaction(() => {
      for (let i = 0; i < 20_000; i++) ins.run(`n${i}`, old, i, old, old);
    })();
    // A clock that jumps 100 ms per check: the budget ends the pass after a few batches.
    let t = 0;
    const clock = () => (t += 100);
    const first = pruneHistory(db, NOW, { batch: 500, budgetMs: 350, clock });
    expect(first.truncated).toBe(true);
    expect(first.notifications).toBe(1500);
    expect(count(db, "notifications")).toBe(18_500);
    // With the real clock the pass stays within its budget and the next passes finish the work.
    const started = Date.now();
    let passes = 0;
    while (count(db, "notifications") > 0 && passes < 200) {
      const r = pruneHistory(db, NOW, { batch: 500, budgetMs: 250 });
      expect(r.notifications).toBeGreaterThan(0);
      passes += 1;
    }
    expect(count(db, "notifications")).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe("retention with the audit log", () => {
  it("keeps the audit chain verifiable after history is pruned", async () => {
    const home = tmp();
    const composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      now: () => NOW,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    try {
      for (let i = 0; i < 3; i++) {
        await composed.audit.append({
          kind: "config.changed",
          actor: { type: "system" },
          data: { key: `k${i}` },
        });
      }
      const ctx = composed.gateway.context;
      const thread = createThread(ctx.db, { kind: "main", sessionKey: "owner:main" });
      addTask(ctx.db, thread.id, "t_old", "done", old);
      addNotification(ctx.db, "n_old", old, { resolved: true });
      const before = await composed.audit.verify();
      expect(before.ok).toBe(true);
      const report = runRetention(ctx);
      expect(report.history.tasks).toBe(1);
      expect(report.history.notifications).toBe(1);
      const after = await composed.audit.verify();
      expect(after).toEqual(before);
    } finally {
      await composed.stop("test");
    }
  });
});

/** A database as the owner has it today: created before auto_vacuum was set. */
function legacyDb(path: string): PsycheDb {
  const first = openDb(path);
  first.sqlite.pragma("auto_vacuum = NONE");
  first.sqlite.exec("VACUUM");
  first.close();
  const db = openDb(path);
  dbs.push(db);
  return db;
}

const ctxOf = (db: PsycheDb) => ({ db, log: silentLogger }) as unknown as GatewayContext;

describe("auto_vacuum and VACUUM", () => {
  it("a new database is INCREMENTAL, a legacy one is not", () => {
    const home = tmp();
    const fresh = openDb(join(home, "fresh.db"));
    dbs.push(fresh);
    expect(fresh.sqlite.pragma("auto_vacuum", { simple: true })).toBe(2);
    const legacy = legacyDb(join(home, "legacy.db"));
    expect(legacy.sqlite.pragma("auto_vacuum", { simple: true })).toBe(0);
    expect(maybeVacuum(ctxOf(fresh))).toBe("not-needed");
  });

  it("converts a legacy database when idle and enough disk is free", () => {
    const db = legacyDb(join(tmp(), "legacy.db"));
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    addTask(db, thread.id, "keep", "done", recent);
    expect(maybeVacuum(ctxOf(db), () => 1e12)).toBe("done");
    expect(db.sqlite.pragma("auto_vacuum", { simple: true })).toBe(2);
    expect(has(db, "tasks", "keep")).toBe(true);
    expect(maybeVacuum(ctxOf(db), () => 1e12)).toBe("not-needed");
  });

  it("is skipped while a run is active, and runs once it ends", () => {
    const db = legacyDb(join(tmp(), "legacy.db"));
    const thread = createThread(db, { kind: "main", sessionKey: "owner:main" });
    const live = createRun(db, { threadId: thread.id, modelRef: "fake/model" });
    db.sqlite.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(live.id);
    expect(maybeVacuum(ctxOf(db), () => 1e12)).toBe("skipped-busy");
    expect(db.sqlite.pragma("auto_vacuum", { simple: true })).toBe(0);
    db.sqlite.prepare("UPDATE runs SET status = 'done' WHERE id = ?").run(live.id);
    expect(maybeVacuum(ctxOf(db), () => 1e12)).toBe("done");
  });

  it("is skipped when the disk cannot hold the copy", () => {
    const db = legacyDb(join(tmp(), "legacy.db"));
    expect(maybeVacuum(ctxOf(db), () => 1024)).toBe("skipped-low-disk");
    expect(db.sqlite.pragma("auto_vacuum", { simple: true })).toBe(0);
  });

  it("maintenance reclaims freed pages on an INCREMENTAL database and checkpoints", () => {
    const db = openDb(join(tmp(), "fresh.db"));
    dbs.push(db);
    db.sqlite.exec("CREATE TABLE bulk (v BLOB)");
    const ins = db.sqlite.prepare("INSERT INTO bulk VALUES (?)");
    db.sqlite.transaction(() => {
      for (let i = 0; i < 400; i++) ins.run(Buffer.alloc(8192, 1));
    })();
    db.sqlite.exec("DELETE FROM bulk");
    const free = () => db.sqlite.pragma("freelist_count", { simple: true }) as number;
    const before = free();
    expect(before).toBeGreaterThan(300);
    expect(runDbMaintenance(ctxOf(db)).vacuum).toBe("not-needed");
    expect(free()).toBeLessThan(before);
  });
});
