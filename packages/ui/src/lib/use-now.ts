import { useEffect, useState } from "react";

/**
 * Current time in ms, re-read every `intervalMs`. A fixed `now` (stories, tests) disables ticking.
 * The tick pauses while the document is hidden and catches up when it shows again. With
 * `active` false (nothing time-relative on screen) it does not tick at all; it catches up
 * when `active` turns true.
 */
export function useNow(intervalMs = 1000, fixed?: number, active = true): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) {
      setNow(fixed);
      return;
    }
    if (!active) return;
    setNow(Date.now());
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        setNow(Date.now());
        start();
      }
    };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, fixed, active]);
  return fixed ?? now;
}
