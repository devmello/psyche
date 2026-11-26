import { useNotifications } from "../data/index.ts";
import { needsYou } from "../screens/inbox/InboxScreen.tsx";
import { useCatchUp } from "./use-catch-up.ts";

/**
 * What waits on the owner: unresolved approvals and questions plus the past-due "Did you finish
 * ...?" asks. Home's "Needs you" section and the sidebar badge beside Home both read this, so the
 * count is what the section lists, and it drops the moment a card is answered or denied on any
 * device (`notification.resolved`, or the approval leaving "pending").
 */
export function useNeedsYou(now: number = Date.now()) {
  const notifications = needsYou(useNotifications().unresolved, now);
  const { asks, busy, act } = useCatchUp();
  return { notifications, asks, busy, act, count: notifications.length + asks.length };
}
