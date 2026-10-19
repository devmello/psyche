import type {
  MemoryStore,
  SearchIndex,
  SearchIndexDocKind,
  SearchIndexFilters,
  SearchIndexHit,
  SearchIndexQuery,
  SearchIndexResult,
} from "@psyche/protocol";
import type Database from "better-sqlite3";
import { HL_CLOSE, HL_OPEN, snippetFor, stripMarkers } from "./highlight.ts";
import { searchMemory } from "./memory.ts";
import {
  highlightTokens,
  type ParsedFilters,
  type ParsedQuery,
  parseQuery,
  type SearchFlag,
  toFtsExclusion,
  toFtsMatch,
} from "./query-parser.ts";
import { fuse } from "./ranking.ts";
import { ensureSearchSchema } from "./schema.ts";
import {
  GROUP_OF_KIND,
  GROUP_ORDER,
  type GroupResult,
  OWNER,
  OWNER_SCOPE,
  type RichHit,
  type SearchDoc,
  type SearchGroup,
  type SearchRequest,
  type SearchResponse,
  type SearchViewer,
} from "./types.ts";

export interface SqliteSearchIndexOptions {
  /** Epoch ms; drives the recency boost and relative dates. Default `Date.now`. */
  now?: () => number;
  /** Recency half-life in days (default 30, like the memory index, data model §7). */
  halfLifeDays?: number;
  /** Boost for a document created now: score × (1 + weight × 0.5^(age/halfLife)). Default 1. */
  recencyWeight?: number;
  /** Body text beyond this many characters is not indexed (default 100 000). */
  maxBodyChars?: number;
  /** Memory is queried live through the store, not copied into this index. */
  memory?: MemoryStore;
  /** Minutes east of UTC for calendar dates in queries (default 0). */
  tzOffsetMinutes?: number;
}

interface DocRow {
  rowid: number;
  id: string;
  kind: SearchIndexDocKind;
  grp: SearchGroup;
  title: string;
  body: string;
  provenance: SearchIndexHit["provenance"];
  thread_id: string | null;
  parent_id: string | null;
  sender: string | null;
  mime: string | null;
  created_ms: number;
}

interface RankedRow {
  rid: number;
  grp: SearchGroup;
  score: number;
  /** Rank inside its group (Infinity when only in the flat list). */
  rn: number;
  /** Rank in the flat list (Infinity when only in a group). */
  grn: number;
}

interface Where {
  sql: string[];
  params: unknown[];
}

const BM25 = "bm25(search_fts, 3.0, 1.0, 0.5)";
const DAY_MS = 86_400_000;

function collapseKey(doc: SearchDoc): string {
  if (doc.kind === "thread") return `thread:${doc.id}`;
  if (doc.kind === "message" && doc.threadId !== undefined) return `thread:${doc.threadId}`;
  return `p:${doc.parentId ?? doc.id}`;
}

/**
 * `SearchIndex` over SQLite FTS5 (BM25, porter stemming, diacritics folded) with a recency boost,
 * the query language from `query-parser.ts`, viewer scoping, grouped results with highlights and
 * live fusion of memory hits from `MemoryStore`.
 */
export class SqliteSearchIndex implements SearchIndex {
  readonly db: Database.Database;
  #now: () => number;
  #halfLifeMs: number;
  #weight: number;
  #maxBody: number;
  #memory: MemoryStore | undefined;
  #tz: number;
  #upsert: Database.Statement;
  #delete: Database.Statement;

  constructor(db: Database.Database, options: SqliteSearchIndexOptions = {}) {
    this.db = db;
    this.#now = options.now ?? Date.now;
    this.#halfLifeMs = (options.halfLifeDays ?? 30) * DAY_MS;
    this.#weight = options.recencyWeight ?? 1;
    this.#maxBody = options.maxBodyChars ?? 100_000;
    this.#memory = options.memory;
    this.#tz = options.tzOffsetMinutes ?? 0;
    ensureSearchSchema(db);
    db.pragma("temp_store = MEMORY");
    db.exec("CREATE TEMP TABLE IF NOT EXISTS search_hits (rid INTEGER, grp TEXT, score REAL)");
    db.function(
      "psyche_recency",
      { deterministic: true },
      (created: unknown, now: unknown, halfLife: unknown, weight: unknown) => {
        const age = Math.max(0, Number(now) - Number(created));
        return 1 + Number(weight) * 0.5 ** (age / Number(halfLife));
      },
    );
    this.#upsert = db.prepare(`
      INSERT INTO search_docs (id, kind, grp, title, body, extra, provenance, thread_id, parent_id,
        collapse_key, scope_key, sender, mime, tags, source, created_ms, updated_ms)
      VALUES (@id, @kind, @grp, @title, @body, @extra, @provenance, @thread_id, @parent_id,
        @collapse_key, @scope_key, @sender, @mime, @tags, @source, @created_ms, @updated_ms)
      ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, grp = excluded.grp,
        title = excluded.title, body = excluded.body, extra = excluded.extra,
        provenance = excluded.provenance, thread_id = excluded.thread_id,
        parent_id = excluded.parent_id, collapse_key = excluded.collapse_key,
        scope_key = excluded.scope_key, sender = excluded.sender, mime = excluded.mime,
        tags = excluded.tags, source = excluded.source, created_ms = excluded.created_ms,
        updated_ms = excluded.updated_ms`);
    this.#delete = db.prepare("DELETE FROM search_docs WHERE id = ?");
  }

  // --- Writes ----------------------------------------------------------------------------------

  /** Upserts by id. Incognito documents are never stored; indexing one deletes the old row. */
  async index(doc: SearchDoc): Promise<void> {
    this.#write(doc);
  }

  /** Upserts many documents in one transaction (backfill, rebuild). */
  async indexMany(docs: Iterable<SearchDoc>): Promise<number> {
    let n = 0;
    this.db.transaction(() => {
      for (const doc of docs) {
        this.#write(doc);
        n += 1;
      }
    })();
    return n;
  }

  #write(doc: SearchDoc): void {
    if (doc.incognito === true) {
      this.#delete.run(doc.id);
      return;
    }
    this.#upsert.run({
      id: doc.id,
      kind: doc.kind,
      grp: GROUP_OF_KIND[doc.kind],
      title: doc.title,
      body: doc.text.length > this.#maxBody ? doc.text.slice(0, this.#maxBody) : doc.text,
      extra: [doc.from, ...(doc.tags ?? [])].filter((x) => x !== undefined && x !== "").join(" "),
      provenance: doc.provenance,
      thread_id: doc.threadId ?? null,
      parent_id: doc.parentId ?? null,
      collapse_key: collapseKey(doc),
      scope_key: doc.scopeKey ?? OWNER_SCOPE,
      sender: doc.from ?? null,
      mime: doc.mime ?? null,
      tags: JSON.stringify(doc.tags ?? []),
      source: doc.source ?? null,
      created_ms: Math.trunc(doc.createdAt),
      updated_ms: Math.trunc(doc.updatedAt ?? doc.createdAt),
    });
  }

  async remove(id: string): Promise<void> {
    this.#delete.run(id);
    this.db.prepare("DELETE FROM search_flags WHERE target_id = ?").run(id);
  }

  /** Removes a thread and everything indexed under it (thread deleted or turned incognito). */
  async removeThread(threadId: string): Promise<number> {
    const r = this.db
      .prepare("DELETE FROM search_docs WHERE id = ? OR thread_id = ?")
      .run(threadId, threadId);
    this.db.prepare("DELETE FROM search_flags WHERE target_id = ?").run(threadId);
    return r.changes;
  }

  /** A thread was renamed or re-scoped: carry it to the messages and tasks indexed under it. */
  async retitleThread(threadId: string, title: string, scopeKey: string): Promise<void> {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE search_docs SET title = ? WHERE thread_id = ? AND kind = 'message'")
        .run(title, threadId);
      this.db
        .prepare("UPDATE search_docs SET scope_key = ? WHERE thread_id = ? OR id = ?")
        .run(scopeKey, threadId, threadId);
    })();
  }

  /** Removes every document of a producer (a connector the owner stopped indexing). */
  async removeSource(source: string): Promise<number> {
    return this.db.prepare("DELETE FROM search_docs WHERE source = ?").run(source).changes;
  }

  /** Records a `has:` fact about a document, thread or task (it may not be indexed yet). */
  async setFlag(targetId: string, flag: SearchFlag): Promise<void> {
    this.db
      .prepare("INSERT OR IGNORE INTO search_flags (target_id, flag) VALUES (?, ?)")
      .run(targetId, flag);
  }

  async count(): Promise<number> {
    return (this.db.prepare("SELECT count(*) AS n FROM search_docs").get() as { n: number }).n;
  }

  /** Rebuilds the FTS index from `search_docs` and merges segments. */
  optimize(): void {
    this.db.exec("INSERT INTO search_fts (search_fts) VALUES ('rebuild')");
    this.db.exec("INSERT INTO search_fts (search_fts) VALUES ('optimize')");
  }

  // --- Contract query --------------------------------------------------------------------------

  /** `SearchIndex.query`: flat hits (no collapsing, no memory fusion), best first. */
  async query(query: SearchIndexQuery): Promise<SearchIndexResult> {
    const parsed = this.parse(query.q);
    const where = this.#where(parsed.filters, query.filters, OWNER);
    const limit = clampLimit(query.limit, 20);
    const ranked = this.#rank(parsed, where, { collapse: false, limit, groupLimit: 0 });
    const hits = this.#materialize(parsed, ranked.rows).map(
      ({ id, kind, title, score, snippet, provenance }) => ({
        id,
        kind,
        title,
        score,
        snippet,
        provenance,
      }),
    );
    return { hits, total: ranked.total };
  }

  parse(q: string): ParsedQuery {
    return parseQuery(q, { now: this.#now(), tzOffsetMinutes: this.#tz });
  }

  // --- Rich query ------------------------------------------------------------------------------

  /** Grouped, collapsed, highlighted search for the Search screen and ⌘K. */
  async search(request: SearchRequest): Promise<SearchResponse> {
    const started = performance.now();
    const viewer = request.viewer ?? OWNER;
    const parsed = this.parse(request.q);
    const limit = clampLimit(request.limit, 20);
    const groupLimit = clampLimit(request.groupLimit, 5);
    const where = this.#where(parsed.filters, undefined, viewer);
    if (request.groups !== undefined) {
      const kinds = (Object.keys(GROUP_OF_KIND) as SearchIndexDocKind[]).filter((k) =>
        request.groups?.includes(GROUP_OF_KIND[k]),
      );
      where.sql.push(`d.kind IN (${kinds.map(() => "?").join(", ") || "NULL"})`);
      where.params.push(...kinds);
    }

    const ranked = this.#rank(parsed, where, { collapse: true, limit, groupLimit });
    const local = this.#materialize(parsed, ranked.rows);
    const byRid = new Map(ranked.rows.map((r, i) => [r.rid, local[i]] as const));

    const groups = new Map<SearchGroup, GroupResult>();
    for (const [grp, count] of ranked.groupCounts) groups.set(grp, { group: grp, count, hits: [] });
    for (const r of ranked.rows) {
      const hit = byRid.get(r.rid);
      if (hit !== undefined && r.rn <= groupLimit) groups.get(r.grp)?.hits.push(hit);
    }
    const flatLocal = ranked.rows
      .filter((r) => r.grn <= limit)
      .sort((a, b) => a.grn - b.grn)
      .map((r) => byRid.get(r.rid))
      .filter((h): h is RichHit => h !== undefined);

    let total = ranked.total;
    let flat = flatLocal;
    const memory = await this.#searchMemory(parsed, viewer, request.groups, groupLimit, limit);
    if (memory.length > 0) {
      groups.set("memory", {
        group: "memory",
        count: memory.length,
        hits: memory.slice(0, groupLimit),
      });
      total += memory.length;
      flat = fuse([flatLocal, memory]).slice(0, limit);
    }

    return {
      hits: flat,
      groups: GROUP_ORDER.flatMap((g) => {
        const r = groups.get(g);
        return r === undefined || r.count === 0 ? [] : [r];
      }),
      total,
      warnings: parsed.warnings,
      tookMs: Math.round((performance.now() - started) * 10) / 10,
    };
  }

  async #searchMemory(
    parsed: ParsedQuery,
    viewer: SearchViewer,
    groups: SearchGroup[] | undefined,
    groupLimit: number,
    limit: number,
  ): Promise<RichHit[]> {
    const f = parsed.filters;
    if (this.#memory === undefined || viewer.kind !== "owner") return [];
    if (groups !== undefined && !groups.includes("memory")) return [];
    if (f.kinds !== undefined && !f.kinds.includes("memory")) return [];
    // Filters memory chunks cannot satisfy exclude memory rather than being ignored.
    if (f.from !== undefined || f.has !== undefined || f.mimes !== undefined) return [];
    if (f.threadId !== undefined) return [];
    return searchMemory(this.#memory, parsed, {
      limit: Math.max(groupLimit, limit),
      now: this.#now(),
    });
  }

  // --- Internals -------------------------------------------------------------------------------

  #where(
    parsed: ParsedFilters,
    contract: SearchIndexFilters | undefined,
    viewer: SearchViewer,
  ): Where {
    const sql: string[] = [];
    const params: unknown[] = [];
    const inList = (col: string, values: readonly unknown[]) => {
      sql.push(`${col} IN (${values.map(() => "?").join(", ") || "NULL"})`);
      params.push(...values);
    };
    if (viewer.kind === "delegated") {
      sql.push("d.scope_key = ?", "d.kind != 'memory'");
      params.push(viewer.scopeKey);
    }
    if (parsed.kinds !== undefined) inList("d.kind", parsed.kinds);
    if (contract?.kinds !== undefined) inList("d.kind", contract.kinds);
    if (parsed.provenance !== undefined) inList("d.provenance", parsed.provenance);
    if (contract?.provenance !== undefined) inList("d.provenance", contract.provenance);
    if (parsed.mimes !== undefined) {
      sql.push(`(${parsed.mimes.map(() => "d.mime LIKE ?").join(" OR ")})`);
      params.push(...parsed.mimes.map((m) => m.replace(/\*$/, "%")));
    }
    if (parsed.from !== undefined) {
      sql.push(`(${parsed.from.map(() => "instr(lower(d.sender), ?) > 0").join(" OR ")})`);
      params.push(...parsed.from);
    }
    if (contract?.from !== undefined) {
      sql.push("d.sender = ?");
      params.push(contract.from);
    }
    const threadId = contract?.threadId ?? parsed.threadId;
    if (threadId !== undefined) {
      sql.push("(d.thread_id = ? OR (d.kind = 'thread' AND d.id = ?))");
      params.push(threadId, threadId);
    }
    if (parsed.before !== undefined) {
      sql.push("d.created_ms < ?");
      params.push(parsed.before);
    }
    if (parsed.after !== undefined) {
      sql.push("d.created_ms >= ?");
      params.push(parsed.after);
    }
    if (contract?.before !== undefined) {
      sql.push("d.created_ms < ?");
      params.push(contract.before);
    }
    if (contract?.after !== undefined) {
      sql.push("d.created_ms > ?");
      params.push(contract.after);
    }
    for (const flag of parsed.has ?? []) {
      sql.push(
        "EXISTS (SELECT 1 FROM search_flags f WHERE f.flag = ? AND f.target_id IN (d.id, d.thread_id, d.parent_id))",
      );
      params.push(flag);
    }
    return { sql, params };
  }

  #rank(
    parsed: ParsedQuery,
    where: Where,
    opts: { collapse: boolean; limit: number; groupLimit: number },
  ): { rows: RankedRow[]; total: number; groupCounts: Map<SearchGroup, number> } {
    const match = toFtsMatch(parsed.terms);
    const exclusion = toFtsExclusion(parsed.excluded);
    const sql = [...where.sql];
    const params = [...where.params];
    if (exclusion !== undefined) {
      sql.push("d.rowid NOT IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?)");
      params.push(exclusion);
    }
    // Terms that tokenize to nothing (only punctuation) match nothing rather than everything.
    if (match === undefined && parsed.terms.length > 0) {
      return { rows: [], total: 0, groupCounts: new Map() };
    }
    const recency = "psyche_recency(d.created_ms, ?, ?, ?)";
    const recencyParams = [this.#now(), this.#halfLifeMs, this.#weight];
    const whereSql = sql.length === 0 ? "" : ` AND ${sql.join(" AND ")}`;
    const m =
      match === undefined
        ? `SELECT d.rowid AS rid, d.grp AS grp, d.collapse_key AS ck, ${recency} AS score
           FROM search_docs d WHERE 1 = 1${whereSql}`
        : `SELECT d.rowid AS rid, d.grp AS grp, d.collapse_key AS ck, (-${BM25}) * ${recency} AS score
           FROM search_fts JOIN search_docs d ON d.rowid = search_fts.rowid
           WHERE search_fts MATCH ?${whereSql}`;
    const mParams =
      match === undefined ? [...recencyParams, ...params] : [...recencyParams, match, ...params];
    // Score every match once into a temp table, collapsing messages onto threads and actions
    // onto tasks, then take top-N slices from it. Window functions over the full match set were
    // the slow part on common terms (100k-document test).
    const pick = opts.collapse
      ? "SELECT rid, grp, max(score) AS score FROM m GROUP BY ck"
      : "SELECT rid, grp, score FROM m";
    this.db.prepare("DELETE FROM temp.search_hits").run();
    this.db
      .prepare(
        `WITH m AS MATERIALIZED (${m}) INSERT INTO temp.search_hits (rid, grp, score) ${pick}`,
      )
      .run(...mParams);
    const counts = this.db
      .prepare("SELECT grp, count(*) AS n FROM temp.search_hits GROUP BY grp")
      .all() as { grp: SearchGroup; n: number }[];
    const groupCounts = new Map(counts.map((r) => [r.grp, r.n] as const));
    const total = counts.reduce((sum, r) => sum + r.n, 0);
    const order = "ORDER BY score DESC, rid DESC";
    const byRid = new Map<number, RankedRow>();
    const top = this.db
      .prepare(`SELECT rid, grp, score FROM temp.search_hits ${order} LIMIT ?`)
      .all(opts.limit) as { rid: number; grp: SearchGroup; score: number }[];
    top.forEach((r, i) => {
      byRid.set(r.rid, { ...r, grn: i + 1, rn: Infinity });
    });
    if (opts.groupLimit > 0) {
      const perGroup = this.db.prepare(
        `SELECT rid, grp, score FROM temp.search_hits WHERE grp = ? ${order} LIMIT ?`,
      );
      for (const { grp } of counts) {
        const rows = perGroup.all(grp, opts.groupLimit) as typeof top;
        rows.forEach((r, i) => {
          const prev = byRid.get(r.rid);
          if (prev !== undefined) prev.rn = i + 1;
          else byRid.set(r.rid, { ...r, grn: Infinity, rn: i + 1 });
        });
      }
    }
    this.db.prepare("DELETE FROM temp.search_hits").run();
    const rows = [...byRid.values()].sort((a, b) => b.score - a.score || b.rid - a.rid);
    return { rows, total, groupCounts };
  }

  /** Loads rows and builds snippets and highlights for the ranked rowids only. */
  #materialize(parsed: ParsedQuery, ranked: RankedRow[]): RichHit[] {
    if (ranked.length === 0) return [];
    const rids = ranked.map((r) => r.rid);
    const placeholders = rids.map(() => "?").join(", ");
    const docs = this.db
      .prepare(
        `SELECT rowid, id, kind, grp, title, body, provenance, thread_id, parent_id, sender, mime, created_ms
         FROM search_docs WHERE rowid IN (${placeholders})`,
      )
      .all(...rids) as DocRow[];
    const rowsById = new Map(docs.map((d) => [d.rowid, d]));
    const match = toFtsMatch(parsed.terms);
    const marked = new Map<number, { snip: string; title: string }>();
    if (match !== undefined) {
      const rows = this.db
        .prepare(
          `SELECT rowid AS rid,
             snippet(search_fts, 1, '${HL_OPEN}', '${HL_CLOSE}', '…', 24) AS snip,
             highlight(search_fts, 0, '${HL_OPEN}', '${HL_CLOSE}') AS title
           FROM search_fts WHERE search_fts MATCH ? AND rowid IN (${placeholders})`,
        )
        .all(match, ...rids) as { rid: number; snip: string; title: string }[];
      for (const r of rows) marked.set(r.rid, r);
    }
    const tokens = highlightTokens(parsed);
    return ranked.flatMap((r) => {
      const d = rowsById.get(r.rid);
      if (d === undefined) return [];
      const m = marked.get(r.rid);
      const snip =
        m?.snip.includes(HL_OPEN) === true && m !== undefined
          ? stripMarkers(m.snip)
          : snippetFor(d.body, tokens);
      const title = m !== undefined ? stripMarkers(m.title) : { text: d.title, ranges: [] };
      const hit: RichHit = {
        id: d.id,
        kind: d.kind,
        group: d.grp,
        title: title.text,
        score: r.score,
        snippet: snip.text,
        provenance: d.provenance,
        createdAt: d.created_ms,
        snippetHighlights: snip.ranges,
        titleHighlights: title.ranges,
      };
      if (d.thread_id !== null) hit.threadId = d.thread_id;
      if (d.parent_id !== null) hit.parentId = d.parent_id;
      if (d.sender !== null) hit.from = d.sender;
      if (d.mime !== null) hit.mime = d.mime;
      return [hit];
    });
  }
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(value)));
}
