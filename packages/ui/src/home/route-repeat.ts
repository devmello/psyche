import { useEffect, useState } from "react";

/**
 * Fired by the shell when a navigation asks for the route the owner is already on: nothing
 * changes, so a screen that scrolls to a target (Home's post or section) listens for this to do
 * it again. Without it, a second click on "Open the wrap-up" would be a no-op.
 */
export const ROUTE_REPEAT_EVENT = "psyche:route-repeat";

/** A count that goes up each time the current route is asked for again. */
export function useRouteRepeat(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const again = () => setCount((n) => n + 1);
    document.addEventListener(ROUTE_REPEAT_EVENT, again);
    return () => document.removeEventListener(ROUTE_REPEAT_EVENT, again);
  }, []);
  return count;
}
