import { type ReactElement, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/core.ts";

/**
 * Older history of a long chat (UI design §3.2). A sentinel at the top of the transcript asks for
 * the next page when it scrolls into view; the page is added above, and the scroll position is
 * moved by the height it added so the message the reader was on stays where it was.
 */
export function useLoadEarlier({
  viewport,
  hasMore,
  loadOlder,
  firstId,
}: {
  viewport: RefObject<HTMLElement | null>;
  hasMore: boolean;
  loadOlder: () => Promise<unknown>;
  /** The oldest loaded message: a change means a page arrived (or the thread changed). */
  firstId: string | null;
}): {
  sentinel: RefObject<HTMLDivElement | null>;
  loading: boolean;
  failed: boolean;
  retry: () => void;
} {
  const sentinel = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const before = useRef<{ height: number; top: number } | null>(null);
  // The caller's function changes identity every render; the observer must not re-subscribe.
  const loadRef = useRef(loadOlder);
  loadRef.current = loadOlder;

  const load = useCallback(async () => {
    const el = viewport.current;
    if (busy.current || el === null) return;
    busy.current = true;
    setLoading(true);
    setFailed(false);
    before.current = { height: el.scrollHeight, top: el.scrollTop };
    try {
      await loadRef.current();
      // The page is in the store; the transcript renders it a beat later. Move the scroll by the
      // height it adds once that happens, so the message the reader was on stays put.
      const settle = (): boolean => {
        const was = before.current;
        if (was === null) return true;
        const grew = el.scrollHeight - was.height;
        if (grew <= 0) return false;
        el.scrollTop = was.top + grew;
        before.current = null;
        return true;
      };
      if (!settle() && typeof MutationObserver !== "undefined") {
        const mo = new MutationObserver(() => {
          if (settle()) mo.disconnect();
        });
        mo.observe(el, { childList: true, subtree: true });
        // No page arrived (the history was spent): stop watching.
        setTimeout(() => {
          mo.disconnect();
          before.current = null;
        }, 2000);
      }
    } catch {
      before.current = null;
      setFailed(true);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [viewport]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `firstId` re-arms it after a page, so a sentinel still in view asks again
  useEffect(() => {
    const target = sentinel.current;
    const root = viewport.current;
    if (!hasMore || failed || target === null || root === null) return;
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void load();
      },
      { root, rootMargin: "200px 0px 0px 0px" },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [hasMore, failed, load, viewport, firstId]);

  return { sentinel, loading, failed, retry: () => void load() };
}

/** The sentinel plus its status row: "Loading earlier messages", or a retry when that failed. */
export function EarlierMessagesRow({
  sentinel,
  hasMore,
  loading,
  failed,
  onRetry,
}: {
  sentinel: RefObject<HTMLDivElement | null>;
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}): ReactElement | null {
  if (!hasMore) return null;
  return (
    <div ref={sentinel} data-testid="earlier-sentinel" className="flex min-h-px justify-center">
      {loading ? (
        <p role="status" className="py-2 text-callout text-label-tertiary">
          {t("chat.thread.loadingEarlier")}
        </p>
      ) : null}
      {failed && !loading ? (
        <p role="alert" className="flex items-center gap-2 py-2 text-callout text-label-secondary">
          {t("chat.thread.loadEarlierFailed")}
          <button
            type="button"
            onClick={onRetry}
            className="cursor-default rounded-sm px-1 text-accent-11 hover:bg-fill-tertiary"
          >
            {t("common.retry")}
          </button>
        </p>
      ) : null}
    </div>
  );
}
