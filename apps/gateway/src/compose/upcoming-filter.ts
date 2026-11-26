import type { Automation, UpcomingItem } from "@psyche/protocol";
import type { AutomationHandlers } from "@psyche/scheduler";
import { pausedRoutines, routineOf, type ScheduledKv } from "./scheduled.ts";

/**
 * Home's "Coming up" (`automations.upcoming`) lists what will really run. Psyche's own routines
 * are scheduled whether or not they have anything to do, so the list drops the ones that would
 * wake up and find nothing:
 * - a paused routine (Scheduled → Pause);
 * - the Today brief while the owner's Morning brief switch (`daily.brief.enabled`) is off;
 * - the new-mail check with no mail connected or nothing listening for mail;
 * - the mail digest, voice and focus jobs with no mail connected;
 * - Ideas mining and delivery with nothing to mine (no connector, no active goal).
 * The owner's own automations, reminders and event automations are never filtered.
 */
export interface RunnableUpcomingDeps {
  /** Every automation (the routine key is read from its prompt). */
  list: () => Promise<readonly Automation[]>;
  /** Ids of Psyche's own routines. */
  systemIds: () => ReadonlySet<string>;
  kv: ScheduledKv;
  /** A stored setting, or undefined. */
  setting: (key: string) => unknown;
  mailConnected: () => boolean;
  mailListening: () => Promise<boolean>;
  ideaSources: () => Promise<boolean>;
}

const NEEDS_MAIL = new Set(["mail-digest", "mail-voice", "mail-focus"]);

export async function runnableUpcoming(
  items: readonly UpcomingItem[],
  deps: RunnableUpcomingDeps,
): Promise<UpcomingItem[]> {
  const system = deps.systemIds();
  if (!items.some((i) => system.has(i.automationId ?? i.id))) return [...items];
  const byId = new Map((await deps.list()).map((a) => [a.id, a]));
  const paused = pausedRoutines(deps.kv);
  // Each question is asked once, and only when a routine needs it.
  const memo = new Map<string, Promise<boolean>>();
  const once = (key: string, fn: () => Promise<boolean>): Promise<boolean> => {
    let p = memo.get(key);
    if (p === undefined) {
      p = fn().catch(() => true);
      memo.set(key, p);
    }
    return p;
  };
  const keep = async (item: UpcomingItem): Promise<boolean> => {
    const id = item.automationId ?? item.id;
    const a = byId.get(id);
    if (a === undefined || !system.has(id)) return true;
    const routine = routineOf(a);
    if (paused.has(routine.id)) return false;
    if (routine.key === "feed-brief") return deps.setting("daily.brief.enabled") === true;
    if (routine.key === "mail-watch")
      return deps.mailConnected() && (await once("mail", deps.mailListening));
    if (NEEDS_MAIL.has(routine.key)) return deps.mailConnected();
    if (routine.key === "ideas-mine" || routine.key === "ideas-deliver")
      return once("ideas", deps.ideaSources);
    return true;
  };
  const kept = await Promise.all(items.map(keep));
  return items.filter((_, i) => kept[i]);
}

/** The automation handlers with `automations.upcoming` narrowed to what will really run. */
export function withRunnableUpcoming(
  handlers: AutomationHandlers,
  deps: RunnableUpcomingDeps,
): AutomationHandlers {
  return {
    ...handlers,
    "automations.upcoming": async (p) => {
      const r = await handlers["automations.upcoming"](p);
      return { ...r, items: await runnableUpcoming(r.items, deps) };
    },
  };
}
