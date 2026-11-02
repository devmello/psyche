import { createRun, createThread, openDb } from "@psyche/db";
import type { ThreadListEntry } from "@psyche/protocol";
import { groupAutomationRunThreads } from "@psyche/scheduler";
import { describe, expect, it } from "vitest";
import type { Call } from "../src/context.ts";
import { threadsHandlers } from "../src/handlers/threads.ts";

/** The sidebar's list for a database as the old build left it (a chat per run). */
function fixture() {
  const db = openDb(":memory:");
  const insertAutomation = db.sqlite.prepare(
    `INSERT INTO automations (id, kind, title, schedule, timezone, session_target, delivery, prompt,
       enabled, light_context, system, created_at, updated_at)
     VALUES (?, 'cron', ?, '0 7 * * *', 'UTC', 'isolated', '{}', 'brief', 1, 0, 0, ?, ?)`,
  );
  insertAutomation.run("aut_a", "Morning brief", db.now(), db.now());
  const insertRun = db.sqlite.prepare(
    `INSERT INTO automation_runs (id, automation_id, thread_id, trigger, scheduled_for, coalesced,
       started_at, ended_at, status, summary, created_at)
     VALUES (?, 'aut_a', ?, 'schedule', ?, 1, ?, ?, ?, ?, ?)`,
  );
  const threads = [1, 2, 3].map((i) =>
    createThread(db, {
      kind: "automation",
      sessionKey: `cron:aut_a:run_${i}`,
      title: "Morning brief",
    }),
  );
  threads.forEach((t, i) => {
    const at = `2026-11-0${i + 1}T07:00:00.000Z`;
    insertRun.run(
      `run_${i + 1}`,
      t.id,
      at,
      at,
      i === 2 ? null : at,
      i === 2 ? "running" : i === 1 ? "failed" : "done",
      i === 1 ? "Mail was unreachable" : "3 meetings today",
      at,
    );
  });
  const chat = createThread(db, { kind: "side", sessionKey: "owner:side:1", title: "A chat" });
  db.sqlite
    .prepare(
      `INSERT INTO messages (id, thread_id, seq, role, blocks, provenance, created_at)
       VALUES ('m1', ?, 1, 'user', '[{"type":"text","md":"hi"}]', 'owner', ?)`,
    )
    .run(chat.id, db.now());
  // The newest run is mid-flight and parked on an approval.
  createRun(db, {
    threadId: (threads[2] as { id: string }).id,
    modelRef: "m/x",
    kind: "automation",
    origin: "automation",
  });
  db.sqlite.prepare("UPDATE runs SET status = 'awaiting_approval'").run();
  return { db, threads, chat };
}

const call = (db: ReturnType<typeof openDb>) => ({ ctx: { db } }) as unknown as Call;
const invoke = <T>(db: ReturnType<typeof openDb>, method: string, params: object): T =>
  (threadsHandlers[method] as { run: (c: Call, p: object) => T }).run(call(db), params);
const list = (db: ReturnType<typeof openDb>) =>
  invoke<{ threads: ThreadListEntry[] }>(db, "threads.list", {}).threads;

describe("an automation in the chat list", () => {
  it("lists the automation once, with its runs, after the old copies are filed under its chat", () => {
    const { db, chat } = fixture();
    // The copies never list again; the migration gives their runs a chat to show under.
    expect(list(db).map((e) => e.thread.title)).toEqual(["A chat"]);
    groupAutomationRunThreads(db);
    const entries = list(db);
    expect(entries.map((e) => e.thread.title).sort()).toEqual(["A chat", "Morning brief"]);
    const brief = entries.find((e) => e.thread.title === "Morning brief") as ThreadListEntry;
    expect(brief.thread.sessionKey).toBe("automation:aut_a");
    expect(brief.automation).toMatchObject({
      automationId: "aut_a",
      runCount: 3,
      lastRun: { id: "run_3", status: "running" },
    });
    // Its runs work in hidden threads; the chat still shows that one waits on the owner.
    expect(brief.activity).toEqual({ running: 0, awaitingInput: 0, awaitingApproval: 1 });
    expect(entries.find((e) => e.thread.id === chat.id)?.automation).toBeUndefined();
  });

  it("threads.get returns the same summary, and run threads stay reachable by id", () => {
    const { db, threads } = fixture();
    groupAutomationRunThreads(db);
    const home = list(db).find((e) => e.automation !== undefined) as ThreadListEntry;
    const got = invoke<ThreadListEntry>(db, "threads.get", { threadId: home.thread.id });
    expect(got.automation?.runCount).toBe(3);
    const run = invoke<ThreadListEntry>(db, "threads.get", {
      threadId: (threads[0] as { id: string }).id,
    });
    expect(run.thread.parentThreadId).toBe(home.thread.id);
    expect(run.automation).toBeUndefined();
  });
});
