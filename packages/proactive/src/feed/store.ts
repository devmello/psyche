import type { FeedPost } from "@psyche/protocol";
import { parseJson, type SqliteDatabase } from "../sqlite.ts";

interface PostRow {
  id: string;
  title: string;
  body_md: string;
  citations: string;
  cluster: string | null;
  score: number;
  reasons: string;
  exploration: number;
  briefing_id: string | null;
  feedback: FeedPost["feedback"] | null;
  batch_id: string;
  created_at: string;
  read_at?: string | null;
  kind?: string | null;
  refs?: string | null;
  card?: string | null;
  growth?: string | null;
}

export interface StoredPost extends FeedPost {
  batchId: string;
  /** When the owner (or the agent on their behalf) marked it read; not on the wire. */
  readAt?: string | null;
}

function fromRow(r: PostRow): StoredPost {
  return {
    id: r.id,
    title: r.title,
    bodyMd: r.body_md,
    citations: parseJson(r.citations, []),
    cluster: parseJson(r.cluster, null),
    score: r.score,
    reasons: parseJson(r.reasons, []),
    exploration: r.exploration === 1,
    briefingId: r.briefing_id,
    feedback: r.feedback ?? null,
    createdAt: r.created_at,
    batchId: r.batch_id,
    readAt: r.read_at ?? null,
    ...(r.kind == null ? {} : { kind: r.kind as NonNullable<FeedPost["kind"]> }),
    ...(r.refs == null ? {} : { refs: parseJson<NonNullable<FeedPost["refs"]>>(r.refs, {}) }),
    ...(r.card == null
      ? {}
      : { card: parseJson<NonNullable<FeedPost["card"]>>(r.card, null as never) }),
    ...(r.growth == null
      ? {}
      : { growth: parseJson<NonNullable<FeedPost["growth"]>>(r.growth, null as never) }),
  };
}

export interface PostListFilter {
  since?: string;
  briefingId?: string;
  cursor?: string;
  limit?: number;
}

/** `feed_posts` (data model §8). */
export class FeedStore {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  insert(post: StoredPost): void {
    this.#db
      .prepare(
        `INSERT INTO feed_posts (id, title, body_md, citations, cluster, score, reasons, exploration,
           briefing_id, feedback, batch_id, created_at, kind, refs, card, growth)
         VALUES (@id, @title, @body_md, @citations, @cluster, @score, @reasons, @exploration,
           @briefing_id, @feedback, @batch_id, @created_at, @kind, @refs, @card, @growth)`,
      )
      .run({
        id: post.id,
        title: post.title,
        body_md: post.bodyMd,
        citations: JSON.stringify(post.citations),
        cluster: post.cluster == null ? null : JSON.stringify(post.cluster),
        score: post.score,
        reasons: JSON.stringify(post.reasons),
        exploration: post.exploration ? 1 : 0,
        briefing_id: post.briefingId ?? null,
        feedback: post.feedback ?? null,
        batch_id: post.batchId,
        created_at: post.createdAt,
        kind: post.kind ?? null,
        refs: post.refs === undefined ? null : JSON.stringify(post.refs),
        card: post.card === undefined ? null : JSON.stringify(post.card),
        growth: post.growth === undefined ? null : JSON.stringify(post.growth),
      });
  }

  get(id: string): StoredPost | undefined {
    const r = this.#db.prepare("SELECT * FROM feed_posts WHERE id = ?").get(id) as
      | PostRow
      | undefined;
    return r === undefined ? undefined : fromRow(r);
  }

  /** Marks posts read; returns how many changed. */
  markRead(ids: readonly string[], at: string): number {
    let n = 0;
    for (const id of ids) {
      const r = this.#db
        .prepare("UPDATE feed_posts SET read_at = ? WHERE id = ? AND read_at IS NULL")
        .run(at, id) as { changes?: number };
      n += r.changes ?? 0;
    }
    return n;
  }

  setFeedback(id: string, feedback: FeedPost["feedback"]): void {
    this.#db.prepare("UPDATE feed_posts SET feedback = ? WHERE id = ?").run(feedback ?? null, id);
  }

  /** Newest first, keyset-paged on (created_at, id). */
  list(filter: PostListFilter = {}): { posts: StoredPost[]; nextCursor: string | null } {
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 500));
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.since !== undefined) {
      where.push("created_at >= ?");
      params.push(filter.since);
    }
    if (filter.briefingId !== undefined) {
      where.push("briefing_id = ?");
      params.push(filter.briefingId);
    }
    if (filter.cursor !== undefined) {
      let after: [string, string];
      try {
        after = JSON.parse(Buffer.from(filter.cursor, "base64url").toString()) as [string, string];
      } catch {
        after = ["", ""];
      }
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(after[0], after[0], after[1]);
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM feed_posts${where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as PostRow[];
    const items = rows.slice(0, limit).map(fromRow);
    const last = items.at(-1);
    return {
      posts: items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url")
          : null,
    };
  }

  /** Urls already posted in the last `days` (no repeats across briefs). */
  recentUrls(sinceIso: string): Set<string> {
    const rows = this.#db
      .prepare("SELECT citations FROM feed_posts WHERE created_at >= ?")
      .all(sinceIso) as { citations: string }[];
    const out = new Set<string>();
    for (const r of rows)
      for (const c of parseJson<{ url: string }[]>(r.citations, [])) out.add(c.url);
    return out;
  }
}
