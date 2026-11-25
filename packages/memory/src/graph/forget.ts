import { holdSecureDelete } from "@psyche/db";
import { PsycheError } from "@psyche/protocol";
import type Database from "better-sqlite3";
import { type ForgetCounts, type ForgetMatcher, mentions } from "../forget-cascade.ts";
import { factKeyHash, type GraphStore } from "./store.ts";

/**
 * Forget a phrase in the people graph and the extraction (EM) tables that live beside it
 * (memory wave 3A). The Markdown side is `SqliteMemoryStore.forget`; this is the rest of the
 * database, in one pass that both previews and deletes from the same selection, so the counts of
 * a preview are the counts of the forget.
 *
 * What it removes, and how:
 * - People, organisations and projects whose name or an alias matches, whole: `GraphStore.forget`
 *   (facts, relations, loops, identifiers, sole interactions, cards, search rows; identifiers go
 *   on the blocklist so ingest never recreates them). The owner's own entity is never deleted.
 * - Facts (every version) whose value or evidence matches, or that a matching citation backs;
 *   their citations, vectors and review rows. The wrong-fact hash is kept so the same value is
 *   not learned again from the same source.
 * - Relations and loops the same way (a matching citation, or a loop's own text).
 * - Interactions' subject and gist, entity summaries and notes, merge suggestions, anchors'
 *   labels and exclusion hints: blanked in place (the row stays, so ingest does not read it again).
 * - Quarantined items: the excerpt is erased, the row stays (it is what stops a re-read).
 *
 * Not reached: identifiers (an email address or number) of an entity that is not deleted, even
 * when they spell the phrase; they are the owner's links, not remembered text.
 */

const DAY_ISO = (): string => new Date().toISOString();

type Row = Record<string, unknown>;

interface Plan {
  roots: { id: string; cardPath: string | null }[];
  matchedIds: string[];
  gone: Set<string>;
  citationIds: string[];
  factIds: string[];
  pendingFacts: Set<string>;
  tombstones: { entityId: string; hash: string }[];
  edgeIds: string[];
  pendingEdges: number;
  loopIds: string[];
  interactionIds: string[];
  summaries: string[];
  /** Connector state rows (not `poll:*`) rewritten without the matching entries. */
  cursors: { source: string; json: string }[];
  cursorRemoved: number;
  notes: { id: string; text: string }[];
  suggestionIds: string[];
  anchorIds: string[];
  exclusionHints: { table: string; kind: string; hash: string }[];
  quarantineIds: string[];
  /** Per root: what `GraphStore.forget` reports it will remove. */
  entityCounts: Partial<ForgetCounts>;
}

/** Cursor rows that are one record: address or thread key -> entry (`ingest.ts`). */
const RECORD_CURSORS = new Set(["candidates:mail", "threads:asks"]);

const deepMentions = (m: ForgetMatcher, v: unknown): boolean => {
  if (typeof v === "string") return mentions(m, v);
  if (Array.isArray(v)) return v.some((e) => deepMentions(m, e));
  if (v !== null && typeof v === "object")
    return Object.entries(v).some(([k, e]) => mentions(m, k) || deepMentions(m, e));
  return false;
};

/**
 * A connector state row without what names the phrase. `record` rows (candidate addresses with
 * display names, thread asks with their text) lose the whole entry; `struct` rows (work signals,
 * catch-up state) keep their fields and lose the matching entries or elements inside them
 * (an ask with its verbatim evidence). Poll cursors (`poll:*`) carry no text and are not read here.
 */
export function pruneCursor(
  value: unknown,
  shape: "record" | "struct",
  m: ForgetMatcher,
): { value: unknown; removed: number } {
  let removed = 0;
  const prune = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const kept = v.filter((e) => !deepMentions(m, e));
      removed += v.length - kept.length;
      return kept;
    }
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, e] of Object.entries(v)) {
        if (mentions(m, k) || deepMentions(m, e)) removed++;
        else out[k] = e;
      }
      return out;
    }
    return v;
  };
  if (shape === "record") return { value: prune(value), removed };
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { value: prune(value), removed };
  const out: Record<string, unknown> = {};
  for (const [k, e] of Object.entries(value)) out[k] = prune(e);
  return { value: out, removed };
}

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

function inChunks<T>(items: readonly T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function plan(db: Database.Database, graph: GraphStore, m: ForgetMatcher): Plan {
  const hit = (t: unknown): boolean => typeof t === "string" && mentions(m, t);
  const all = (sql: string, ...args: unknown[]): Row[] => db.prepare(sql).all(...args) as Row[];

  // --- entities to delete whole ---
  const entities = all(
    "SELECT id, name, card_path, merged_into FROM graph_entities WHERE is_owner = 0",
  );
  const aliasHit = new Set(
    all("SELECT entity_id, alias FROM graph_aliases")
      .filter((r) => hit(r.alias))
      .map((r) => r.entity_id as string),
  );
  const matched = entities.filter((e) => hit(e.name) || aliasHit.has(e.id as string));
  const matchedIds = new Set(matched.map((e) => e.id as string));
  const roots = matched.filter(
    (e) => !(typeof e.merged_into === "string" && matchedIds.has(e.merged_into)),
  );
  const gone = new Set<string>();
  for (const r of roots) {
    gone.add(r.id as string);
    for (const c of all("SELECT id FROM graph_entities WHERE merged_into = ?", r.id)) {
      gone.add(c.id as string);
    }
  }
  const goneList = [...gone];
  const entityCounts: Partial<ForgetCounts> = {
    graphEntities: gone.size,
    graphFacts: 0,
    graphEdges: 0,
    graphLoops: 0,
    graphInteractions: 0,
    graphOther: 0,
    reviewItems: 0,
  };
  for (const r of roots) {
    const f = graph.forget(r.id as string, true).removed;
    entityCounts.graphFacts = (entityCounts.graphFacts ?? 0) + f.facts;
    entityCounts.graphEdges = (entityCounts.graphEdges ?? 0) + f.edges;
    entityCounts.graphLoops = (entityCounts.graphLoops ?? 0) + f.loops;
    entityCounts.graphInteractions = (entityCounts.graphInteractions ?? 0) + f.interactions;
    entityCounts.graphOther = (entityCounts.graphOther ?? 0) + f.identifiers;
  }
  // Review rows under a deleted entity count as review items, not as facts.
  const factsOfGone: Row[] = [];
  for (const part of inChunks(goneList)) {
    factsOfGone.push(
      ...all(
        `SELECT id, review FROM graph_facts WHERE entity_id IN (${marks(part.length)})`,
        ...part,
      ),
    );
  }
  const pendingGone = factsOfGone.filter(
    (f) => f.review === "pending" || f.review === "quarantined",
  );
  entityCounts.graphFacts = (entityCounts.graphFacts ?? 0) - pendingGone.length;
  entityCounts.reviewItems = pendingGone.length;

  // --- citations that name it ---
  const citations = all("SELECT id, target_kind, target_id, quote FROM graph_citations");
  const citedBy = (kind: string): Set<string> =>
    new Set(
      citations
        .filter((c) => c.target_kind === kind && hit(c.quote))
        .map((c) => c.target_id as string),
    );
  const citedFacts = citedBy("fact");
  const citedEdges = citedBy("edge");
  const citedLoops = citedBy("loop");

  // --- facts ---
  const facts = all(
    "SELECT id, entity_id, attribute, value, evidence, review FROM graph_facts",
  ).filter(
    (f) =>
      !gone.has(f.entity_id as string) &&
      (hit(f.value) || hit(f.evidence) || citedFacts.has(f.id as string)),
  );
  const factIds = facts.map((f) => f.id as string);
  const pendingFacts = new Set(
    facts
      .filter((f) => f.review === "pending" || f.review === "quarantined")
      .map((f) => f.id as string),
  );
  const tombstones = facts.map((f) => ({
    entityId: f.entity_id as string,
    hash: factKeyHash(f.attribute as never, f.value as string),
  }));

  // --- edges ---
  const edges = all("SELECT id, src, dst, review FROM graph_edges").filter(
    (e) =>
      !gone.has(e.src as string) && !gone.has(e.dst as string) && citedEdges.has(e.id as string),
  );
  const edgeIds = edges.map((e) => e.id as string);
  const pendingEdges = edges.filter(
    (e) => e.review === "pending" || e.review === "quarantined",
  ).length;

  // --- loops ---
  const loops = all(
    "SELECT id, text, evidence, counterpart_label, due_text, counterpart_id, project_id FROM graph_loops",
  ).filter(
    (l) =>
      !gone.has(l.counterpart_id as string) &&
      !gone.has(l.project_id as string) &&
      (hit(l.text) ||
        hit(l.evidence) ||
        hit(l.counterpart_label) ||
        hit(l.due_text) ||
        citedLoops.has(l.id as string)),
  );
  const loopIds = loops.map((l) => l.id as string);

  // Every citation whose target goes: the quote is text of the owner's mail or messages.
  const edgesOfGone = new Set<string>();
  const factOfGoneIds = new Set(factsOfGone.map((f) => f.id as string));
  const loopsOfGone = new Set<string>();
  const interactionsOfGone = new Set<string>();
  if (goneList.length > 0) {
    for (const part of inChunks(goneList)) {
      const q = marks(part.length);
      for (const e of all(
        `SELECT id FROM graph_edges WHERE src IN (${q}) OR dst IN (${q})`,
        ...part,
        ...part,
      ))
        edgesOfGone.add(e.id as string);
      for (const l of all(
        `SELECT id FROM graph_loops WHERE counterpart_id IN (${q}) OR project_id IN (${q})`,
        ...part,
        ...part,
      ))
        loopsOfGone.add(l.id as string);
      for (const i of all(
        `SELECT DISTINCT interaction_id AS id FROM graph_participants WHERE entity_id IN (${q})`,
        ...part,
      ))
        interactionsOfGone.add(i.id as string);
    }
  }

  // --- interactions: subject and gist blanked in place ---
  const interactions = all("SELECT id, subject, gist FROM graph_interactions").filter(
    (i) => (hit(i.subject) || hit(i.gist)) && !interactionsOfGone.has(i.id as string),
  );
  const interactionIds = interactions.map((i) => i.id as string);

  const targetGoes = (kind: unknown, id: unknown): boolean => {
    switch (kind) {
      case "fact":
        return factIds.includes(id as string) || factOfGoneIds.has(id as string);
      case "edge":
        return edgeIds.includes(id as string) || edgesOfGone.has(id as string);
      case "loop":
        return loopIds.includes(id as string) || loopsOfGone.has(id as string);
      case "entity":
      case "event":
        return gone.has(id as string);
      case "interaction":
        return interactionIds.includes(id as string) || interactionsOfGone.has(id as string);
      default:
        return false;
    }
  };
  const factSet = new Set(factIds);
  const edgeSet = new Set(edgeIds);
  const loopSet = new Set(loopIds);
  const interactionSet = new Set(interactionIds);
  const citationIds = citations
    .filter((c) => {
      if (hit(c.quote)) return true;
      const id = c.target_id as string;
      switch (c.target_kind) {
        case "fact":
          return factSet.has(id) || factOfGoneIds.has(id);
        case "edge":
          return edgeSet.has(id) || edgesOfGone.has(id);
        case "loop":
          return loopSet.has(id) || loopsOfGone.has(id);
        case "interaction":
          return interactionSet.has(id) || interactionsOfGone.has(id);
        default:
          return targetGoes(c.target_kind, c.target_id);
      }
    })
    .map((c) => c.id as string);

  // --- text on entities that stay ---
  const keep = all("SELECT id, summary, notes FROM graph_entities").filter(
    (e) => !gone.has(e.id as string),
  );
  const summaries = keep.filter((e) => hit(e.summary)).map((e) => e.id as string);
  const notes = keep
    .filter((e) => hit(e.notes))
    .map((e) => ({
      id: e.id as string,
      text: (e.notes as string)
        .split("\n")
        .filter((l) => !mentions(m, l))
        .join("\n"),
    }));

  const suggestionIds = all("SELECT id, name, reason, entity_ids FROM graph_suggestions")
    .filter((s) => (hit(s.name) || hit(s.reason)) && !(s.name === null && s.reason === ""))
    .map((s) => s.id as string);
  const anchorIds = all("SELECT id, entity_id, label FROM graph_anchors")
    .filter((a) => !gone.has(a.entity_id as string) && hit(a.label))
    .map((a) => a.id as string);
  const exclusionHints = [
    ...all("SELECT kind, value_hash, hint FROM graph_exclusions")
      .filter((r) => hit(r.hint))
      .map((r) => ({
        table: "graph_exclusions",
        kind: r.kind as string,
        hash: r.value_hash as string,
      })),
    ...all("SELECT kind, value_hash, hint FROM graph_blocklist")
      .filter((r) => hit(r.hint))
      .map((r) => ({
        table: "graph_blocklist",
        kind: r.kind as string,
        hash: r.value_hash as string,
      })),
  ];

  // --- connector state: candidate addresses, thread asks, work signals, catch-up marks ---
  const cursors: { source: string; json: string }[] = [];
  let cursorRemoved = 0;
  for (const r of all("SELECT source, cursor FROM graph_cursors WHERE source NOT LIKE 'poll:%'")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.cursor as string);
    } catch {
      continue;
    }
    const out = pruneCursor(
      parsed,
      RECORD_CURSORS.has(r.source as string) ? "record" : "struct",
      m,
    );
    if (out.removed > 0) {
      cursors.push({ source: r.source as string, json: JSON.stringify(out.value) });
      cursorRemoved += out.removed;
    }
  }

  // --- quarantine: the excerpt, and any item from a sender that goes ---
  const quarantineIds = all("SELECT id, excerpt, sender_entity_id FROM memory_quarantine")
    .filter((q) => hit(q.excerpt) || (gone.has(q.sender_entity_id as string) && q.excerpt !== ""))
    .map((q) => q.id as string);
  return {
    roots: roots.map((r) => ({
      id: r.id as string,
      cardPath: (r.card_path as string | null) ?? null,
    })),
    matchedIds: [...matchedIds],
    gone,
    citationIds,
    factIds,
    pendingFacts,
    tombstones,
    edgeIds,
    pendingEdges,
    loopIds,
    interactionIds,
    summaries,
    cursors,
    cursorRemoved,
    notes,
    suggestionIds,
    anchorIds,
    exclusionHints,
    quarantineIds,
    entityCounts,
  };
}

export interface GraphForgetResult {
  counts: Partial<ForgetCounts>;
  /** Card files of the deleted entities: the caller removes them from the workspace. */
  cardPaths: string[];
}

function countsOf(p: Plan): Partial<ForgetCounts> {
  const e = p.entityCounts;
  const pendingFactCount = p.pendingFacts.size;
  return {
    graphEntities: e.graphEntities ?? 0,
    graphFacts: (e.graphFacts ?? 0) + (p.factIds.length - pendingFactCount),
    graphEdges: (e.graphEdges ?? 0) + p.edgeIds.length,
    graphLoops: (e.graphLoops ?? 0) + p.loopIds.length,
    graphInteractions: (e.graphInteractions ?? 0) + p.interactionIds.length,
    graphCitations: p.citationIds.length,
    graphOther:
      (e.graphOther ?? 0) +
      p.summaries.length +
      p.cursorRemoved +
      p.notes.length +
      p.suggestionIds.length +
      p.anchorIds.length +
      p.exclusionHints.length,
    reviewItems: (e.reviewItems ?? 0) + pendingFactCount + p.pendingEdges,
    quarantine: p.quarantineIds.length,
  };
}

/** What forgetting `m` would remove from the graph and the extraction tables. */
export function previewGraphForget(
  db: Database.Database,
  graph: GraphStore,
  m: ForgetMatcher,
): GraphForgetResult {
  const p = plan(db, graph, m);
  return {
    counts: countsOf(p),
    cardPaths: p.roots.flatMap((r) => (r.cardPath === null ? [] : [r.cardPath])),
  };
}

/** Deletes what `previewGraphForget` counted. */
export function applyGraphForget(
  db: Database.Database,
  graph: GraphStore,
  m: ForgetMatcher,
): GraphForgetResult {
  const p = plan(db, graph, m);
  const counts = countsOf(p);
  const touched = new Set<string>();
  const entityOf = (sql: string, ids: readonly string[]): void => {
    for (const part of inChunks(ids)) {
      for (const r of db.prepare(sql.replace("?*", marks(part.length))).all(...part) as Row[]) {
        for (const v of Object.values(r))
          if (typeof v === "string" && !p.gone.has(v)) touched.add(v);
      }
    }
  };
  entityOf("SELECT entity_id FROM graph_facts WHERE id IN (?*)", p.factIds);
  entityOf("SELECT src, dst FROM graph_edges WHERE id IN (?*)", p.edgeIds);
  for (const n of p.notes) touched.add(n.id);
  for (const id of p.summaries) touched.add(id);

  const release = holdSecureDelete(db);
  try {
    db.transaction(() => {
      const del = (table: string, ids: readonly string[], col = "id"): void => {
        for (const part of inChunks(ids)) {
          db.prepare(`DELETE FROM ${table} WHERE ${col} IN (${marks(part.length)})`).run(...part);
        }
      };
      del("graph_citations", p.citationIds);
      del("memory_work_undo", p.factIds, "fact_id");
      del("graph_facts", p.factIds);
      del("graph_edges", p.edgeIds);
      del("graph_loops", p.loopIds);
      const now = DAY_ISO();
      const tomb = db.prepare(
        `INSERT INTO graph_feedback (id, kind, entity_id, other_id, key_hash, created_at)
         SELECT ?, 'wrong_fact', ?, NULL, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM graph_feedback WHERE kind = 'wrong_fact' AND entity_id = ? AND key_hash = ?)`,
      );
      let n = 0;
      for (const t of p.tombstones) {
        tomb.run(
          `fb_forget_${now}_${n++}_${t.hash.slice(0, 8)}`,
          t.entityId,
          t.hash,
          now,
          t.entityId,
          t.hash,
        );
      }
      for (const part of inChunks(p.interactionIds)) {
        db.prepare(
          `UPDATE graph_interactions SET subject = NULL, gist = NULL WHERE id IN (${marks(part.length)})`,
        ).run(...part);
      }
      for (const part of inChunks(p.summaries)) {
        db.prepare(
          `UPDATE graph_entities SET summary = NULL, summary_at = NULL, summary_hash = NULL WHERE id IN (${marks(part.length)})`,
        ).run(...part);
      }
      for (const c of p.cursors) {
        db.prepare("UPDATE graph_cursors SET cursor = ? WHERE source = ?").run(c.json, c.source);
      }
      for (const nt of p.notes) {
        db.prepare("UPDATE graph_entities SET notes = ? WHERE id = ?").run(
          nt.text.trim() === "" ? null : nt.text,
          nt.id,
        );
      }
      for (const part of inChunks(p.suggestionIds)) {
        db.prepare(
          `UPDATE graph_suggestions SET status = 'rejected', name = NULL, reason = '' WHERE id IN (${marks(part.length)})`,
        ).run(...part);
      }
      for (const part of inChunks(p.anchorIds)) {
        db.prepare(`UPDATE graph_anchors SET label = '' WHERE id IN (${marks(part.length)})`).run(
          ...part,
        );
      }
      for (const h of p.exclusionHints) {
        db.prepare(`UPDATE ${h.table} SET hint = NULL WHERE kind = ? AND value_hash = ?`).run(
          h.kind,
          h.hash,
        );
      }
      for (const part of inChunks(p.quarantineIds)) {
        db.prepare(
          `UPDATE memory_quarantine SET excerpt = '', decided = COALESCE(decided, 'discarded'),
             decided_at = COALESCE(decided_at, ?) WHERE id IN (${marks(part.length)})`,
        ).run(now, ...part);
      }
    })();
    db.exec("INSERT INTO graph_fts (graph_fts) VALUES ('optimize')");
  } finally {
    release();
  }
  for (const id of touched) graph.touch(id, ["facts", "forgotten"]);
  // Whole entities last: their own forget blocklists identifiers and refuses nothing here.
  for (const r of p.roots) graph.forget(r.id, false);
  // A merge chain deeper than one level leaves its far end behind: delete what still matches.
  for (const id of p.matchedIds) if (graph.getEntity(id) !== undefined) graph.forget(id, false);
  try {
    if (db.name !== ":memory:") db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // a reader holding the WAL postpones the cut
  }
  return {
    counts,
    cardPaths: p.roots.flatMap((r) => (r.cardPath === null ? [] : [r.cardPath])),
  };
}

// --- memory.reset ---------------------------------------------------------------------------

export interface GraphResetCounts {
  entities: number;
  facts: number;
  edges: number;
  interactions: number;
  loops: number;
  citations: number;
  quarantine: number;
}

const resetCounts = (db: Database.Database): GraphResetCounts => {
  const n = (table: string): number =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    entities: n("graph_entities"),
    facts: n("graph_facts"),
    edges: n("graph_edges"),
    interactions: n("graph_interactions"),
    loops: n("graph_loops"),
    citations: n("graph_citations"),
    quarantine: n("memory_quarantine"),
  };
};

/**
 * `memory.reset` for the graph and the extraction tables: entities (the owner's too), facts,
 * relations, interactions, loops, suggestions, corrections, citations and the quarantine, with
 * the free pages zeroed. Kept: the owner's exclusion rules and trusted senders (settings, hashes),
 * the blocklist, the poll cursors (`poll:*`: where each connector stopped; the other connector state, with its addresses, ask texts and evidence, goes) and the "this is wrong" corrections (hashes), the
 * extraction run log and `memory_extracted_items` (hashes of what was read, no text): without
 * them the next poll would read the same mail again, bring blocklisted people back and relearn
 * what the owner marked wrong.
 */
export function previewGraphReset(db: Database.Database): GraphResetCounts {
  return resetCounts(db);
}

const RESET_TABLES = [
  "graph_entities",
  "graph_facts",
  "graph_citations",
  "memory_quarantine",
  "memory_migration_backup_2026_11",
  "graph_blocklist",
  "graph_cursors",
  "graph_feedback",
];

/** Refuses (before anything else is erased) when the graph tables are not all there. */
export function assertGraphResetReady(db: Database.Database): void {
  const have = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name),
  );
  const missing = RESET_TABLES.filter((t) => !have.has(t));
  if (missing.length > 0) {
    throw new PsycheError(
      "unavailable",
      `Memory can't be reset yet: the memory database is not ready (${missing[0]} is missing). Nothing was erased.`,
    );
  }
}

export function applyGraphReset(db: Database.Database): GraphResetCounts {
  assertGraphResetReady(db);
  const counts = resetCounts(db);
  const release = holdSecureDelete(db);
  try {
    db.transaction(() => {
      db.exec(
        `DELETE FROM graph_citations; DELETE FROM memory_quarantine; DELETE FROM memory_migration_backup_2026_11;
         DELETE FROM graph_cursors WHERE source NOT LIKE 'poll:%';
         DELETE FROM graph_loops; DELETE FROM graph_participants; DELETE FROM graph_interactions;
         DELETE FROM graph_suggestions; DELETE FROM memory_work_undo;
         DELETE FROM graph_feedback WHERE kind NOT IN ('wrong_fact', 'wrong_edge');
         DELETE FROM graph_fts; UPDATE graph_entities SET merged_into = NULL; DELETE FROM graph_entities;`,
      );
    })();
    db.exec("INSERT INTO graph_fts (graph_fts) VALUES ('optimize')");
    if (db.name !== ":memory:") db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    release();
  }
  return counts;
}
