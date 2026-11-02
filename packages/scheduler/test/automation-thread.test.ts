import { createThread, type PsycheDb } from "@psyche/db";
import { describe, expect, it } from "vitest";
import {
  automationIdOfThreadKey,
  automationThreadKey,
  createDbSessionResolver,
  groupAutomationRunThreads,
} from "../src/index.ts";
import { asleep, BASE, setup } from "./helpers.ts";

const homes = (db: PsycheDb) =>
  db.sqlite
    .prepare(
      "SELECT id, session_key AS key, title FROM threads WHERE session_key LIKE 'automation:%'",
    )
    .all() as { id: string; key: string; title: string }[];

const parentOf = (db: PsycheDb, id: string) =>
  (
    db.sqlite.prepare("SELECT parent_thread_id AS p FROM threads WHERE id = ?").get(id) as {
      p: string | null;
    }
  ).p;

describe("one chat per automation", () => {
  it("files every isolated run's work thread under the automation's one chat", async () => {
    const { scheduler, launcher, db } = setup({ timers: asleep });
    const a = await scheduler.create({ ...BASE, kind: "cron", schedule: "0 * * * *" });
    const b = await scheduler.create({
      ...BASE,
      title: "Other",
      kind: "cron",
      schedule: "0 * * * *",
    });
    for (const x of [a, a, a, b]) {
      await scheduler.trigger(x.id);
      await scheduler.idle();
    }
    const [t0, t1, t2, t3] = launcher.requests.map((r) => r.threadId);
    expect(new Set([t0, t1, t2]).size).toBe(3); // each run keeps its own work thread
    const chats = homes(db);
    expect(chats.map((c) => c.key).sort()).toEqual(
      [automationThreadKey(a.id), automationThreadKey(b.id)].sort(),
    );
    const homeA = chats.find((c) => c.key === automationThreadKey(a.id));
    expect(homeA?.title).toBe("Inbox triage");
    expect([t0, t1, t2].map((t) => parentOf(db, t as string))).toEqual([
      homeA?.id,
      homeA?.id,
      homeA?.id,
    ]);
    expect(parentOf(db, t3 as string)).toBe(chats.find((c) => c.key.endsWith(b.id))?.id);
    expect(automationIdOfThreadKey(automationThreadKey(a.id))).toBe(a.id);
    expect(automationIdOfThreadKey("cron:x:y")).toBeUndefined();
  });

  it("moves the chat to the top of the list when a run starts", async () => {
    const { scheduler, db } = setup({ timers: asleep });
    const a = await scheduler.create({ ...BASE, kind: "cron", schedule: "0 * * * *" });
    await scheduler.trigger(a.id);
    await scheduler.idle();
    const home = homes(db)[0] as { id: string };
    const at = db.sqlite
      .prepare("SELECT last_message_at AS at FROM threads WHERE id = ?")
      .get(home.id) as { at: string | null };
    expect(at.at).not.toBeNull();
  });

  it("leaves main and named targets alone", async () => {
    const { db } = setup({ timers: asleep });
    const resolver = createDbSessionResolver(db);
    const automation = { ...BASE, id: "aut_1" } as never;
    const named = await resolver.resolve("named:research", { automation, runId: "run_1" });
    const again = await resolver.resolve("named:research", { automation, runId: "run_2" });
    expect(again).toBe(named);
    expect(homes(db)).toEqual([]);
  });
});

describe("groupAutomationRunThreads", () => {
  /** A database as the old build left it: a chat per run, some with messages. */
  function legacy() {
    const { db } = setup({ timers: asleep });
    const runThread = (automationId: string, runId: string, title: string) =>
      createThread(db, { kind: "automation", sessionKey: `cron:${automationId}:${runId}`, title });
    const a1 = runThread("aut_a", "run_1", "Morning brief");
    const a2 = runThread("aut_a", "run_2", "Morning brief");
    const a3 = runThread("aut_a", "run_3", "Morning brief");
    const b1 = runThread("aut_b", "run_4", "Weekly review");
    const named = createThread(db, {
      kind: "automation",
      sessionKey: "named:research",
      title: "Research",
    });
    const side = createThread(db, { kind: "side", sessionKey: "owner:side:1", title: "A chat" });
    // A message the old run left in its thread; migrating must keep it.
    db.sqlite
      .prepare(
        `INSERT INTO messages (id, thread_id, seq, role, blocks, provenance, created_at)
         VALUES ('msg_keep', ?, 1, 'agent', '[{"type":"text","md":"Brief: 3 meetings"}]', 'agent', ?)`,
      )
      .run(a2.id, db.now());
    return { db, a1, a2, a3, b1, named, side };
  }

  it("files the copies under one chat per automation and keeps their messages", () => {
    const { db, a1, a2, a3, b1, named, side } = legacy();
    expect(groupAutomationRunThreads(db)).toEqual({ created: 2, filed: 4 });
    const chats = homes(db);
    expect(chats).toHaveLength(2);
    const homeA = chats.find((c) => c.key === "automation:aut_a") as { id: string; title: string };
    const homeB = chats.find((c) => c.key === "automation:aut_b") as { id: string };
    expect(homeA.title).toBe("Morning brief");
    for (const t of [a1, a2, a3]) expect(parentOf(db, t.id)).toBe(homeA.id);
    expect(parentOf(db, b1.id)).toBe(homeB.id);
    expect(parentOf(db, named.id)).toBeNull();
    expect(parentOf(db, side.id)).toBeNull();
    // Nothing is lost: the run thread and its message are where they were.
    const kept = db.sqlite
      .prepare("SELECT thread_id AS t FROM messages WHERE id = 'msg_keep'")
      .get() as { t: string };
    expect(kept.t).toBe(a2.id);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM threads").get()).toEqual({ n: 8 });
    // The chat sorts where its newest run was.
    const stamp = db.sqlite
      .prepare("SELECT last_message_at AS at FROM threads WHERE id = ?")
      .get(homeA.id) as { at: string | null };
    expect(stamp.at).not.toBeNull();
  });

  it("is idempotent", () => {
    const { db } = legacy();
    groupAutomationRunThreads(db);
    const before = db.sqlite.prepare("SELECT count(*) AS n FROM threads").get();
    expect(groupAutomationRunThreads(db)).toEqual({ created: 0, filed: 0 });
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM threads").get()).toEqual(before);
  });

  it("uses the automation's current title and does nothing on an empty database", async () => {
    const { db, scheduler } = setup({ timers: asleep });
    expect(groupAutomationRunThreads(db)).toEqual({ created: 0, filed: 0 });
    const a = await scheduler.create({
      ...BASE,
      title: "Real title",
      kind: "cron",
      schedule: "0 * * * *",
    });
    createThread(db, { kind: "automation", sessionKey: `cron:${a.id}:old`, title: "Stale title" });
    groupAutomationRunThreads(db);
    expect(homes(db)[0]?.title).toBe("Real title");
  });
});
