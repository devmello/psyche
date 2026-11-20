import type {
  GraphEntityKind,
  MemoryMap,
  MemoryMapEdge,
  MemoryMapEdgeKind,
  MemoryMapNode,
} from "@psyche/protocol";
import type Database from "better-sqlite3";

/**
 * The memory map (`memory.graph.map`): a read-only graph over rows the store already holds.
 *
 * - Nodes are active, visible entities except the owner (who would link to everything).
 * - Edges come from three real relations, never from a model: accepted `graph_edges`
 *   (works_on, met_in, related) and people and subjects that appear in the same few interactions
 *   (co_mentioned, and met_in for meetings about a project or event). Both need two shared
 *   interactions.
 * - Nothing here reads a fact or a body. A node carries its display name, which can itself be a
 *   phone number or the first part of an email address when that is all Psyche knows; the list
 *   view and `memory.entities.search` show the same names.
 *
 * Cost: everything is aggregated in SQL over the retention window, and a built map is kept until
 * the graph changes, so an open map that refetches costs a handful of cheap count queries.
 */

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 2000;
/** An interaction with more people and subjects than this (a mass mail) links nobody. */
const MAX_GROUP = 12;
/** Each node keeps its strongest few shared-interaction edges, so a hub stays readable. */
const MAX_CO_PER_NODE = 6;
/** Only interactions this recent count; the store keeps 540 days by default anyway. */
const WINDOW_DAYS = 540;
const ACCEPTED = "('accepted', 'auto_accepted', 'edited')";
/** "Quiet": at least this many past interactions and none for this long. */
const QUIET_MIN_INTERACTIONS = 3;
const QUIET_DAYS = 60;

const ALL_KINDS: GraphEntityKind[] = [
  "person",
  "org",
  "project",
  "place",
  "event",
  "topic",
  "assignment",
];

const WORKS_ON = new Set(["member_of", "stakeholder_of", "works_at", "studied_at", "part_of"]);

interface NodeRow {
  id: string;
  kind: GraphEntityKind;
  name: string;
  pinned: number;
  private: number;
  last: string | null;
}

export interface MemoryMapOptions {
  limit?: number;
  kinds?: GraphEntityKind[];
  /** Epoch ms; defaults to now. */
  now?: number;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const iso = (ms: number): string => new Date(ms).toISOString();

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Merge candidate edges: one per pair, the most specific kind wins, strengths add up. */
const KIND_RANK: Record<MemoryMapEdgeKind, number> = {
  works_on: 4,
  met_in: 3,
  related: 2,
  co_mentioned: 1,
};

export function buildMemoryMap(db: Database.Database, opts: MemoryMapOptions = {}): MemoryMap {
  const now = opts.now ?? Date.now();
  const nowIso = iso(now);
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), 5000);
  const kinds = opts.kinds ?? ALL_KINDS;
  const windowStart = iso(now - WINDOW_DAYS * DAY_MS);

  const rows = db
    .prepare(
      `SELECT id, kind, name, pinned, private, last_interaction_at AS last FROM graph_entities
        WHERE status = 'active' AND is_owner = 0 AND hidden = 0
          AND kind IN (${kinds.map(() => "?").join(", ")})`,
    )
    .all(...kinds) as NodeRow[];
  const ids = new Set(rows.map((r) => r.id));

  // Interaction counts per entity, bucketed by age, aggregated in SQL.
  const counts = new Map<string, { all: number; score: number }>();
  for (const r of db
    .prepare(
      `SELECT p.entity_id AS id, count(*) AS n,
              sum(i.occurred_at >= ?) AS c30,
              sum(i.occurred_at >= ?) AS c90,
              sum(i.occurred_at >= ?) AS c180
         FROM graph_participants p JOIN graph_interactions i ON i.id = p.interaction_id
        WHERE i.occurred_at >= ?
        GROUP BY p.entity_id`,
    )
    .all(iso(now - 30 * DAY_MS), iso(now - 90 * DAY_MS), iso(now - 180 * DAY_MS), windowStart) as {
    id: string;
    n: number;
    c30: number;
    c90: number;
    c180: number;
  }[]) {
    if (!ids.has(r.id)) continue;
    counts.set(r.id, {
      all: r.n,
      score: r.c30 + 0.5 * (r.c90 - r.c30) + 0.2 * (r.c180 - r.c90),
    });
  }

  const loops = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT counterpart_id AS id, count(*) AS n FROM graph_loops
        WHERE status IN ('open', 'suggested') AND counterpart_id IS NOT NULL GROUP BY counterpart_id`,
    )
    .all() as { id: string; n: number }[])
    loops.set(r.id, r.n);

  // --- candidate edges -------------------------------------------------------------------------
  const candidates = new Map<
    string,
    { a: string; b: string; kind: MemoryMapEdgeKind; w: number }
  >();
  const add = (a: string, b: string, kind: MemoryMapEdgeKind, w: number) => {
    if (a === b || !ids.has(a) || !ids.has(b)) return;
    const key = pairKey(a, b);
    const cur = candidates.get(key);
    if (cur === undefined) {
      candidates.set(key, { a, b, kind, w });
      return;
    }
    cur.w += w;
    if (KIND_RANK[kind] > KIND_RANK[cur.kind]) cur.kind = kind;
  };

  for (const e of db
    .prepare(
      `SELECT src, dst, rel, confidence FROM graph_edges
        WHERE superseded_by IS NULL AND retracted_at IS NULL
          AND (valid_to IS NULL OR valid_to > ?) AND review IN ${ACCEPTED}`,
    )
    .all(nowIso) as { src: string; dst: string; rel: string; confidence: number }[]) {
    const kind: MemoryMapEdgeKind = WORKS_ON.has(e.rel)
      ? "works_on"
      : e.rel === "attended"
        ? "met_in"
        : "related";
    add(e.src, e.dst, kind, 1 + clamp01(e.confidence) * 0.5);
  }

  // Small interactions only. The size is every person and subject on the interaction, counted
  // before any filtering, so a long recipient list stays a mass mail whatever `kinds` says.
  const members = new Map<string, { kind: string; who: Set<string> }>();
  for (const r of db
    .prepare(
      `WITH m AS (
         SELECT p.interaction_id AS iid, p.entity_id AS eid
           FROM graph_participants p JOIN graph_interactions i ON i.id = p.interaction_id
          WHERE i.occurred_at >= ?
         UNION ALL
         SELECT s.interaction_id, s.entity_id
           FROM graph_interaction_subjects s JOIN graph_interactions i ON i.id = s.interaction_id
          WHERE i.occurred_at >= ?
       ), small AS (
         SELECT iid FROM m GROUP BY iid HAVING count(DISTINCT eid) BETWEEN 2 AND ${MAX_GROUP}
       )
       SELECT small.iid AS iid, i.kind AS kind, x.eid AS eid
         FROM small
         JOIN graph_interactions i ON i.id = small.iid
         JOIN (
           SELECT interaction_id AS iid, entity_id AS eid FROM graph_participants
           UNION ALL
           SELECT interaction_id, entity_id FROM graph_interaction_subjects
            WHERE linked_by IN ('rule', 'owner')
         ) x ON x.iid = small.iid`,
    )
    .all(windowStart, windowStart) as { iid: string; kind: string; eid: string }[]) {
    if (!ids.has(r.eid)) continue;
    const m = members.get(r.iid) ?? { kind: r.kind, who: new Set<string>() };
    m.who.add(r.eid);
    members.set(r.iid, m);
  }
  const kindOf = new Map(rows.map((r) => [r.id, r.kind] as const));
  const together = new Map<string, { a: string; b: string; n: number; meet: number }>();
  for (const { kind, who } of members.values()) {
    if (who.size < 2) continue;
    const list = [...who];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as string;
        const b = list[j] as string;
        const key = pairKey(a, b);
        const cur = together.get(key) ?? { a, b, n: 0, meet: 0 };
        cur.n++;
        // A meeting between a person and a project or event they are about.
        const ka = kindOf.get(a);
        const kb = kindOf.get(b);
        const personAbout =
          (ka === "person" && (kb === "project" || kb === "event")) ||
          (kb === "person" && (ka === "project" || ka === "event"));
        if (kind === "meeting" && personAbout) cur.meet++;
        together.set(key, cur);
      }
    }
  }
  // Two shared interactions make a link; each node keeps its strongest few.
  const perNode = new Map<string, number>();
  const used = (id: string) => perNode.get(id) ?? 0;
  const coSorted = [...together.values()]
    .filter((t) => t.n >= 2)
    .sort((x, y) => y.n - x.n || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
  for (const t of coSorted) {
    if (used(t.a) >= MAX_CO_PER_NODE || used(t.b) >= MAX_CO_PER_NODE) continue;
    perNode.set(t.a, used(t.a) + 1);
    perNode.set(t.b, used(t.b) + 1);
    if (t.meet >= 2) add(t.a, t.b, "met_in", 1 + Math.min(2, t.meet) * 0.5);
    else add(t.a, t.b, "co_mentioned", Math.min(3, t.n) * 0.4);
  }

  // --- weights, cap, edges between the kept nodes ---------------------------------------------
  const degree = new Map<string, number>();
  for (const c of candidates.values()) {
    degree.set(c.a, (degree.get(c.a) ?? 0) + 1);
    degree.set(c.b, (degree.get(c.b) ?? 0) + 1);
  }
  const raw = rows.map((r) => {
    const c = counts.get(r.id);
    const lastAge =
      r.last === null ? Number.POSITIVE_INFINITY : (now - Date.parse(r.last)) / DAY_MS;
    const recency = Number.isFinite(lastAge) ? 0.5 ** (Math.max(0, lastAge) / 45) : 0;
    const score =
      Math.log1p(c?.score ?? 0) * 1.5 +
      Math.log1p(c?.all ?? 0) * 0.5 +
      recency * 1.5 +
      Math.log1p(degree.get(r.id) ?? 0) * 0.8 +
      Math.log1p(loops.get(r.id) ?? 0) * 0.8 +
      (r.pinned === 1 ? 1.5 : 0);
    return { r, score, all: c?.all ?? 0, lastAge };
  });
  raw.sort((a, b) => b.score - a.score || a.r.name.localeCompare(b.r.name));
  const kept = raw.slice(0, limit);
  const max = kept[0]?.score ?? 1;
  const keptIds = new Set(kept.map((k) => k.r.id));

  const nodes: MemoryMapNode[] = kept.map(({ r, score, all, lastAge }) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    weight: round(max > 0 ? clamp01(score / max) : 0),
    lastInteractionAt: r.last,
    pinned: r.pinned === 1,
    ...(r.private === 1 ? { private: true } : {}),
    ...(r.kind === "person" && all >= QUIET_MIN_INTERACTIONS && lastAge > QUIET_DAYS
      ? { quiet: true }
      : {}),
  }));

  const edges: MemoryMapEdge[] = [];
  for (const c of candidates.values()) {
    if (!keptIds.has(c.a) || !keptIds.has(c.b)) continue;
    edges.push({ a: c.a, b: c.b, kind: c.kind, weight: round(clamp01(c.w / 3)) });
  }
  edges.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));

  return { nodes, edges, total: rows.length, truncated: rows.length > kept.length };
}

/**
 * A fingerprint that changes whenever any row changes through this connection or another one.
 * SQLite counts every insert, update and delete (triggers included), so no change to an entity,
 * edge, interaction or participant can slip past it, whatever the clock says. It also moves for
 * writes to unrelated tables, which only costs a rebuild.
 */
export function graphFingerprint(db: Database.Database): string | undefined {
  // No fingerprint (so no cache) inside a transaction, which a rollback could undo without
  // lowering total_changes(), or while the store is closed (the encrypted store before its key).
  if (!db.open || db.inTransaction) return undefined;
  const row = db.prepare("SELECT total_changes() AS n").get() as { n: number } | undefined;
  if (row === undefined) return undefined;
  const other = db.pragma("data_version", { simple: true });
  return `${db.name}:${row.n}:${String(other)}`;
}

/**
 * A map builder that remembers its last few results. A result is reused while the graph's
 * fingerprint is unchanged and it is under six hours old (recency and "quiet" move with the clock).
 */
export function createMemoryMapBuilder(db: Database.Database) {
  const cache = new Map<string, { fingerprint: string; at: number; map: MemoryMap }>();
  return (opts: MemoryMapOptions = {}): MemoryMap => {
    const now = opts.now ?? Date.now();
    const key = JSON.stringify([
      opts.limit ?? DEFAULT_LIMIT,
      [...(opts.kinds ?? ALL_KINDS)].sort(),
    ]);
    const fingerprint = graphFingerprint(db);
    if (fingerprint === undefined) return buildMemoryMap(db, { ...opts, now });
    const hit = cache.get(key);
    if (hit !== undefined && hit.fingerprint === fingerprint && Math.abs(now - hit.at) < DAY_MS / 4)
      return hit.map;
    const map = buildMemoryMap(db, { ...opts, now });
    cache.delete(key);
    cache.set(key, { fingerprint, at: now, map });
    if (cache.size > 4) cache.delete(cache.keys().next().value as string);
    return map;
  };
}
