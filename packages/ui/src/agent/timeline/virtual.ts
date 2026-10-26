import { type RefObject, useCallback, useEffect, useState } from "react";

/**
 * Fixed-height row virtualisation for the waterfall (run trace §5.1 T3: 2,000 rows at 60 fps).
 * Only the rows in view, plus an overscan, are in the DOM; the rest are spacer height.
 */

export const ROW_HEIGHT = 28;
const OVERSCAN = 8;

export function visibleRange(
  scrollTop: number,
  viewport: number,
  count: number,
  rowHeight = ROW_HEIGHT,
  overscan = OVERSCAN,
): { start: number; end: number } {
  if (count === 0) return { start: 0, end: 0 };
  const first = Math.floor(scrollTop / rowHeight);
  const inView = Math.ceil(viewport / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + inView + overscan);
  return { start, end };
}

/** The window of rows to render for a scroll container; falls back to every row without layout. */
export function useVirtualRows(
  ref: RefObject<HTMLElement | null>,
  count: number,
  rowHeight = ROW_HEIGHT,
): { start: number; end: number; scrollTo: (index: number) => void } {
  const [box, setBox] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setBox((b) =>
        b.top === el.scrollTop && b.height === el.clientHeight
          ? b
          : { top: el.scrollTop, height: el.clientHeight },
      );
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(onScroll) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [ref]);
  const scrollTo = useCallback(
    (index: number) => {
      const el = ref.current;
      if (!el) return;
      const top = index * rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + el.clientHeight)
        el.scrollTop = top + rowHeight - el.clientHeight;
    },
    [ref, rowHeight],
  );
  // No layout yet (first paint, jsdom): a first screenful, as if the viewport were 900 px tall.
  if (box.height === 0) return { ...visibleRange(box.top, 900, count, rowHeight), scrollTo };
  return { ...visibleRange(box.top, box.height, count, rowHeight), scrollTo };
}
