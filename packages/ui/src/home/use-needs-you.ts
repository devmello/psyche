import { useNotifications, useStoreState } from "../data/index.ts";
import { useNow } from "../lib/use-now.ts";
import { needsYou } from "../screens/inbox/InboxScreen.tsx";
import { useCatchUp } from "./use-catch-up.ts";

/**
 * What waits on the owner: unresolved approvals and questions plus the past-due "Did you finish
 * ...?" asks. Home's "Needs you" section and the sidebar badge beside Home both read this, so the
 * count is what the section lists. It drops the moment a card is answered, denied or expires, on
 * any device (`notification.resolved`, or the approval leaving "pending" or passing its expiry).
 */
export function useNeedsYou(fixedNow?: number) {
  // Ticks, so an approval that reaches its deadline leaves the count without another event.
  const now = useNow(30_000, fixedNow);
  const approvals = useStoreState((s) => s.approvals);
  const notifications = needsYou(useNotifications().unresolved, now, approvals);
  const { asks, busy, act } = useCatchUp();
  return { notifications, asks, busy, act, count: notifications.length + asks.length };
}
