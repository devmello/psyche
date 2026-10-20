import type { Goal, GoalLink, GoalMilestone, JsonObject } from "@psyche/protocol";
import { parseJson, type SqliteDatabase } from "../sqlite.ts";

/** Rows of `goals`, `goal_milestones` and `goal_links` (data model §8). */
interface GoalRow {
  id: string;
  title: string;
  category: Goal["category"];
  status: Goal["status"];
  inferred: number;
  confirmed_at: string | null;
  plan: string | null;
  cadence: string | null;
  next_checkin_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MilestoneRow {
  id: string;
  goal_id: string;
  title: string;
  due_at: string | null;
  done_at: string | null;
  position: number;
}

interface LinkRow {
  goal_id: string;
  task_id: string | null;
  automation_id: string | null;
  watch_id: string | null;
  created_at: string;
}

function goalFromRow(r: GoalRow): Goal {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    status: r.status,
    inferred: r.inferred === 1,
    confirmedAt: r.confirmed_at,
    plan: parseJson<JsonObject | null>(r.plan, null),
    cadence: r.cadence,
    nextCheckinAt: r.next_checkin_at,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function milestoneFromRow(r: MilestoneRow): GoalMilestone {
  return { id: r.id, goalId: r.goal_id, title: r.title, dueAt: r.due_at, doneAt: r.done_at };
}

function linkFromRow(r: LinkRow): GoalLink {
  return {
    goalId: r.goal_id,
    taskId: r.task_id,
    automationId: r.automation_id,
    watchId: r.watch_id,
  };
}

export interface GoalListFilter {
  status?: readonly Goal["status"][];
  category?: Goal["category"];
}

/** SQLite persistence for goals; no policy here (that is `GoalsService`). */
export class GoalStore {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  insert(goal: Goal): void {
    this.#db
      .prepare(
        `INSERT INTO goals (id, title, category, status, inferred, confirmed_at, plan, cadence,
           next_checkin_at, archived_at, created_at, updated_at)
         VALUES (@id, @title, @category, @status, @inferred, @confirmed_at, @plan, @cadence,
           @next_checkin_at, @archived_at, @created_at, @updated_at)`,
      )
      .run(this.#toRow(goal));
  }

  update(goal: Goal): void {
    this.#db
      .prepare(
        `UPDATE goals SET title = @title, category = @category, status = @status,
           inferred = @inferred, confirmed_at = @confirmed_at, plan = @plan, cadence = @cadence,
           next_checkin_at = @next_checkin_at, archived_at = @archived_at, updated_at = @updated_at
         WHERE id = @id`,
      )
      .run(this.#toRow(goal));
  }

  #toRow(g: Goal): GoalRow {
    return {
      id: g.id,
      title: g.title,
      category: g.category,
      status: g.status,
      inferred: g.inferred ? 1 : 0,
      confirmed_at: g.confirmedAt ?? null,
      plan: g.plan == null ? null : JSON.stringify(g.plan),
      cadence: g.cadence ?? null,
      next_checkin_at: g.nextCheckinAt ?? null,
      archived_at: g.archivedAt ?? null,
      created_at: g.createdAt,
      updated_at: g.updatedAt,
    };
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM goals WHERE id = ?").run(id);
  }

  get(id: string): Goal | undefined {
    const r = this.#db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as GoalRow | undefined;
    return r === undefined ? undefined : goalFromRow(r);
  }

  list(filter: GoalListFilter = {}): Goal[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined && filter.status.length > 0) {
      where.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    if (filter.category !== undefined) {
      where.push("category = ?");
      params.push(filter.category);
    }
    const sql = `SELECT * FROM goals${where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`} ORDER BY created_at DESC, id DESC`;
    return (this.#db.prepare(sql).all(...params) as GoalRow[]).map(goalFromRow);
  }

  /** Open (non-archived) goals whose normalized title equals `title`'s. */
  findByTitle(title: string): Goal[] {
    const wanted = normalizeTitle(title);
    return this.list().filter((g) => normalizeTitle(g.title) === wanted);
  }

  // --- milestones ------------------------------------------------------------------------------

  milestones(goalId: string): GoalMilestone[] {
    return (
      this.#db
        .prepare("SELECT * FROM goal_milestones WHERE goal_id = ? ORDER BY position, id")
        .all(goalId) as MilestoneRow[]
    ).map(milestoneFromRow);
  }

  milestone(goalId: string, milestoneId: string): GoalMilestone | undefined {
    const r = this.#db
      .prepare("SELECT * FROM goal_milestones WHERE goal_id = ? AND id = ?")
      .get(goalId, milestoneId) as MilestoneRow | undefined;
    return r === undefined ? undefined : milestoneFromRow(r);
  }

  insertMilestone(m: GoalMilestone): void {
    const pos = this.#db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM goal_milestones WHERE goal_id = ?")
      .get(m.goalId) as { p: number };
    this.#db
      .prepare(
        "INSERT INTO goal_milestones (id, goal_id, title, due_at, done_at, position) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(m.id, m.goalId, m.title, m.dueAt ?? null, m.doneAt ?? null, pos.p);
  }

  updateMilestone(m: GoalMilestone): void {
    this.#db
      .prepare("UPDATE goal_milestones SET title = ?, due_at = ?, done_at = ? WHERE id = ?")
      .run(m.title, m.dueAt ?? null, m.doneAt ?? null, m.id);
  }

  removeMilestone(goalId: string, milestoneId: string): void {
    this.#db
      .prepare("DELETE FROM goal_milestones WHERE goal_id = ? AND id = ?")
      .run(goalId, milestoneId);
  }

  // --- links -----------------------------------------------------------------------------------

  links(goalId: string): GoalLink[] {
    return (
      this.#db
        .prepare("SELECT * FROM goal_links WHERE goal_id = ? ORDER BY created_at, rowid")
        .all(goalId) as LinkRow[]
    ).map(linkFromRow);
  }

  /** Goals linked to a task, automation or watch (for the Activity and Upcoming views). */
  linkedGoalIds(ref: { taskId?: string; automationId?: string; watchId?: string }): string[] {
    const [column, value] =
      ref.taskId !== undefined
        ? ["task_id", ref.taskId]
        : ref.automationId !== undefined
          ? ["automation_id", ref.automationId]
          : ["watch_id", ref.watchId ?? ""];
    return (
      this.#db.prepare(`SELECT goal_id FROM goal_links WHERE ${column} = ?`).all(value) as {
        goal_id: string;
      }[]
    ).map((r) => r.goal_id);
  }

  /** Idempotent: the unique index makes a repeated link a no-op. */
  link(link: GoalLink, createdAt: string): void {
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO goal_links (goal_id, task_id, automation_id, watch_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        link.goalId,
        link.taskId ?? null,
        link.automationId ?? null,
        link.watchId ?? null,
        createdAt,
      );
  }

  unlink(link: GoalLink): void {
    this.#db
      .prepare(
        "DELETE FROM goal_links WHERE goal_id = ? AND task_id IS ? AND automation_id IS ? AND watch_id IS ?",
      )
      .run(link.goalId, link.taskId ?? null, link.automationId ?? null, link.watchId ?? null);
  }

  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
