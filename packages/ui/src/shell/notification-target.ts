import { chatLinkRoute, type Notification, SCHEDULED_RUNS_ROUTE } from "@psyche/protocol";

/** What a notification needs from the Gateway to find its source. */
export interface NotificationLookup {
  /** The thread a task runs in, or null when it is gone. */
  taskThread: (taskId: string) => Promise<string | null>;
  /** The thread an approval was asked in, or null. */
  approvalThread: (approvalId: string) => Promise<string | null>;
}

type Source = Pick<Notification, "kind" | "route" | "taskId" | "approvalId">;

/** Routes the shell renders as they are; anything else is an old link or unknown. */
const CURRENT =
  /^\/(chat|overview|scheduled|settings|feed|goals|ideas|library|agent|inbox)(\/|\?|$)/;

/** Where an approval with no known chat is answered. */
const APPROVALS = "/agent/approvals";

/**
 * The route a notification opens (nav-inbox 2026): its own durable link when that is one the
 * shell renders (`/chat/<thread>?message=`, a run's Timeline, Scheduled → Runs, Memory → Review),
 * else the source rebuilt from its ids (a task's or approval's chat), else the inbox. Old links
 * (`/tasks/<id>`, `/approvals/<id>`, `/upcoming/<id>`) written before the links were durable
 * resolve through `lookup`; without one they fall back to something that still opens.
 */
export async function notificationRoute(n: Source, lookup?: NotificationLookup): Promise<string> {
  const route = n.route ?? null;
  if (route !== null && CURRENT.test(route)) return route;
  if (route !== null && /^\/upcoming(\/|$)/.test(route)) return SCHEDULED_RUNS_ROUTE;
  const approvalId = n.approvalId ?? /^\/approvals\/([^/?#]+)/.exec(route ?? "")?.[1] ?? null;
  const taskId = n.taskId ?? /^\/tasks\/([^/?#]+)/.exec(route ?? "")?.[1] ?? null;
  if (approvalId !== null) {
    const threadId = await settle(lookup?.approvalThread(approvalId));
    return threadId === null ? APPROVALS : chatLinkRoute({ threadId, approvalId });
  }
  if (taskId !== null) {
    const threadId = await settle(lookup?.taskThread(taskId));
    if (threadId !== null) return chatLinkRoute({ threadId });
  }
  return n.kind === "approval" ? APPROVALS : "/inbox";
}

async function settle(p: Promise<string | null> | undefined): Promise<string | null> {
  try {
    return (await p) ?? null;
  } catch {
    return null;
  }
}

/** The row's button: "Open card" for an approval, "Answer" when it asks, else "Open". */
export function notificationHasTarget(n: Source): boolean {
  return (
    (n.route ?? null) !== null || (n.approvalId ?? null) !== null || (n.taskId ?? null) !== null
  );
}
