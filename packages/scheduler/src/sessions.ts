import { createThread, type PsycheDb } from "@psyche/db";
import type { Automation } from "@psyche/protocol";
import type { SessionResolver } from "./types.ts";

/** Session key of an automation's one chat; the id is the automation's. */
export const AUTOMATION_THREAD_PREFIX = "automation:";
/** Session key of one run's work thread (`cron:<automationId>:<runId>`). */
export const RUN_THREAD_PREFIX = "cron:";

export const automationThreadKey = (automationId: string): string =>
  `${AUTOMATION_THREAD_PREFIX}${automationId}`;

/** The automation id a chat's session key names, or `undefined` for any other thread. */
export function automationIdOfThreadKey(sessionKey: string): string | undefined {
  return sessionKey.startsWith(AUTOMATION_THREAD_PREFIX)
    ? sessionKey.slice(AUTOMATION_THREAD_PREFIX.length)
    : undefined;
}

/**
 * The automation's one chat (created on first use), the same thread for every run. It holds no
 * work of its own: each run still executes in its own work thread (below), so approvals granted
 * for the session, the agent's saved transcript and its taint never carry from one run to the
 * next; the chat is where the owner finds the runs together.
 */
export function ensureAutomationThread(
  db: PsycheDb,
  automation: Pick<Automation, "id" | "title">,
): { id: string } {
  const key = automationThreadKey(automation.id);
  const found = db.sqlite
    .prepare(
      "SELECT id FROM threads WHERE session_key = ? AND kind = 'automation' ORDER BY archived_at IS NOT NULL, created_at LIMIT 1",
    )
    .get(key) as { id: string } | undefined;
  if (found !== undefined) return found;
  return createThread(db, {
    kind: "automation",
    sessionKey: key,
    title: automation.title,
    titleSource: "auto",
  });
}

/** Moves the chat up the list: it just ran. */
function touch(db: PsycheDb, threadId: string): void {
  db.sqlite
    .prepare("UPDATE threads SET last_message_at = ?, updated_at = ? WHERE id = ?")
    .run(db.now(), db.now(), threadId);
}

/**
 * Session targets (architecture §4.11; OpenClaw `main` / `isolated` / `session:<id>`):
 * `main` runs in the owner's main thread; `isolated` gets a fresh work thread per run
 * (`cron:<automationId>:<runId>`), filed under the automation's one chat; `named:<id>` reuses one
 * persistent thread across runs.
 */
export function createDbSessionResolver(db: PsycheDb): SessionResolver {
  const bySessionKey = (key: string) =>
    db.sqlite
      .prepare(
        "SELECT id FROM threads WHERE session_key = ? AND archived_at IS NULL ORDER BY created_at LIMIT 1",
      )
      .get(key) as { id: string } | undefined;
  return {
    async resolve(target, { automation, runId }) {
      if (target === "main") {
        const main = db.sqlite
          .prepare(
            "SELECT id FROM threads WHERE kind = 'main' AND archived_at IS NULL ORDER BY created_at LIMIT 1",
          )
          .get() as { id: string } | undefined;
        return main?.id ?? createThread(db, { kind: "main", sessionKey: "main" }).id;
      }
      if (target === "isolated") {
        const home = ensureAutomationThread(db, automation);
        touch(db, home.id);
        return createThread(db, {
          kind: "automation",
          sessionKey: `${RUN_THREAD_PREFIX}${automation.id}:${runId}`,
          title: automation.title,
          parentThreadId: home.id,
        }).id;
      }
      const name = /^named:(.+)$/.exec(target)?.[1];
      if (name === undefined) throw new Error(`unknown session target ${target}`);
      const key = `named:${name}`;
      return (
        bySessionKey(key)?.id ??
        createThread(db, { kind: "automation", sessionKey: key, title: automation.title }).id
      );
    },
  };
}

export interface GroupRunThreadsResult {
  /** Automation chats created for runs that had none. */
  created: number;
  /** Run work threads filed under their automation's chat. */
  filed: number;
}

/**
 * Gateway migration: before, every `isolated` run opened its own chat, so one automation filled
 * the list with copies (and they stayed empty). Files each existing run thread under its
 * automation's one chat. Nothing is deleted or rewritten: the run threads keep their messages,
 * runs, tasks and approvals (the chat shows them with the run they belong to); only the thread
 * list stops showing them. Idempotent; safe to run at every start.
 */
export function groupAutomationRunThreads(db: PsycheDb): GroupRunThreadsResult {
  const rows = db.sqlite
    .prepare(
      `SELECT t.id, t.session_key AS sessionKey, t.title, t.parent_thread_id AS parentId,
              t.created_at AS createdAt
         FROM threads t
        WHERE t.kind = 'automation' AND t.session_key LIKE 'cron:%'
        ORDER BY t.created_at, t.id`,
    )
    .all() as {
    id: string;
    sessionKey: string;
    title: string;
    parentId: string | null;
    createdAt: string;
  }[];
  const result: GroupRunThreadsResult = { created: 0, filed: 0 };
  if (rows.length === 0) return result;
  const titleOf = db.sqlite.prepare("SELECT title FROM automations WHERE id = ?");
  const homes = new Map<string, string>();
  const latest = new Map<string, string>();
  const move = db.sqlite.prepare("UPDATE threads SET parent_thread_id = ? WHERE id = ?");
  const tx = db.sqlite.transaction(() => {
    for (const r of rows) {
      const automationId = r.sessionKey.slice(RUN_THREAD_PREFIX.length).split(":")[0] ?? "";
      if (automationId === "") continue;
      let home = homes.get(automationId);
      if (home === undefined) {
        const existed = db.sqlite
          .prepare("SELECT 1 FROM threads WHERE session_key = ? AND kind = 'automation'")
          .get(automationThreadKey(automationId));
        const title = (titleOf.get(automationId) as { title: string } | undefined)?.title;
        home = ensureAutomationThread(db, { id: automationId, title: title ?? r.title }).id;
        if (existed === undefined) result.created += 1;
        homes.set(automationId, home);
      }
      if (r.parentId !== home) {
        move.run(home, r.id);
        result.filed += 1;
      }
      latest.set(automationId, r.createdAt);
    }
    // The chat sorts where its last run was, not where it was created now.
    const stamp = db.sqlite.prepare(
      "UPDATE threads SET last_message_at = ? WHERE id = ? AND (last_message_at IS NULL OR last_message_at < ?)",
    );
    for (const [automationId, at] of latest) {
      const home = homes.get(automationId);
      if (home !== undefined) stamp.run(at, home, at);
    }
  });
  tx();
  return result;
}
