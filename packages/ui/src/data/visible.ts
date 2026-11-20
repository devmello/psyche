import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * True once the element has come near the viewport, and stays true after that. A long chat
 * mounts a trace per run, so a trace uses this to load only when the owner can see it (or is about
 * to). Without an IntersectionObserver (old webviews, jsdom) it counts as visible at once.
 */
export function useLatchedVisible<T extends Element>(): {
  ref: RefObject<T | null>;
  visible: boolean;
} {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (el === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      // Start a little before the trace scrolls in, so the steps are there when it arrives.
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);
  return { ref, visible };
}
