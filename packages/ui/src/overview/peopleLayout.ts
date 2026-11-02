import type { InsightEntity } from "@psyche/protocol";

/**
 * The People map's geometry (docs/design/agent-overview-2026.md §5.4). Pure and deterministic:
 * no force simulation, no randomness, so the same data always gives the same picture. "You" sits
 * at the centre; the top entities by interactions sit on three rings by how recently they were
 * last interacted with. Only "you → entity" edges exist, because the data has no others.
 */

export const MAP_WIDTH = 640;
export const MAP_HEIGHT = 480;
export const MAP_CENTER = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 } as const;
/** The most nodes drawn (the Gateway sends at most 12). */
export const MAP_LIMIT = 12;

const DAY_MS = 86_400_000;

/** Ring 0: this week, 1: this month, 2: earlier. */
export type Ring = 0 | 1 | 2;
export const RING_RADII: readonly [number, number, number] = [100, 150, 198];
/** Where the first node of each ring sits, in turns, so rings don't line up like spokes. */
const RING_PHASE: readonly [number, number, number] = [0, 1 / 12, 1 / 7];

/** Node sizes by interaction count relative to the busiest entity. */
export type NodeSize = 1 | 2 | 3;
export const NODE_RADII: Readonly<Record<NodeSize, number>> = { 1: 10, 2: 14, 3: 18 };

export type NodeShape = "circle" | "square";

/** Where a node's name goes: just outside the node, away from "you". */
export interface NodeLabel {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

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
  label: NodeLabel;
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

/** The longest name drawn on the map; the full name is the node's title and accessible name. */
export const MAX_LABEL = 12;
export const labelText = (name: string): string =>
  name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name;

const LABEL_SIZE = 11;
export const labelWidth = (text: string): number => Math.ceil(text.length * LABEL_SIZE * 0.58) + 2;

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

const overlaps = (a: Box, b: Box): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

/** The box a label occupies for its anchor, baseline position and width (11 px type). */
export function labelBox(label: NodeLabel, width: number): Box {
  const l =
    label.anchor === "start"
      ? label.x
      : label.anchor === "end"
        ? label.x - width
        : label.x - width / 2;
  return { l, t: label.y - LABEL_SIZE, r: l + width, b: label.y + 3 };
}

const discBox = (x: number, y: number, r: number): Box => ({
  l: x - r,
  t: y - r,
  r: x + r,
  b: y + r,
});

/**
 * Names placed one by one in rank order: outward from "you" first, then beside, below or above
 * the node, and a little further out, taking the first spot that touches no node, no earlier
 * name, "you" or the map's edge. If every spot is taken the outward one stays (never overlapping
 * a node, since the last resort is a wider radial offset).
 */
function placeLabels(
  nodes: readonly Omit<PeopleNode, "label">[],
  center: { x: number; y: number },
): NodeLabel[] {
  const blocked: Box[] = [
    discBox(center.x, center.y, 27),
    ...nodes.map((n) => discBox(n.x, n.y, n.radius + 3)),
    // The open-loops badge PeopleMap draws at the node's upper right.
    ...nodes
      .filter((n) => n.entity.openLoops > 0)
      .map((n) =>
        discBox(n.x + n.radius * 0.8, n.y - n.radius * 0.8, Math.max(8, n.radius * 0.75) + 2),
      ),
  ];
  const placed: Box[] = [];
  return nodes.map((n) => {
    const text = labelText(n.entity.name);
    const w = labelWidth(text);
    const dx = n.x - center.x;
    const dy = n.y - center.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const side: NodeLabel["anchor"] = ux > 0.35 ? "start" : ux < -0.35 ? "end" : "middle";
    const out = (pad: number): NodeLabel => {
      const g = n.radius + pad;
      return side === "middle"
        ? { x: round(n.x), y: round(uy > 0 ? n.y + g + 8 : n.y - g), anchor: "middle" }
        : { x: round(n.x + Math.sign(ux) * g), y: round(n.y + 4), anchor: side };
    };
    const right = (pad: number): NodeLabel => ({
      x: round(n.x + n.radius + pad),
      y: round(n.y + 4),
      anchor: "start",
    });
    const left = (pad: number): NodeLabel => ({
      x: round(n.x - n.radius - pad),
      y: round(n.y + 4),
      anchor: "end",
    });
    const below = (pad: number): NodeLabel => ({
      x: round(n.x),
      y: round(n.y + n.radius + pad + 8),
      anchor: "middle",
    });
    const above = (pad: number): NodeLabel => ({
      x: round(n.x),
      y: round(n.y - n.radius - pad),
      anchor: "middle",
    });
    const candidates = [
      out(6),
      right(6),
      left(6),
      below(6),
      above(6),
      out(14),
      right(14),
      left(14),
      below(14),
      above(14),
      out(24),
      below(24),
      above(24),
    ];
    const free = (c: NodeLabel): boolean => {
      const box = labelBox(c, w);
      if (box.l < 0 || box.r > MAP_WIDTH || box.t < 0 || box.b > MAP_HEIGHT) return false;
      const own = discBox(n.x, n.y, n.radius + 3);
      return (
        !blocked.some((b) => b !== own && overlaps(box, b)) && !placed.some((b) => overlaps(box, b))
      );
    };
    const chosen = candidates.find(free) ?? candidates[0] ?? out(6);
    placed.push(labelBox(chosen, w));
    return chosen;
  });
}

/** The map for `entities` as of `now` (epoch ms). */
export function layoutPeopleMap(entities: readonly InsightEntity[], now: number): PeopleLayout {
  const ranked = rankEntities(entities).slice(0, MAP_LIMIT);
  const max = ranked.reduce((m, e) => Math.max(m, e.interactions), 0);
  const rings = ranked.map((e) => ringOf(e.lastInteractionAt, now));
  const perRing: [number, number, number] = [0, 0, 0];
  for (const r of rings) perRing[r] += 1;
  const seen: [number, number, number] = [0, 0, 0];
  const nodes = ranked.map((entity, rank): Omit<PeopleNode, "label"> => {
    const ring = rings[rank] as Ring;
    const index = seen[ring];
    seen[ring] += 1;
    // Evenly around the ring, starting at the top (-90°), in rank order clockwise.
    const turn = RING_PHASE[ring] + index / perRing[ring];
    const angle = turn * 2 * Math.PI - Math.PI / 2;
    const size = sizeOf(entity.interactions, max);
    const radius = NODE_RADII[size];
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const x = round(MAP_CENTER.x + RING_RADII[ring] * dx);
    const y = round(MAP_CENTER.y + RING_RADII[ring] * dy);
    return { entity, rank, ring, size, radius, shape: shapeOf(entity.kind), x, y };
  });
  const labels = placeLabels(nodes, MAP_CENTER);
  const withLabels = nodes.map((n, i): PeopleNode => ({ ...n, label: labels[i] as NodeLabel }));
  return {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    center: { ...MAP_CENTER },
    rings: RING_RADII.map((radius, i) => ({ ring: i as Ring, radius })),
    nodes: withLabels,
  };
}
