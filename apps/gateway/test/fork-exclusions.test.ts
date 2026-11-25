import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMessage,
  createRun,
  createThread,
  insertPlanFork,
  insertPlanForkBranch,
  listThreadsPage,
  openDb,
  updatePlanForkBranch,
} from "@psyche/db";
import type { Task, Thread } from "@psyche/protocol";
import { type SearchDoc, SearchIndexer } from "@psyche/search";
import { SqliteTaskEngine } from "@psyche/tasks";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it, vi } from "vitest";
import {
  forkEventHidden,
  forkThreadRefusal,
  learnerSkipsThread,
  memoryWritesOff,
  scrubForkSearchHits,
  withForkTaskScrub,
  withoutForkTasks,
} from "../src/compose/fork-hidden.ts";
import { searchSources } from "../src/compose/search-sources.ts";
import { promiseChatOnThreadEnd, snapshotThread } from "../src/compose/thread-end.ts";
import type { Call, HandlerDef } from "../src/context.ts";

/**
 * Every consumer that must not see a plan fork's speculative text (fork-a-plan-2026 §2.3, §4.4),
 * each with must-exclude rows (a thread marked only by its fork origin, only by `fork-branch:`,
 * only by `fork-digest:`) and an include control (the owner's own chat).
 */

const OWNER_TEXT = "I'll send Sam the deck on Friday";

async function fixture() {
  const clock = new FakeClock(Date.parse("2026-11-25T10:00:00Z"));
  const db = openDb(":memory:", { now: () => new Date(clock.now()).toISOString() });
  const engine = new SqliteTaskEngine({ db, clock });
  const main = createThread(db, { kind: "main", sessionKey: "main" });
  const fork = insertPlanFork(db, { threadId: main.id });
  // Marked only by origin: a plan_fork_branches row, an ordinary-looking session key.
  const origin = createThread(db, {
    kind: "subagent",
    sessionKey: "subagent:plain",
    parentThreadId: main.id,
  });
  const branch = insertPlanForkBranch(db, {
    forkId: fork.id,
    ord: 0,
    label: "Austin",
    premise: "Assume Austin",
    threadId: origin.id,
  });
  // Marked only by session key: no branch row.
  const branchKey = createThread(db, { kind: "side", sessionKey: "fork-branch:f_x:1" });
  const digestKey = createThread(db, {
    kind: "side",
    sessionKey: `fork-digest:${branch.id}:1:0`,
    parentThreadId: origin.id,
  });
  const hidden = [origin, branchKey, digestKey];
  for (const t of [main, ...hidden]) {
    appendMessage(
      db,
      {
        threadId: t.id,
        role: "user",
        blocks: [{ type: "text", md: OWNER_TEXT }] as never,
        provenance: "owner",
        runId: null,
      },
      { expectedWriterRunId: null },
    );
  }
  const mk = (threadId: string, createdFrom: string, title: string) =>
    engine.create({
      threadId,
      title,
      goal: `excerpt from mail for ${title}`,
      createdFrom: createdFrom as never,
      mode: "unattended",
      ...(createdFrom === "fork"
        ? { staging: { kind: "fork" as const, forkId: fork.id, branchId: branch.id } }
        : {}),
    });
  const tasks = {
    forkInMain: await mk(main.id, "fork", "fork task in main"),
    inOrigin: await mk(origin.id, "automation", "task in branch thread"),
    inDigest: await mk(digestKey.id, "automation", "task in digest thread"),
    normal: await mk(main.id, "automation", "owner task"),
  };
  return { db, clock, engine, main, fork, branch, origin, branchKey, digestKey, hidden, tasks };
}

const desktop = {
  identity: { deviceId: "dev_mac", role: "client", desktopShell: true },
  conn: { peer: { remoteLoopback: true } },
} as unknown as Call;
const phone = {
  identity: { deviceId: "dev_phone", role: "client" },
  conn: { peer: { remoteLoopback: false } },
} as unknown as Call;

describe("threads.list (listThreadsPage)", () => {
  it("leaves out fork threads by origin and by both prefixes; lists the owner's chat", async () => {
    const f = await fixture();
    const ids = listThreadsPage(f.db, {}).threads.map((t) => t.id);
    expect(ids).toContain(f.main.id);
    for (const t of f.hidden) expect(ids).not.toContain(t.id);
  });
});

describe("the search indexer and the backfill", () => {
  const has = (docs: SearchDoc[], id: string) => docs.some((d) => JSON.stringify(d).includes(id));

  it("indexes no fork thread, message or task (live events)", async () => {
    const f = await fixture();
    const docs: SearchDoc[] = [];
    const removed: string[] = [];
    const writer = {
      index: async (d: SearchDoc) => void docs.push(d),
      remove: async () => {},
      removeThread: async (id: string) => {
        removed.push(id);
        return 0;
      },
      removeThreadMessages: async () => 0,
      setFlag: async () => {},
      retitleThread: async () => {},
    };
    const { getThread, listAllMessages } = await import("@psyche/db");
    const ix = new SearchIndexer(writer, {
      lookupThread: async (id) => getThread(f.db, id),
      lookupTask: (id) => f.engine.get(id),
      isForkThread: (id) => f.hidden.some((t) => t.id === id && t.sessionKey === "subagent:plain"),
    });
    for (const t of [f.main, ...f.hidden]) {
      await ix.handle("thread.updated", { thread: getThread(f.db, t.id) as Thread });
      for (const m of listAllMessages(f.db, t.id)) await ix.handle("chat.message", { message: m });
    }
    for (const t of Object.values(f.tasks)) await ix.handle("task.updated", { task: t });
    expect(has(docs, f.main.id)).toBe(true);
    expect(has(docs, f.tasks.normal.id)).toBe(true);
    for (const t of f.hidden) expect(has(docs, t.id)).toBe(false);
    for (const t of [f.tasks.forkInMain, f.tasks.inOrigin, f.tasks.inDigest]) {
      expect(has(docs, t.id)).toBe(false);
    }
  });

  it("the backfill leaves out the same rows", async () => {
    const f = await fixture();
    const sources = searchSources({
      db: f.db,
      home: mkdtempSync(join(tmpdir(), "psyche-forkx-")),
      tasks: { get: (id: string) => f.engine.get(id), actions: async () => [] },
    } as never);
    const docs: SearchDoc[] = [];
    for (const name of ["threads", "messages", "tasks"]) {
      const src = sources.find((s) => s.name === name);
      const page = await src?.page(null);
      docs.push(...(page?.docs ?? []));
    }
    expect(has(docs, f.main.id)).toBe(true);
    expect(has(docs, f.tasks.normal.id)).toBe(true);
    for (const t of f.hidden) expect(has(docs, t.id)).toBe(false);
    for (const t of [f.tasks.forkInMain, f.tasks.inOrigin, f.tasks.inDigest]) {
      expect(has(docs, t.id)).toBe(false);
    }
  });
});

describe("the learner, daily notes and thread-end", () => {
  it("the learner's admit skips fork threads (origin, both prefixes), reads the owner's chat", async () => {
    const f = await fixture();
    expect(learnerSkipsThread(f.db, f.main)).toBe(false);
    for (const t of f.hidden) expect(learnerSkipsThread(f.db, t)).toBe(true);
  });

  it("daily notes: memory writes are off for fork threads and incognito, on for the owner's chat", async () => {
    const f = await fixture();
    const off = memoryWritesOff(f.db);
    expect(off(f.main.id)).toBe(false);
    for (const t of f.hidden) expect(off(t.id)).toBe(true);
    const incognito = createThread(f.db, { kind: "incognito", sessionKey: "incognito:1" });
    expect(off(incognito.id)).toBe(true);
  });

  it("thread-end reads the owner's chat for promises and never a fork thread", async () => {
    const f = await fixture();
    const run = vi.fn(async () => undefined);
    const hook = promiseChatOnThreadEnd({
      enabled: () => true,
      snapshot: (id) => snapshotThread(f.db, id),
      run,
    });
    for (const t of f.hidden) {
      expect(snapshotThread(f.db, t.id)).toMatchObject({ fork: true, turns: [] });
      hook.ending(t.id);
      hook.ended(t.id);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(run).not.toHaveBeenCalled();
    expect(snapshotThread(f.db, f.main.id)?.turns.length).toBe(1);
    hook.ending(f.main.id);
    hook.ended(f.main.id);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });
});

describe("the daily brief's task lines and growth.summary (withoutForkTasks)", () => {
  it("drops fork tasks by origin and tasks in fork threads; keeps the owner's task", async () => {
    const f = await fixture();
    const kept = withoutForkTasks(f.db, Object.values(f.tasks)).map((t) => t.id);
    expect(kept).toEqual([f.tasks.normal.id]);
  });
});

describe("remote viewers: tasks and search hits", () => {
  it("tasks.list, tasks.get and tasks.actions strip fork task text for a phone; the desktop sees it", async () => {
    const f = await fixture();
    const all = Object.values(f.tasks) as Task[];
    const base: Record<string, HandlerDef> = {
      "tasks.list": { run: async () => ({ tasks: all, nextCursor: null }) },
      "tasks.get": {
        run: async (_c, p: never) => ({
          task: all.find((t) => t.id === (p as { taskId: string }).taskId),
        }),
      },
      "tasks.actions": {
        run: async () => ({ actions: [{ id: "a1", text: "read mail" }], nextCursor: null }),
      },
    };
    const h = withForkTaskScrub(f.db, base);
    const list = (c: Call) => h["tasks.list"]?.run(c, {} as never) as Promise<{ tasks: Task[] }>;
    const onPhone = (await list(phone)).tasks;
    for (const id of [f.tasks.forkInMain.id, f.tasks.inOrigin.id, f.tasks.inDigest.id]) {
      expect(onPhone.find((t) => t.id === id)?.goal).toBe("");
    }
    expect(onPhone.find((t) => t.id === f.tasks.normal.id)?.goal).toContain("owner task");
    // Desktop positive control: the fork task's goal is there.
    expect((await list(desktop)).tasks.find((t) => t.id === f.tasks.forkInMain.id)?.goal).toContain(
      "excerpt from mail",
    );
    const get = (c: Call, taskId: string) =>
      h["tasks.get"]?.run(c, { taskId } as never) as Promise<{ task: Task }>;
    expect((await get(phone, f.tasks.forkInMain.id)).task.goal).toBe("");
    expect((await get(desktop, f.tasks.forkInMain.id)).task.goal).toContain("excerpt");
    const actions = (c: Call, taskId: string) =>
      h["tasks.actions"]?.run(c, { taskId } as never) as Promise<{ actions: unknown[] }>;
    expect((await actions(phone, f.tasks.forkInMain.id)).actions).toEqual([]);
    expect((await actions(phone, f.tasks.normal.id)).actions).toHaveLength(1);
    expect((await actions(desktop, f.tasks.forkInMain.id)).actions).toHaveLength(1);
  });

  it("search hits under a fork thread are dropped for a phone and kept for the desktop", async () => {
    const f = await fixture();
    const res = {
      hits: [
        { id: "m1", threadId: f.main.id },
        ...f.hidden.map((t, i) => ({ id: `h${i}`, threadId: t.id })),
      ],
      groups: [
        {
          count: 4,
          hits: [
            { id: "m1", threadId: f.main.id },
            { id: "h0", threadId: f.origin.id },
          ],
        },
      ],
      total: 4,
    };
    const onPhone = scrubForkSearchHits(phone, f.db, res);
    expect(onPhone.hits.map((h) => h.id)).toEqual(["m1"]);
    expect(onPhone.total).toBe(1);
    expect(onPhone.groups?.[0]?.hits.map((h) => h.id)).toEqual(["m1"]);
    expect(scrubForkSearchHits(desktop, f.db, res).hits).toHaveLength(4);
  });
});

describe("fork threads for remote viewers (threads.get, chat.history, runs, events)", () => {
  const refuse =
    (db: Parameters<typeof forkThreadRefusal>[0], method: string, params: unknown, d = false) =>
    () =>
      forkThreadRefusal(db, method, params, d);

  it("refuses a phone a running branch, a branch that read owner-only data and its digest; the desktop is let through", async () => {
    const f = await fixture();
    for (const m of ["threads.get", "chat.history", "threads.export"]) {
      // Still running: what it read is not settled, so it fails closed.
      expect(refuse(f.db, m, { threadId: f.origin.id })).toThrow(/only on your Mac/);
      expect(refuse(f.db, m, { threadId: f.origin.id }, true)).not.toThrow();
    }
    updatePlanForkBranch(f.db, f.branch.id, { status: "reported", readOwnerOnly: true });
    expect(refuse(f.db, "chat.history", { threadId: f.origin.id })).toThrow(/only on your Mac/);
    expect(refuse(f.db, "chat.history", { threadId: f.digestKey.id })).toThrow(/only on your Mac/);
    // A fork key with no branch behind it fails closed.
    expect(refuse(f.db, "threads.get", { threadId: f.branchKey.id })).toThrow(/only on your Mac/);
    const run = createRun(f.db, { threadId: f.origin.id, modelRef: "test/model" } as never);
    expect(refuse(f.db, "runs.trace", { runId: run.id })).toThrow(/only on your Mac/);
    expect(refuse(f.db, "threads.get", { threadId: f.main.id })).not.toThrow();
    expect(refuse(f.db, "planForks.get", { threadId: f.origin.id })).not.toThrow();
    // Reported without reading Memory, Messages or Contacts: the viewer.ts rule shows it.
    updatePlanForkBranch(f.db, f.branch.id, { readOwnerOnly: false });
    expect(refuse(f.db, "chat.history", { threadId: f.origin.id })).not.toThrow();
  });

  it("events of a fork thread or a fork task reach only the desktop shell", async () => {
    const f = await fixture();
    const cache = new Map<string, boolean>();
    const msg = { message: { threadId: f.origin.id } };
    expect(forkEventHidden(f.db, msg, { local: false }, cache)).toBe(true);
    expect(forkEventHidden(f.db, msg, { local: true }, cache)).toBe(false);
    expect(forkEventHidden(f.db, { threadId: f.digestKey.id }, {}, cache)).toBe(true);
    expect(forkEventHidden(f.db, { task: f.tasks.forkInMain }, {}, cache)).toBe(true);
    expect(forkEventHidden(f.db, { message: { threadId: f.main.id } }, {}, cache)).toBe(false);
    expect(forkEventHidden(f.db, { task: f.tasks.normal }, {}, cache)).toBe(false);
  });
});
