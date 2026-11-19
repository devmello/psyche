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
 *   (works_on, met_in, related), people and subjects that appear in the same interactions
 *   (co_mentioned, needs two shared interactions), and attendees of a meeting that is tied to a
 *   project or event (met_in).
 * - Nothing here reads a fact, a body or an identifier: names, kinds and counts only.
 */

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 2000;
/** An interaction with more participants than this (a mass mail) links nobody. */
const MAX_GROUP = 12;
/** Each node keeps its strongest few co-mention edges, so a hub stays readable. */
const MAX_CO_PER_NODE = 6;
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
  const nowIso = new Date(now).toISOString();
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), 5000);
  const kinds = opts.kinds ?? ALL_KINDS;

  const rows = db
    .prepare(
      `SELECT id, kind, name, pinned, private, last_interaction_at AS last FROM graph_entities
        WHERE status = 'active' AND is_owner = 0 AND hidden = 0
          AND kind IN (${kinds.map(() => "?").join(", ")})`,
    )
    .all(...kinds) as NodeRow[];
  const ids = new Set(rows.map((r) => r.id));

  // Per-entity interaction counts: all time, and a recency-weighted score over 180 days.
  const counts = new Map<string, { all: number; score: number }>();
  const part = db
    .prepare(
      `SELECT p.entity_id AS id, i.occurred_at AS at FROM graph_participants p
         JOIN graph_interactions i ON i.id = p.interaction_id`,
    )
    .iterate() as Iterable<{ id: string; at: string }>;
  for (const r of part) {
    if (!ids.has(r.id)) continue;
    const c = counts.get(r.id) ?? { all: 0, score: 0 };
    c.all++;
    const age = (now - Date.parse(r.at)) / DAY_MS;
    if (age <= 180) c.score += 0.5 ** (Math.max(0, age) / 30);
    counts.set(r.id, c);
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

  // Interactions with a small set of mapped participants and subjects.
  const members = new Map<string, { kind: string; who: Set<string> }>();
  const memberRows = db
    .prepare(
      `SELECT p.interaction_id AS iid, i.kind AS kind, p.entity_id AS id FROM graph_participants p
         JOIN graph_interactions i ON i.id = p.interaction_id
       UNION
       SELECT s.interaction_id, i.kind, s.entity_id FROM graph_interaction_subjects s
         JOIN graph_interactions i ON i.id = s.interaction_id WHERE s.linked_by != 'model'`,
    )
    .iterate() as Iterable<{ iid: string; kind: string; id: string }>;
  for (const r of memberRows) {
    if (!ids.has(r.id)) continue;
    const m = members.get(r.iid) ?? { kind: r.kind, who: new Set<string>() };
    m.who.add(r.id);
    members.set(r.iid, m);
  }
  const kindOf = new Map(rows.map((r) => [r.id, r.kind] as const));
  const together = new Map<string, { a: string; b: string; n: number; meet: number }>();
  for (const { kind, who } of members.values()) {
    if (who.size < 2 || who.size > MAX_GROUP) continue;
    const list = [...who];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as string;
        const b = list[j] as string;
        const key = pairKey(a, b);
        const cur = together.get(key) ?? { a, b, n: 0, meet: 0 };
        cur.n++;
        // A meeting between a person and a project or event they are about: "met in".
        const pe = kindOf.get(a) === "person" ? kindOf.get(b) : kindOf.get(a);
        const pp = kindOf.get(a) === "person" || kindOf.get(b) === "person";
        if (kind === "meeting" && pp && (pe === "project" || pe === "event")) cur.meet++;
        together.set(key, cur);
      }
    }
  }
  // Keep each node's strongest co-mentions.
  const perNode = new Map<string, number>();
  const coSorted = [...together.values()]
    .filter((t) => t.n >= 2 || t.meet >= 1)
    .sort((x, y) => y.n - x.n || (x.a < y.a ? -1 : 1));
  for (const t of coSorted) {
    const used = (id: string) => perNode.get(id) ?? 0;
    if (t.meet === 0 && (used(t.a) >= MAX_CO_PER_NODE || used(t.b) >= MAX_CO_PER_NODE)) continue;
    perNode.set(t.a, used(t.a) + 1);
    perNode.set(t.b, used(t.b) + 1);
    if (t.meet > 0) add(t.a, t.b, "met_in", 1 + Math.min(2, t.meet) * 0.5);
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
    const lastAge = r.last === null ? Infinity : (now - Date.parse(r.last)) / DAY_MS;
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
