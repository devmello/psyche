import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import {
  drawMap,
  FALLBACK_PALETTE,
  fitView,
  hitTest,
  type MapPalette,
  type MapView,
  readPalette,
  zoomAt,
} from "./map-draw.ts";
import { ForceLayout } from "./map-layout.ts";
import { type MapModel, type MapNode, modelOverlap } from "./map-model.ts";

/** True when the OS asks for less motion. Read through a function so tests can stub it. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export interface MapCanvasProps {
  model: MapModel;
  /** The node the map is focused on (its neighbourhood is the whole model). */
  focusId: string | null;
  quietOnly: boolean;
  onOpen: (id: string) => void;
  onFocus: (id: string) => void;
  className?: string;
}

const KEY_PAN = 56;

/**
 * The map itself: a canvas drawn on demand. The layout runs in short slices per frame until it
 * settles, then nothing runs (no idle loop). Pan with a drag or arrow keys, zoom with the wheel,
 * a pinch or +/-, click to open, Shift-click to focus. A tap on a touch screen selects first and
 * offers Open and Focus. Reduced motion: the layout settles before the first frame is drawn and
 * the view jumps instead of easing.
 */
export function MapCanvas({
  model,
  focusId,
  quietOnly,
  onOpen,
  onFocus,
  className,
}: MapCanvasProps): ReactElement {
  const wrapRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<ForceLayout | null>(null);
  const viewRef = useRef<MapView>({ k: 1, x: 0, y: 0 });
  const targetRef = useRef<MapView>({ k: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const paletteRef = useRef<MapPalette>(FALLBACK_PALETTE);
  const autoFit = useRef(true);
  const rafRef = useRef<number | null>(null);
  const dirty = useRef(true);
  const activeRef = useRef<number | null>(null);
  const lastTime = useRef(0);
  const modelRef = useRef(model);
  const quietRef = useRef(quietOnly);
  const focusIdx = useMemo(
    () => (focusId === null ? null : (model.index.get(focusId) ?? null)),
    [model, focusId],
  );
  const focusRef = useRef<number | null>(focusIdx);
  focusRef.current = focusIdx;
  quietRef.current = quietOnly;

  const [hover, setHover] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const active = selected ?? hover;
  activeRef.current = active;

  const frameRef = useRef<() => void>(() => {});
  const request = useCallback(() => {
    dirty.current = true;
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(() => frameRef.current());
  }, []);

  frameRef.current = () => {
    rafRef.current = null;
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    const { w, h, dpr } = sizeRef.current;
    if (canvas === null || layout === null || w === 0) return;
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, (now - (lastTime.current || now - 16)) / 1000));
    lastTime.current = now;
    const reduced = prefersReducedMotion();
    let again = false;

    if (!layout.settled) {
      layout.run(reduced ? 24 : 7);
      again = true;
    }
    if (autoFit.current) targetRef.current = fitView(layout.bounds(), w, h);
    const v = viewRef.current;
    const g = targetRef.current;
    if (reduced) {
      viewRef.current = { ...g };
    } else {
      const a = 1 - Math.exp(-dt * 12);
      const next = { k: v.k + (g.k - v.k) * a, x: v.x + (g.x - v.x) * a, y: v.y + (g.y - v.y) * a };
      const close =
        Math.abs(next.k - g.k) < 0.002 * g.k &&
        Math.abs(next.x - g.x) < 0.3 &&
        Math.abs(next.y - g.y) < 0.3;
      viewRef.current = close ? { ...g } : next;
      if (!close) again = true;
    }
    // Reduced motion: do not paint a half-settled layout; wait for the settled picture.
    if (reduced && !layout.settled) {
      rafRef.current = requestAnimationFrame(() => frameRef.current());
      return;
    }
    const ctx = canvas.getContext("2d");
    if (ctx !== null) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawMap(ctx, {
        model: modelRef.current,
        x: layout.x,
        y: layout.y,
        view: viewRef.current,
        width: w,
        height: h,
        palette: paletteRef.current,
        active: activeRef.current,
        quietOnly: quietRef.current,
        focus: focusRef.current,
      });
    }
    dirty.current = false;
    if (again) rafRef.current = requestAnimationFrame(() => frameRef.current());
  };

  // A new model: a new layout, started from where the nodes already are. A refetch of the same
  // map (same focus, mostly the same nodes) keeps the owner's view and selection; a focus or
  // filter change refits.
  const focusIdRef = useRef(focusId);
  focusIdRef.current = focusId;
  const lastFocusId = useRef(focusId);
  useEffect(() => {
    const prev = modelRef.current;
    const prevLayout = layoutRef.current;
    const layout = new ForceLayout({
      radii: model.nodes.map((n) => n.r),
      links: model.links.map((l) => ({ a: l.a, b: l.b, weight: l.weight })),
    });
    let seeded = 0;
    if (prevLayout !== null && prev !== model) {
      model.nodes.forEach((node, i) => {
        const j = prev.index.get(node.id);
        if (j === undefined) return;
        layout.x[i] = prevLayout.x[j] ?? 0;
        layout.y[i] = prevLayout.y[j] ?? 0;
        seeded++;
      });
    }
    const continuing =
      prevLayout !== null &&
      lastFocusId.current === focusIdRef.current &&
      modelOverlap(prev, model) >= 0.8;
    if (seeded > 0) layout.alpha = continuing ? 0.25 : 0.5;
    lastFocusId.current = focusIdRef.current;
    modelRef.current = model;
    layoutRef.current = layout;
    setHover(null);
    setSelected((cur) => {
      if (!continuing || cur === null) return null;
      const id = prev.nodes[cur]?.id;
      return id === undefined ? null : (model.index.get(id) ?? null);
    });
    if (!continuing) {
      autoFit.current = true;
      // Pre-warm a little so the first frame is not a spiral of dots.
      if (seeded === 0 && !prefersReducedMotion()) layout.run(10);
      const { w, h } = sizeRef.current;
      if (w > 0 && seeded === 0) {
        viewRef.current = fitView(layout.bounds(), w, h);
        targetRef.current = { ...viewRef.current };
      }
    }
    request();
  }, [model, request]);

  // Size, palette and theme changes.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (wrap === null || canvas === null) return;
    const refreshPalette = () => {
      paletteRef.current = readPalette(wrap);
      request();
    };
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const first = sizeRef.current.w === 0;
      sizeRef.current = { w: Math.round(rect.width), h: Math.round(rect.height), dpr };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const layout = layoutRef.current;
      if (layout !== null && (first || autoFit.current)) {
        viewRef.current = fitView(layout.bounds(), sizeRef.current.w, sizeRef.current.h);
        targetRef.current = { ...viewRef.current };
      }
      request();
    };
    refreshPalette();
    resize();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    ro?.observe(wrap);
    const mo = new MutationObserver(refreshPalette);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    scheme?.addEventListener?.("change", refreshPalette);
    return () => {
      ro?.disconnect();
      mo.disconnect();
      scheme?.removeEventListener?.("change", refreshPalette);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [request]);

  // Redraw when what is highlighted changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are the redraw triggers
  useEffect(() => {
    request();
  }, [active, quietOnly, focusIdx, request]);

  // Wheel zoom needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : 1;
      const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.012 : 0.0016));
      autoFit.current = false;
      targetRef.current = zoomAt(
        targetRef.current,
        factor,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      request();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [request]);

  // Pointer: drag to pan, two fingers to pinch, click or tap on a node.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: number; pinch: number | null; downAt: number } | null>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };
  const nodeAt = (p: { x: number; y: number }): number => {
    const layout = layoutRef.current;
    if (layout === null) return -1;
    return hitTest(modelRef.current, layout.x, layout.y, viewRef.current, p.x, p.y);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    wrapRef.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    gesture.current = { moved: 0, pinch: null, downAt: e.timeStamp };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    const prev = pointers.current.get(e.pointerId);
    const g = gesture.current;
    if (prev === undefined || g === null) {
      if (e.pointerType === "mouse") {
        const i = nodeAt(p);
        setHover(i < 0 ? null : i);
      }
      return;
    }
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.pinch !== null && g.pinch > 0) {
        autoFit.current = false;
        g.moved = 99;
        viewRef.current = zoomAt(viewRef.current, dist / g.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        targetRef.current = { ...viewRef.current };
        request();
      }
      g.pinch = dist;
      return;
    }
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    g.moved += Math.abs(dx) + Math.abs(dy);
    if (g.moved > 4) {
      autoFit.current = false;
      const v = viewRef.current;
      viewRef.current = { ...v, x: v.x + dx, y: v.y + dy };
      targetRef.current = { ...viewRef.current };
      setHover(null);
      request();
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    const had = pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) gesture.current = null;
    if (!had || g === null || g.moved > 4) return;
    const i = nodeAt(local(e));
    const node = i < 0 ? undefined : (modelRef.current.nodes[i] as MapNode);
    if (node === undefined) {
      setSelected(null);
      return;
    }
    if (e.shiftKey || e.altKey) onFocus(node.id);
    else if (e.pointerType === "mouse") onOpen(node.id);
    else if (selected === i) onOpen(node.id);
    else setSelected(i);
  };
  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && pointers.current.size === 0) setHover(null);
  };

  const zoomBy = (factor: number) => {
    const { w, h } = sizeRef.current;
    autoFit.current = false;
    targetRef.current = zoomAt(targetRef.current, factor, w / 2, h / 2);
    request();
  };
  const fit = () => {
    autoFit.current = true;
    request();
  };
  const panBy = (dx: number, dy: number) => {
    autoFit.current = false;
    const v = targetRef.current;
    targetRef.current = { ...v, x: v.x + dx, y: v.y + dy };
    request();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => panBy(KEY_PAN, 0),
      ArrowRight: () => panBy(-KEY_PAN, 0),
      ArrowUp: () => panBy(0, KEY_PAN),
      ArrowDown: () => panBy(0, -KEY_PAN),
      "+": () => zoomBy(1.4),
      "=": () => zoomBy(1.4),
      "-": () => zoomBy(1 / 1.4),
      "0": fit,
    };
    const fn = keys[e.key];
    if (fn !== undefined) {
      e.preventDefault();
      fn();
    }
  };

  const shown = active === null ? undefined : model.nodes[active];
  const links = active === null ? 0 : (model.adjacency[active]?.length ?? 0);

  return (
    <section
      ref={wrapRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the map takes arrow and +/- keys
      tabIndex={0}
      aria-label={t("memory.map.canvasLabel", {
        nodes: model.nodes.length,
        links: model.links.length,
      })}
      data-testid="memory-map-canvas"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      className={cn(
        "relative h-[min(68vh,640px)] min-h-[340px] touch-none overflow-hidden rounded-lg bg-surface-raised shadow-elevation-1 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        hover !== null && "cursor-pointer",
        className,
      )}
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />

      <div className="absolute end-2 top-2 flex flex-col gap-1">
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label={t("memory.map.zoomIn")}
          onClick={() => zoomBy(1.4)}
        >
          <span aria-hidden="true">+</span>
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label={t("memory.map.zoomOut")}
          onClick={() => zoomBy(1 / 1.4)}
        >
          <span aria-hidden="true">−</span>
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label={t("memory.map.fit")}
          onClick={fit}
        >
          <FitGlyph />
        </Button>
      </div>

      {shown ? (
        <div
          data-testid="memory-map-card"
          className={cn(
            "absolute start-2 bottom-2 flex max-w-[min(20rem,calc(100%-4rem))] flex-col gap-1 rounded-lg bg-surface-raised p-3 text-body shadow-elevation-2",
            selected === null && "pointer-events-none",
          )}
        >
          <p className="truncate font-medium text-label-primary">{shown.name}</p>
          <p className="text-callout text-label-secondary">
            {t(`memory.map.kind.${shown.kind}`)} · {t("memory.map.card.connections", { n: links })}
            {shown.quiet === true ? ` · ${t("memory.map.card.quiet")}` : ""}
            {shown.private === true ? ` · ${t("memory.map.card.private")}` : ""}
          </p>
          {selected === null ? (
            <p className="text-caption text-label-tertiary">{t("memory.map.card.hint")}</p>
          ) : (
            <div className="mt-1 flex gap-2">
              <Button type="button" size="sm" onClick={() => onOpen(shown.id)}>
                {t("memory.map.card.open")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => onFocus(shown.id)}>
                {t("memory.map.card.focus")}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function FitGlyph(): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
