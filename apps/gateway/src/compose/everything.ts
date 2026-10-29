import { join } from "node:path";
import { getSetting, openDb, type PsycheDb } from "@psyche/db";
import {
  EverythingStore,
  everythingNightlyStep,
  type GraphStore,
  type ItemReader,
  localMinutesAt,
  type NightlyStep,
  type PassDeps,
  SearchDocReader,
} from "@psyche/memory";
import {
  type Clock,
  EVERYTHING_MEMORY_DEFAULTS,
  EVERYTHING_MEMORY_SETTING_KEY,
  EverythingMemorySettings,
  type MethodParams,
  type MethodResult,
  type ModelProvider,
  type ModelRef,
  PsycheError,
} from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { readSystemState } from "./everything-probe.ts";
import { mountParamsOnly } from "./handlers.ts";
import type { ComposedPart } from "./services.ts";

/**
 * Everything memory in the Gateway (docs/design/everything-memory-2026.md §6, §7): the review and
 * quarantine handlers, and the nightly pass as a step of the dreaming automation. The dreaming
 * window is the existing 03:00 schedule, inside the default quiet hours (01:00-06:00); the pass
 * itself checks AC power, Low Power Mode, temperature, idle time and quiet hours, so a Mac on
 * battery or in use simply waits for the next night. The model is None until the owner picks one;
 * a local model also needs the owner to have confirmed its RAM warning.
 */

const ANNOUNCE_CURSOR = "everything:announce";
export const REVIEW_LINK = "/settings/memory";
const BRIEF_WINDOW_MS = 36 * 3_600_000;

interface Announcement {
  at: number;
  autoAccepted: number;
  toReview: number;
  quarantined: number;
}

const summaryLine = (a: Announcement): string =>
  `${a.autoAccepted} auto-accepted · ${a.toReview} to review · ${a.quarantined} quarantined`;

export const EVERYTHING_LOCAL_CONFIRMED = `${EVERYTHING_MEMORY_SETTING_KEY}.localConfirmed`;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function merge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

/**
 * `memory.everything` with its defaults filled in. A stored value that does not fit the schema
 * is ignored whole and the feature reads as off: a bad setting never turns reading on.
 */
export function everythingSettings(value: unknown): EverythingMemorySettings {
  const merged = merge(structuredClone(EVERYTHING_MEMORY_DEFAULTS), value);
  if (Value.Check(EverythingMemorySettings, merged)) return merged;
  return {
    ...(structuredClone(EVERYTHING_MEMORY_DEFAULTS) as EverythingMemorySettings),
    enabled: false,
  };
}

type EverythingMethod =
  | "memory.review.list"
  | "memory.review.decide"
  | "memory.review.undo"
  | "memory.quarantine.list"
  | "memory.quarantine.decide"
  | "memory.runs.list"
  | "memory.exclusions.list"
  | "memory.exclusions.add"
  | "memory.exclusions.remove";
type ReviewParams<M extends EverythingMethod> = MethodParams<M>;
type ReviewResult<M extends EverythingMethod> = MethodResult<M>;

export interface EverythingHandlers {
  "memory.review.list"(
    p: ReviewParams<"memory.review.list">,
  ): Promise<ReviewResult<"memory.review.list">>;
  "memory.review.decide"(
    p: ReviewParams<"memory.review.decide">,
  ): Promise<ReviewResult<"memory.review.decide">>;
  "memory.review.undo"(
    p: ReviewParams<"memory.review.undo">,
  ): Promise<ReviewResult<"memory.review.undo">>;
  "memory.quarantine.list"(
    p: ReviewParams<"memory.quarantine.list">,
  ): Promise<ReviewResult<"memory.quarantine.list">>;
  "memory.quarantine.decide"(
    p: ReviewParams<"memory.quarantine.decide">,
  ): Promise<ReviewResult<"memory.quarantine.decide">>;
  "memory.runs.list"(
    p: ReviewParams<"memory.runs.list">,
  ): Promise<ReviewResult<"memory.runs.list">>;
  "memory.exclusions.list"(
    p: ReviewParams<"memory.exclusions.list">,
  ): Promise<ReviewResult<"memory.exclusions.list">>;
  "memory.exclusions.add"(
    p: ReviewParams<"memory.exclusions.add">,
  ): Promise<ReviewResult<"memory.exclusions.add">>;
  "memory.exclusions.remove"(
    p: ReviewParams<"memory.exclusions.remove">,
  ): Promise<ReviewResult<"memory.exclusions.remove">>;
}

const PAGE = 50;

export function everythingHandlers(
  em: EverythingStore,
  settings: () => EverythingMemorySettings = () => everythingSettings(undefined),
): EverythingHandlers {
  const offsetOf = (cursor: string | undefined): number => {
    const n = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };
  return {
    async "memory.review.list"(p) {
      const offset = offsetOf(p.cursor);
      const limit = Math.min(p.limit ?? PAGE, 200);
      const page = em.reviewItems({
        ...(p.state === undefined ? {} : { states: p.state }),
        ...(p.entityId === undefined ? {} : { entityId: p.entityId }),
        limit,
        offset,
      });
      return {
        items: page.items,
        counts: em.reviewCounts(),
        nextCursor:
          offset + page.items.length < page.total ? String(offset + page.items.length) : null,
      };
    },
    async "memory.review.decide"(p) {
      if (p.decision === "edit" && (p.value === undefined || p.factIds.length !== 1)) {
        throw new PsycheError("invalid_params", "an edit needs one fact and a value");
      }
      const facts = [];
      for (const id of p.factIds) {
        facts.push(
          em.decide(id, p.decision, {
            ...(p.value === undefined ? {} : { value: p.value }),
            ...(p.never === undefined ? {} : { never: p.never }),
          }),
        );
      }
      return { facts };
    },
    async "memory.review.undo"(p) {
      return { fact: em.undo(p.factId) };
    },
    async "memory.quarantine.list"(p) {
      const offset = offsetOf(p.cursor);
      const limit = Math.min(p.limit ?? PAGE, 200);
      const page = em.quarantined({
        ...(p.includeDecided === undefined ? {} : { includeDecided: p.includeDecided }),
        limit,
        offset,
      });
      return {
        items: page.items,
        nextCursor:
          offset + page.items.length < page.total ? String(offset + page.items.length) : null,
      };
    },
    async "memory.quarantine.decide"(p) {
      return { item: em.decideQuarantine(p.id, p.action) };
    },
    async "memory.runs.list"(p) {
      return { runs: em.runs(p.limit ?? 14) };
    },
    async "memory.exclusions.list"() {
      return {
        entries: em
          .exclusions()
          .filter((e) => e.kind === "email" || e.kind === "phone" || e.kind === "domain")
          .map((e) => ({
            id: e.id,
            kind: e.kind as "email" | "phone" | "domain",
            hint: e.hint,
            mode: e.mode,
            createdAt: e.createdAt,
          })),
        defaultPeople: settings().people.default,
      };
    },
    async "memory.exclusions.add"(p) {
      const mode = p.mode ?? "exclude";
      const { entry, forgotten } = em.excludeIdentifier(p.kind, p.value, mode, p.dryRun === true);
      const found = entry ?? {
        id: "",
        kind: p.kind,
        hint: null,
        mode,
        createdAt: new Date().toISOString(),
      };
      return {
        entry: {
          id: found.id,
          kind: p.kind,
          hint: found.hint,
          mode: found.mode,
          createdAt: found.createdAt,
        },
        forgotten,
      };
    },
    async "memory.exclusions.remove"(p) {
      return { removed: em.removeExclusionById(p.id) };
    },
  };
}

export interface EverythingDeps {
  db: PsycheDb;
  clock: Clock;
  graph: GraphStore;
  /** `$PSYCHE_HOME`; the search index is `<home>/state/search.sqlite`. */
  home: string;
  provider: ModelProvider;
  /** The router's utility role: the cloud model when the setting names none. */
  utility: ModelRef;
  timeZone: () => string;
  /** The machine, read once when the pass starts (tests pass fixed numbers). */
  readState?: () => Promise<PassDeps["state"]>;
  /** Posts the "Psyche learned N things" card to the Feed (no notification). */
  announce?: (card: { title: string; bodyMd: string }) => void;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
}

export interface Everything {
  readonly store: EverythingStore;
  readonly settings: () => EverythingMemorySettings;
  readonly handlers: EverythingHandlers;
  /** The nightly step, for the dreaming automation (after the lesson pass, before the graph pass). */
  readonly nightly: NightlyStep;
  /** The brief's "Learned yesterday" line, while the last run is recent and found something. */
  learnedYesterday(): { text: string; link: string } | undefined;
  part(): ComposedPart;
}

export function composeEverything(deps: EverythingDeps): Everything {
  const { db, clock, graph } = deps;
  const store = new EverythingStore({ sqlite: db.sqlite, graph, clock });
  const settings = () => everythingSettings(getSetting(db, EVERYTHING_MEMORY_SETTING_KEY)?.value);
  const handlers = everythingHandlers(store, settings);
  let search: PsycheDb | undefined;
  // A second, read-only connection to the derived index, opened on the first read (so a pass the
  // gates refuse never touches the file) and never written to.
  const reader = (): ItemReader => ({
    read(source, after, opts) {
      search ??= openDb(join(deps.home, "state", "search.sqlite"), { readonly: true });
      return new SearchDocReader(search.sqlite).read(source, after, opts);
    },
  });
  const passDeps = async (): Promise<PassDeps> => {
    const s = settings();
    const zone = deps.timeZone();
    const refOf = (kind: "cloud" | "local", source: string): ModelRef | undefined => {
      const per = (
        s.model.perSource as Record<string, { kind: string; ref?: string }> | undefined
      )?.[source];
      const choice = per !== undefined && per.kind === kind ? per : s.model.default;
      if (choice.kind !== kind) return undefined;
      // A cloud choice with no named model uses the router's utility role; a local one must be named.
      return (choice.ref as ModelRef | undefined) ?? (kind === "cloud" ? deps.utility : undefined);
    };
    const defaultLocal = s.model.default.kind === "local" ? s.model.default.ref : undefined;
    return {
      graph,
      em: store,
      sqlite: db.sqlite,
      reader: reader(),
      settings: s,
      state: await (deps.readState ?? readSystemState)(),
      clock,
      timeZone: zone,
      localMinutes: localMinutesAt(clock.now(), zone),
      modelFor: (kind, source) => {
        const model = refOf(kind, source);
        return model === undefined ? undefined : { provider: deps.provider, model };
      },
      // The owner confirms the RAM warning for one named model; changing it asks again.
      localModelConfirmed:
        defaultLocal !== undefined &&
        getSetting(db, EVERYTHING_LOCAL_CONFIRMED)?.value === defaultLocal,
    };
  };
  const nightly: NightlyStep = async () => {
    const s = settings();
    // Off, or no model chosen: nothing is read and nothing is opened.
    if (!s.enabled) return undefined;
    try {
      return await everythingNightlyStep(passDeps, (report) => {
        if (report.runId === undefined) return;
        const sum = store.runSummary(report.runId);
        const learned = sum.autoAccepted + sum.toReview;
        if (learned + sum.quarantined === 0) return;
        graph.setCursor(ANNOUNCE_CURSOR, { at: clock.now(), ...sum } satisfies Announcement);
        // Counts only: no fact text reaches the Feed card or the brief.
        deps.announce?.({
          title: `Psyche learned ${learned} ${learned === 1 ? "thing" : "things"}`,
          bodyMd: `${summaryLine({ at: 0, ...sum })}\n\n[Review](${REVIEW_LINK})`,
        });
      })();
    } catch (err) {
      deps.logger?.log("warn", "everything memory pass failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  };
  return {
    store,
    settings,
    handlers,
    nightly,
    learnedYesterday() {
      const a = graph.cursor(ANNOUNCE_CURSOR) as Announcement | undefined;
      if (a === undefined || clock.now() - a.at > BRIEF_WINDOW_MS) return undefined;
      const learned = a.autoAccepted + a.toReview;
      return {
        text: `Psyche learned ${learned} ${learned === 1 ? "thing" : "things"} yesterday: ${summaryLine(a)}`,
        link: REVIEW_LINK,
      };
    },
    part() {
      return {
        handlers: mountParamsOnly(handlers as never),
        stop() {
          search?.sqlite.close();
          search = undefined;
        },
      };
    },
  };
}
