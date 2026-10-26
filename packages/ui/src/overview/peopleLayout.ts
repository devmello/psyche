import type { InsightEntity } from "@psyche/protocol";

/**
 * The People map's geometry (docs/design/agent-overview-2026.md §5.4). Pure and deterministic:
 * no force simulation, no randomness, so the same data always gives the same picture. "You" sits
 * at the centre; the top entities by interactions sit on three rings by how recently they were
 * last interacted with. Only "you → entity" edges exist, because the data has no others.
 */

export const MAP_WIDTH = 520;
export const MAP_HEIGHT = 440;
export const MAP_CENTER = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 } as const;
/** The most nodes drawn (the Gateway sends at most 12). */
export const MAP_LIMIT = 12;

const DAY_MS = 86_400_000;

/** Ring 0: this week, 1: this month, 2: earlier. */
export type Ring = 0 | 1 | 2;
export const RING_RADII: readonly [number, number, number] = [74, 124, 172];
/** Where the first node of each ring sits, in turns, so rings don't line up like spokes. */
const RING_PHASE: readonly [number, number, number] = [0, 1 / 12, 1 / 7];

/** Node sizes by interaction count relative to the busiest entity. */
export type NodeSize = 1 | 2 | 3;
export const NODE_RADII: Readonly<Record<NodeSize, number>> = { 1: 10, 2: 14, 3: 18 };

export type NodeShape = "circle" | "square";

export interface PeopleNode {
  entity: InsightEntity;
  /** 0-based position in rank order (interactions, then recency, then name). */
  rank: number;
  ring: Ring;
  size: NodeSize;
  radius: number;
  shape: NodeShape;
  x: number;
  y: number;
}

export interface PeopleLayout {
  width: number;
  height: number;
  center: { x: number; y: number };
  rings: readonly { ring: Ring; radius: number }[];
  nodes: PeopleNode[];
}

/** A person is a circle; projects, orgs and places are rounded squares. */
export const shapeOf = (kind: InsightEntity["kind"]): NodeShape =>
  kind === "person" ? "circle" : "square";

/** Which ring an entity falls in, from the age of its last interaction. */
export function ringOf(lastInteractionAt: string, now: number): Ring {
  const at = Date.parse(lastInteractionAt);
  if (Number.isNaN(at)) return 2;
  const age = now - at;
  if (age <= 7 * DAY_MS) return 0;
  if (age <= 30 * DAY_MS) return 1;
  return 2;
}

/** 3 sizes: at least two thirds of the busiest, at least a third, and the rest. */
export function sizeOf(interactions: number, max: number): NodeSize {
  if (max <= 0) return 1;
  const share = interactions / max;
  return share >= 2 / 3 ? 3 : share >= 1 / 3 ? 2 : 1;
}

/** Most interactions first; ties by the more recent, then by name, then id. */
export function rankEntities(entities: readonly InsightEntity[]): InsightEntity[] {
  return [...entities].sort(
    (a, b) =>
      b.interactions - a.interactions ||
      b.lastInteractionAt.localeCompare(a.lastInteractionAt) ||
      a.name.localeCompare(b.name) ||
      a.entityId.localeCompare(b.entityId),
  );
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** The map for `entities` as of `now` (epoch ms). */
export function layoutPeopleMap(entities: readonly InsightEntity[], now: number): PeopleLayout {
  const ranked = rankEntities(entities).slice(0, MAP_LIMIT);
  const max = ranked.reduce((m, e) => Math.max(m, e.interactions), 0);
  const rings = ranked.map((e) => ringOf(e.lastInteractionAt, now));
  const perRing: [number, number, number] = [0, 0, 0];
  for (const r of rings) perRing[r] += 1;
  const seen: [number, number, number] = [0, 0, 0];
  const nodes = ranked.map((entity, rank): PeopleNode => {
    const ring = rings[rank] as Ring;
    const index = seen[ring];
    seen[ring] += 1;
    // Evenly around the ring, starting at the top (-90°), in rank order clockwise.
    const turn = RING_PHASE[ring] + index / perRing[ring];
    const angle = turn * 2 * Math.PI - Math.PI / 2;
    const size = sizeOf(entity.interactions, max);
    return {
      entity,
      rank,
      ring,
      size,
      radius: NODE_RADII[size],
      shape: shapeOf(entity.kind),
      x: round(MAP_CENTER.x + RING_RADII[ring] * Math.cos(angle)),
      y: round(MAP_CENTER.y + RING_RADII[ring] * Math.sin(angle)),
    };
  });
  return {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    center: { ...MAP_CENTER },
    rings: RING_RADII.map((radius, i) => ({ ring: i as Ring, radius })),
    nodes,
  };
}
