import type {
  GraphEntityKind,
  MemoryMap,
  MemoryMapEdgeKind,
  MemoryMapNode,
} from "@psyche/protocol";

/**
 * The memory map's view model: pure functions over `memory.graph.map`. Filtering by group,
 * the neighbourhood of a node, search and the sizes the renderer draws. No DOM, no canvas, so
 * the logic is tested without a browser.
 */

/** Kinds fold into five groups, so the legend stays short. */
export const MAP_GROUPS = ["people", "projects", "events", "topics", "other"] as const;
export type MapGroup = (typeof MAP_GROUPS)[number];

export function groupOf(kind: GraphEntityKind): MapGroup {
  switch (kind) {
    case "person":
      return "people";
    case "project":
    case "assignment":
      return "projects";
    case "event":
      return "events";
    case "topic":
      return "topics";
    default:
      return "other";
  }
}

export interface MapNode extends MemoryMapNode {
  group: MapGroup;
  /** Drawn radius in world units. */
  r: number;
  /** Lower-cased, accent-folded name for search. */
  key: string;
}

export interface MapLink {
  /** Indexes into `nodes`. */
  a: number;
  b: number;
  kind: MemoryMapEdgeKind;
  weight: number;
}

export interface MapModel {
  nodes: MapNode[];
  links: MapLink[];
  index: Map<string, number>;
  /** Neighbour indexes per node. */
  adjacency: number[][];
  /** The store held more than the map shows. */
  truncated: boolean;
  total: number;
}

export interface MapFilter {
  groups: ReadonlySet<MapGroup>;
}

export const ALL_GROUPS: ReadonlySet<MapGroup> = new Set(MAP_GROUPS);

/** A circle's radius from importance 0..1: small nodes stay visible, big ones do not swamp. */
export function radiusOf(weight: number): number {
  return 3 + 10 * Math.sqrt(Math.min(1, Math.max(0, weight)));
}

export function foldName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim();
}

function assemble(
  nodes: MemoryMapNode[],
  edges: MemoryMap["edges"],
  truncated: boolean,
  total: number,
): MapModel {
  const out: MapNode[] = nodes.map((n) => ({
    ...n,
    group: groupOf(n.kind),
    r: radiusOf(n.weight),
    key: foldName(n.name),
  }));
  const index = new Map(out.map((n, i) => [n.id, i] as const));
  const adjacency: number[][] = out.map(() => []);
  const links: MapLink[] = [];
  for (const e of edges) {
    const a = index.get(e.a);
    const b = index.get(e.b);
    if (a === undefined || b === undefined || a === b) continue;
    links.push({ a, b, kind: e.kind, weight: e.weight });
    adjacency[a]?.push(b);
    adjacency[b]?.push(a);
  }
  return { nodes: out, links, index, adjacency, truncated, total };
}

/** The map for the chosen groups; links to a hidden group go with it. */
export function buildMapModel(
  map: MemoryMap,
  filter: MapFilter = { groups: ALL_GROUPS },
): MapModel {
  const nodes = map.nodes.filter((n) => filter.groups.has(groupOf(n.kind)));
  const keep = new Set(nodes.map((n) => n.id));
  const edges = map.edges.filter((e) => keep.has(e.a) && keep.has(e.b));
  return assemble(nodes, edges, map.truncated, map.total);
}

/** Indexes within `depth` hops of `id`, the node first. Empty when the node is not on the map. */
export function neighbourhood(model: MapModel, id: string, depth = 1): number[] {
  const start = model.index.get(id);
  if (start === undefined) return [];
  const seen = new Set<number>([start]);
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      for (const j of model.adjacency[i] ?? []) {
        if (seen.has(j)) continue;
        seen.add(j);
        next.push(j);
      }
    }
    frontier = next;
  }
  return [...seen];
}

/** A model reduced to the neighbourhood of one node (the focus view). */
export function focusModel(model: MapModel, id: string, depth = 1): MapModel {
  const keep = neighbourhood(model, id, depth);
  if (keep.length === 0) return model;
  const ids = new Set(keep.map((i) => model.nodes[i]?.id));
  const nodes = keep.map((i) => model.nodes[i] as MapNode);
  const edges = model.links
    .filter((l) => ids.has(model.nodes[l.a]?.id) && ids.has(model.nodes[l.b]?.id))
    .map((l) => ({
      a: model.nodes[l.a]?.id as string,
      b: model.nodes[l.b]?.id as string,
      kind: l.kind,
      weight: l.weight,
    }));
  return assemble(nodes, edges, false, nodes.length);
}

/** Names that start with the query first, then words that start with it, then the rest. */
export function searchNodes(model: MapModel, query: string, limit = 8): MapNode[] {
  const q = foldName(query);
  if (q === "") return [];
  const scored: { n: MapNode; s: number }[] = [];
  for (const n of model.nodes) {
    let s = -1;
    if (n.key.startsWith(q)) s = 3;
    else if (n.key.split(/[\s\-_.@]+/).some((w) => w.startsWith(q))) s = 2;
    else if (n.key.includes(q)) s = 1;
    if (s > 0) scored.push({ n, s });
  }
  return scored
    .sort((x, y) => y.s - x.s || y.n.weight - x.n.weight || x.n.name.localeCompare(y.n.name))
    .slice(0, limit)
    .map((x) => x.n);
}

/** People the owner has lost touch with, most important first. */
export function quietPeople(model: MapModel): MapNode[] {
  return model.nodes.filter((n) => n.quiet === true).sort((a, b) => b.weight - a.weight);
}

/** Too little to read as a map: few nodes, or nothing joined to anything. */
export function isSparse(model: MapModel): boolean {
  return model.nodes.length > 0 && (model.nodes.length < 4 || model.links.length === 0);
}

/** Most important first, for the keyboard and screen-reader list beside the canvas. */
export function topNodes(model: MapModel, n = 30): MapNode[] {
  return [...model.nodes]
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    .slice(0, n);
}

/** Share of the new map's nodes that were already on the old one (1 for an unchanged map). */
export function modelOverlap(prev: MapModel, next: MapModel): number {
  if (next.nodes.length === 0) return prev.nodes.length === 0 ? 1 : 0;
  let shared = 0;
  for (const n of next.nodes) if (prev.index.has(n.id)) shared++;
  const union = prev.nodes.length + next.nodes.length - shared;
  return union === 0 ? 1 : shared / union;
}

/** True when two maps hold the same nodes and links with the same weights. */
export function sameMap(a: MemoryMap, b: MemoryMap): boolean {
  return (
    a.total === b.total &&
    a.truncated === b.truncated &&
    JSON.stringify(a.nodes) === JSON.stringify(b.nodes) &&
    JSON.stringify(a.edges) === JSON.stringify(b.edges)
  );
}
