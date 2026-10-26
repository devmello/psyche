import type { ActionProposal } from "@psyche/protocol";
import { parseJson, type SqliteDatabase } from "../sqlite.ts";

interface Row {
  id: string;
  title: string;
  calls: string;
  status: ActionProposal["status"];
  created_by: string;
  thread_id: string | null;
  post_id: string | null;
  approval_id: string | null;
  taint: number;
  taint_sources: string | null;
  results: string | null;
  undo_of: string | null;
  finished_at: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

/** A proposal plus the facts only the Gateway needs (the thread its calls run in). */
export interface StoredProposal extends ActionProposal {
  threadId: string | null;
  finishedAt: string | null;
}

function fromRow(r: Row): StoredProposal {
  const p: StoredProposal = {
    id: r.id,
    title: r.title,
    calls: parseJson(r.calls, []),
    sideEffect: "write",
    status: r.status,
    createdBy: parseJson(r.created_by, { job: "unknown" }),
    postId: r.post_id,
    approvalId: r.approval_id,
    taint: r.taint === 1,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    updatedAt: r.updated_at,
    threadId: r.thread_id,
    finishedAt: r.finished_at,
    undoOf: r.undo_of,
  };
  const sources = parseJson<ActionProposal["taintSources"] | null>(r.taint_sources, null);
  if (sources != null) p.taintSources = sources;
  const results = parseJson<ActionProposal["results"] | null>(r.results, null);
  if (results != null) p.results = results;
  return p;
}

export function toActionProposal(p: StoredProposal): ActionProposal {
  const { threadId: _t, finishedAt: _f, ...rest } = p;
  return rest;
}

/** `action_proposals` (migration 202610251900_proactive_proposals). */
export class ProposalStore {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  #row(p: StoredProposal): Row {
    return {
      id: p.id,
      title: p.title,
      calls: JSON.stringify(p.calls),
      status: p.status,
      created_by: JSON.stringify(p.createdBy),
      thread_id: p.threadId,
      post_id: p.postId ?? null,
      approval_id: p.approvalId ?? null,
      taint: p.taint ? 1 : 0,
      taint_sources: p.taintSources === undefined ? null : JSON.stringify(p.taintSources),
      results: p.results === undefined ? null : JSON.stringify(p.results),
      undo_of: p.undoOf ?? null,
      finished_at: p.finishedAt,
      created_at: p.createdAt,
      expires_at: p.expiresAt,
      updated_at: p.updatedAt,
    };
  }

  insert(p: StoredProposal): void {
    this.#db
      .prepare(
        `INSERT INTO action_proposals (id, title, calls, status, created_by, thread_id, post_id,
           approval_id, taint, taint_sources, results, undo_of, finished_at, created_at,
           expires_at, updated_at)
         VALUES (@id, @title, @calls, @status, @created_by, @thread_id, @post_id, @approval_id,
           @taint, @taint_sources, @results, @undo_of, @finished_at, @created_at, @expires_at,
           @updated_at)`,
      )
      .run(this.#row(p));
  }

  update(p: StoredProposal): void {
    this.#db
      .prepare(
        `UPDATE action_proposals SET status = @status, approval_id = @approval_id,
           results = @results, finished_at = @finished_at, updated_at = @updated_at
         WHERE id = @id`,
      )
      .run(this.#row(p));
  }

  get(id: string): StoredProposal | undefined {
    const r = this.#db.prepare("SELECT * FROM action_proposals WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r === undefined ? undefined : fromRow(r);
  }

  byApproval(approvalId: string): StoredProposal | undefined {
    const r = this.#db
      .prepare("SELECT * FROM action_proposals WHERE approval_id = ?")
      .get(approvalId) as Row | undefined;
    return r === undefined ? undefined : fromRow(r);
  }

  list(filter: {
    status?: readonly ActionProposal["status"][];
    postId?: string;
    cursor?: string;
    limit?: number;
  }): { proposals: StoredProposal[]; nextCursor: string | null } {
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 500));
    const where: string[] = [];
    const params: unknown[] = [];
    const statuses = filter.status ?? ["pending", "awaiting_approval"];
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
    if (filter.postId !== undefined) {
      where.push("post_id = ?");
      params.push(filter.postId);
    }
    if (filter.cursor !== undefined) {
      let after: [string, string] = ["", ""];
      try {
        after = JSON.parse(Buffer.from(filter.cursor, "base64url").toString()) as [string, string];
      } catch {
        // a bad cursor reads as the start
      }
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(after[0], after[0], after[1]);
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM action_proposals WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as Row[];
    const items = rows.slice(0, limit).map(fromRow);
    const last = items.at(-1);
    return {
      proposals: items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url")
          : null,
    };
  }
}
