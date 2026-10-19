import { useEffect, useState } from "react";

/** Current time in ms, re-read every `intervalMs`. A fixed `now` (stories, tests) disables ticking. */
export function useNow(intervalMs = 1000, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) {
      setNow(fixed);
      return;
    }
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, fixed]);
  return fixed ?? now;
}
