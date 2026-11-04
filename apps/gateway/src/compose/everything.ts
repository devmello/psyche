import { join } from "node:path";
import { getSetting, openDb, type PsycheDb } from "@psyche/db";
import {
  type AnswerPassage,
  answerFromSources,
  describeUpcoming,
  EverythingStore,
  FactVectorStore,
  fuseLifeHits,
  type GraphStore,
  type ItemReader,
  isAppleOnDeviceRef,
  type LifeEmbedder,
  type LifeFactHit,
  lifeCandidates,
  lifeFactsForQuestion,
  lifeSearch,
  localMinutesAt,
  MAX_ANSWER_PASSAGES,
  type NightlyStep,
  type PassDeps,
  type PassReport,
  runEverythingPass,
  SearchDocReader,
  upcoming,
} from "@psyche/memory";
import {
  jobMarker,
  type LaunchResult,
  type ProactiveJob,
  parseJobMarker,
  type SchedulerLike,
} from "@psyche/proactive";
import {
  APPLE_LLM_CONTEXT_TOKENS,
  type Clock,
  EVERYTHING_MEMORY_DEFAULTS,
  EVERYTHING_MEMORY_SETTING_KEY,
  EverythingMemorySettings,
  type EverythingRunResult,
  effectiveEverythingSources,
  everythingOptOut,
  type FeedWidget,
  type GraphCitation,
  MEMORY_WORK_SETTING_KEY,
  type MethodParams,
  type MethodResult,
  type ModelProvider,
  type ModelRef,
  PsycheError,
} from "@psyche/protocol";
import { OWNER_ONLY_SOURCES, readSourcesConfig } from "@psyche/search";
import { Value } from "@sinclair/typebox/value";
import type { Call } from "../context.ts";
import type { Gateway } from "../server.ts";
import { readSystemState } from "./everything-probe.ts";
import { mountParamsOnly } from "./handlers.ts";
import {
  type AnswerViewer,
  lifePassages,
  type PassageDeps,
  type PassageSource,
} from "./life-passages.ts";
import type { ComposedPart } from "./services.ts";
import { workSettings } from "./work.ts";

/**
 * Everything memory in the Gateway (docs/design/everything-memory-2026.md §6, §7): the review and
 * quarantine handlers, and the nightly pass as a step of the dreaming automation. The dreaming
 * window is the existing 03:00 schedule, inside the default quiet hours (01:00-06:00); the pass
 * itself checks AC power, Low Power Mode, temperature, idle time and quiet hours, so a Mac on
 * battery or in use simply waits for the next night. The model is None until the owner picks one;
 * a local model also needs the owner to have confirmed its RAM warning.
 */

const ANNOUNCE_CURSOR = "everything:announce";
export const REVIEW_LINK = "/memory/review";
const BRIEF_WINDOW_MS = 36 * 3_600_000;

interface Announcement {
  at: number;
  autoAccepted: number;
  toReview: number;
  quarantined: number;
}

/**
 * The Feed card's static widget (generative-ui-2026 §8, D8): the three counts as stat tiles and a
 * button to the review screen. Counts only, so no fact text can reach the Feed; `open` is the one
 * control it needs, and a Feed snapshot draws only open and reply anyway.
 */
export function learnedSnapshot(a: Announcement): FeedWidget {
  const learned = a.autoAccepted + a.toReview;
  return {
    taint: [],
    spec: {
      v: 1,
      title: "What Psyche learned",
      fallbackText: `Psyche learned ${learned} ${learned === 1 ? "thing" : "things"}: ${summaryLine(a)}`,
      root: {
        id: "root",
        type: "stack",
        gap: "sm",
        children: [
          {
            id: "counts",
            type: "grid",
            columns: 3,
            children: [
              { id: "auto", type: "stat", label: "Added", value: a.autoAccepted },
              { id: "review", type: "stat", label: "To review", value: a.toReview },
              { id: "held", type: "stat", label: "Held back", value: a.quarantined },
            ],
          },
          {
            id: "open",
            type: "button",
            label: "Review what was learned",
            action: { kind: "open", route: REVIEW_LINK },
          },
        ],
      },
    },
  };
}

const summaryLine = (a: Announcement): string =>
  `${a.autoAccepted} auto-accepted · ${a.toReview} to review · ${a.quarantined} quarantined`;

const JOB = "everything-memory";
/** After dreaming (03:00), inside the default quiet hours (01:00-06:00). */
export const NIGHTLY_CRON = "15 3 * * *";

const emptyReport = (): PassReport => ({
  ran: false,
  itemsRead: 0,
  itemsFiltered: 0,
  batches: 0,
  tokensIn: 0,
  tokensOut: 0,
  factsStored: 0,
  edgesStored: 0,
  dropped: {},
  quarantined: 0,
  deferred: 0,
  ownerProposals: [],
  workUpdates: 0,
  suggestionsStored: 0,
  error: null,
});

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
 *
 * Memory follows Search (everything-memory-2026 §8): `sources` is not the stored switches but the
 * sources memory learns from, indexed && !optOut. `indexed` is the sources Search reads; leave it
 * out and nothing counts as indexed, so a caller that forgot it reads nothing. Browser pages and
 * chats are never in it. A value stored before `optOut` existed is migrated (a switch that was
 * explicitly off is an opt-out) by `everythingOptOut`.
 */
export function everythingSettings(
  value: unknown,
  indexed: Iterable<string> = [],
): EverythingMemorySettings {
  const merged = merge(structuredClone(EVERYTHING_MEMORY_DEFAULTS), value);
  if (!Value.Check(EverythingMemorySettings, merged)) {
    return {
      ...(structuredClone(EVERYTHING_MEMORY_DEFAULTS) as EverythingMemorySettings),
      enabled: false,
    };
  }
  const optOut = everythingOptOut(value);
  return { ...merged, optOut, sources: effectiveEverythingSources(optOut, indexed) };
}

/** The sources Search reads now (switched on in Settings → Search sources). */
export function indexedSources(db: PsycheDb): string[] {
  const cfg = readSourcesConfig(getSetting(db, "search.sources")?.value);
  return Object.entries(cfg.sources)
    .filter(([, c]) => c.enabled)
    .map(([id]) => id);
}

type EverythingMethod =
  | "memory.review.list"
  | "memory.review.decide"
  | "memory.review.undo"
  | "memory.work.undoUpdate"
  | "memory.quarantine.list"
  | "memory.quarantine.decide"
  | "memory.runs.list"
  | "memory.exclusions.list"
  | "memory.exclusions.add"
  | "memory.exclusions.remove"
  | "memory.everything.run"
  | "memory.senders.list"
  | "memory.senders.decide"
  | "memory.upcoming"
  | "memory.life.search"
  | "memory.life.answer"
  | "memory.entities.export"
  | "memory.entities.forgetSaid"
  | "memory.entities.exclude";
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
  "memory.work.undoUpdate"(
    p: ReviewParams<"memory.work.undoUpdate">,
  ): Promise<ReviewResult<"memory.work.undoUpdate">>;
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
  "memory.everything.run"(
    p: ReviewParams<"memory.everything.run">,
  ): Promise<ReviewResult<"memory.everything.run">>;
  "memory.senders.list"(
    p: ReviewParams<"memory.senders.list">,
  ): Promise<ReviewResult<"memory.senders.list">>;
  "memory.senders.decide"(
    p: ReviewParams<"memory.senders.decide">,
  ): Promise<ReviewResult<"memory.senders.decide">>;
  "memory.upcoming"(p: ReviewParams<"memory.upcoming">): Promise<ReviewResult<"memory.upcoming">>;
  "memory.life.search"(
    p: ReviewParams<"memory.life.search">,
  ): Promise<ReviewResult<"memory.life.search">>;
  "memory.life.answer"(
    p: ReviewParams<"memory.life.answer">,
    /** Who asks; absent is the most restricted viewer (no passages, nothing owner-only). */
    viewer?: AnswerViewer,
  ): Promise<ReviewResult<"memory.life.answer">>;
  "memory.entities.export"(
    p: ReviewParams<"memory.entities.export">,
  ): Promise<ReviewResult<"memory.entities.export">>;
  "memory.entities.forgetSaid"(
    p: ReviewParams<"memory.entities.forgetSaid">,
  ): Promise<ReviewResult<"memory.entities.forgetSaid">>;
  "memory.entities.exclude"(
    p: ReviewParams<"memory.entities.exclude">,
  ): Promise<ReviewResult<"memory.entities.exclude">>;
}

/** What the person-page methods need beyond the store. */
export interface PersonContext {
  graph: GraphStore;
  clock: Clock;
  /** The graph database, for the Life search scan. */
  db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } };
  timeZone: () => string;
  /** The person's card file, when one exists, for the export. */
  card?: (path: string) => Promise<string | undefined>;
  /** The embedder search uses now, if any: ranks Life search by meaning too. */
  embedder?: () => LifeEmbedder | undefined;
  /** Stored fact vectors (`graph_fact_vectors`), so only new or changed facts are embedded. */
  vectors?: FactVectorStore;
  /** The model that may answer a question about people (off, or an unconfirmed local one: none). */
  answerModel?: () => { provider: ModelProvider; model: ModelRef } | undefined;
  /** Raw source passages for an answer (late-bound: the index is composed after this). */
  passages?: () => PassageSource | undefined;
}

const PAGE = 50;

const RESTRICTED_VIEWER: AnswerViewer = { passages: false, desktop: false };

const ownerOnly = (x: string | null | undefined): boolean =>
  x != null && (OWNER_ONLY_SOURCES as readonly string[]).includes(x.split(":")[0] ?? "");

/**
 * A fact as this connection may be shown it. A connection other than the desktop app cannot open
 * Messages, Contacts or Memory passages (`search.document`), so a fact that rests on one is left
 * out of its answer, and a source link it cannot open is not sent.
 */
function forViewer(h: LifeFactHit, viewer: AnswerViewer): LifeFactHit | undefined {
  if (viewer.desktop) return h;
  if (ownerOnly(h.source) || ownerOnly(h.docId)) return undefined;
  const docIds = (h.docIds ?? []).filter((d) => !ownerOnly(d));
  return { ...h, docIds };
}

export function everythingHandlers(
  em: EverythingStore,
  settings: () => EverythingMemorySettings = () => everythingSettings(undefined),
  run: () => Promise<ReviewResult<"memory.everything.run">> = async () => ({
    ran: false,
    reason: "disabled",
    itemsRead: 0,
    factsProposed: 0,
    quarantined: 0,
    deferred: 0,
    tokens: 0,
  }),
  person?: PersonContext,
): EverythingHandlers {
  /** The owner is never excluded or forgotten from their own memory: that would blind it. */
  const notOwner = (raw: string): string => {
    const g = needPerson().graph;
    const id = g.resolveMerged(raw);
    if (g.getEntity(id)?.isOwner === true) {
      throw new PsycheError("invalid_params", "that is you, not someone to exclude");
    }
    return id;
  };
  const needPerson = (): PersonContext => {
    if (person === undefined) throw new PsycheError("unavailable", "the people graph is not ready");
    return person;
  };
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
    async "memory.work.undoUpdate"(p) {
      return { status: em.undoChatWork(p.factId) };
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
    async "memory.life.search"(p) {
      const ctx = needPerson();
      const now = ctx.clock.now();
      const limit = p.limit ?? 20;
      const found = lifeSearch(ctx.graph, em, ctx.db, p.q, { limit, now });
      const embedder = ctx.embedder?.();
      if (embedder === undefined || found.intent !== null) return found;
      const facts = await fuseLifeHits(
        p.q,
        found.facts,
        lifeCandidates(ctx.graph, em, ctx.db, now),
        embedder,
        limit,
        undefined,
        ctx.vectors,
      );
      return { ...found, facts };
    },
    async "memory.life.answer"(p, viewer = RESTRICTED_VIEWER) {
      const ctx = needPerson();
      const now = ctx.clock.now();
      const model = ctx.answerModel?.();
      if (model === undefined) return { answer: null, facts: [], passages: [], reason: "no_model" };
      const lexical = lifeFactsForQuestion(ctx.graph, em, ctx.db, p.q, { limit: 20, now });
      const candidates = lifeCandidates(ctx.graph, em, ctx.db, now);
      const fused = await fuseLifeHits(
        p.q,
        lexical,
        candidates,
        ctx.embedder?.(),
        12,
        undefined,
        ctx.vectors,
      );
      // A follow-up keeps the facts its earlier answer cited: read again, under this
      // connection's rules, never taken from what the client sent back.
      const prev = p.previous;
      const earlier =
        prev === undefined
          ? []
          : candidates
              .filter((c) => !c.sensitive && prev.factIds.includes(c.hit.factId))
              .map((c) => c.hit);
      const seen = new Set<string>();
      const hits = [...earlier, ...fused].flatMap((h) => {
        if (seen.has(h.factId)) return [];
        seen.add(h.factId);
        const shown = forViewer(h, viewer);
        return shown === undefined ? [] : [shown];
      });
      const source = p.passages === true && viewer.passages ? ctx.passages?.() : undefined;
      let passages: AnswerPassage[] = [];
      if (source !== undefined) {
        const seenIds = new Set<string>();
        const lists = [
          source.byIds(prev?.passageIds ?? [], p.q, viewer),
          await source.search(p.q, viewer, MAX_ANSWER_PASSAGES),
          // "and what about his sister?" reads better next to the question before it.
          ...(prev === undefined
            ? []
            : [await source.search(`${prev.q} ${p.q}`.slice(0, 500), viewer, MAX_ANSWER_PASSAGES)]),
        ];
        passages = lists.flat().filter((x) => !seenIds.has(x.id) && seenIds.add(x.id));
      }
      const r = await answerFromSources({
        ...model,
        question: p.q,
        hits,
        passages,
        ...(prev === undefined ? {} : { prior: { question: prev.q, answer: prev.answer } }),
        exclude: new Set(candidates.filter((c) => c.sensitive).map((c) => c.hit.factId)),
      });
      return r.answer === null
        ? { answer: null, facts: [], passages: [], reason: r.reason }
        : {
            answer: r.answer,
            facts: r.facts,
            passages: r.passages.map((x) => ({
              id: x.id,
              source: x.source,
              title: x.title.slice(0, 200),
              createdAt: Math.max(0, Math.trunc(x.createdAt)),
            })),
            reason: null,
          };
    },
    async "memory.everything.run"() {
      return run();
    },
    async "memory.upcoming"(p) {
      const ctx = needPerson();
      const now = ctx.clock.now();
      const items = upcoming(ctx.graph, {
        now,
        days: p.days ?? 14,
        timeZone: ctx.timeZone(),
        ...(p.entityId === undefined ? {} : { entityId: p.entityId }),
      });
      return {
        items: items.map((i) => ({
          entityId: i.entityId,
          name: i.name,
          kind: i.kind,
          date: i.date,
          daysAway: i.daysAway,
          turns: i.turns,
          lastContactAt: i.lastContactAt,
          text: describeUpcoming(i, now),
        })),
      };
    },
    async "memory.entities.export"(p) {
      const ctx = needPerson();
      const entity = ctx.graph.getEntity(ctx.graph.resolveMerged(p.id));
      if (entity === undefined) throw new PsycheError("not_found", "no such person");
      const card =
        entity.cardPath != null && ctx.card !== undefined
          ? await ctx.card(entity.cardPath)
          : undefined;
      const { filename, data } = em.exportPersonZip(
        entity.id,
        card === undefined ? {} : { "card.md": card },
      );
      return {
        filename,
        mime: "application/zip" as const,
        data: Buffer.from(data).toString("base64"),
        bytes: data.byteLength,
      };
    },
    async "memory.entities.forgetSaid"(p) {
      const id = notOwner(p.id);
      const r = em.forgetWhatTheySaid(id, p.dryRun === true);
      return {
        removed: {
          facts: r.facts,
          edges: r.edges,
          citations: r.citations,
          quarantine: r.quarantine,
        },
        dryRun: r.dryRun,
      };
    },
    async "memory.entities.exclude"(p) {
      const id = notOwner(p.id);
      if (p.dryRun === true) {
        const r = em.forgetWhatTheySaid(id, true);
        const n = needPerson().graph.identifiers(id).length;
        return {
          excluded: n,
          removed:
            p.mode === "forget"
              ? { facts: r.facts, edges: r.edges, citations: r.citations, quarantine: r.quarantine }
              : { facts: 0, edges: 0, citations: 0, quarantine: 0 },
          dryRun: true,
        };
      }
      const before = p.mode === "forget" ? em.forgetWhatTheySaid(id, true) : undefined;
      const excluded = em.excludeEntity(id, p.mode);
      return {
        excluded,
        removed: {
          facts: before?.facts ?? 0,
          edges: before?.edges ?? 0,
          citations: before?.citations ?? 0,
          quarantine: before?.quarantine ?? 0,
        },
        dryRun: false,
      };
    },
    async "memory.senders.list"() {
      return { senders: em.senderTrust(settings().review.perSenderAutoAcceptAfter) };
    },
    async "memory.senders.decide"(p) {
      em.decideSender(p.entityId, p.decision);
      return { senders: em.senderTrust(settings().review.perSenderAutoAcceptAfter) };
    },
    async "memory.exclusions.remove"(p) {
      return { removed: em.removeExclusionById(p.id) };
    },
  };
}

export interface EverythingDeps {
  db: PsycheDb;
  /** Where everything memory lives when it is not `db.sqlite` (the encrypted store). */
  memorySqlite?: PsycheDb["sqlite"];
  /** False while that store is closed: the pass does not run and says why. */
  memoryReady?: () => boolean;
  clock: Clock;
  graph: GraphStore;
  /** `$PSYCHE_HOME`; the search index is `<home>/state/search.sqlite`. */
  home: string;
  provider: ModelProvider;
  /** The router's utility role: the cloud model when the setting names none. */
  utility: ModelRef;
  timeZone: () => string;
  /** Reads a person's card file for their export. */
  card?: (path: string) => Promise<string | undefined>;
  /** The embedder Search uses now (late-bound), for Life search by meaning. */
  embedder?: () => LifeEmbedder | undefined;
  /** The search index and what it needs to read passages for an answer (late-bound, like the embedder). */
  passageIndex?: () => Pick<PassageDeps, "index" | "document" | "cloudBlocked"> | undefined;
  /** The machine, read once when the pass starts (tests pass fixed numbers). */
  readState?: () => Promise<PassDeps["state"]>;
  /** Posts the "Psyche learned N things" card to the Feed (no notification). */
  announce?: (card: { title: string; bodyMd: string; widget?: FeedWidget }) => void;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
}

/** What one connection may see of a review item's citations (`scrubCitations`); see `useCitationScrub`. */
export type CitationScrub = (call: Call, citations: GraphCitation[]) => GraphCitation[];

export interface Everything {
  /**
   * Binds the per-connection rule for citations in `memory.review.list`. Until it is bound every
   * citation loses its `docId` and the quote of an owner-only source.
   */
  useCitationScrub(scrub: CitationScrub): void;
  readonly store: EverythingStore;
  readonly settings: () => EverythingMemorySettings;
  readonly handlers: EverythingHandlers;
  /** The model the owner chose, or none (off, or a local one not confirmed yet). */
  readonly answerModel: () => { provider: ModelProvider; model: ModelRef } | undefined;
  /** The nightly step, for the dreaming automation (after the lesson pass, before the graph pass). */
  readonly nightly: NightlyStep;
  /** The scheduled job (matched by its marker) for the launcher chain. */
  readonly job: ProactiveJob;
  /** "Run now": same pass and limits, minus quiet hours and idle time. */
  runNow(): Promise<EverythingRunResult>;
  /** The brief's "Learned yesterday" line, while the last run is recent and found something. */
  learnedYesterday(): { text: string; link: string } | undefined;
  /** "Coming up" lines for the morning brief: birthdays, anniversaries and events, 14 days. */
  comingUp(): { text: string; link?: string }[];
  part(scheduler?: SchedulerLike, timezone?: string): ComposedPart;
}

export function composeEverything(deps: EverythingDeps): Everything {
  const { db, clock, graph } = deps;
  /** Fail closed until Search is bound: no document ids, and no quote of an owner-only source. */
  let citationScrub: CitationScrub = (_call, citations) =>
    citations.map((c) => ({
      ...c,
      docId: null,
      ...(["messages", "contacts"].includes(c.source) ? { quote: "", sourceRef: "" } : {}),
    }));
  const memorySql = deps.memorySqlite ?? db.sqlite;
  const store = new EverythingStore({ sqlite: memorySql, graph, clock });
  const vectors = new FactVectorStore(memorySql);
  // Read on every call, so a Search or Memory switch applies to the next pass at once.
  const settings = () =>
    everythingSettings(getSetting(db, EVERYTHING_MEMORY_SETTING_KEY)?.value, indexedSources(db));
  let runNowFn: () => Promise<EverythingRunResult> = async () => {
    throw new PsycheError("unavailable", "everything memory is not ready");
  };
  const answerModel = (): { provider: ModelProvider; model: ModelRef } | undefined => {
    const s = settings();
    const choice = s.model.default;
    if (!s.enabled || choice.kind === "none") return undefined;
    if (choice.kind === "cloud")
      return {
        provider: deps.provider,
        model: (choice.ref as ModelRef | undefined) ?? deps.utility,
      };
    const raw = getSetting(db, EVERYTHING_LOCAL_CONFIRMED)?.value;
    const confirmed = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
    return choice.ref !== undefined && confirmed.includes(choice.ref)
      ? { provider: deps.provider, model: choice.ref as ModelRef }
      : undefined;
  };
  const handlers = everythingHandlers(store, settings, () => runNowFn(), {
    graph,
    clock,
    db: memorySql,
    vectors,
    timeZone: deps.timeZone,
    ...(deps.card === undefined ? {} : { card: deps.card }),
    ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
    answerModel,
    passages: () => {
      const idx = deps.passageIndex?.();
      return idx === undefined
        ? undefined
        : lifePassages({
            ...idx,
            cloud: () => settings().model.default.kind === "cloud",
            sensitive: () => settings().sensitive,
          });
    },
  });
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
    // Every local model a source would load must be named and confirmed (the default's, and each
    // per-source override's); one name or a list is stored.
    const confirmedRaw = getSetting(db, EVERYTHING_LOCAL_CONFIRMED)?.value;
    const confirmed = new Set(
      typeof confirmedRaw === "string"
        ? [confirmedRaw]
        : Array.isArray(confirmedRaw)
          ? confirmedRaw.filter((x): x is string => typeof x === "string")
          : [],
    );
    const perSource = s.model.perSource as
      | Record<string, { kind: string; ref?: string }>
      | undefined;
    const localRefs = Object.entries(s.sources)
      .filter(([, on]) => on)
      .map(([src]) => perSource?.[src] ?? s.model.default)
      // Apple's model is the system's: no download, no RAM to warn about, nothing to confirm.
      .filter((c) => c.kind === "local" && !isAppleOnDeviceRef(c.ref))
      .map((c) => c.ref);
    return {
      graph,
      em: store,
      sqlite: memorySql,
      reader: reader(),
      settings: s,
      state: await (deps.readState ?? readSystemState)(),
      clock,
      timeZone: zone,
      localMinutes: localMinutesAt(clock.now(), zone),
      modelFor: (kind, source) => {
        const model = refOf(kind, source);
        if (model === undefined) return undefined;
        // Apple's on-device model has a small window; the router pins a concrete ref (no
        // fallbacks), and a refusal makes the batch do nothing instead of asking another model.
        return isAppleOnDeviceRef(model)
          ? { provider: deps.provider, model, window: { contextTokens: APPLE_LLM_CONTEXT_TOKENS } }
          : { provider: deps.provider, model };
      },
      // The owner confirms the RAM warning for one named model; changing it asks again.
      localModelConfirmed: localRefs.every((r) => r !== undefined && confirmed.has(r)),
      // Work in the owner's notes only with their work-tracking consent.
      workConsent: workSettings(getSetting(db, MEMORY_WORK_SETTING_KEY)?.value).enabled,
    };
  };
  // One pass at a time: the scheduled run, "Run now" and a retry never overlap.
  let running = false;
  const afterReport = (report: PassReport) => {
    if (report.runId === undefined) return;
    const sum = store.runSummary(report.runId);
    const learned = sum.autoAccepted + sum.toReview;
    if (learned + sum.quarantined === 0) return;
    graph.setCursor(ANNOUNCE_CURSOR, { at: clock.now(), ...sum } satisfies Announcement);
    // Counts only: no fact text reaches the Feed card or the brief.
    deps.announce?.({
      title: `Psyche learned ${learned} ${learned === 1 ? "thing" : "things"}`,
      bodyMd: `${summaryLine({ at: 0, ...sum })}\n\n[Review](${REVIEW_LINK})`,
      widget: learnedSnapshot({ at: 0, ...sum }),
    });
  };
  /** Runs the pass under its gates; `manual` skips quiet hours and idle time, nothing else. */
  const runPass = async (manual: boolean): Promise<PassReport | "busy"> => {
    if (running) return "busy";
    if (deps.memoryReady?.() === false) return { ...emptyReport(), gate: "store_unavailable" };
    running = true;
    try {
      const d = await passDeps();
      const report = await runEverythingPass({ ...d, manual });
      vectors.prune(new Date(clock.now()).toISOString());
      afterReport(report);
      return report;
    } finally {
      running = false;
    }
  };
  const line = (r: PassReport): string => {
    const bits = [`${r.factsStored + r.edgesStored} facts proposed from ${r.itemsRead} items`];
    if (r.quarantined > 0) bits.push(`${r.quarantined} quarantined`);
    if (r.deferred > 0) bits.push(`${r.deferred} left for tomorrow`);
    if (r.error !== null) bits.push("stopped early");
    return `everything memory: ${bits.join(", ")}`;
  };
  const toResult = (r: PassReport | "busy"): EverythingRunResult =>
    r === "busy"
      ? {
          ran: false,
          reason: "busy",
          itemsRead: 0,
          factsProposed: 0,
          quarantined: 0,
          deferred: 0,
          tokens: 0,
        }
      : {
          ran: r.ran,
          reason: r.gate ?? null,
          itemsRead: r.itemsRead,
          factsProposed: r.factsStored + r.edgesStored,
          quarantined: r.quarantined,
          deferred: r.deferred,
          tokens: r.tokensIn + r.tokensOut,
        };
  runNowFn = async () => {
    // Off is off: not even "Run now" reads anything while the feature is switched off.
    if (!settings().enabled) return toResult({ ...emptyReport(), gate: "disabled" });
    return toResult(await runPass(true));
  };
  const nightly: NightlyStep = async () => {
    if (!settings().enabled) return undefined;
    try {
      const r = await runPass(false);
      return r === "busy" || !r.ran ? undefined : line(r);
    } catch (err) {
      deps.logger?.log("warn", "everything memory pass failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  };
  const WAITING: Record<string, string> = {
    disabled: "Everything memory is off.",
    no_sources: "Search is not reading any source memory can learn from.",
    model_none: "No model is chosen.",
    battery: "Waiting: not plugged in.",
    low_power: "Waiting: Low Power Mode is on.",
    thermal: "Waiting: the Mac is too warm.",
    not_idle: "Waiting: you are using the Mac.",
    outside_quiet_hours: "Waiting for quiet hours.",
    local_not_confirmed: "The local model has not been confirmed.",
    low_memory: "Waiting: not enough free memory for the local model.",
    no_owner_entity: "Waiting for your own card in People.",
    store_unavailable: "Waiting: the memory store is still opening.",
    busy: "Already running.",
  };
  /** The scheduled job (Scheduled → Everything memory): same pass, and "Run now" works there. */
  const job: ProactiveJob = {
    name: "everything memory",
    matches: (a) => parseJobMarker(a.prompt)?.job === JOB,
    async run(request): Promise<LaunchResult> {
      const manual = (request.run as { trigger?: string }).trigger === "manual";
      if (!settings().enabled) return { status: "no_reply", summary: WAITING.disabled ?? "" };
      const r = await runPass(manual);
      if (r === "busy") return { status: "no_reply", summary: WAITING.busy ?? "" };
      return {
        status: "no_reply",
        summary: r.ran ? line(r) : (WAITING[r.gate ?? "disabled"] ?? "Did not run."),
      };
    },
  };
  /** The system automation shown in Scheduled; on only while the feature is on. */
  const syncAutomation = async (scheduler: SchedulerLike, timezone: string) => {
    const fields = {
      title: "Everything memory",
      schedule: NIGHTLY_CRON,
      timezone,
      sessionTarget: "main",
      delivery: {},
      prompt: jobMarker(JOB, "nightly"),
      enabled: settings().enabled,
      scratch: null,
    };
    const existing = (await scheduler.list()).find((a) => a.prompt.trim() === fields.prompt);
    if (existing === undefined) await scheduler.create({ kind: "cron", system: true, ...fields });
    else await scheduler.update(existing.id, fields);
  };
  return {
    store,
    settings,
    handlers,
    answerModel,
    nightly,
    job,
    runNow: () => runNowFn(),
    comingUp() {
      if (!settings().enabled) return [];
      const now = clock.now();
      return upcoming(graph, { now, days: 14, timeZone: deps.timeZone() })
        .slice(0, 8)
        .map((i) => ({
          text: describeUpcoming(i, now),
          link: `/agent/soul?entity=${encodeURIComponent(i.entityId)}`,
        }));
    },
    learnedYesterday() {
      const a = graph.cursor(ANNOUNCE_CURSOR) as Announcement | undefined;
      if (a === undefined || clock.now() - a.at > BRIEF_WINDOW_MS) return undefined;
      const learned = a.autoAccepted + a.toReview;
      return {
        text: `Psyche learned ${learned} ${learned === 1 ? "thing" : "things"} yesterday: ${summaryLine(a)}`,
        link: REVIEW_LINK,
      };
    },
    useCitationScrub(scrub) {
      citationScrub = scrub;
    },
    part(scheduler, timezone) {
      let unsubscribe: (() => void) | undefined;
      const mounted = mountParamsOnly(handlers as never);
      return {
        handlers: {
          ...mounted,
          // The answer depends on who asks: the desktop app, another paired client, or no one
          // who can open a passage (a Mac helper).
          "memory.life.answer": {
            run: (call: Call, params: never) =>
              handlers["memory.life.answer"](params, {
                passages: call.identity.role === "client",
                desktop: call.identity.role === "client" && call.identity.desktopShell === true,
              }),
          },
          "memory.review.list": {
            run: async (call: Call, params: never) => {
              const res = await handlers["memory.review.list"](params);
              return {
                ...res,
                items: res.items.map((item) => ({
                  ...item,
                  citations: citationScrub(call, item.citations),
                })),
              };
            },
          },
        },
        async start(gateway: Gateway) {
          if (scheduler === undefined) return;
          const sync = () =>
            void syncAutomation(scheduler, timezone ?? deps.timeZone()).catch((err) =>
              deps.logger?.log("warn", "everything memory schedule sync failed", {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          sync();
          unsubscribe = gateway.bus.subscribe(["operator.read"], (frame) => {
            const f = JSON.parse(frame) as {
              event?: string;
              payload?: { entries?: { key: string }[] };
            };
            if (
              f.event === "settings.changed" &&
              f.payload?.entries?.some((e) => e.key === EVERYTHING_MEMORY_SETTING_KEY)
            )
              sync();
          });
        },
        stop() {
          unsubscribe?.();
          search?.sqlite.close();
          search = undefined;
        },
      };
    },
  };
}
