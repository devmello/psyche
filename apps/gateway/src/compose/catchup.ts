import { getSetting, type PsycheDb } from "@psyche/db";
import {
  type AgentMemoryAccess,
  CatchUpState,
  dueNotice,
  type EverythingStore,
  type GraphStore,
  gatherCandidates,
  isWorkKind,
  pendingCounts,
  pendingText,
  rankCatchUp,
  resolveSurfaceSettings,
  startOfDay,
  surfaceFilter,
  visibleToAgent,
  workedOnToday,
} from "@psyche/memory";
import {
  type BriefSurface,
  type DailyCatchUp,
  dailyMarkdown,
  type StoredPost,
} from "@psyche/proactive";
import {
  type Clock,
  type MemorySurfacesSettings,
  type MethodParams,
  type MethodResult,
  PsycheError,
} from "@psyche/protocol";
import type { HandlerDef } from "../context.ts";
import { mountParamsOnly } from "./handlers.ts";

/**
 * Catching up in the Gateway (docs/design/memory-everything-2026.md §5, MW4): the
 * `memory.catchup.*` methods, the brief's "Catching up" and wrap-up "Worked on today", the opt-in
 * due-soon notification, and what the agent may read of the brief. All of it is code over the
 * graph store: no model, nothing leaves the Mac. Every surface reads through `surfaceFilter`.
 */

export const WORK_SETTING_KEY = "memory.work";
export const SURFACES_SETTING_KEY = "memory.surfaces";
/** "All work due ›" on the Memory page. */
export const WORK_DUE_ROUTE = "/memory?kind=due";
export const REVIEW_ROUTE = "/memory/review";

const entityLink = (id: string) => `/memory?entity=${encodeURIComponent(id)}`;
const DAY_MS = 86_400_000;

export interface WorkSettings {
  /** Work memory is on (after the owner's consent card). Everything below is moot while off. */
  enabled: boolean;
  remind: {
    /** Due-soon notification: off by default (W4). */
    enabled: boolean;
    dueSoonHours: number;
    /** `wrapup` or a local `HH:MM`. Only the wrap-up time is wired; any other falls back to it. */
    at: string;
    /** A separate morning "due today" message, off by default (W4). */
    dayOf: boolean;
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored object at `prefix`, with any flat `prefix.a.b` keys laid over it (the `daily.*` style). */
function layered(
  get: (key: string) => unknown,
  prefix: string,
  paths: readonly string[],
): Record<string, unknown> {
  const root = get(prefix);
  const out: Record<string, unknown> = isObj(root) ? structuredClone(root) : {};
  for (const path of paths) {
    const v = get(`${prefix}.${path}`);
    if (v === undefined) continue;
    const keys = path.split(".");
    let at = out;
    for (const k of keys.slice(0, -1)) {
      const next = at[k];
      if (isObj(next)) {
        at = next;
      } else {
        const fresh: Record<string, unknown> = {};
        at[k] = fresh;
        at = fresh;
      }
    }
    at[keys.at(-1) as string] = v;
  }
  return out;
}

/** The `memory.work` settings, every missing field at the owner's default (§9). */
export function readWorkSettings(get: (key: string) => unknown): WorkSettings {
  const raw = layered(get, WORK_SETTING_KEY, [
    "enabled",
    "remind.enabled",
    "remind.dueSoonHours",
    "remind.at",
    "remind.dayOf",
  ]);
  const remind = isObj(raw.remind) ? raw.remind : {};
  const hours = remind.dueSoonHours;
  return {
    enabled: raw.enabled === true,
    remind: {
      enabled: remind.enabled === true,
      dueSoonHours:
        typeof hours === "number" && Number.isInteger(hours) && hours >= 1 && hours <= 72
          ? hours
          : 24,
      at: typeof remind.at === "string" ? remind.at : "wrapup",
      dayOf: remind.dayOf === true,
    },
  };
}

const SWITCH_KEYS = ["home", "brief", "notification", "channel"] as const;
const SURFACE_PATHS = [
  ...["work", "workMail", "people"].flatMap((t) => SWITCH_KEYS.map((k) => `tiers.${t}.${k}`)),
  "birthdays",
  "hideSources",
  ...["project", "course", "assignment", "event"].map((k) => `kinds.${k}`),
];

/** The `memory.surfaces` settings, resolved against the §4 defaults. */
export function readSurfaceSettings(get: (key: string) => unknown): MemorySurfacesSettings {
  return resolveSurfaceSettings(layered(get, SURFACES_SETTING_KEY, SURFACE_PATHS));
}

const ENTITY_PARAM = /[?&]entity=([^&#]+)/;

/** The entity a catch-up, Coming up or Keep in touch line opens, from its link. */
export function entityOfLink(link: string | undefined): string | undefined {
  const m = link === undefined ? null : ENTITY_PARAM.exec(link);
  if (m?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}

type Handlers = {
  "memory.catchup.list"(
    p: MethodParams<"memory.catchup.list">,
  ): Promise<MethodResult<"memory.catchup.list">>;
  "memory.catchup.act"(
    p: MethodParams<"memory.catchup.act">,
  ): Promise<MethodResult<"memory.catchup.act">>;
  "memory.catchup.seen"(
    p: MethodParams<"memory.catchup.seen">,
  ): Promise<MethodResult<"memory.catchup.seen">>;
};

export interface CatchupDeps {
  db: PsycheDb;
  clock: Clock;
  graph: GraphStore;
  /** Citations, to re-check what the agent may read of a line. */
  em: Pick<EverythingStore, "citations">;
  /** What the agent may read of everything memory right now (`memory.everything.agentAccess`). */
  access: () => AgentMemoryAccess;
  timeZone: () => string;
}

export interface Catchup {
  readonly handlers: Record<string, HandlerDef>;
  /** The brief's side of work memory: `undefined` is not needed; `enabled()` says when it is on. */
  readonly daily: DailyCatchUp;
  /** Coming up, with birthdays on their own switch and life events in the people tier. */
  comingUp(
    base: (() => { text: string; link?: string }[]) | undefined,
  ): ((surface?: BriefSurface) => { text: string; link?: string }[]) | undefined;
  /** Keep in touch is the people tier: off in the brief unless the owner opened it. */
  keepInTouch(
    base: (() => { text: string; link?: string }[]) | undefined,
  ): ((surface?: BriefSurface) => { text: string; link?: string }[]) | undefined;
  /** A post as the agent may read it: catch-up lines it may not see become "1 item hidden". */
  agentView(post: StoredPost): StoredPost;
  /** The same list the handler returns, for tests and the brief. */
  list: Handlers["memory.catchup.list"];
}

const iso = (ms: number) => new Date(ms).toISOString();

function badRequest(message: string): never {
  throw new PsycheError("invalid_params", message);
}

export function composeCatchup(deps: CatchupDeps): Catchup {
  const { db, clock, graph } = deps;
  const get = (key: string) => getSetting(db, key)?.value;
  const state = new CatchUpState(graph);
  const work = () => readWorkSettings(get);
  const surfaces = () => readSurfaceSettings(get);
  const candidates = () =>
    gatherCandidates(graph, state, { now: clock.now(), timeZone: deps.timeZone() });
  const tz = () => deps.timeZone();
  const day = (now: number) => new Date(startOfDay(now, tz())).toISOString().slice(0, 10);
  /** Home and the brief carry a link; the channel copy has the same text without the mail. */
  const ranked = (surface: "home" | "brief" | "channel", limit?: number) =>
    rankCatchUp(candidates(), {
      now: clock.now(),
      timeZone: tz(),
      surface,
      settings: surfaces(),
      ...(limit === undefined ? {} : { limit }),
    });
  const pending = (surface: "home" | "brief" | "channel") => {
    if (surfaceFilter([{ tier: "work" as const }], surface, surfaces()).length === 0)
      return undefined;
    const c = pendingCounts(graph);
    return { ...c, text: pendingText(c.assignments, c.courses) };
  };

  const list: Handlers["memory.catchup.list"] = async (p) => {
    const asOf = iso(clock.now());
    if (!work().enabled) return { items: [], pendingCount: 0, hiddenCount: 0, asOf };
    const items = ranked(p.surface, p.limit).map((r) => r.item);
    const c = pending(p.surface);
    return {
      items,
      pendingCount: c === undefined ? 0 : c.assignments + c.courses,
      hiddenCount: 0,
      asOf,
    };
  };

  const handlers: Handlers = {
    "memory.catchup.list": list,

    async "memory.catchup.act"(p) {
      const id = graph.resolveMerged(p.entityId);
      const entity = graph.getEntity(id);
      if (entity === undefined || !isWorkKind(entity.kind))
        throw new PsycheError("not_found", "no such work item");
      const now = iso(clock.now());
      const needsAssignment = () => {
        if (entity.kind !== "assignment")
          badRequest("only a to-do can be handed in or dropped");
      };
      let until: string | undefined;
      if (p.until !== undefined) {
        const t = Date.parse(p.until);
        if (Number.isNaN(t)) badRequest("until must be a date and time");
        until = new Date(t).toISOString();
      }
      switch (p.action) {
        case "done":
          if (entity.kind === "assignment")
            graph.setWorkStatus(id, { type: "owner_set", to: "done" });
          else if (entity.kind === "project") graph.updateEntity(id, { projectStatus: "done" });
          // An event has no status: put it away until it has happened.
          else state.snooze(id, entity.dueAt ?? iso(clock.now() + 7 * DAY_MS), now);
          break;
        case "submitted":
          needsAssignment();
          graph.setWorkStatus(id, { type: "owner_set", to: "submitted" });
          break;
        case "drop":
          needsAssignment();
          graph.setWorkStatus(id, { type: "owner_set", to: "dropped" });
          break;
        case "snooze": {
          const to = until ?? iso(clock.now() + DAY_MS);
          if (Date.parse(to) <= clock.now()) badRequest("snooze until a time in the future");
          state.snooze(id, to, now);
          break;
        }
        case "still_working":
          // The owner's answer to "Did you finish ...?": a new due date moves it, otherwise the
          // ask comes back tomorrow. Silence never changes status.
          if (until !== undefined) graph.updateEntity(id, { dueAt: until });
          else state.snooze(id, iso(clock.now() + DAY_MS), now);
          // It also answers a "submitted?" question: the owner says it is not handed in.
          state.dismissAsks(id, now);
          break;
      }
      state.touch(id, now);
      return { entity: graph.getEntity(id) ?? entity };
    },

    async "memory.catchup.seen"(p) {
      return { seen: state.markSeen(p.entityIds, iso(clock.now())) };
    },
  };

  // --- the brief ------------------------------------------------------------------------------

  const daily: DailyCatchUp = {
    enabled: () => work().enabled,
    morning(surface) {
      const lines = ranked(surface).map((r) => ({
        text: r.item.line,
        link: entityLink(r.item.entityId),
        title: r.item.title,
      }));
      const c = pending(surface);
      return {
        lines,
        ...(c?.text === undefined ? {} : { pending: { text: c.text, link: REVIEW_ROUTE } }),
      };
    },
    evening(surface) {
      const now = clock.now();
      const cands = candidates();
      const settings = surfaces();
      const worked = workedOnToday(cands, { now, timeZone: tz(), surface, settings }).map((w) => ({
        text: w.text,
        link: entityLink(w.entityId),
        title: w.title,
      }));
      const dueTomorrow = rankCatchUp(cands, { now, timeZone: tz(), surface, settings, limit: 5 })
        .filter((r) => r.item.urgency === "today" && !r.ask)
        .map((r) => ({
          text: r.item.line,
          link: entityLink(r.item.entityId),
          title: r.item.title,
        }));
      return { worked, dueTomorrow };
    },
    notice(mode) {
      const w = work();
      if (!w.enabled) return undefined;
      if (mode === "wrapup" ? !w.remind.enabled : !w.remind.dayOf) return undefined;
      const now = clock.now();
      const today = day(now);
      if (state.lastNotified(mode) === today) return undefined;
      const n = dueNotice(candidates(), {
        now,
        timeZone: tz(),
        settings: surfaces(),
        mode,
        hours: w.remind.dueSoonHours,
      });
      if (n === undefined) return undefined;
      state.setNotified(mode, today);
      return {
        title: n.title,
        body: n.body,
        route: WORK_DUE_ROUTE,
        dedupeKey: `memory-due:${mode}:${today}`,
      };
    },
  };

  // --- the other memory lines in the brief: same one filter ------------------------------------

  /** A birthday is the birthday tier; an event inside a project is work; the rest is the people tier. */
  const tierOfLine = (link: string | undefined) => {
    const id = entityOfLink(link);
    const e = id === undefined ? undefined : graph.getEntity(id);
    if (e === undefined) return { tier: "people" as const };
    if (e.kind === "person" || e.kind === "org")
      return { tier: "birthday" as const, entityId: e.id };
    if (e.kind === "event") {
      const inWork = graph
        .edges(e.id)
        .some(
          (x) =>
            x.rel === "part_of" && x.src === e.id && graph.getEntity(x.dst)?.kind === "project",
        );
      return inWork
        ? {
            tier: "work" as const,
            kind: "event" as const,
            entityId: e.id,
            ...(e.private ? { private: true } : {}),
          }
        : { tier: "people" as const, entityId: e.id };
    }
    return { tier: "people" as const, entityId: e.id };
  };

  const channelOrBrief = (s: BriefSurface | undefined) => (s === "channel" ? "channel" : "brief");

  const comingUp: Catchup["comingUp"] = (base) =>
    base === undefined
      ? undefined
      : (surface) => {
          const lines = base().map((l) => ({ line: l, ...tierOfLine(l.link) }));
          return surfaceFilter(lines, channelOrBrief(surface), surfaces()).map((x) => x.line);
        };

  const keepInTouch: Catchup["keepInTouch"] = (base) =>
    base === undefined
      ? undefined
      : (surface) =>
          surfaceFilter([{ tier: "people" as const }], channelOrBrief(surface), surfaces())
            .length === 0
            ? []
            : base();

  // --- what the agent may read -----------------------------------------------------------------

  const agentView = (post: StoredPost): StoredPost => {
    if (post.card?.type !== "daily") return post;
    const access = deps.access();
    const byId = new Map(candidates().map((c) => [c.entityId, c]));
    const learned = deps.em;
    /** Everything memory put in the line must be something the agent may see right now. */
    const mayRead = (entityId: string): boolean => {
      if (access.mode === "none") return false;
      const e = graph.getEntity(entityId);
      if (e === undefined) return false;
      if (!graph.facts(entityId).every((f) => visibleToAgent(f, access, learned))) return false;
      return (byId.get(entityId)?.signals ?? []).every((s) => access.sourceAllowed(s.source));
    };
    let hidden = 0;
    const sections = post.card.daily.sections.map((s) => {
      let n = 0;
      const items = s.items.filter((i) => {
        const id = entityOfLink(i.link);
        if (id === undefined || mayRead(id)) return true;
        n++;
        return false;
      });
      hidden += n;
      if (n === 0) return s;
      return { ...s, items: [...items, { text: `${n} item${n === 1 ? "" : "s"} hidden` }] };
    });
    if (hidden === 0) return post;
    return {
      ...post,
      bodyMd: dailyMarkdown(sections),
      card: { type: "daily", daily: { ...post.card.daily, sections } },
    };
  };

  return {
    handlers: mountParamsOnly(handlers as never),
    daily,
    comingUp,
    keepInTouch,
    agentView,
    list,
  };
}
