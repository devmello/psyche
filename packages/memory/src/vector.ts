import { createRequire } from "node:module";
import type { ModelProvider, ModelRef } from "@psyche/protocol";
import type Database from "better-sqlite3";

/**
 * Embeddings and vector search (architecture §4.8, ADR-004). Vectors are stored as float32 BLOBs
 * on `memory_chunks.embedding` (the source of truth). When the sqlite-vec extension loads, a
 * `memory_vec` vec0 table mirrors them for in-database KNN; otherwise search computes exact
 * cosine in process, which is fast enough at personal scale (thousands of chunks).
 */

export type VectorMode = "sqlite-vec" | "brute-force" | "off";

export interface Embedder {
  /** Identifies the vector space; a change triggers re-embedding. */
  readonly model: string;
  embed(texts: string[], purpose: "document" | "query", signal?: AbortSignal): Promise<number[][]>;
}

export interface ProviderEmbedderOptions {
  model?: ModelRef;
  /** Task prefixes some local models need, e.g. nomic-embed-text: `search_document: `. */
  documentPrefix?: string;
  queryPrefix?: string;
  batchSize?: number;
}

/** Wraps `ModelProvider.embed`; `undefined` when the provider has no embeddings. */
export function providerEmbedder(
  provider: ModelProvider,
  options: ProviderEmbedderOptions = {},
): Embedder | undefined {
  const embed = provider.embed?.bind(provider);
  if (embed === undefined) return undefined;
  const batch = Math.max(1, options.batchSize ?? 64);
  return {
    model: options.model ?? `${provider.id}/default`,
    async embed(texts, purpose, signal) {
      const prefix = (purpose === "query" ? options.queryPrefix : options.documentPrefix) ?? "";
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batch) {
        const part = texts.slice(i, i + batch).map((t) => prefix + t);
        out.push(
          ...(await embed(part, {
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(signal === undefined ? {} : { signal }),
          })),
        );
      }
      return out;
    },
  };
}

export function encodeVector(v: readonly number[]): Buffer {
  const f = Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function decodeVector(buf: Uint8Array): Float32Array {
  const copy = new Uint8Array(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Loads sqlite-vec into the connection; `false` (never a throw) when it is unavailable. */
export function tryLoadSqliteVec(sqlite: Database.Database): boolean {
  try {
    const require = createRequire(import.meta.url);
    const vec = require("sqlite-vec") as { load(db: unknown): void };
    vec.load(sqlite);
    sqlite.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

export interface VectorHit {
  id: string;
  cosine: number;
}

/** KNN over chunk embeddings in either mode. */
export class VectorIndex {
  readonly #sqlite: Database.Database;
  readonly #useVec: boolean;
  #dims: number | undefined;

  constructor(sqlite: Database.Database, useSqliteVec: boolean) {
    this.#sqlite = sqlite;
    this.#useVec = useSqliteVec;
    if (useSqliteVec) {
      const row = sqlite.prepare("SELECT value FROM memory_state WHERE key = 'vec.dims'").get() as
        | { value: string }
        | undefined;
      const dims = row === undefined ? undefined : Number(JSON.parse(row.value));
      this.#dims = dims !== undefined && Number.isInteger(dims) && dims > 0 ? dims : undefined;
    }
  }

  get mode(): "sqlite-vec" | "brute-force" {
    return this.#useVec ? "sqlite-vec" : "brute-force";
  }

  /** Creates (or re-creates for a new width) the vec0 table. */
  #ensure(dims: number): void {
    if (!this.#useVec || this.#dims === dims) return;
    this.#sqlite.exec("DROP TABLE IF EXISTS memory_vec");
    this.#sqlite.exec(
      `CREATE VIRTUAL TABLE memory_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${dims}] distance_metric=cosine)`,
    );
    this.#sqlite
      .prepare(
        "INSERT INTO memory_state (key, value, updated_at) VALUES ('vec.dims', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(JSON.stringify(dims), new Date().toISOString());
    this.#dims = dims;
    // Mirror existing embeddings of this width.
    const rows = this.#sqlite
      .prepare("SELECT id, embedding FROM memory_chunks WHERE embedding IS NOT NULL")
      .all() as { id: string; embedding: Buffer }[];
    const insert = this.#sqlite.prepare(
      "INSERT INTO memory_vec (chunk_id, embedding) VALUES (?, ?)",
    );
    for (const r of rows) if (r.embedding.byteLength === dims * 4) insert.run(r.id, r.embedding);
  }

  upsert(id: string, embedding: Buffer): void {
    if (!this.#useVec) return;
    this.#ensure(embedding.byteLength / 4);
    this.#sqlite.prepare("DELETE FROM memory_vec WHERE chunk_id = ?").run(id);
    this.#sqlite
      .prepare("INSERT INTO memory_vec (chunk_id, embedding) VALUES (?, ?)")
      .run(id, embedding);
  }

  remove(ids: readonly string[]): void {
    if (!this.#useVec || this.#dims === undefined) return;
    const del = this.#sqlite.prepare("DELETE FROM memory_vec WHERE chunk_id = ?");
    for (const id of ids) del.run(id);
  }

  clear(): void {
    if (this.#useVec && this.#dims !== undefined) this.#sqlite.exec("DELETE FROM memory_vec");
  }

  /** Nearest chunks to `query` among embeddings made by `model`. */
  query(query: readonly number[], model: string, k: number): VectorHit[] {
    if (this.#useVec && this.#dims === query.length) {
      const rows = this.#sqlite
        .prepare(
          `SELECT v.chunk_id AS id, v.distance AS distance
             FROM memory_vec v JOIN memory_chunks c ON c.id = v.chunk_id
            WHERE v.embedding MATCH ? AND k = ? AND c.embedding_model = ?
            ORDER BY v.distance`,
        )
        .all(encodeVector(query), k, model) as { id: string; distance: number }[];
      return rows.map((r) => ({ id: r.id, cosine: 1 - r.distance }));
    }
    const q = Float32Array.from(query);
    const rows = this.#sqlite
      .prepare(
        "SELECT id, embedding FROM memory_chunks WHERE embedding IS NOT NULL AND embedding_model = ?",
      )
      .all(model) as { id: string; embedding: Buffer }[];
    return rows
      .map((r) => ({ id: r.id, cosine: cosine(q, decodeVector(r.embedding)) }))
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, k);
  }
}
