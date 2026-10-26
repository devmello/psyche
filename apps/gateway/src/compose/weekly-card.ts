import {
  buildWeeklyCard,
  type Launcher,
  type LaunchRequest,
  type LaunchResult,
  type SchedulerLike,
  type SqliteMemoryStore,
  type TeachingStore,
  type WeeklyCard,
} from "@psyche/memory";
import type { Automation, Clock } from "@psyche/protocol";

/**
 * The weekly "What I learned" Feed post (docs/agent/teaching-loop-2026.md §5.4, #681 T3): one
 * system automation, Sunday 18:00 in the owner's zone (a missed Sunday runs at the next catch-up),
 * that builds the card from the lessons and evidence and posts it to the Feed. In-process like
 * dreaming: no agent turn. Nothing to say, or `teaching.weeklyCard` / `teaching.enabled` off,
 * means no post.
 */

export const WEEKLY_CARD_MARKER = "@psyche/teaching:weekly";
export const WEEKLY_CARD_SCHEDULE = "0 18 * * 0";

export const isWeeklyCardAutomation = (a: Pick<Automation, "prompt">) =>
  a.prompt.trim() === WEEKLY_CARD_MARKER;

/** Creates or updates the weekly automation. */
export async function ensureWeeklyCardAutomation(
  scheduler: SchedulerLike,
  options: { timezone: string },
): Promise<Automation> {
  const fields = {
    title: "What I learned this week",
    schedule: WEEKLY_CARD_SCHEDULE,
    timezone: options.timezone,
    sessionTarget: "main",
    delivery: {},
    prompt: WEEKLY_CARD_MARKER,
    enabled: true,
  };
  const existing = (await scheduler.list()).find(isWeeklyCardAutomation);
  if (existing !== undefined) return scheduler.update(existing.id, fields);
  return scheduler.create({ kind: "cron", scratch: null, system: true, ...fields });
}

export interface WeeklyCardDeps {
  store: TeachingStore;
  memory: SqliteMemoryStore;
  clock: Clock;
  /** `teaching.enabled` and `teaching.weeklyCard`. */
  enabled: () => boolean;
  post: (card: WeeklyCard) => unknown;
}

/** Runs the weekly card for its automation and passes every other run to `inner`. */
export function withWeeklyCard<R extends LaunchRequest, Run>(
  inner: Launcher<R, Run>,
  deps: WeeklyCardDeps,
): Launcher<R, Run> {
  return {
    async launch(request) {
      if (!isWeeklyCardAutomation(request.automation)) return inner.launch(request);
      const result = (async (): Promise<LaunchResult> => {
        if (!deps.enabled()) return { status: "no_reply", summary: "weekly card is off" };
        const card = buildWeeklyCard(deps.store, deps.memory, { clock: deps.clock });
        if (card === undefined) return { status: "no_reply", summary: "nothing to say this week" };
        await deps.post(card);
        return {
          status: "no_reply",
          summary: `posted ${card.growth.items.length} items for the week of ${card.growth.weekOf}`,
        };
      })().catch((): LaunchResult => ({ status: "failed", summary: "Weekly card failed" }));
      return { result };
    },
    ...(inner.reattach === undefined ? {} : { reattach: (run: Run) => inner.reattach?.(run) }),
    ...(inner.cancel === undefined
      ? {}
      : { cancel: (run: Run, reason: string) => inner.cancel?.(run, reason) ?? Promise.resolve() }),
  };
}
