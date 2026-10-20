import type { Idea, JsonObject } from "@psyche/protocol";
import { parseJson, type SqliteDatabase } from "../sqlite.ts";

/** What accepting an idea does. Built from template text only; untrusted values stay quoted. */
export type IdeaAction =
  | { type: "task"; title: string; goal: string; goalId?: string }
  | {
      type: "automation";
      title: string;
      schedule: string;
      prompt: string;
      /** Also offer a one-off task when `recurring` is false. */
      taskGoal?: string;
      goalId?: string;
    }
  | { type: "goal_cadence"; goalId: string; cadence: string };

export interface StoredIdea extends Idea {
  /** `tools`, `memory`, `goals`, `connector:<id>`. */
  source: string;
  patternKey: string;
  action: IdeaAction;
  /** The evidence includes untrusted content (an email subject): accepted tasks start tainted. */
  untrusted: boolean;
  deliveredAt: string | null;
  dismissReason: string | null;
}

interface IdeaRow {
  id: string;
  kind: Idea["kind"];
  title: string;
  body_md: string;
  evidence: string;
  effort: string;
  acceptance_prob: number;
  status: Idea["status"];
  result_ref: string | null;
  pattern_key: string | null;
  dismiss_reason: string | null;
  created_at: string;
  decided_at: string | null;
  source: string;
  action: string | null;
  untrusted: number;
  delivered_at: string | null;
}

function fromRow(r: IdeaRow): StoredIdea {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    bodyMd: r.body_md,
    evidence: parseJson<JsonObject[]>(r.evidence, []),
    effort: r.effort,
    acceptanceProb: r.acceptance_prob,
    status: r.status,
    resultRef: r.result_ref,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    source: r.source,
    patternKey: r.pattern_key ?? r.id,
    action: parseJson<IdeaAction>(r.action, { type: "task", title: r.title, goal: r.title }),
    untrusted: r.untrusted === 1,
    deliveredAt: r.delivered_at,
    dismissReason: r.dismiss_reason,
  };
}

export function toIdea(i: StoredIdea): Idea {
  return {
    id: i.id,
    kind: i.kind,
    title: i.title,
    bodyMd: i.bodyMd,
    evidence: i.evidence,
    effort: i.effort,
    acceptanceProb: i.acceptanceProb,
    status: i.status,
    resultRef: i.resultRef ?? null,
    createdAt: i.createdAt,
    decidedAt: i.decidedAt ?? null,
  };
}

/** `ideas` (data model §8 plus the delivery columns). */
export class IdeaStore {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  insert(i: StoredIdea): void {
    this.#db
      .prepare(
        `INSERT INTO ideas (id, kind, title, body_md, evidence, effort, acceptance_prob, status,
           result_ref, pattern_key, dismiss_reason, created_at, decided_at, source, action,
           untrusted, delivered_at)
         VALUES (@id, @kind, @title, @body_md, @evidence, @effort, @acceptance_prob, @status,
           @result_ref, @pattern_key, @dismiss_reason, @created_at, @decided_at, @source, @action,
           @untrusted, @delivered_at)`,
      )
      .run(this.#row(i));
  }

  update(i: StoredIdea): void {
    this.#db
      .prepare(
        `UPDATE ideas SET acceptance_prob = @acceptance_prob, status = @status,
           result_ref = @result_ref, dismiss_reason = @dismiss_reason, decided_at = @decided_at,
           delivered_at = @delivered_at
         WHERE id = @id`,
      )
      .run(this.#row(i));
  }

  #row(i: StoredIdea) {
    return {
      id: i.id,
      kind: i.kind,
      title: i.title,
      body_md: i.bodyMd,
      evidence: JSON.stringify(i.evidence),
      effort: i.effort,
      acceptance_prob: i.acceptanceProb,
      status: i.status,
      result_ref: i.resultRef ?? null,
      pattern_key: i.patternKey,
      dismiss_reason: i.dismissReason,
      created_at: i.createdAt,
      decided_at: i.decidedAt ?? null,
      source: i.source,
      action: JSON.stringify(i.action),
      untrusted: i.untrusted ? 1 : 0,
      delivered_at: i.deliveredAt,
    };
  }

  get(id: string): StoredIdea | undefined {
    const r = this.#db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as IdeaRow | undefined;
    return r === undefined ? undefined : fromRow(r);
  }

  all(): StoredIdea[] {
    return (this.#db.prepare("SELECT * FROM ideas ORDER BY created_at, id").all() as IdeaRow[]).map(
      fromRow,
    );
  }

  byPattern(patternKey: string): StoredIdea[] {
    return (
      this.#db
        .prepare("SELECT * FROM ideas WHERE pattern_key = ? ORDER BY created_at, id")
        .all(patternKey) as IdeaRow[]
    ).map(fromRow);
  }

  /** Queued candidates (mined, not yet delivered). */
  queued(): StoredIdea[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM ideas WHERE status = 'proposed' AND delivered_at IS NULL ORDER BY created_at, id",
        )
        .all() as IdeaRow[]
    ).map(fromRow);
  }

  /** Delivered ideas with one of `statuses`, newest first, keyset-paged on (created_at, id). */
  page(
    statuses: readonly Idea["status"][],
    page: { cursor?: string; limit?: number },
  ): { ideas: StoredIdea[]; nextCursor: string | null } {
    const limit = Math.max(1, Math.min(page.limit ?? 50, 500));
    const params: unknown[] = [...statuses];
    let where = `status IN (${statuses.map(() => "?").join(", ")}) AND delivered_at IS NOT NULL`;
    if (page.cursor !== undefined) {
      let after: [string, string] = ["", ""];
      try {
        after = JSON.parse(Buffer.from(page.cursor, "base64url").toString()) as [string, string];
      } catch {
        // a bad cursor reads as the start
      }
      where += " AND (delivered_at < ? OR (delivered_at = ? AND id < ?))";
      params.push(after[0], after[0], after[1]);
    }
    const rows = this.#db
      .prepare(`SELECT * FROM ideas WHERE ${where} ORDER BY delivered_at DESC, id DESC LIMIT ?`)
      .all(...params, limit + 1) as IdeaRow[];
    const items = rows.slice(0, limit).map(fromRow);
    const last = items.at(-1);
    return {
      ideas: items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? Buffer.from(JSON.stringify([last.deliveredAt, last.id])).toString("base64url")
          : null,
    };
  }
}
