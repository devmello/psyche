import type { MemoryMapEdgeKind } from "@psyche/protocol";
import type { MapGroup, MapModel, MapNode } from "./map-model.ts";

/**
 * Canvas drawing for the memory map. Pure with respect to React: give it a context, the model,
 * positions and a view, and it paints one frame. Everything is drawn in screen space (not under a
 * scale transform) so lines and labels stay crisp at any zoom.
 */

export interface MapView {
  /** Screen = offset + k * world. */
  k: number;
  x: number;
  y: number;
}

export interface MapPalette {
  ink: string;
  primary: string;
  textSecondary: string;
  textTertiary: string;
  line: string;
  paper: string;
  font: string;
}

export const FALLBACK_PALETTE: MapPalette = {
  ink: "#2c5aa0",
  primary: "rgb(28 28 30)",
  textSecondary: "rgb(91 91 96)",
  textTertiary: "rgb(140 140 146)",
  line: "rgb(201 201 206)",
  paper: "rgb(255 255 255)",
  font: "system-ui, sans-serif",
};

/** The palette from the theme's custom properties on `el`; the fallback where a token is absent. */
export function readPalette(el: Element): MapPalette {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    ink: v("--accent-9", FALLBACK_PALETTE.ink),
    primary: v("--label-primary", FALLBACK_PALETTE.primary),
    textSecondary: v("--label-secondary", FALLBACK_PALETTE.textSecondary),
    textTertiary: v("--label-tertiary", FALLBACK_PALETTE.textTertiary),
    line: v("--separator-strong", FALLBACK_PALETTE.line),
    paper: v("--surface-raised", FALLBACK_PALETTE.paper),
    font: css.fontFamily || FALLBACK_PALETTE.font,
  };
}

/** Polygon outline of a group's shape, unit radius, as [x, y] pairs. `null` is a circle. */
export function shapeOf(group: MapGroup): [number, number][] | null {
  switch (group) {
    case "people":
      return null;
    case "projects":
      return [
        [-0.85, -0.85],
        [0.85, -0.85],
        [0.85, 0.85],
        [-0.85, 0.85],
      ];
    case "events":
      return [
        [0, -1.15],
        [1.15, 0],
        [0, 1.15],
        [-1.15, 0],
      ];
    case "topics":
      return [
        [0, -1.1],
        [1, 0.8],
        [-1, 0.8],
      ];
    default:
      return Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        return [Math.cos(a) * 1.05, Math.sin(a) * 1.05] as [number, number];
      });
  }
}

export interface EdgeStyle {
  width: number;
  dash: number[];
}

export const EDGE_STYLES: Record<MemoryMapEdgeKind, EdgeStyle> = {
  works_on: { width: 1.5, dash: [] },
  met_in: { width: 1.2, dash: [5, 3] },
  co_mentioned: { width: 1, dash: [1.5, 3] },
  related: { width: 0.8, dash: [] },
};

const EDGE_ORDER: MemoryMapEdgeKind[] = ["related", "co_mentioned", "met_in", "works_on"];

function trace(
  ctx: CanvasRenderingContext2D,
  group: MapGroup,
  cx: number,
  cy: number,
  r: number,
): void {
  const pts = shapeOf(group);
  ctx.beginPath();
  if (pts === null) {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    return;
  }
  pts.forEach(([px, py], i) => {
    const sx = cx + px * r;
    const sy = cy + py * r;
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.closePath();
}

export interface DrawState {
  model: MapModel;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  view: MapView;
  width: number;
  height: number;
  palette: MapPalette;
  /** Highlighted node (hover or selection) whose neighbourhood stays bright. */
  active: number | null;
  /** Only quiet people stay bright. */
  quietOnly: boolean;
  /** The node the map is focused on, drawn as the anchor. */
  focus: number | null;
}

/** On-screen radius: grows a little with zoom, never below a readable dot. */
export function screenRadius(r: number, k: number): number {
  return Math.max(2.2, r * Math.min(1.6, Math.max(0.55, Math.sqrt(k))));
}

export function drawMap(ctx: CanvasRenderingContext2D, s: DrawState): number {
  const { model, x, y, view, width, height, palette } = s;
  ctx.clearRect(0, 0, width, height);
  const n = model.nodes.length;
  const near = new Set<number>();
  if (s.active !== null) {
    near.add(s.active);
    for (const j of model.adjacency[s.active] ?? []) near.add(j);
  }
  const hasActive = s.active !== null;
  const sx = (i: number) => view.x + view.k * (x[i] ?? 0);
  const sy = (i: number) => view.y + view.k * (y[i] ?? 0);
  const onScreen = (i: number, pad: number) => {
    const px = sx(i);
    const py = sy(i);
    return px > -pad && px < width + pad && py > -pad && py < height + pad;
  };

  // Links: one path per style, quiet grey; the active node's links in ink on top.
  const lod = n > 1500 && view.k < 0.5;
  ctx.lineCap = "round";
  for (const kind of EDGE_ORDER) {
    const style = EDGE_STYLES[kind];
    ctx.beginPath();
    for (const l of model.links) {
      if (l.kind !== kind) continue;
      if (lod && l.weight < 0.35) continue;
      if (hasActive && (l.a === s.active || l.b === s.active)) continue;
      if (!onScreen(l.a, 40) && !onScreen(l.b, 40)) continue;
      ctx.moveTo(sx(l.a), sy(l.a));
      ctx.lineTo(sx(l.b), sy(l.b));
    }
    ctx.setLineDash(style.dash);
    ctx.lineWidth = style.width;
    ctx.strokeStyle = palette.line;
    ctx.globalAlpha = hasActive ? 0.22 : s.quietOnly ? 0.18 : 0.7;
    ctx.stroke();
  }
  if (hasActive) {
    for (const kind of EDGE_ORDER) {
      const style = EDGE_STYLES[kind];
      ctx.beginPath();
      for (const l of model.links) {
        if (l.kind !== kind || (l.a !== s.active && l.b !== s.active)) continue;
        ctx.moveTo(sx(l.a), sy(l.a));
        ctx.lineTo(sx(l.b), sy(l.b));
      }
      ctx.setLineDash(style.dash);
      ctx.lineWidth = style.width + 0.6;
      ctx.strokeStyle = palette.ink;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  // Nodes: heavy ones last, so they sit on top.
  const labels: { i: number; px: number; py: number; r: number; priority: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (!onScreen(i, 20)) continue;
    const node = model.nodes[i] as MapNode;
    const r = screenRadius(node.r, view.k);
    const px = sx(i);
    const py = sy(i);
    const lit = !hasActive || near.has(i);
    const dim = s.quietOnly && node.quiet !== true;
    ctx.globalAlpha = lit ? (dim ? 0.2 : 1) : 0.16;
    const emphasised = i === s.active || i === s.focus;
    trace(ctx, node.group, px, py, r);
    if (node.quiet === true) {
      // Gone quiet: a ring, not a disc.
      ctx.fillStyle = palette.paper;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = emphasised || (s.quietOnly && !dim) ? palette.ink : palette.textSecondary;
      ctx.stroke();
    } else {
      ctx.fillStyle = emphasised || node.pinned ? palette.ink : palette.textTertiary;
      ctx.fill();
      if (hasActive && near.has(i) && !emphasised) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = palette.ink;
        ctx.stroke();
      }
    }
    if (lit && !dim && (r >= 6.5 || emphasised || (hasActive && near.has(i)))) {
      labels.push({
        i,
        px,
        py,
        r,
        priority: (emphasised ? 10 : 0) + (near.has(i) ? 3 : 0) + node.weight,
      });
    }
  }

  // Labels: most important first, skipping any that would overlap one already placed.
  ctx.globalAlpha = 1;
  ctx.font = `12px ${palette.font}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  labels.sort((a, b) => b.priority - a.priority);
  const placed: [number, number, number, number][] = [];
  let count = 0;
  for (const l of labels) {
    if (count >= 90) break;
    const name = (model.nodes[l.i] as MapNode).name;
    const w = ctx.measureText(name).width;
    const x0 = l.px + l.r + 4;
    const y0 = l.py - 8;
    const box: [number, number, number, number] = [x0 - 2, y0, x0 + w + 2, y0 + 16];
    const forced = l.i === s.active || l.i === s.focus;
    if (
      !forced &&
      placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])
    )
      continue;
    placed.push(box);
    count++;
    // A paper halo keeps the text readable over links.
    ctx.lineWidth = 3;
    ctx.strokeStyle = palette.paper;
    ctx.globalAlpha = 0.85;
    ctx.lineJoin = "round";
    ctx.strokeText(name, x0, l.py);
    ctx.globalAlpha = 1;
    ctx.fillStyle = forced ? palette.ink : palette.primary;
    ctx.fillText(name, x0, l.py);
  }
  ctx.globalAlpha = 1;
  return count;
}

/** The node under a screen point, or -1. Heavier nodes win ties: they are drawn on top. */
export function hitTest(
  model: MapModel,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  view: MapView,
  px: number,
  py: number,
  slop = 3,
): number {
  for (let i = 0; i < model.nodes.length; i++) {
    const r = screenRadius((model.nodes[i] as MapNode).r, view.k) + slop;
    const dx = view.x + view.k * (x[i] ?? 0) - px;
    const dy = view.y + view.k * (y[i] ?? 0) - py;
    if (dx * dx + dy * dy <= r * r) return i;
  }
  return -1;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** The view that shows `bounds` inside a `width` by `height` box with `pad` around it. */
export function fitView(
  bounds: { x0: number; y0: number; x1: number; y1: number },
  width: number,
  height: number,
  pad = 48,
): MapView {
  const bw = Math.max(1, bounds.x1 - bounds.x0);
  const bh = Math.max(1, bounds.y1 - bounds.y0);
  const k = clampZoom(
    Math.min(2.2, Math.max(1, width - pad * 2) / bw, Math.max(1, height - pad * 2) / bh),
  );
  return {
    k,
    x: width / 2 - k * ((bounds.x0 + bounds.x1) / 2),
    y: height / 2 - k * ((bounds.y0 + bounds.y1) / 2),
  };
}

/** Zoom by `factor` keeping the world point under (px, py) still. */
export function zoomAt(view: MapView, factor: number, px: number, py: number): MapView {
  const k = clampZoom(view.k * factor);
  const f = k / view.k;
  return { k, x: px - (px - view.x) * f, y: py - (py - view.y) * f };
}
