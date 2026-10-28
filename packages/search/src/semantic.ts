import type Database from "better-sqlite3";
import { ensureCardSchema } from "./cards/store.ts";
import { contextLine } from "./cards/text.ts";

/**
 * On-device semantic search (docs/design/search-2026.md §3–§5): chunk embeddings of indexed
 * documents, stored next to the lexical index, and a nearest-neighbour scan the index fuses with
 * BM25 by reciprocal rank fusion.
 *
 * - `search_vectors` holds one row per chunk: the chunk text (for snippets), the model and width,
 *   and the unit-length float32 embedding (the source of truth). `search_vec_state` records which
 *   version of a document each model embedded, so edits re-embed and unchanged documents never do.
 * - A trigger on `search_docs` deletes a document's vectors with the document, whatever deleted it
 *   (thread deleted or turned incognito, a connector dropped, a rebuild's sweep): no embedding of
 *   removed content outlives it.
 * - Queries use only vectors of the active model; switching model re-embeds in the background and
 *   drops the old model's rows once the new pass has caught up.
 * - The scan is exact, over an in-memory int8 copy of the active model's vectors (~38 MB for 100k
 *   chunks of 384 dimensions), so no vector extension has to load.
 */

/** Turns text into vectors. Implementations: on-device ONNX, the model router, test fakes. */
export interface SearchEmbedder {
  /** Identifies the vector space (model and its prefixes); a change re-embeds everything. */
  readonly model: string;
  /** Minimum cosine for a semantic-only hit with this model (overrides the index default). */
  readonly floor?: number;
  embed(
    texts: string[],
    purpose: "document" | "query",
    signal?: AbortSignal,
  ): Promise<ArrayLike<number>[]>;
}

export interface SemanticCandidate {
  docId: string;
  /** Cosine similarity of the best chunk (approximate: int8 scan). */
  cosine: number;
  /** That chunk's text. */
  chunk: string;
}

export interface SemanticSearch {
  /** Nearest documents to `text` above the cosine floor, best first; `[]` when not ready. */
  candidates(text: string, k: number): Promise<SemanticCandidate[]>;
  /** The index wrote documents: embed them in the background. */
  schedule?(): void;
}

export interface SemanticIndexOptions {
  /** Minimum cosine for a semantic-only hit (model-specific; default 0.75). */
  floor?: number;
  /** Chunks embedded per call (default 16). */
  batchSize?: number;
  /** Pause between batches so the CPU stays available (default 50 ms). */
  pauseMs?: number;
  /** How long a query waits for its embedding before searching lexically (default 300 ms). */
  queryTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Progress of the background pass. */
  onProgress?: (p: SemanticProgress) => void;
}

export interface SemanticProgress {
  state: "idle" | "indexing" | "ready" | "error";
  model?: string;
  dims?: number;
  /** Documents embedded in this pass, and how many were pending when it started. */
  done: number;
  total: number;
  error?: string;
}

/** Kinds that get vectors. Memory has its own index; people and projects are cards. */
const EMBED_KINDS = ["message", "task", "library", "feed", "idea", "goal", "connector"] as const;
/** Texts shorter than this ("ok", "thanks") stay lexical-only. */
const MIN_CHARS = 24;
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 200;
const SINGLE_MAX = 1500;
const MAX_CHUNKS = { library: 64, other: 16 } as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS search_vectors (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS search_vectors_doc ON search_vectors (doc_id);
CREATE INDEX IF NOT EXISTS search_vectors_model ON search_vectors (model);
CREATE TABLE IF NOT EXISTS search_vec_state (
  doc_id TEXT NOT NULL,
  model TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (doc_id, model)
);
CREATE TRIGGER IF NOT EXISTS search_docs_vectors_ad AFTER DELETE ON search_docs BEGIN
  DELETE FROM search_vectors WHERE doc_id = old.id;
  DELETE FROM search_vec_state WHERE doc_id = old.id;
END;
`;

/** What a document's embedding depends on; a message's title is its thread's, so it is left out. */
const VERSION_SQL =
  "d.updated_ms || ':' || length(d.body) || ':' || (CASE WHEN d.kind = 'message' THEN 0 ELSE length(d.title) END) || ':' || coalesce(c.updated_ms, 0)";

/** The text a document is embedded from, split into chunks (empty: too short to embed). */
export function chunksOf(
  kind: string,
  title: string,
  body: string,
  context?: { source?: string | null; createdAt?: number; card?: string },
): string[] {
  const chunks = bodyChunks(kind, title, body);
  // A long document's later chunks lose their title; every chunk carries a context line so it
  // can be found on its own (title, source, date).
  const line =
    chunks.length > 1 && kind !== "message"
      ? contextLine({ title, source: context?.source ?? kind, createdAt: context?.createdAt })
      : "";
  const out = line === "" ? chunks : chunks.map((c, i) => (i === 0 ? c : `${line}\n${c}`));
  const card = (context?.card ?? "").replace(/\s+/g, " ").trim();
  // The card is its own chunk: its summary and questions match how people ask.
  if (card.length >= MIN_CHARS) out.push(card.slice(0, SINGLE_MAX));
  return out;
}

function bodyChunks(kind: string, title: string, body: string): string[] {
  const text = (kind === "message" ? body : `${title}\n${body}`).replace(/\s+/g, " ").trim();
  if (text.length < MIN_CHARS) return [];
  if (text.length <= SINGLE_MAX) return [text];
  const max = kind === "library" ? MAX_CHUNKS.library : MAX_CHUNKS.other;
  const out: string[] = [];
  let start = 0;
  while (start < text.length && out.length < max) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length) {
      // End on a sentence or word boundary in the last quarter of the window.
      const window = text.slice(start + CHUNK_CHARS * 0.75, end);
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf(" "));
      if (cut > 0) end = start + Math.floor(CHUNK_CHARS * 0.75) + cut + 1;
    }
    out.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return out;
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  const len = Math.sqrt(n);
  if (len > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) / len;
  return out;
}

/** In-memory int8 copy of one model's unit vectors. */
class VectorCache {
  readonly dims: number;
  #data: Int8Array;
  #docs: string[] = [];
  #ids: string[] = [];
  #alive: Uint8Array;
  #slot = new Map<string, number>();
  #size = 0;
  #dead = 0;

  constructor(dims: number, capacity = 1024) {
    this.dims = dims;
    this.#data = new Int8Array(dims * capacity);
    this.#alive = new Uint8Array(capacity);
  }

  get size(): number {
    return this.#size - this.#dead;
  }

  get deadRatio(): number {
    return this.#size === 0 ? 0 : this.#dead / this.#size;
  }

  put(id: string, docId: string, v: Float32Array): void {
    if (v.length !== this.dims) return;
    let i = this.#slot.get(id);
    if (i === undefined) {
      i = this.#size++;
      if (i >= this.#alive.length) this.#grow();
      this.#slot.set(id, i);
      this.#ids[i] = id;
    } else if (this.#alive[i] === 0) this.#dead--;
    this.#docs[i] = docId;
    this.#alive[i] = 1;
    const off = i * this.dims;
    for (let j = 0; j < this.dims; j++) this.#data[off + j] = Math.round((v[j] as number) * 127);
  }

  dropDoc(docId: string): void {
    for (let i = 0; i < this.#size; i++) {
      if (this.#alive[i] === 1 && this.#docs[i] === docId) {
        this.#alive[i] = 0;
        this.#dead++;
      }
    }
  }

  drop(id: string): void {
    const i = this.#slot.get(id);
    if (i !== undefined && this.#alive[i] === 1) {
      this.#alive[i] = 0;
      this.#dead++;
    }
  }

  /** The `k` nearest live chunks to the unit vector `q`, best first. */
  nearest(q: Float32Array, k: number): { id: string; docId: string; cosine: number }[] {
    const top: { i: number; s: number }[] = [];
    let floor = -Infinity;
    const d = this.#data;
    const dims = this.dims;
    for (let i = 0; i < this.#size; i++) {
      if (this.#alive[i] === 0) continue;
      const off = i * dims;
      let s = 0;
      for (let j = 0; j < dims; j++) s += (q[j] as number) * (d[off + j] as number);
      if (top.length < k) {
        top.push({ i, s });
        if (top.length === k) {
          top.sort((a, b) => b.s - a.s);
          floor = top[k - 1]?.s ?? -Infinity;
        }
      } else if (s > floor) {
        let at = k - 1;
        while (at > 0 && (top[at - 1]?.s ?? Infinity) < s) at--;
        top.splice(at, 0, { i, s });
        top.pop();
        floor = top[k - 1]?.s ?? -Infinity;
      }
    }
    if (top.length < k) top.sort((a, b) => b.s - a.s);
    return top.map(({ i, s }) => ({
      id: this.#ids[i] as string,
      docId: this.#docs[i] as string,
      cosine: s / 127,
    }));
  }

  #grow(): void {
    const cap = this.#alive.length * 2;
    const data = new Int8Array(this.dims * cap);
    data.set(this.#data);
    this.#data = data;
    const alive = new Uint8Array(cap);
    alive.set(this.#alive);
    this.#alive = alive;
  }
}

interface PendingRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  source: string | null;
  created_ms: number;
  card: string | null;
  version: string;
}

/**
 * Vectors for the documents of a `SqliteSearchIndex` (same connection). `setEmbedder` turns it on
 * (or switches model), `setEmbedder(undefined)` off; `clear()` drops every vector.
 */
export class SemanticIndex implements SemanticSearch {
  readonly #db: Database.Database;
  readonly #floor: number;
  readonly #batch: number;
  readonly #pauseMs: number;
  readonly #queryTimeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onProgress: ((p: SemanticProgress) => void) | undefined;
  #embedder: SearchEmbedder | undefined;
  #cache: VectorCache | undefined;
  #dims: number | undefined;
  #pass: Promise<void> | null = null;
  #again = false;
  #generation = 0;
  #progress: SemanticProgress = { state: "idle", done: 0, total: 0 };

  constructor(db: Database.Database, options: SemanticIndexOptions = {}) {
    this.#db = db;
    this.#floor = options.floor ?? 0.75;
    this.#batch = Math.max(1, options.batchSize ?? 16);
    this.#pauseMs = options.pauseMs ?? 50;
    this.#queryTimeoutMs = options.queryTimeoutMs ?? 300;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))));
    this.#onProgress = options.onProgress;
    db.exec(SCHEMA);
    ensureCardSchema(db);
    // Rows whose document went away while the trigger did not exist (an older index).
    db.exec(
      "DELETE FROM search_vectors WHERE doc_id NOT IN (SELECT id FROM search_docs); DELETE FROM search_vec_state WHERE doc_id NOT IN (SELECT id FROM search_docs)",
    );
  }

  get model(): string | undefined {
    return this.#embedder?.model;
  }

  progress(): SemanticProgress {
    return { ...this.#progress };
  }

  /** Vectors stored for the active model. */
  count(): number {
    const model = this.#embedder?.model;
    if (model === undefined) return 0;
    return (
      this.#db.prepare("SELECT count(*) AS n FROM search_vectors WHERE model = ?").get(model) as {
        n: number;
      }
    ).n;
  }

  /** Starts (or switches to) `embedder` and embeds what is missing in the background. */
  setEmbedder(embedder: SearchEmbedder | undefined): void {
    if (embedder?.model === this.#embedder?.model && embedder !== undefined) {
      this.#embedder = embedder;
      this.schedule();
      return;
    }
    this.#generation++;
    this.#embedder = embedder;
    this.#cache = undefined;
    this.#dims = undefined;
    if (embedder === undefined) {
      this.#set({ state: "idle", done: 0, total: 0 });
      return;
    }
    this.schedule();
  }

  /** Drops every vector (semantic search turned off). */
  clear(): void {
    this.#db.exec("DELETE FROM search_vectors; DELETE FROM search_vec_state");
    this.#cache = undefined;
  }

  /** Embeds documents added or changed since the last pass (called after index writes). */
  schedule(): void {
    if (this.#embedder === undefined) return;
    if (this.#pass !== null) {
      this.#again = true;
      return;
    }
    this.#pass = this.#run(this.#generation).finally(() => {
      this.#pass = null;
      if (this.#again) {
        this.#again = false;
        this.schedule();
      }
    });
  }

  /** Resolves when the background pass (and any it scheduled) has finished. */
  async idle(): Promise<void> {
    while (this.#pass !== null) await this.#pass;
  }

  async candidates(text: string, k: number): Promise<SemanticCandidate[]> {
    const embedder = this.#embedder;
    const q = text.trim();
    if (embedder === undefined || q.length < 3) return [];
    const cache = this.#loadCache(embedder.model);
    if (cache === undefined || cache.size === 0) return [];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#queryTimeoutMs);
    let vector: Float32Array;
    try {
      const out = await Promise.race([
        embedder.embed([q], "query", ac.signal),
        new Promise<never>((_, reject) =>
          ac.signal.addEventListener("abort", () => reject(new SemanticBusyError())),
        ),
      ]);
      const first = out[0];
      if (first === undefined) return [];
      vector = normalize(first);
    } finally {
      clearTimeout(timer);
    }
    if (vector.length !== cache.dims) return [];
    // More chunks than documents: several chunks of one document may rank close together.
    const near = cache.nearest(vector, Math.max(k * 3, 50));
    const floor = embedder.floor ?? this.#floor;
    const best = new Map<string, { id: string; cosine: number }>();
    for (const n of near) {
      if (n.cosine < floor) break;
      if (!best.has(n.docId)) best.set(n.docId, { id: n.id, cosine: n.cosine });
      if (best.size >= k) break;
    }
    if (best.size === 0) return [];
    const ids = [...best.values()].map((b) => b.id);
    const rows = this.#db
      .prepare(
        `SELECT id, doc_id, text FROM search_vectors WHERE id IN (${ids.map(() => "?").join(", ")})`,
      )
      .all(...ids) as { id: string; doc_id: string; text: string }[];
    const textOf = new Map(rows.map((r) => [r.id, r.text]));
    const out: SemanticCandidate[] = [];
    for (const [docId, b] of best) {
      const chunk = textOf.get(b.id);
      // Gone since the cache was loaded (its document was deleted).
      if (chunk === undefined) {
        cache.drop(b.id);
        continue;
      }
      out.push({ docId, cosine: b.cosine, chunk });
    }
    if (cache.deadRatio > 0.25) this.#cache = undefined;
    return out;
  }

  #loadCache(model: string): VectorCache | undefined {
    if (this.#cache !== undefined) return this.#cache;
    const dims = this.#dims ?? this.#storedDims(model);
    if (dims === undefined) return undefined;
    const cache = new VectorCache(dims);
    const rows = this.#db
      .prepare("SELECT id, doc_id, embedding FROM search_vectors WHERE model = ? AND dims = ?")
      .iterate(model, dims) as Iterable<{ id: string; doc_id: string; embedding: Buffer }>;
    for (const r of rows) cache.put(r.id, r.doc_id, decode(r.embedding));
    this.#cache = cache;
    this.#dims = dims;
    return cache;
  }

  #storedDims(model: string): number | undefined {
    const row = this.#db
      .prepare("SELECT dims FROM search_vectors WHERE model = ? LIMIT 1")
      .get(model) as { dims: number } | undefined;
    return row?.dims;
  }

  #pending(model: string, limit: number): PendingRow[] {
    return this.#db
      .prepare(
        `SELECT d.id AS id, d.kind AS kind, d.title AS title, d.body AS body, d.source AS source,
           d.created_ms AS created_ms, c.fts AS card, ${VERSION_SQL} AS version
         FROM search_docs d LEFT JOIN search_vec_state s ON s.doc_id = d.id AND s.model = ?
         LEFT JOIN search_cards c ON c.doc_id = d.id
         WHERE d.kind IN (${EMBED_KINDS.map(() => "?").join(", ")})
           AND (s.version IS NULL OR s.version != ${VERSION_SQL})
         ORDER BY d.created_ms DESC LIMIT ?`,
      )
      .all(model, ...EMBED_KINDS, limit) as PendingRow[];
  }

  #pendingCount(model: string): number {
    return (
      this.#db
        .prepare(
          `SELECT count(*) AS n FROM search_docs d
           LEFT JOIN search_vec_state s ON s.doc_id = d.id AND s.model = ?
           LEFT JOIN search_cards c ON c.doc_id = d.id
           WHERE d.kind IN (${EMBED_KINDS.map(() => "?").join(", ")})
             AND (s.version IS NULL OR s.version != ${VERSION_SQL})`,
        )
        .get(model, ...EMBED_KINDS) as { n: number }
    ).n;
  }

  async #run(generation: number): Promise<void> {
    const embedder = this.#embedder;
    if (embedder === undefined) return;
    const model = embedder.model;
    const total = this.#pendingCount(model);
    let done = 0;
    this.#set({ state: total === 0 ? "ready" : "indexing", model, done, total, ...this.#dimsOf() });
    try {
      for (;;) {
        if (generation !== this.#generation) return;
        const rows = this.#pending(model, this.#batch);
        if (rows.length === 0) break;
        const chunks: { row: PendingRow; n: number; text: string }[] = [];
        for (const row of rows) {
          chunksOf(row.kind, row.title, row.body, {
            source: row.source,
            createdAt: row.created_ms,
            card: row.card ?? "",
          }).forEach((text, n) => {
            chunks.push({ row, n, text });
          });
        }
        const vectors =
          chunks.length === 0
            ? []
            : await embedder.embed(
                chunks.map((c) => c.text),
                "document",
              );
        if (generation !== this.#generation) return;
        this.#write(model, rows, chunks, vectors);
        done += rows.length;
        this.#set({
          state: "indexing",
          model,
          done,
          total: Math.max(total, done),
          ...this.#dimsOf(),
        });
        await this.#sleep(this.#pauseMs);
      }
      // Caught up: vectors of other models are no longer needed.
      this.#db.prepare("DELETE FROM search_vectors WHERE model != ?").run(model);
      this.#db.prepare("DELETE FROM search_vec_state WHERE model != ?").run(model);
      this.#set({ state: "ready", model, done, total: Math.max(total, done), ...this.#dimsOf() });
    } catch (err) {
      this.#set({
        state: "error",
        model,
        done,
        total,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #dimsOf(): { dims?: number } {
    return this.#dims === undefined ? {} : { dims: this.#dims };
  }

  #write(
    model: string,
    rows: PendingRow[],
    chunks: { row: PendingRow; n: number; text: string }[],
    vectors: ArrayLike<number>[],
  ): void {
    const unit = vectors.map((v) => normalize(v));
    const dims = unit[0]?.length;
    if (dims !== undefined) {
      if (this.#dims !== undefined && this.#dims !== dims) {
        throw new Error(`embedding width changed from ${this.#dims} to ${dims}`);
      }
      this.#dims = dims;
    }
    const cache = this.#cache;
    const delVectors = this.#db.prepare(
      "DELETE FROM search_vectors WHERE doc_id = ? AND model = ?",
    );
    const insert = this.#db.prepare(
      "INSERT INTO search_vectors (id, doc_id, chunk, model, dims, text, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const state = this.#db.prepare(
      "INSERT INTO search_vec_state (doc_id, model, version) VALUES (?, ?, ?) ON CONFLICT (doc_id, model) DO UPDATE SET version = excluded.version",
    );
    const exists = this.#db.prepare("SELECT 1 FROM search_docs WHERE id = ?");
    this.#db.transaction(() => {
      for (const row of rows) {
        // Deleted while its batch was embedding: nothing may be written for it.
        if (exists.get(row.id) === undefined) continue;
        delVectors.run(row.id, model);
        cache?.dropDoc(row.id);
        state.run(row.id, model, row.version);
      }
      chunks.forEach((c, i) => {
        const v = unit[i];
        if (v === undefined || exists.get(c.row.id) === undefined) return;
        const id = `${c.row.id}#${c.n}@${model}`;
        insert.run(id, c.row.id, c.n, model, v.length, c.text, encode(v));
        cache?.put(id, c.row.id, v);
      });
    })();
  }

  #set(p: SemanticProgress): void {
    this.#progress = p;
    this.#onProgress?.({ ...p });
  }
}

/** The query's embedding did not arrive within the budget; the search ran lexically. */
export class SemanticBusyError extends Error {
  constructor() {
    super("semantic_busy");
    this.name = "SemanticBusyError";
  }
}

function encode(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function decode(buf: Uint8Array): Float32Array {
  const copy = new Uint8Array(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
