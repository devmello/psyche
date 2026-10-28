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
import { CardStore } from "./cards/store.ts";
import type { ContextCard } from "./cards/types.ts";
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
import { fuse, RRF_K } from "./ranking.ts";
import { ensureSearchSchema } from "./schema.ts";
import { SemanticBusyError, type SemanticCandidate, type SemanticSearch } from "./semantic.ts";
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
import { understand } from "./understand.ts";

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
  /**
   * Minutes east of UTC for calendar dates in queries (default 0). A function is read per query,
   * so daylight saving time follows the owner's zone.
   */
  tzOffsetMinutes?: number | (() => number);
  /** Names and addresses a person is known by (people graph, contacts) for "from Alex". */
  resolvePerson?: (name: string) => readonly string[] | undefined;
}

/** Semantic candidates (documents) fused into one search. */
const SEMANTIC_K = 50;

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
  #tz: () => number;
  #resolvePerson: ((name: string) => readonly string[] | undefined) | undefined;
  #upsert: Database.Statement;
  #delete: Database.Statement;
  #semantic: SemanticSearch | undefined;
  /** Context cards of indexed items (docs/design/grounded-ingest-2026.md). */
  readonly cards: CardStore;

  constructor(db: Database.Database, options: SqliteSearchIndexOptions = {}) {
    this.db = db;
    this.#now = options.now ?? Date.now;
    this.#halfLifeMs = (options.halfLifeDays ?? 30) * DAY_MS;
    this.#weight = options.recencyWeight ?? 1;
    this.#maxBody = options.maxBodyChars ?? 100_000;
    this.#memory = options.memory;
    const tz = options.tzOffsetMinutes ?? 0;
    this.#tz = typeof tz === "function" ? tz : () => tz;
    this.#resolvePerson = options.resolvePerson;
    ensureSearchSchema(db);
    this.cards = new CardStore(db);
    db.pragma("temp_store = MEMORY");
    db.exec("CREATE TEMP TABLE IF NOT EXISTS search_hits (rid INTEGER, grp TEXT, score REAL)");
    this.#upsert = db.prepare(`
      INSERT INTO search_docs (id, kind, grp, title, body, extra, provenance, thread_id, parent_id,
        collapse_key, scope_key, sender, sender_key, mime, tags, source, created_ms, updated_ms)
      VALUES (@id, @kind, @grp, @title, @body, @extra, @provenance, @thread_id, @parent_id,
        @collapse_key, @scope_key, @sender, @sender_key, @mime, @tags, @source, @created_ms,
        @updated_ms)
      ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, grp = excluded.grp,
        title = excluded.title, body = excluded.body, extra = excluded.extra,
        provenance = excluded.provenance, thread_id = excluded.thread_id,
        parent_id = excluded.parent_id, collapse_key = excluded.collapse_key,
        scope_key = excluded.scope_key, sender = excluded.sender,
        sender_key = excluded.sender_key, mime = excluded.mime,
        tags = excluded.tags, source = excluded.source, created_ms = excluded.created_ms,
        updated_ms = excluded.updated_ms`);
    this.#delete = db.prepare("DELETE FROM search_docs WHERE id = ?");
  }

  // --- Writes ----------------------------------------------------------------------------------

  /**
   * Fuses nearest-neighbour hits into `search` (docs/design/search-2026.md §5.8); `undefined`
   * searches lexically only. Writes are handed to it to embed in the background.
   */
  setSemantic(semantic: SemanticSearch | undefined): void {
    this.#semantic = semantic;
  }

  /** Upserts by id. Incognito documents are never stored; indexing one deletes the old row. */
  async index(doc: SearchDoc): Promise<void> {
    this.#write(doc);
    this.#semantic?.schedule?.();
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
    if (n > 0) this.#semantic?.schedule?.();
    return n;
  }

  #write(doc: SearchDoc): void {
    if (doc.incognito === true) {
      this.#delete.run(doc.id);
      return;
    }
    const body = doc.text.length > this.#maxBody ? doc.text.slice(0, this.#maxBody) : doc.text;
    const extra = [doc.from, ...(doc.tags ?? []), this.cards.ftsFor(doc.id)].filter(
      (x) => x !== undefined && x !== "",
    );
    this.#upsert.run({
      id: doc.id,
      kind: doc.kind,
      grp: GROUP_OF_KIND[doc.kind],
      // The highlight markers can never come from content, so ranges cannot be forged.
      title: clean(doc.title),
      body: clean(body),
      extra: clean(extra.join(" ")),
      provenance: doc.provenance,
      thread_id: doc.threadId ?? null,
      parent_id: doc.parentId ?? null,
      collapse_key: collapseKey(doc),
      scope_key: doc.scopeKey ?? OWNER_SCOPE,
      sender: doc.from ?? null,
      sender_key: doc.from === undefined ? null : doc.from.normalize("NFC").toLowerCase(),
      mime: doc.mime ?? null,
      tags: JSON.stringify(doc.tags ?? []),
      source: doc.source ?? null,
      created_ms: Math.trunc(doc.createdAt),
      updated_ms: Math.trunc(doc.updatedAt ?? doc.createdAt),
    });
  }

  /**
   * Stores a context card for an indexed document and folds its words (summary, questions,
   * entities, tags) into the document's full-text and embedding input. No-op when the document
   * is gone (incognito or deleted meanwhile).
   */
  attachCard(card: ContextCard): boolean {
    const row = this.db
      .prepare("SELECT sender, tags FROM search_docs WHERE id = ?")
      .get(card.docId) as { sender: string | null; tags: string } | undefined;
    if (row === undefined) return false;
    this.db.transaction(() => {
      this.cards.put(card);
      const extra = [
        row.sender ?? "",
        ...(JSON.parse(row.tags) as string[]),
        this.cards.ftsFor(card.docId),
      ]
        .filter((x) => x !== "")
        .join(" ");
      this.db
        .prepare("UPDATE search_docs SET extra = ? WHERE id = ?")
        .run(clean(extra), card.docId);
    })();
    this.#semantic?.schedule?.();
    return true;
  }

  async remove(id: string): Promise<void> {
    this.#delete.run(id);
    this.db.prepare("DELETE FROM search_flags WHERE target_id = ?").run(id);
  }

  /**
   * Removes a thread and the conversation indexed under it: messages, tasks and their actions,
   * and their flags (thread deleted or turned incognito). Library items keep their own life.
   */
  async removeThread(threadId: string): Promise<number> {
    return this.db.transaction(() => {
      const ids = (
        this.db
          .prepare(
            `SELECT id FROM search_docs
             WHERE (id = ? AND kind = 'thread')
                OR (thread_id = ? AND kind IN ('thread', 'message', 'task'))
                OR parent_id IN (SELECT id FROM search_docs WHERE thread_id = ? AND kind = 'task')`,
          )
          .all(threadId, threadId, threadId) as { id: string }[]
      ).map((r) => r.id);
      const delDoc = this.db.prepare("DELETE FROM search_docs WHERE id = ?");
      const delFlags = this.db.prepare("DELETE FROM search_flags WHERE target_id = ?");
      for (const id of ids) {
        delDoc.run(id);
        delFlags.run(id);
      }
      delFlags.run(threadId);
      return ids.length;
    })();
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
    return parseQuery(q, { now: this.#now(), tzOffsetMinutes: this.#tz() });
  }

  // --- Rich query ------------------------------------------------------------------------------

  /**
   * Grouped, collapsed, highlighted search for the Search screen and ⌘K. A question in plain
   * words is understood first (`understand.ts`): stop words dropped, the rest ORed, time, people
   * and source phrases applied as filters. If a reading finds nothing the next, looser one runs,
   * so a query with matching words never comes back empty.
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    if (request.understand === false) return this.#searchOnce(request);
    const plan = understand(request.q, {
      now: this.#now(),
      tzOffsetMinutes: this.#tz(),
      disabled: request.dropChips ?? [],
      ...(this.#resolvePerson === undefined ? {} : { resolvePerson: this.#resolvePerson }),
    });
    let res: SearchResponse | undefined;
    let used = plan.attempts[0];
    for (const attempt of plan.attempts) {
      used = attempt;
      res = await this.#searchOnce({ ...request, q: attempt.q });
      if (res.hits.length > 0 || res.total > 0) break;
    }
    if (res === undefined) return this.#searchOnce(request);
    res.understood = {
      natural: plan.natural,
      intent: plan.intent,
      chips: plan.chips,
      relaxed: used?.relaxed ?? "none",
      query: used?.q ?? request.q,
    };
    return res;
  }

  async #searchOnce(request: SearchRequest): Promise<SearchResponse> {
    const started = performance.now();
    const viewer = request.viewer ?? OWNER;
    const parsed = this.parse(request.q);
    const limit = clampLimit(request.limit, 20);
    const groupLimit = clampLimit(request.groupLimit, 5);
    const where = this.#where(parsed.filters, undefined, viewer);
    const kinds = allowedKinds(request);
    if (kinds !== undefined) {
      where.sql.push(`d.kind IN (${kinds.map(() => "?").join(", ") || "NULL"})`);
      where.params.push(...kinds);
    }

    const collapse = request.collapse ?? true;
    const warnings = [...parsed.warnings];
    const semantic = await this.#semanticCandidates(parsed, warnings);
    if (semantic.length > 0) {
      return this.#hybrid(parsed, where, semantic, {
        viewer,
        kinds,
        collapse,
        limit,
        groupLimit,
        warnings,
        started,
      });
    }
    const ranked = this.#rank(parsed, where, { collapse, limit, groupLimit });
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
    const memory = await this.#searchMemory(parsed, viewer, kinds, groupLimit, limit);
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
      warnings,
      tookMs: Math.round((performance.now() - started) * 10) / 10,
    };
  }

  /** Nearest documents for the free text, or `[]` (off, filter-only query, busy, too short). */
  async #semanticCandidates(parsed: ParsedQuery, warnings: string[]): Promise<SemanticCandidate[]> {
    if (this.#semantic === undefined || parsed.matchesNothing || parsed.terms.length === 0)
      return [];
    try {
      return await this.#semantic.candidates(parsed.text, SEMANTIC_K);
    } catch (err) {
      // A slow or failing embedder never fails the search: it runs lexically and says so.
      warnings.push(err instanceof SemanticBusyError ? "semantic_busy" : "semantic_unavailable");
      return [];
    }
  }

  /**
   * Lexical and semantic results fused by reciprocal rank (k = 60). Semantic candidates pass the
   * same filters as lexical rows (viewer scope, `in:`, dates, `-excluded`), so a vector can never
   * surface a document the viewer could not find by its words. With collapsing, a semantic hit on
   * a message of a thread the lexical side already found merges into that result.
   */
  async #hybrid(
    parsed: ParsedQuery,
    where: Where,
    semantic: SemanticCandidate[],
    o: {
      viewer: SearchViewer;
      kinds: SearchIndexDocKind[] | undefined;
      collapse: boolean;
      limit: number;
      groupLimit: number;
      warnings: string[];
      started: number;
    },
  ): Promise<SearchResponse> {
    const depth = Math.max(o.limit, SEMANTIC_K);
    const ranked = this.#rank(parsed, where, {
      collapse: o.collapse,
      limit: depth,
      groupLimit: Math.max(o.groupLimit, 20),
    });
    const lexRids = ranked.rows.map((r) => r.rid);
    const lexSet = new Set(lexRids);
    const keyOf = new Map<number, string>();
    if (lexRids.length > 0) {
      const rows = this.db
        .prepare(
          `SELECT rowid AS rid, collapse_key AS ck FROM search_docs WHERE rowid IN (${lexRids.map(() => "?").join(", ")})`,
        )
        .all(...lexRids) as { rid: number; ck: string }[];
      for (const r of rows) keyOf.set(r.rid, r.ck);
    }
    const ridOfKey = new Map<string, number>();
    for (const r of ranked.rows) {
      const ck = keyOf.get(r.rid);
      if (ck !== undefined && !ridOfKey.has(ck)) ridOfKey.set(ck, r.rid);
    }

    // Semantic candidates through the same filters.
    const ids = semantic.map((c) => c.docId);
    const sql = [`d.id IN (${ids.map(() => "?").join(", ")})`, ...where.sql];
    const params: unknown[] = [...ids, ...where.params];
    const exclusion = toFtsExclusion(parsed.excluded);
    if (exclusion !== undefined) {
      sql.push("d.rowid NOT IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?)");
      params.push(exclusion);
    }
    const allowed = this.db
      .prepare(
        `SELECT d.rowid AS rid, d.id AS id, d.grp AS grp, d.collapse_key AS ck FROM search_docs d WHERE ${sql.join(" AND ")}`,
      )
      .all(...params) as { rid: number; id: string; grp: SearchGroup; ck: string }[];
    const byId = new Map(allowed.map((a) => [a.id, a]));
    const semRank = new Map<number, number>();
    const chunkOf = new Map<number, string>();
    const grpOf = new Map<number, SearchGroup>(ranked.rows.map((r) => [r.rid, r.grp]));
    const seenKeys = new Set<string>();
    for (const c of semantic) {
      const a = byId.get(c.docId);
      if (a === undefined) continue;
      const key = o.collapse ? a.ck : a.id;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const rid = (o.collapse ? ridOfKey.get(a.ck) : undefined) ?? a.rid;
      semRank.set(rid, semRank.size + 1);
      grpOf.set(rid, grpOf.get(rid) ?? a.grp);
      if (!lexSet.has(rid)) chunkOf.set(rid, c.chunk);
    }

    const fused = new Map<number, number>();
    ranked.rows.forEach((r, i) => {
      fused.set(r.rid, 1 / (RRF_K + i + 1));
    });
    for (const [rid, rank] of semRank) fused.set(rid, (fused.get(rid) ?? 0) + 1 / (RRF_K + rank));
    const order = [...fused.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

    const semanticOnly = new Map<SearchGroup, number>();
    for (const rid of chunkOf.keys()) {
      const g = grpOf.get(rid);
      if (g !== undefined) semanticOnly.set(g, (semanticOnly.get(g) ?? 0) + 1);
    }
    const flatRids = order.slice(0, o.limit).map(([rid]) => rid);
    const perGroup = new Map<SearchGroup, number[]>();
    for (const [rid] of order) {
      const g = grpOf.get(rid);
      if (g === undefined) continue;
      const list = perGroup.get(g) ?? [];
      if (list.length < o.groupLimit) list.push(rid);
      perGroup.set(g, list);
    }
    const wanted = [...new Set([...flatRids, ...[...perGroup.values()].flat()])];
    const tokens = highlightTokens(parsed);
    const hitOf = this.#materializeByRid(
      parsed,
      wanted.map((rid) => ({
        rid,
        grp: grpOf.get(rid) as SearchGroup,
        score: fused.get(rid) ?? 0,
        grn: 0,
        rn: 0,
      })),
    );
    for (const [rid, hit] of hitOf) {
      const chunk = chunkOf.get(rid);
      const lexical = lexSet.has(rid);
      hit.match = lexical && semRank.has(rid) ? "both" : lexical ? "lexical" : "semantic";
      if (chunk !== undefined) {
        // No FTS match to mark: the best chunk's opening, with any literal query words marked.
        const snip = snippetFor(chunk, tokens);
        hit.snippet = snip.text;
        hit.snippetHighlights = snip.ranges;
      }
    }

    const groups = new Map<SearchGroup, GroupResult>();
    for (const g of new Set([...ranked.groupCounts.keys(), ...semanticOnly.keys()])) {
      groups.set(g, {
        group: g,
        count: (ranked.groupCounts.get(g) ?? 0) + (semanticOnly.get(g) ?? 0),
        hits: (perGroup.get(g) ?? []).flatMap((rid) => hitOf.get(rid) ?? []),
      });
    }
    const flatLocal = flatRids.flatMap((rid) => hitOf.get(rid) ?? []);
    let total = ranked.total + chunkOf.size;
    let flat = flatLocal;
    const memory = await this.#searchMemory(parsed, o.viewer, o.kinds, o.groupLimit, o.limit);
    if (memory.length > 0) {
      groups.set("memory", {
        group: "memory",
        count: memory.length,
        hits: memory.slice(0, o.groupLimit),
      });
      total += memory.length;
      flat = fuse([flatLocal, memory]).slice(0, o.limit);
    }
    return {
      hits: flat,
      groups: GROUP_ORDER.flatMap((g) => {
        const r = groups.get(g);
        return r === undefined || r.count === 0 ? [] : [r];
      }),
      total,
      warnings: o.warnings,
      tookMs: Math.round((performance.now() - o.started) * 10) / 10,
    };
  }

  async #searchMemory(
    parsed: ParsedQuery,
    viewer: SearchViewer,
    kinds: SearchIndexDocKind[] | undefined,
    groupLimit: number,
    limit: number,
  ): Promise<RichHit[]> {
    const f = parsed.filters;
    if (this.#memory === undefined || viewer.kind !== "owner" || parsed.matchesNothing) return [];
    if (kinds !== undefined && !kinds.includes("memory")) return [];
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
    if (parsed.sources !== undefined) {
      sql.push(`(${parsed.sources.map(() => "d.source IN (?, ?)").join(" OR ")})`);
      params.push(...parsed.sources.flatMap((k) => [k, `connector:${k}`]));
    }
    if (parsed.from !== undefined) {
      sql.push(`(${parsed.from.map(() => "instr(d.sender_key, ?) > 0").join(" OR ")})`);
      params.push(...parsed.from.map((f) => f.normalize("NFC").toLowerCase()));
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
        "EXISTS (SELECT 1 FROM search_flags f WHERE f.flag = ? AND f.target_id IN (d.id, d.parent_id))",
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
    if (parsed.matchesNothing || (match === undefined && parsed.terms.length > 0)) {
      return { rows: [], total: 0, groupCounts: new Map() };
    }
    // 1 + weight × 0.5^(age / halfLife), inline (SQLite math functions): a JS function called
    // per matching row dominated common-term queries.
    const recency = "(1 + ? * exp(-0.6931471805599453 * max(0, ? - d.created_ms) / ?))";
    const recencyParams = [this.#weight, this.#now(), this.#halfLifeMs];
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
    return [...this.#materializeByRid(parsed, ranked).values()];
  }

  /** `#materialize` keyed by rowid, in `ranked` order (rows that vanished are left out). */
  #materializeByRid(parsed: ParsedQuery, ranked: RankedRow[]): Map<number, RichHit> {
    if (ranked.length === 0) return new Map();
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
    const previews = this.cards.previews(docs.map((d) => d.id));
    const out = new Map<number, RichHit>();
    for (const r of ranked) {
      const d = rowsById.get(r.rid);
      if (d === undefined) continue;
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
      const card = previews.get(d.id);
      if (card !== undefined) hit.card = card;
      out.set(r.rid, hit);
    }
    return out;
  }
}

/** Kinds allowed by `groups` and `kinds` (intersection), or `undefined` for all. */
function allowedKinds(request: SearchRequest): SearchIndexDocKind[] | undefined {
  let kinds: SearchIndexDocKind[] | undefined;
  if (request.groups !== undefined) {
    kinds = (Object.keys(GROUP_OF_KIND) as SearchIndexDocKind[]).filter((k) =>
      request.groups?.includes(GROUP_OF_KIND[k]),
    );
  }
  if (request.kinds !== undefined) {
    const wanted = request.kinds;
    kinds = (kinds ?? wanted).filter((k) => wanted.includes(k));
  }
  return kinds;
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(value)));
}

const MARKERS = new RegExp(`[${HL_OPEN}${HL_CLOSE}]`, "g");
function clean(text: string): string {
  return text.replace(MARKERS, "");
}
