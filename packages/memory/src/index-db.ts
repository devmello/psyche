import type { MemoryChunk, MemoryHit, Provenance } from "@psyche/protocol";
import type Database from "better-sqlite3";
import { datedNoteDate, isEvergreen } from "./layout.ts";
import { type Embedder, encodeVector, type VectorIndex } from "./vector.ts";

/**
 * The memory index in the main database (data model §7): `memory_files`, `memory_chunks`, the
 * external-content FTS5 table kept in sync by triggers, and the vector mirror. Ranking:
 * `score = bm25_norm * 0.4 + cosine * 0.5 + recency * 0.1`, recency = 0.5^(ageDays / 30).
 */

export const RANK_WEIGHTS = { bm25: 0.4, cosine: 0.5, recency: 0.1 } as const;
export const RECENCY_HALF_LIFE_DAYS = 30;
/** A chunk found only by vector search must be at least this similar to the query. */
export const MIN_VECTOR_ONLY_COSINE = 0.5;
const CANDIDATES = 200;
const DAY_MS = 86_400_000;

export interface ChunkInput {
  id: string;
  source: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  provenance: Provenance;
  tokenCount: number;
}

export interface FileRow {
  path: string;
  sha256: string;
  bytes: number;
  provenance: Provenance;
  mtime_ms: number | null;
  indexed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ChunkRow {
  id: string;
  source: string;
  line_start: number;
  line_end: number;
  text: string;
  provenance: Provenance;
  claim_id: string | null;
  token_count: number;
  embedding_model: string | null;
  created_at: string;
  updated_at: string;
}

export interface IndexSearchOptions {
  limit?: number;
  provenance?: readonly Provenance[];
  sources?: readonly string[];
}

const CHUNK_COLUMNS =
  "c.id, c.source, c.line_start, c.line_end, c.text, c.provenance, c.claim_id, c.token_count, c.embedding_model, c.created_at, c.updated_at";

export function toChunk(row: ChunkRow): MemoryChunk {
  return {
    id: row.id,
    source: row.source,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    text: row.text,
    provenance: row.provenance,
    claimId: row.claim_id,
    tokenCount: row.token_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Query terms, lowercased and unique (letters and digits in any script). */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 32);
}

function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class MemoryIndex {
  readonly #db: Database.Database;
  readonly #now: () => string;
  readonly #vector: VectorIndex;
  readonly #embedder: Embedder | undefined;

  constructor(options: {
    sqlite: Database.Database;
    now: () => string;
    vector: VectorIndex;
    embedder?: Embedder;
  }) {
    this.#db = options.sqlite;
    this.#now = options.now;
    this.#vector = options.vector;
    this.#embedder = options.embedder;
  }

  get vectorMode(): "sqlite-vec" | "brute-force" | "off" {
    return this.#embedder === undefined ? "off" : this.#vector.mode;
  }

  // --- files ------------------------------------------------------------------------------------

  getFile(path: string): FileRow | undefined {
    return this.#db.prepare("SELECT * FROM memory_files WHERE path = ?").get(path) as
      | FileRow
      | undefined;
  }

  listFiles(): FileRow[] {
    return this.#db.prepare("SELECT * FROM memory_files ORDER BY path").all() as FileRow[];
  }

  upsertFile(row: {
    path: string;
    sha256: string;
    bytes: number;
    provenance: Provenance;
    mtimeMs: number | null;
  }): void {
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO memory_files (path, sha256, bytes, provenance, mtime_ms, indexed_at, created_at, updated_at)
         VALUES (@path, @sha256, @bytes, @provenance, @mtimeMs, @now, @now, @now)
         ON CONFLICT (path) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes,
           provenance = excluded.provenance, mtime_ms = excluded.mtime_ms,
           indexed_at = excluded.indexed_at, updated_at = excluded.updated_at`,
      )
      .run({ ...row, now });
  }

  /** Removes a file row and all its chunks; returns the removed chunk ids. */
  deleteFile(path: string): string[] {
    const ids = this.#chunkIds(path);
    this.deleteChunks(ids);
    this.#db.prepare("DELETE FROM memory_files WHERE path = ?").run(path);
    return ids;
  }

  // --- chunks -----------------------------------------------------------------------------------

  #chunkIds(source: string): string[] {
    return (
      this.#db.prepare("SELECT id FROM memory_chunks WHERE source = ?").all(source) as {
        id: string;
      }[]
    ).map((r) => r.id);
  }

  /**
   * Makes the chunks of `source` exactly `chunks`: unchanged chunks keep their row (embedding,
   * claim link), vanished ones are deleted, new ones inserted, changed provenance updated.
   */
  replaceChunks(
    source: string,
    chunks: readonly ChunkInput[],
  ): { added: string[]; removed: string[] } {
    const run = this.#db.transaction(() => {
      const existing = new Map(
        (
          this.#db
            .prepare("SELECT id, provenance FROM memory_chunks WHERE source = ?")
            .all(source) as { id: string; provenance: Provenance }[]
        ).map((r) => [r.id, r.provenance]),
      );
      const wanted = new Map(chunks.map((c) => [c.id, c]));
      const removed = [...existing.keys()].filter((id) => !wanted.has(id));
      this.deleteChunks(removed);
      const now = this.#now();
      const insert = this.#db.prepare(
        `INSERT INTO memory_chunks (id, source, line_start, line_end, text, provenance, token_count, created_at, updated_at)
         VALUES (@id, @source, @lineStart, @lineEnd, @text, @provenance, @tokenCount, @now, @now)`,
      );
      const retag = this.#db.prepare(
        "UPDATE memory_chunks SET provenance = ?, updated_at = ? WHERE id = ?",
      );
      const added: string[] = [];
      for (const c of wanted.values()) {
        const had = existing.get(c.id);
        if (had === undefined) {
          insert.run({ ...c, now });
          added.push(c.id);
        } else if (had !== c.provenance) {
          retag.run(c.provenance, now, c.id);
        }
      }
      return { added, removed };
    });
    return run.immediate();
  }

  deleteChunks(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const del = this.#db.prepare("DELETE FROM memory_chunks WHERE id = ?");
    for (const id of ids) del.run(id);
    this.#vector.remove(ids);
  }

  getChunk(id: string): MemoryChunk | undefined {
    const row = this.#db
      .prepare(`SELECT ${CHUNK_COLUMNS} FROM memory_chunks c WHERE c.id = ?`)
      .get(id) as ChunkRow | undefined;
    return row === undefined ? undefined : toChunk(row);
  }

  chunksBySource(source: string): MemoryChunk[] {
    return (
      this.#db
        .prepare(
          `SELECT ${CHUNK_COLUMNS} FROM memory_chunks c WHERE c.source = ? ORDER BY c.line_start, c.id`,
        )
        .all(source) as ChunkRow[]
    ).map(toChunk);
  }

  allChunks(): MemoryChunk[] {
    return (
      this.#db
        .prepare(
          `SELECT ${CHUNK_COLUMNS} FROM memory_chunks c ORDER BY c.source, c.line_start, c.id`,
        )
        .all() as ChunkRow[]
    ).map(toChunk);
  }

  setChunkClaim(id: string, claimId: string | null): void {
    this.#db
      .prepare("UPDATE memory_chunks SET claim_id = ?, updated_at = ? WHERE id = ?")
      .run(claimId, this.#now(), id);
  }

  counts(): { files: number; chunks: number } {
    const files = (
      this.#db.prepare("SELECT count(*) AS n FROM memory_files").get() as { n: number }
    ).n;
    const chunks = (
      this.#db.prepare("SELECT count(*) AS n FROM memory_chunks").get() as { n: number }
    ).n;
    return { files, chunks };
  }

  /** Drops every chunk and file row (reset). */
  clear(): void {
    this.#db.exec("DELETE FROM memory_chunks; DELETE FROM memory_files;");
    this.#vector.clear();
  }

  /**
   * Embeds chunks that have no embedding from the current model. Failures leave the chunks
   * unembedded (keyword search still finds them) and are retried on the next call.
   */
  async embedPending(signal?: AbortSignal): Promise<number> {
    const embedder = this.#embedder;
    if (embedder === undefined) return 0;
    const rows = this.#db
      .prepare(
        "SELECT id, text FROM memory_chunks WHERE embedding IS NULL OR embedding_model IS NOT ? ORDER BY id",
      )
      .all(embedder.model) as { id: string; text: string }[];
    let done = 0;
    for (let i = 0; i < rows.length; i += 64) {
      const batch = rows.slice(i, i + 64);
      let vectors: number[][];
      try {
        vectors = await embedder.embed(
          batch.map((r) => r.text),
          "document",
          signal,
        );
      } catch {
        return done;
      }
      const update = this.#db.prepare(
        "UPDATE memory_chunks SET embedding = ?, embedding_model = ? WHERE id = ?",
      );
      this.#db.transaction(() => {
        batch.forEach((r, j) => {
          const v = vectors[j];
          if (v === undefined || v.length === 0) return;
          const blob = encodeVector(v);
          // The chunk may have been deleted while the embedder was running.
          if (update.run(blob, embedder.model, r.id).changes > 0) {
            this.#vector.upsert(r.id, blob);
            done++;
          }
        });
      })();
    }
    return done;
  }

  // --- search -----------------------------------------------------------------------------------

  #filterSql(options: IndexSearchOptions): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.provenance !== undefined) {
      if (options.provenance.length === 0) return { sql: " AND 0", params };
      clauses.push(`c.provenance IN (${options.provenance.map(() => "?").join(", ")})`);
      params.push(...options.provenance);
    }
    if (options.sources !== undefined) {
      if (options.sources.length === 0) return { sql: " AND 0", params };
      clauses.push(`(${options.sources.map(() => "c.source LIKE ? ESCAPE '\\'").join(" OR ")})`);
      params.push(...options.sources.map(likePrefix));
    }
    return { sql: clauses.map((c) => ` AND ${c}`).join(""), params };
  }

  #recency(chunk: MemoryChunk, nowMs: number): number {
    if (isEvergreen(chunk.source)) return 1;
    const date = datedNoteDate(chunk.source);
    const at = date === undefined ? Date.parse(chunk.updatedAt) : Date.parse(`${date}T12:00:00Z`);
    const ageDays = Math.max(0, (nowMs - at) / DAY_MS);
    return 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
  }

  async search(query: string, options: IndexSearchOptions, nowMs: number): Promise<MemoryHit[]> {
    const limit = Math.min(Math.max(1, options.limit ?? 10), 100);
    const terms = queryTerms(query);
    const filter = this.#filterSql(options);
    const candidates = new Map<string, { chunk: MemoryChunk; bm25?: number; cosine?: number }>();

    if (terms.length > 0) {
      const match = terms.map((t) => `"${t}"`).join(" OR ");
      const rows = this.#db
        .prepare(
          `SELECT ${CHUNK_COLUMNS}, bm25(memory_fts) AS rank
             FROM memory_fts JOIN memory_chunks c ON c.rowid = memory_fts.rowid
            WHERE memory_fts MATCH ?${filter.sql}
            ORDER BY rank LIMIT ${CANDIDATES}`,
        )
        .all(match, ...filter.params) as (ChunkRow & { rank: number })[];
      const best = Math.max(0, ...rows.map((r) => -r.rank));
      for (const r of rows) {
        const raw = -r.rank;
        candidates.set(r.id, { chunk: toChunk(r), bm25: best > 0 ? raw / best : 1 });
      }
    }

    const embedder = this.#embedder;
    if (embedder !== undefined && query.trim().length > 0) {
      let qv: number[] | undefined;
      try {
        qv = (await embedder.embed([query], "query"))[0];
      } catch {
        qv = undefined;
      }
      if (qv !== undefined && qv.length > 0) {
        const hits = this.#vector.query(qv, embedder.model, CANDIDATES);
        const byId = new Map(hits.map((h) => [h.id, h.cosine]));
        for (const [id, c] of candidates) {
          const cos = byId.get(id);
          if (cos !== undefined) c.cosine = Math.max(0, cos);
        }
        const extra = hits.filter(
          (h) => !candidates.has(h.id) && h.cosine >= MIN_VECTOR_ONLY_COSINE,
        );
        if (extra.length > 0) {
          const rows = this.#db
            .prepare(
              `SELECT ${CHUNK_COLUMNS} FROM memory_chunks c
                WHERE c.id IN (${extra.map(() => "?").join(", ")})${filter.sql}`,
            )
            .all(...extra.map((h) => h.id), ...filter.params) as ChunkRow[];
          for (const r of rows) {
            candidates.set(r.id, { chunk: toChunk(r), cosine: Math.max(0, byId.get(r.id) ?? 0) });
          }
        }
      }
    }

    const hits: MemoryHit[] = [];
    for (const c of candidates.values()) {
      const score =
        (c.bm25 ?? 0) * RANK_WEIGHTS.bm25 +
        (c.cosine ?? 0) * RANK_WEIGHTS.cosine +
        this.#recency(c.chunk, nowMs) * RANK_WEIGHTS.recency;
      hits.push({
        chunk: c.chunk,
        score,
        ...(c.bm25 === undefined ? {} : { bm25: c.bm25 }),
        ...(c.cosine === undefined ? {} : { cosine: c.cosine }),
      });
    }
    return hits
      .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
      .slice(0, limit);
  }
}
