import { getThread, isForkThread, type PsycheDb } from "@psyche/db";
import { isForkSessionKey, PsycheError, type Task } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";

/**
 * Keeping a plan fork's speculative text where it belongs (docs/design/fork-a-plan-2026.md §2.3,
 * §4.4). A branch transcript says "assume we move to Austin", and a forced report's task goal
 * (`buildForcedReportGoal`) carries read excerpts from mail, Messages, Contacts and Memory. Every
 * exclusion keys on the fork origin (a `plan_fork_branches` row, `tasks.created_from = 'fork'`)
 * and on the fork session prefixes (`fork-branch:`, `fork-digest:`) both, so a thread that only
 * one of them marks is still left out.
 */

export { isForkThread };

/** The desktop shell on this Mac's loopback: the only viewer of a fork's owner-only text. */
export function isDesktopViewer(call: Pick<Call, "identity" | "conn">): boolean {
  const identity = call.identity as { role?: string; desktopShell?: boolean } | undefined;
  return (
    identity?.role === "client" &&
    identity.desktopShell === true &&
    (call.conn as { peer?: { remoteLoopback?: boolean } } | undefined)?.peer?.remoteLoopback ===
      true
  );
}

/**
 * The loop's "no memory writes from this thread" predicate (`AgentLoopOptions.isIncognito`):
 * incognito chats, and a fork's hidden threads, whose turns never reach daily notes (compaction
 * flush) or spawn work that would.
 */
export function memoryWritesOff(db: PsycheDb): (threadId: string) => boolean {
  return (threadId) => getThread(db, threadId)?.kind === "incognito" || isForkThread(db, threadId);
}

/** A fork task: by origin, or because it runs in a fork's hidden thread. */
export function isForkTask(db: PsycheDb, task: Pick<Task, "createdFrom" | "threadId">): boolean {
  return task.createdFrom === "fork" || isForkThread(db, task.threadId);
}

/** Tasks without a fork's hidden work: the daily brief's task lines and `growth.summary`. */
export function withoutForkTasks<T extends Pick<Task, "createdFrom" | "threadId">>(
  db: PsycheDb,
  tasks: readonly T[],
): T[] {
  return tasks.filter((t) => !isForkTask(db, t));
}

/** The learner never reads a fork's hidden thread: a branch turn is a hypothesis, not a fact. */
export function learnerSkipsThread(
  db: PsycheDb,
  thread: { id: string; sessionKey: string },
): boolean {
  return isForkSessionKey(thread.sessionKey) || isForkThread(db, thread.id);
}

/**
 * Whether a caller that is not the desktop shell may not see this fork thread at all, by the
 * `viewer.ts` rule (§4.4): a branch thread whose branch read Memory, Messages or Contacts, or
 * has not filed its report yet (what it read is not settled), and a forced report's digest
 * thread of such a branch. A fork session key with no branch behind it fails closed. Any other
 * thread is not restricted here.
 */
export function forkThreadRestricted(db: PsycheDb, threadId: string): boolean {
  const row = db.sqlite
    .prepare("SELECT session_key AS key, parent_thread_id AS parent FROM threads WHERE id = ?")
    .get(threadId) as { key: string; parent: string | null } | undefined;
  if (row === undefined) return false;
  const branchOf = (tid: string) =>
    db.sqlite
      .prepare("SELECT status, read_owner_only AS r FROM plan_fork_branches WHERE thread_id = ?")
      .get(tid) as { status: string; r: number } | undefined;
  const restricted = (b: { status: string; r: number }) => b.status !== "reported" || b.r === 1;
  const own = branchOf(threadId);
  if (own !== undefined) return restricted(own);
  if (!isForkSessionKey(row.key)) return false;
  const parent = row.parent === null ? undefined : branchOf(row.parent);
  return parent === undefined ? true : restricted(parent);
}

/**
 * The router's check before any method runs (`connection.ts`): a caller that is not the desktop
 * shell is refused a method that names a restricted fork thread, by `threadId`, `threadIds` or a
 * `runId` of a run in one (threads.get, chat.history, the run trace, exports, sends). The
 * `planForks.*` methods name the parent chat and scrub their own answers.
 */
export function forkThreadRefusal(
  db: PsycheDb,
  method: string,
  params: unknown,
  desktop: boolean,
): void {
  if (desktop || method.startsWith("planForks.")) return;
  const p = (params ?? {}) as Record<string, unknown>;
  const ids: string[] = [];
  if (typeof p.threadId === "string") ids.push(p.threadId);
  if (Array.isArray(p.threadIds))
    for (const t of p.threadIds) if (typeof t === "string") ids.push(t);
  if (typeof p.runId === "string") {
    const run = db.sqlite.prepare("SELECT thread_id AS t FROM runs WHERE id = ?").get(p.runId) as
      | { t: string }
      | undefined;
    if (run !== undefined) ids.push(run.t);
  }
  for (const id of ids) {
    if (forkThreadRestricted(db, id)) {
      throw new PsycheError("forbidden", "this plan's working can be opened only on your Mac", {
        details: { reason: "fork_owner_only" },
      });
    }
  }
}

/**
 * The event personaliser's rule: a subscriber that is not the desktop shell on this Mac gets no
 * event of a fork's hidden thread (its live messages, runs and steps) and no fork task update
 * (its goal holds read excerpts). It gets `planFork.updated`, which names the parent chat only.
 */
export function forkEventHidden(
  db: PsycheDb,
  payload: unknown,
  reader: { local?: boolean },
  cache: Map<string, boolean>,
): boolean {
  if (reader.local === true) return false;
  const p = (payload ?? {}) as Record<string, Record<string, unknown> | string | undefined>;
  const task = p.task as { createdFrom?: unknown; threadId?: unknown } | undefined;
  if (task?.createdFrom === "fork") return true;
  const candidates = [
    p.threadId,
    (p.message as { threadId?: unknown } | undefined)?.threadId,
    (p.thread as { id?: unknown } | undefined)?.id,
    (p.run as { threadId?: unknown } | undefined)?.threadId,
    task?.threadId,
  ];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    let fork = cache.get(c);
    if (fork === undefined) {
      fork = isForkThread(db, c);
      if (cache.size > 5000) cache.clear();
      cache.set(c, fork);
    }
    if (fork) return true;
  }
  return false;
}

/**
 * A fork task as a remote viewer sees it: its kind, state and timing, never its goal (read
 * excerpts), summary, outcome, plan, checklist or taint origins (which name what was read).
 */
export function scrubForkTask<T extends Task>(task: T): T {
  return {
    ...task,
    goal: "",
    summary: null,
    outcome: null,
    plan: null,
    checklist: [],
    ...(task.taintSources === undefined ? {} : { taintSources: [] }),
  };
}

/**
 * `tasks.list`, `tasks.get` and `tasks.actions` held to the viewer: for every caller that is not
 * the desktop shell, a fork task's text is stripped and its Activity lines are withheld.
 */
export function withForkTaskScrub(
  db: PsycheDb,
  handlers: Record<string, HandlerDef>,
): Record<string, HandlerDef> {
  const out: Record<string, HandlerDef> = { ...handlers };
  const wrap = (
    method: string,
    scrub: (call: Call, params: Record<string, unknown>, result: unknown) => unknown,
  ) => {
    const def = handlers[method];
    if (def === undefined) return;
    out[method] = {
      ...def,
      run: async (call: Call, params: never) => {
        const result = await def.run(call, params);
        if (isDesktopViewer(call)) return result;
        return scrub(call, params as Record<string, unknown>, result);
      },
    };
  };
  const one = (t: Task) => (isForkTask(db, t) ? scrubForkTask(t) : t);
  wrap("tasks.list", (_c, _p, r) => {
    const res = r as { tasks: Task[] };
    return { ...res, tasks: res.tasks.map(one) };
  });
  wrap("tasks.get", (_c, _p, r) => {
    const res = r as { task: Task };
    return { ...res, task: one(res.task) };
  });
  wrap("tasks.actions", (_c, p, r) => {
    const taskId = typeof p.taskId === "string" ? p.taskId : "";
    const row = db.sqlite
      .prepare("SELECT created_from AS createdFrom, thread_id AS threadId FROM tasks WHERE id = ?")
      .get(taskId) as Pick<Task, "createdFrom" | "threadId"> | undefined;
    if (row === undefined || !isForkTask(db, row)) return r;
    return { ...(r as object), actions: [], nextCursor: null };
  });
  return out;
}

/**
 * `search.query` for a viewer that is not the desktop shell: hits under a fork's hidden thread
 * (its messages, its task docs) are dropped and subtracted from the counts. The indexer already
 * leaves fork content out; this covers docs indexed before it did.
 */
export function scrubForkSearchHits<
  T extends {
    hits: { id: string; threadId?: string | null }[];
    groups?: { count: number; hits: { id: string; threadId?: string | null }[] }[];
    total?: number;
  },
>(call: Pick<Call, "identity" | "conn">, db: PsycheDb, res: T): T {
  if (isDesktopViewer(call)) return res;
  const memo = new Map<string, boolean>();
  const fork = (h: { threadId?: string | null }) => {
    if (h.threadId == null) return false;
    let v = memo.get(h.threadId);
    if (v === undefined) {
      v = isForkThread(db, h.threadId);
      memo.set(h.threadId, v);
    }
    return v;
  };
  const dropped = new Set<string>();
  for (const h of [...res.hits, ...(res.groups ?? []).flatMap((g) => g.hits)])
    if (fork(h)) dropped.add(h.id);
  if (dropped.size === 0) return res;
  return {
    ...res,
    hits: res.hits.filter((h) => !fork(h)),
    ...(res.total === undefined ? {} : { total: Math.max(0, res.total - dropped.size) }),
    ...(res.groups === undefined
      ? {}
      : {
          groups: res.groups
            .map((g) => {
              const kept = g.hits.filter((h) => !fork(h));
              return {
                ...g,
                count: Math.max(0, g.count - (g.hits.length - kept.length)),
                hits: kept,
              };
            })
            .filter((g) => g.count > 0),
        }),
  };
}
