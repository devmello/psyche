import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Within this distance of the end the transcript follows new content (motion.md §4.6). */
export const ANCHOR_SLACK_PX = 72;

function prefersReducedMotion(el: HTMLElement): boolean {
  const root = el.ownerDocument.documentElement;
  const setting = root.getAttribute("data-reduce-motion");
  if (setting === "true") return true;
  if (setting === "false") return false;
  return (
    el.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

/**
 * Keeps a scrolling transcript anchored to its end (redesign-2026 §5.2, motion.md §4.6): when the
 * reader is within 72 px of the bottom, new content keeps the end in view (instantly: scroll
 * position never animates); otherwise the position stays put and `away` turns true so a "jump to
 * latest" pill can fade in. `jump()` scrolls to the end, smoothly unless motion is reduced.
 *
 * `version` changes whenever the content changes (messages, streamed text, cards); a
 * ResizeObserver on `content` covers late growth such as images and expanding cards.
 */
export function useBottomAnchor(
  viewport: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  version: unknown,
): { away: boolean; jump: () => void } {
  const pinned = useRef(true);
  const [away, setAway] = useState(false);

  const stick = useCallback(() => {
    const el = viewport.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [viewport]);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
      pinned.current = gap <= ANCHOR_SLACK_PX;
      setAway(!pinned.current);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewport]);

  // New content: follow it if the reader was at the end. Layout effect, so there is no frame
  // where the new message sits below the fold.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the trigger
  useLayoutEffect(stick, [version, stick]);

  useEffect(() => {
    const target = content.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => stick());
    ro.observe(target);
    return () => ro.disconnect();
  }, [content, stick]);

  const jump = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    pinned.current = true;
    setAway(false);
    const top = el.scrollHeight;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top, behavior: prefersReducedMotion(el) ? "auto" : "smooth" });
    } else {
      el.scrollTop = top;
    }
  }, [viewport]);

  return { away, jump };
}
