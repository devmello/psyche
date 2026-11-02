import { getSetting, type PsycheDb, setSetting } from "@psyche/db";
import {
  computeNudges,
  type EverythingStore,
  type GraphStore,
  type Nudge,
  type NudgeSensitivity,
  NudgeState,
} from "@psyche/memory";
import { isQuietAt } from "@psyche/notifications";
import {
  type Clock,
  type MethodParams,
  type MethodResult,
  type NudgeItem,
  PsycheError,
} from "@psyche/protocol";
import { mountParamsOnly } from "./handlers.ts";
import { ownerQuietHours } from "./quiet-hours.ts";
import type { ComposedPart } from "./services.ts";

/**
 * Relationship nudges in the Gateway (docs/design/relationship-nudges-2026.md): reads the
 * settings, asks `computeNudges` what the people graph supports, hides what the owner snoozed,
 * finished or muted, and shows the rest in three places: the brief's "Keep in touch" section
 * (at most 3), silent Feed cards (at most 3 a day, never in quiet hours, never twice), and the
 * person page. Nothing is sent to anyone.
 */

export const NUDGES_ENABLED_KEY = "nudges.enabled";
export const NUDGES_CONSENT_KEY = "nudges.consentedAt";
export const NUDGES_SENSITIVITY_KEY = "nudges.sensitivity";

/** At most this many lines in the brief and new Feed cards a day. */
export const NUDGE_CAP = 3;
const REFRESH_MS = 6 * 3_600_000;
const FIRST_REFRESH_MS = 60_000;
const DAY_MS = 86_400_000;

export interface NudgeSettings {
  /** The switch is on and the owner has consented (the date is stored). */
  enabled: boolean;
  sensitivity: NudgeSensitivity;
}

/** Off by default, and off until the owner has seen the consent text and said yes. */
export function nudgeSettings(get: (key: string) => unknown): NudgeSettings {
  const sens = get(NUDGES_SENSITIVITY_KEY);
  return {
    enabled: get(NUDGES_ENABLED_KEY) === true && typeof get(NUDGES_CONSENT_KEY) === "string",
    sensitivity: sens === "low" || sens === "high" || sens === "normal" ? sens : "normal",
  };
}

export interface NudgesDeps {
  db: PsycheDb;
  clock: Clock;
  graph: GraphStore;
  /** Exclusions (§10.1) are read from here. */
  em: EverythingStore;
  timeZone: () => string;
  /** Puts a silent card in the Feed. */
  post: (card: { title: string; bodyMd: string; nudgeId: string }) => void;
  /** Milliseconds between refreshes (default 6 hours); 0 turns the timer off (tests). */
  refreshMs?: number;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
}

type Handlers = {
  "nudges.list"(p: MethodParams<"nudges.list">): Promise<MethodResult<"nudges.list">>;
  "nudges.act"(p: MethodParams<"nudges.act">): Promise<MethodResult<"nudges.act">>;
  "nudges.mute"(p: MethodParams<"nudges.mute">): Promise<MethodResult<"nudges.mute">>;
};

export interface Nudges {
  readonly handlers: Handlers;
  /** The brief's "Keep in touch" lines: at most three, best first. */
  keepInTouch(): { text: string; link: string }[];
  /** Posts Feed cards for nudges not posted yet; returns how many. */
  refresh(): number;
  part(): ComposedPart;
}

const personLink = (entityId: string) => `/agent/soul?entity=${encodeURIComponent(entityId)}`;

const titleOf = (n: Nudge): string =>
  n.kind === "unanswered"
    ? `Reply to ${n.name}?`
    : n.kind === "drift"
      ? `Catch up with ${n.name}`
      : n.kind === "birthday"
        ? `Coming up with ${n.name}`
        : `A promise to ${n.name}`;

const toItem = (n: Nudge): NudgeItem => ({
  id: n.id,
  kind: n.kind,
  entityId: n.entityId,
  name: n.name,
  text: n.text,
  daysAgo: n.daysAgo,
  channel: n.channel,
  date: n.date,
  overdue: n.overdue,
});

export function composeNudges(deps: NudgesDeps): Nudges {
  const { db, clock, graph } = deps;
  const settings = () => nudgeSettings((key) => getSetting(db, key)?.value);
  const state = new NudgeState(
    {
      get: (key) => getSetting(db, key)?.value,
      set: (key, value) => void setSetting(db, key, value),
    },
    () => clock.now(),
  );
  /** Everything the data supports, before snooze, done and mute. */
  const all = (): Nudge[] =>
    computeNudges(graph, {
      now: clock.now(),
      timeZone: deps.timeZone(),
      sensitivity: settings().sensitivity,
      isExcluded: (id) => deps.em.isEntityExcluded(id),
    });
  /** What to show now. Empty while the feature is off or unconsented. */
  const current = (): Nudge[] => (settings().enabled ? state.visible(all()) : []);

  const handlers: Handlers = {
    async "nudges.list"(p) {
      const enabled = settings().enabled;
      const items = current().filter((n) => p.entityId === undefined || n.entityId === p.entityId);
      return {
        enabled,
        items: items.map(toItem),
        muted: p.entityId !== undefined && state.isMuted(p.entityId),
      };
    },
    async "nudges.act"(p) {
      const nudge = all().find((n) => n.id === p.id);
      if (p.action === "mute_person") {
        if (nudge === undefined) throw new PsycheError("not_found", "that nudge is gone");
        state.mute(nudge.entityId);
        return { ok: true };
      }
      // A card for a nudge that has since gone away can still be put away.
      if (p.action === "done") {
        state.done(p.id);
        if (nudge?.loopId != null) {
          try {
            graph.updateLoop(nudge.loopId, { status: "done", closedBy: "owner" });
          } catch {
            // The promise was already closed or removed: nothing left to do.
          }
        }
      } else state.snooze(p.id, p.action === "snooze_week" ? 7 : 30);
      return { ok: true };
    },
    async "nudges.mute"(p) {
      if (graph.getEntity(p.entityId) === undefined)
        throw new PsycheError("not_found", "no such person");
      if (p.muted) state.mute(p.entityId);
      else state.unmute(p.entityId);
      return { ok: true };
    },
  };

  const refresh = (): number => {
    if (!settings().enabled) return 0;
    const now = clock.now();
    const quiet = ownerQuietHours(db, deps.timeZone);
    if (quiet !== null && isQuietAt(quiet, now)) return 0;
    let room = NUDGE_CAP - state.postedSince(now - DAY_MS);
    let posted = 0;
    for (const n of current()) {
      if (room <= 0) break;
      if (state.wasPosted(n.id)) continue;
      deps.post({ title: titleOf(n), bodyMd: n.text, nudgeId: n.id });
      state.markPosted(n.id);
      room--;
      posted++;
    }
    return posted;
  };

  return {
    handlers,
    keepInTouch: () =>
      current()
        .slice(0, NUDGE_CAP)
        .map((n) => ({ text: n.text, link: personLink(n.entityId) })),
    refresh,
    part() {
      let first: NodeJS.Timeout | undefined;
      let timer: NodeJS.Timeout | undefined;
      const safe = () => {
        try {
          refresh();
        } catch (err) {
          deps.logger?.log("warn", "relationship nudges refresh failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };
      return {
        handlers: mountParamsOnly(handlers as never),
        start() {
          const every = deps.refreshMs ?? REFRESH_MS;
          if (every <= 0) return;
          first = setTimeout(safe, FIRST_REFRESH_MS);
          first.unref();
          timer = setInterval(safe, every);
          timer.unref();
        },
        stop() {
          if (first !== undefined) clearTimeout(first);
          if (timer !== undefined) clearInterval(timer);
        },
      };
    },
  };
}
