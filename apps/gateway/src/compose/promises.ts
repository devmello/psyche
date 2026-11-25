import { createHash } from "node:crypto";
import { getSetting, type PsycheDb, setSetting } from "@psyche/db";
import {
  applyDoneSignals,
  type DoneEvidence,
  type EverythingStore,
  type GraphStore,
  hasConfidentPromiseDue,
  type LaneComplete,
  type LaneItem,
  type LaneReport,
  type LoopVisibility,
  nudgeEligible,
  type PromiseActionInput,
  PromiseBudget,
  type PromiseRow,
  PromiseStore,
  promiseLocalDay,
  promiseLocalTime,
  promiseWarnAt,
  runPromiseLane,
} from "@psyche/memory";
import { isQuietAt, type PsycheNotifier, quietEndsAt } from "@psyche/notifications";
import {
  jobMarker,
  type ProactiveJob,
  parseJobMarker,
  type SchedulerLike,
} from "@psyche/proactive";
import {
  type Clock,
  type DailyFollowup,
  type MethodParams,
  type MethodResult,
  type ModelProvider,
  type ModelRef,
  type PromiseSummary,
  type PromiseView,
  type Provenance,
  PsycheError,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import {
  type PromiseAudience,
  type PromiseService,
  promiseHandlers,
  viewerOfCall,
} from "../promise-scrub.ts";
import type { ConnectorRef } from "./mail-threads.ts";
import type { EvidenceQuery } from "./promise-evidence.ts";
import {
  type MailSourceDeps as PromiseMailDeps,
  readMailItems as readPromiseMail,
} from "./promise-mail-source.ts";
import { ownerQuietHours } from "./quiet-hours.ts";
import { promiseChatOnThreadEnd, snapshotThread } from "./thread-end.ts";

/**
 * The promise ledger in the Gateway (docs/design/promise-ledger-2026.md sections 3.2, 4.1, 5, 7, 8.2):
 * the settings, the `promises.*` handlers behind the remote-viewer scrub, the `promises-scan` and
 * `promises-sweep` jobs, the warning notifier with its limits and quiet hours, the nudge offers,
 * the brief lines and the `daily.followups.*` shims. Nothing here sends a message to a person: a
 * nudge is only offered, and the owner's tap drafts it (wave W6).
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const PROMISE_SCAN_JOB = "promises-scan";
export const PROMISE_SWEEP_JOB = "promises-sweep";
/** 08:00 to 22:00 every 2 h, plus 03:00: the catch-up for what the day's cap left (design 3.2). */
export const PROMISE_SCAN_SCHEDULE = "0 3,8-22/2 * * *";
export const PROMISE_SWEEP_SCHEDULE = "7 * * * *";

// --- settings -------------------------------------------------------------------------------

export type PromiseSourceSwitch = "mail" | "messages" | "meetings" | "chat";

export interface PromiseSettings {
  /** `promises.enabled`: off by default and after every update. */
  enabled: boolean;
  sources: Record<PromiseSourceSwitch, boolean>;
  /** `promises.notify`: notifications for the owner's own deadlines only. */
  notify: boolean;
  /** `promises.graceDays`, 0 to 7 working days. */
  graceDays: number;
  /** `promises.retentionDays`, 30 to 730. */
  retentionDays: number;
  /** `promises.budget.callsPerDay`, 0 to 200; 0 means rules only. */
  callsPerDay: number;
}

export const PROMISE_SETTING_DEFAULTS: PromiseSettings = {
  enabled: false,
  sources: { mail: false, messages: false, meetings: false, chat: false },
  notify: true,
  graceDays: 1,
  retentionDays: 180,
  callsPerDay: 40,
};

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : dflt;

/** The settings as stored, with every default and range applied. Anything odd falls back. */
export function promiseSettings(get: (key: string) => unknown): PromiseSettings {
  const src = (k: PromiseSourceSwitch): boolean => get(`promises.sources.${k}`) === true;
  return {
    enabled: get("promises.enabled") === true,
    sources: {
      mail: src("mail"),
      messages: src("messages"),
      meetings: src("meetings"),
      chat: src("chat"),
    },
    notify: get("promises.notify") !== false,
    graceDays: clampInt(get("promises.graceDays"), 0, 7, PROMISE_SETTING_DEFAULTS.graceDays),
    retentionDays: clampInt(
      get("promises.retentionDays"),
      30,
      730,
      PROMISE_SETTING_DEFAULTS.retentionDays,
    ),
    callsPerDay: clampInt(
      get("promises.budget.callsPerDay"),
      0,
      200,
      PROMISE_SETTING_DEFAULTS.callsPerDay,
    ),
  };
}

// --- rate limits ----------------------------------------------------------------------------

/** Warnings: one per promise per due date, three a day. Nudge offers: see {@link admitNudges}. */
export const WARN_LIMIT_PER_DAY = 3;
export const NUDGE_LIMIT_PER_DAY = 3;
export const NUDGE_PERSON_DAYS = 7;

export interface NudgeOffer {
  id: string;
  /** The person, or null when the promise has no known counterpart (then it is its own key). */
  entityId: string | null;
  at: number;
}

export interface NudgeCandidate {
  id: string;
  entityId: string | null;
  /** When a nudge to this promise was last sent, if ever. */
  lastNudgeAt: number | null;
  /** Nudges already sent for this promise (two at most, ever). */
  nudgeCount: number;
}

/**
 * Which nudge-eligible promises may be offered now (design 5.3): at most 3 new offers a day, at
 * most 1 per person per 7 days (an offer or a sent nudge counts), at most 2 sent per promise.
 * An offer made earlier stays on show and is never counted twice. Pure: `offers` is the history.
 */
export function admitNudges(
  candidates: readonly NudgeCandidate[],
  offers: readonly NudgeOffer[],
  nowMs: number,
): { offers: NudgeOffer[]; admitted: string[] } {
  const kept = [...offers];
  const admitted: string[] = [];
  for (const c of candidates) {
    if (c.nudgeCount >= 2) continue;
    if (kept.some((o) => o.id === c.id)) continue;
    const today = kept.filter((o) => nowMs - o.at < DAY_MS).length;
    if (today >= NUDGE_LIMIT_PER_DAY) break;
    const person = c.entityId;
    if (person !== null) {
      const recent = kept.some(
        (o) => o.entityId === person && nowMs - o.at < NUDGE_PERSON_DAYS * DAY_MS,
      );
      const sent = c.lastNudgeAt !== null && nowMs - c.lastNudgeAt < NUDGE_PERSON_DAYS * DAY_MS;
      if (recent || sent) continue;
    }
    kept.push({ id: c.id, entityId: person, at: nowMs });
    admitted.push(c.id);
  }
  return { offers: kept, admitted };
}

// --- warning times --------------------------------------------------------------------------

/**
 * When the one warning for a due date goes out (design 5.1): 16:00 the working day before, or
 * 09:00 on the due day when the promise is due after 12:00.
 */
export function warningAt(dueMs: number, tz: string): number {
  const day = promiseLocalDay(dueMs, tz);
  const dueHour = (dueMs - promiseLocalTime(day, 0, tz)) / HOUR_MS;
  return dueHour >= 12 ? promiseLocalTime(day, 9, tz) : promiseWarnAt(dueMs, tz);
}

export interface WarnDecision {
  kind: "send" | "wait" | "brief_only";
  /** When it may go out: now, or the end of quiet hours. */
  at: number;
}

/**
 * Whether a warning for `dueMs` goes out at `nowMs`: not before its time, moved out of quiet
 * hours, and never when that lands past the due time or within 2 hours of it (then the brief
 * carries it). A promise made less than a day before it is due warns 1 h after it was made.
 */
export function decideWarning(input: {
  dueMs: number;
  createdMs: number;
  nowMs: number;
  tz: string;
  quiet: Parameters<typeof isQuietAt>[0] | null;
}): WarnDecision {
  const { dueMs, createdMs, nowMs, tz, quiet } = input;
  let at = Math.max(warningAt(dueMs, tz), createdMs + HOUR_MS);
  if (nowMs < at) return { kind: "wait", at };
  if (quiet !== null && isQuietAt(quiet, Math.max(at, nowMs))) {
    const end = quietEndsAt(quiet, nowMs);
    if (end === undefined || end >= dueMs) return { kind: "brief_only", at: dueMs };
    at = end;
    if (nowMs < at) return { kind: "wait", at };
  }
  if (dueMs - nowMs < 2 * HOUR_MS) return { kind: "brief_only", at: dueMs };
  return { kind: "send", at: nowMs };
}

// --- the service ----------------------------------------------------------------------------

export interface PromisesDeps {
  db: PsycheDb;
  clock: Clock;
  graph: GraphStore;
  /** Memory's own SQLite connection (the encrypted store when it is on). */
  sqlite: PsycheDb["sqlite"];
  em: Pick<EverythingStore, "isEntityExcluded">;
  loopVisibility: LoopVisibility;
  publish: (event: string, payload: unknown) => void;
  notifier: Pick<PsycheNotifier, "notify">;
  timeZone: () => string;
  redact: (text: string) => string;
  ownerNames: () => string[];
  /** The everything-memory model, or undefined (None: the rules-only mode). */
  model: () => { provider: ModelProvider; model: ModelRef } | undefined;
  /** Mail tools and connectors for the scan. */
  mail?: PromiseMailDeps;
  /** Readers for other sources (Messages); tests and later waves supply them. */
  sources?: Partial<Record<"mail" | "messages", (sinceMs: number) => Promise<LaneItem[]>>>;
  /** Done evidence for one promise; the default reads the connectors. */
  evidence?: (q: EvidenceQuery) => Promise<DoneEvidence>;
  connectors?: () => readonly ConnectorRef[] | Promise<readonly ConnectorRef[]>;
  logger?: Pick<Logger, "log">;
}

export interface ScanReport {
  skipped?: "off" | "no_sources";
  items: number;
  calls: number;
  created: number;
  merged: number;
}

export interface SweepReport {
  woke: number;
  broken: number;
  warned: number;
  agedOut: number;
  done: number;
  asked: number;
  notified: number;
  offered: number;
}

export interface Promises {
  readonly handlers: Record<string, HandlerDef>;
  ledgerOn(): boolean;
  settings(): PromiseSettings;
  scan(): Promise<ScanReport>;
  sweep(): Promise<SweepReport>;
  /** The Home brief lines (at most 4, none when there is nothing). */
  briefLines(surface?: string): { text: string; link?: string }[];
  /** `MeetingLedgerTarget` for the notes writer. */
  meetingTarget():
    | {
        store: PromiseStore;
        mutedEntities: ReadonlySet<string>;
        isExcluded: (id: string) => boolean;
      }
    | "off"
    | undefined;
  /** The chat hooks to register on `threadEnding` and `threadEnded`. */
  readonly chat: ReturnType<typeof promiseChatOnThreadEnd>;
  jobs(): ProactiveJob[];
  ensureSchedules(scheduler: SchedulerLike, timezone: string): Promise<void>;
  /** `daily.followups.*` over the ledger while it is on; otherwise the base handlers. */
  withShims(base: Record<string, HandlerDef>): Record<string, HandlerDef>;
  /** Replaces the source readers (the Gateway's own are the connectors); for tests and later waves. */
  useSources(sources: PromisesDeps["sources"]): void;
  /** Replaces the done-evidence reader. */
  useEvidence(evidence: PromisesDeps["evidence"]): void;
  /** Nudge offers on show (nudge-eligible, under the limits), for Home and the brief. */
  offers(): PromiseRow[];
  store(): PromiseStore;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export function composePromises(deps: PromisesDeps): Promises {
  const { db, clock, graph } = deps;
  const get = (key: string): unknown => getSetting(db, key)?.value;
  const put = (key: string, value: unknown): void => void setSetting(db, key, value);
  const settings = (): PromiseSettings => promiseSettings(get);
  let sourceOverride = deps.sources;
  let evidenceOverride = deps.evidence;
  const tz = (): string => deps.timeZone();
  const vis = deps.loopVisibility;

  const store = (): PromiseStore =>
    new PromiseStore({
      graph,
      sqlite: deps.sqlite,
      clock,
      timezone: tz(),
      graceDays: settings().graceDays,
    });
  const arrayOf = (key: string): string[] => {
    const v = get(key);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  };
  const mutedEntities = (): Set<string> => new Set(arrayOf("promises.state.muted"));
  const mutedThreads = (): Set<string> => new Set(arrayOf("promises.state.mutedThreads"));
  const isExcluded = (id: string): boolean => {
    const e = graph.getEntity(id);
    return deps.em.isEntityExcluded(id) || e?.hidden === true || mutedEntities().has(id);
  };

  // --- views --------------------------------------------------------------------------------

  const SAFE_LINK = /^(?:message:|mailto:|https?:)/i;
  const citationsOf = (id: string) =>
    (
      deps.sqlite
        .prepare(
          `SELECT id, source, source_ref, quote, observed_at, provenance FROM graph_citations
            WHERE target_kind = 'loop' AND target_id = ? ORDER BY observed_at, id LIMIT 20`,
        )
        .all(id) as {
        id: string;
        source: string;
        source_ref: string;
        quote: string;
        observed_at: string;
        provenance: Provenance;
      }[]
    ).flatMap((c) =>
      ["mail", "messages", "notes", "chats", "transcripts"].includes(c.source)
        ? [
            {
              id: c.id,
              source: c.source as "mail",
              quote: c.quote.slice(0, 200),
              sourceRef: c.source_ref.slice(0, 1000),
              observedAt: c.observed_at,
              provenance: c.provenance,
            },
          ]
        : [],
    );
  const view = (p: PromiseRow, detail: boolean): PromiseView => {
    const cites = citationsOf(p.id);
    const mail = cites.find((c) => c.source === "mail" && SAFE_LINK.test(c.sourceRef));
    return {
      id: p.id,
      direction: p.direction,
      what: p.text.slice(0, 200),
      status: p.status,
      state: p.state,
      basis: p.basis,
      whatAction: p.whatAction,
      counterpartLabel: p.counterpartLabel,
      counterpartId: p.counterpartId ?? null,
      projectId: p.projectId ?? null,
      dueAt: p.dueAt ?? null,
      dueText: p.dueText,
      dueKind: p.dueKind,
      dueConfidence: p.dueConfidence,
      proposedDueAt: p.proposedDueAt,
      snoozedUntil: p.snoozedUntil,
      brokenAt: p.brokenAt,
      warnedAt: p.warnedAt,
      nudgeCount: p.nudgeCount,
      lastNudgeAt: p.lastNudgeAt,
      sourceKind: p.sourceKind,
      ...(mail === undefined ? {} : { link: mail.sourceRef }),
      provenance: p.provenance,
      confidence: p.confidence,
      createdAt: p.createdAt,
      closedAt: p.closedAt ?? null,
      closedBy: p.closedBy ?? null,
      ...(detail
        ? {
            citations: cites,
            events: store()
              .events(p.id)
              .slice(-200)
              .map((e) => ({
                id: e.id,
                at: e.at,
                kind: e.kind,
                from: e.from === null ? null : e.from.slice(0, 200),
                to: e.to === null ? null : e.to.slice(0, 200),
                by: e.by,
                citationId: e.citationId,
              })),
          }
        : {}),
    };
  };
  const publishUpdated = (p: PromiseRow | undefined): void => {
    if (p === undefined) return;
    // The full view goes on the bus; each subscriber is personalised (promise scrub).
    deps.publish("promise.updated", { promise: view(p, false) });
  };

  const byDue = (a: PromiseRow, b: PromiseRow): number =>
    (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || a.createdAt.localeCompare(b.createdAt);

  const active = (rows: PromiseRow[]): PromiseRow[] =>
    rows.filter((p) => ["open", "snoozed", "broken"].includes(p.status));

  // --- the service behind the scrub ---------------------------------------------------------

  const notFound = (): never => {
    throw new PsycheError("not_found", "no such promise");
  };
  const remoteRows = (rows: PromiseRow[], audience: PromiseAudience) => {
    if (audience === "full") return { rows, hidden: 0 };
    const ok = vis.remoteVisible(rows.map((r) => r.id));
    const shown = rows.filter((r) => ok.has(r.id));
    return { rows: shown, hidden: rows.length - shown.length };
  };

  const upcoming = (
    rows: PromiseRow[],
    nowMs: number,
    quiet: ReturnType<typeof ownerQuietHours>,
  ) => {
    const out: { id: string; warnAt: string; title: string }[] = [];
    for (const p of rows) {
      if (p.direction !== "i_owe" || p.status !== "open" || !hasConfidentPromiseDue(p)) continue;
      const due = Date.parse(p.dueAt ?? "");
      if (Number.isNaN(due) || due <= nowMs) continue;
      let at = Math.max(warningAt(due, tz()), Date.parse(p.createdAt) + HOUR_MS);
      if (quiet !== null) {
        const end = quietEndsAt(quiet, at);
        if (end === undefined || end >= due) continue;
        at = end;
      }
      if (due - at < 2 * HOUR_MS || at > nowMs + 7 * DAY_MS) continue;
      out.push({
        id: p.id,
        warnAt: new Date(Math.max(at, nowMs)).toISOString(),
        title: p.text.slice(0, 200),
      });
    }
    return out.sort((a, b) => a.warnAt.localeCompare(b.warnAt)).slice(0, 50);
  };

  const service: PromiseService = {
    list(params, audience) {
      const all = store().list(params.view, {
        ...(params.entityId === undefined ? {} : { entityId: params.entityId }),
        ...(params.dueBefore === undefined ? {} : { dueBefore: params.dueBefore }),
        limit: 500,
      });
      const { rows, hidden } = remoteRows(all, audience);
      rows.sort(byDue);
      const limit = Math.min(500, Math.max(1, params.limit ?? 50));
      const offset =
        params.cursor === undefined ? 0 : Math.max(0, Number.parseInt(params.cursor, 10) || 0);
      const page = rows.slice(offset, offset + limit);
      return {
        promises: page.map((p) => view(p, false)),
        hiddenCount: hidden,
        nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
      };
    },
    get(id, audience) {
      const p = store().get(id);
      if (p === undefined || p.basis !== "promise") return notFound();
      return view(p, audience === "full");
    },
    summary(audience): PromiseSummary {
      const s = store();
      const nowMs = clock.now();
      const everything = s.list("all", { limit: 500 });
      const open = active(everything);
      const confirm = s.list("confirm", { limit: 500 });
      const { rows: shown, hidden: hiddenActive } = remoteRows([...open, ...confirm], audience);
      const shownIds = new Set(shown.map((r) => r.id));
      const mine = open.filter((p) => shownIds.has(p.id) && p.direction === "i_owe");
      const theirs = open.filter((p) => shownIds.has(p.id) && p.direction === "waiting_on");
      const dates = mine
        .filter((p) => p.status === "open" && hasConfidentPromiseDue(p) && p.dueAt != null)
        .map((p) => p.dueAt as string)
        .filter((d) => Date.parse(d) > nowMs)
        .sort();
      return {
        enabled: settings().enabled,
        yours: mine.length,
        theirs: theirs.length,
        toConfirm: confirm.filter((p) => shownIds.has(p.id)).length,
        dueSoon: mine.filter((p) => p.state === "due_soon").length,
        missed: mine.filter((p) => p.status === "broken").length,
        late: theirs.filter((p) => p.status === "broken").length,
        nextDueAt: dates[0] ?? null,
        hiddenCount: hiddenActive,
        upcoming: upcoming(
          mine.filter((p) => shownIds.has(p.id)),
          nowMs,
          ownerQuietHours(db, tz),
        ),
      };
    },
    act(params) {
      const a = params.action;
      let input: PromiseActionInput;
      switch (a.type) {
        case "snooze":
          input = { action: "snooze", until: a.until };
          break;
        case "set_due":
          if (a.dueAt == null) throw new PsycheError("invalid_params", "a due date is required");
          input = { action: "set_due", dueAt: a.dueAt };
          break;
        case "more_time":
          input = { action: "more_time", days: a.days };
          break;
        case "answer":
          input = { action: "answer", answer: a.answer };
          break;
        default:
          input = { action: a.type } as PromiseActionInput;
      }
      const s = store();
      const p = s.get(params.id);
      if (p === undefined || p.basis !== "promise") return notFound();
      const next = s.act(params.id, input);
      publishUpdated(next);
      return view(next, false);
    },
    add(params) {
      const what = params.what.trim().slice(0, 120);
      const due = params.dueAt == null ? null : Date.parse(params.dueAt);
      if (due !== null && Number.isNaN(due)) throw new PsycheError("invalid_params", "not a date");
      const r = store().add({
        direction: params.direction,
        what,
        counterpartId: params.counterpartId ?? null,
        counterpartLabel:
          params.counterpartId == null
            ? null
            : (graph.getEntity(params.counterpartId)?.name ?? null),
        ...(due === null
          ? { dueKind: "none" as const }
          : { dueAt: new Date(due).toISOString(), dueKind: "explicit" as const, dueConfidence: 1 }),
        provenance: "owner",
        confidence: 1,
        detectedBy: "owner",
        sourceKind: "manual",
      });
      if (r.kind === "rejected")
        throw new PsycheError("invalid_params", "that cannot be tracked as a promise", {
          details: { reason: r.reason },
        });
      publishUpdated(r.promise);
      return view(r.promise, false);
    },
    delete(params) {
      store().delete(params.id);
      return { ok: true };
    },
    mute(params) {
      if ((params.entityId === undefined) === (params.threadRef === undefined))
        throw new PsycheError("invalid_params", "name exactly one of entityId and threadRef");
      const key =
        params.entityId === undefined ? "promises.state.mutedThreads" : "promises.state.muted";
      const value = params.entityId ?? sha(params.threadRef as string);
      const next = new Set(arrayOf(key));
      if (params.muted) next.add(value);
      else next.delete(value);
      put(key, [...next].slice(-500));
      return { ok: true };
    },
  };
  const handlers = promiseHandlers(service, vis);

  // --- the lane -----------------------------------------------------------------------------

  const seen = {
    has: (hash: string): boolean =>
      deps.sqlite
        .prepare(
          "SELECT 1 FROM memory_extracted_items WHERE source = 'promises' AND source_ref = ?",
        )
        .get(hash) !== undefined,
    add: (hash: string): void => {
      deps.sqlite
        .prepare(
          `INSERT INTO memory_extracted_items (source, source_ref, source_hash, run_id, extracted_at)
           VALUES ('promises', ?, ?, NULL, ?) ON CONFLICT (source, source_ref) DO NOTHING`,
        )
        .run(hash, hash, new Date(clock.now()).toISOString());
    },
  };

  const completeOf = (): LaneComplete | undefined => {
    const m = deps.model();
    if (m === undefined) return undefined;
    return async (req) => {
      let text = "";
      let used = 0;
      for await (const e of m.provider.stream({
        model: m.model,
        system: req.system,
        messages: [{ role: "user", parts: [{ type: "text", text: req.user }] }],
        toolChoice: "none",
        maxOutputTokens: req.maxOutputTokens,
        temperature: 0,
      })) {
        if (e.type === "text_delta") text += e.text;
        if (e.type === "usage") used = e.usage.input + e.usage.output;
        if (e.type === "finish" && e.reason !== "stop" && e.reason !== "length")
          throw new Error(e.reason);
      }
      return {
        text,
        tokens:
          used > 0 ? used : Math.ceil((req.system.length + req.user.length + text.length) / 4),
      };
    };
  };

  let lane: Promise<unknown> = Promise.resolve();
  /** Items in, ledger rows out, on the day's budget. Runs one at a time. */
  const runLane = (items: LaneItem[]): Promise<LaneReport> => {
    const run = lane.then(async () => {
      const s = settings();
      const usage = get("promises.state.budget") as ConstructorParameters<
        typeof PromiseBudget
      >[0]["usage"];
      const budget = new PromiseBudget({
        callsPerDay: s.callsPerDay,
        clock,
        zone: tz(),
        ...(usage === undefined || usage === null ? {} : { usage }),
      });
      const complete = completeOf();
      const report = await runPromiseLane(items, {
        store: store(),
        redact: deps.redact,
        ownerNames: deps.ownerNames(),
        zone: tz(),
        budget,
        ...(complete === undefined ? {} : { complete }),
        seen,
        mutedThreads: mutedThreads(),
        mutedEntities: mutedEntities(),
        isExcluded,
        cuesOff: new Set(arrayOf("promises.state.cuesOff")),
      });
      put("promises.state.budget", budget.usage);
      for (const p of store()
        .list("all", { limit: 500 })
        .slice(-report.created - report.merged))
        publishUpdated(p);
      return report;
    });
    lane = run.catch(() => undefined);
    return run;
  };

  const cursorKey = (source: string): string => `promises.cursor.${source}`;
  const scan = async (): Promise<ScanReport> => {
    const s = settings();
    const out: ScanReport = { items: 0, calls: 0, created: 0, merged: 0 };
    if (!s.enabled) return { ...out, skipped: "off" };
    const readers: { name: "mail" | "messages"; read: (since: number) => Promise<LaneItem[]> }[] =
      [];
    const custom = sourceOverride;
    if (s.sources.mail) {
      const read =
        custom?.mail ??
        (deps.mail === undefined
          ? undefined
          : (since: number) => readPromiseMail(deps.mail as PromiseMailDeps, since));
      if (read !== undefined) readers.push({ name: "mail", read });
    }
    if (s.sources.messages && custom?.messages !== undefined)
      readers.push({ name: "messages", read: custom.messages });
    if (readers.length === 0) return { ...out, skipped: "no_sources" };
    for (const r of readers) {
      const started = clock.now();
      const stored = graph.cursor(cursorKey(r.name)) as { at?: number } | null | undefined;
      const since = typeof stored?.at === "number" ? stored.at : started - DAY_MS;
      let items: LaneItem[];
      try {
        items = await r.read(since);
      } catch (err) {
        deps.logger?.log("warn", "promise scan read failed", {
          source: r.name,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      out.items += items.length;
      let next = started;
      if (items.length > 0) {
        const report = await runLane(items);
        out.calls += report.calls;
        out.created += report.created;
        out.merged += report.merged;
        // What the day's cap left is read again by the next scan (the 03:00 one is the catch-up):
        // the cursor stays before the earliest held-back snippet, and `seen` skips what was done.
        const held = report.queued.map((q) => Date.parse(q.sentAt)).filter((t) => !Number.isNaN(t));
        if (held.length > 0) next = Math.min(...held) - 1;
      }
      graph.setCursor(cursorKey(r.name), { at: next });
    }
    deps.logger?.log("info", "promise scan", { ...out });
    return out;
  };

  // --- the sweep: signals, transitions, warnings, offers ------------------------------------

  const entityPerson = (entityId: string) => {
    const ids = graph.identifiers(entityId);
    return {
      entityId,
      addresses: ids.filter((i) => i.kind === "email").map((i) => i.value),
      handles: ids.filter((i) => i.kind === "phone" || i.kind === "channel").map((i) => i.value),
    };
  };

  const runSignals = async (s: PromiseStore): Promise<{ done: number; asked: number }> => {
    const out = { done: 0, asked: 0 };
    const readEvidence = evidenceOverride;
    if (readEvidence === undefined) return out;
    const nowMs = clock.now();
    const memo = (get("promises.state.signalsAt") ?? {}) as Record<string, number>;
    let reads = 0;
    for (const p of active(s.list("all", { limit: 500 })).sort(byDue)) {
      if (p.counterpartId === null || p.counterpartId === undefined) continue;
      if (reads >= 15) break;
      if (nowMs - (memo[p.id] ?? 0) < 2 * HOUR_MS) continue;
      memo[p.id] = nowMs;
      reads++;
      try {
        const evidence = await readEvidence({
          person: entityPerson(p.counterpartId),
          threadKey: p.threadKey,
          sinceMs: s.firstCitationAt(p.id) ?? (Date.parse(p.createdAt) || nowMs - 30 * DAY_MS),
        });
        const who = p.counterpartLabel ?? graph.getEntity(p.counterpartId)?.name ?? "they";
        const r = applyDoneSignals(s, p.id, evidence, who);
        if (r.kind === "done") out.done++;
        if (r.kind === "ask") out.asked++;
        if (r.kind !== "none") publishUpdated(s.get(p.id));
      } catch (err) {
        deps.logger?.log("warn", "promise done signals failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const k of Object.keys(memo)) if (nowMs - (memo[k] ?? 0) > 3 * DAY_MS) delete memo[k];
    put("promises.state.signalsAt", memo);
    return out;
  };

  interface PendingWarn {
    id: string;
    dueAt: string;
  }
  const dayCount = (key: string): number => {
    const v = get(key) as { day?: string; count?: number } | undefined;
    const today = new Date(clock.now()).toISOString().slice(0, 10);
    return v?.day === today ? (v.count ?? 0) : 0;
  };
  const bumpDay = (key: string, by: number): void => {
    const today = new Date(clock.now()).toISOString().slice(0, 10);
    put(key, { day: today, count: dayCount(key) + by });
  };

  const whenWord = (dueMs: number): string => {
    const a = promiseLocalDay(clock.now(), tz());
    const b = promiseLocalDay(dueMs, tz());
    return a.y === b.y && a.m === b.m && a.d === b.d ? "today" : "tomorrow";
  };

  /** Delivers what is due out of the pending warnings; the rest waits, or is left to the brief. */
  const deliverWarnings = async (s: PromiseStore, fresh: string[]): Promise<number> => {
    const nowMs = clock.now();
    const pending = (get("promises.state.pendingWarns") as PendingWarn[] | undefined) ?? [];
    for (const id of fresh) {
      const p = s.get(id);
      if (p?.dueAt != null && !pending.some((w) => w.id === id && w.dueAt === p.dueAt))
        pending.push({ id, dueAt: p.dueAt });
    }
    const keep: PendingWarn[] = [];
    const send: PromiseRow[] = [];
    const quiet = ownerQuietHours(db, tz);
    for (const w of pending) {
      const p = s.get(w.id);
      if (p === undefined || p.status !== "open" || p.dueAt !== w.dueAt) continue;
      const d = decideWarning({
        dueMs: Date.parse(w.dueAt),
        createdMs: Date.parse(p.createdAt),
        nowMs,
        tz: tz(),
        quiet,
      });
      if (d.kind === "wait") keep.push(w);
      else if (d.kind === "send") send.push(p);
    }
    put("promises.state.pendingWarns", keep.slice(-100));
    if (!settings().notify || send.length === 0) return 0;
    // Three notifications a day in total; two or more at once are one notice (design 5.3).
    if (dayCount("promises.state.notified") >= WARN_LIMIT_PER_DAY) return 0;
    bumpDay("promises.state.notified", 1);
    if (send.length === 1) {
      const p = send[0] as PromiseRow;
      await deps.notifier.notify({
        kind: "promise_due",
        title: "Promise due soon",
        body: `Due ${whenWord(Date.parse(p.dueAt as string))}: ${p.text}`.slice(0, 300),
        route: `/promises/${p.id}`,
        dedupeKey: `promise:${p.id}:warn:${p.dueAt}`,
        surfaces: ["desktop", "web", "notification"],
      });
      return 1;
    }
    await deps.notifier.notify({
      kind: "promise_due",
      title: "Promises due soon",
      body: `${send.length} promises are due soon`,
      route: "/memory/promises",
      dedupeKey: `promises:warn:${sha(send.map((p) => `${p.id}:${p.dueAt}`).join("|")).slice(0, 16)}`,
      surfaces: ["desktop", "web", "notification"],
    });
    return send.length;
  };

  const offersOn = (): NudgeOffer[] => {
    const v = get("promises.state.offers");
    return Array.isArray(v) ? (v as NudgeOffer[]) : [];
  };

  const sweep = async (): Promise<SweepReport> => {
    const out: SweepReport = {
      woke: 0,
      broken: 0,
      warned: 0,
      agedOut: 0,
      done: 0,
      asked: 0,
      notified: 0,
      offered: 0,
    };
    if (!settings().enabled) return out;
    const s = store();
    // Done signals first: a promise already kept is never marked broken or warned about.
    const sig = await runSignals(s);
    out.done = sig.done;
    out.asked = sig.asked;
    const r = s.sweep();
    out.woke = r.woke.length;
    out.broken = r.broken.length;
    out.warned = r.warned.length;
    out.agedOut = r.agedOut.length;
    for (const id of [...r.woke, ...r.broken, ...r.warned, ...r.agedOut]) publishUpdated(s.get(id));
    out.notified = await deliverWarnings(s, r.warned);
    // Their promises that may be chased: only offered, never sent, under the limits.
    const nowMs = clock.now();
    const eligible = r.nudgeEligible
      .map((id) => s.get(id))
      .filter((p): p is PromiseRow => p !== undefined)
      .filter((p) => nudgeEligible(p, nowMs));
    const eligibleIds = new Set(eligible.map((p) => p.id));
    const history = offersOn().filter(
      (o) => eligibleIds.has(o.id) || nowMs - o.at < NUDGE_PERSON_DAYS * DAY_MS,
    );
    const admit = admitNudges(
      eligible.map((p) => ({
        id: p.id,
        entityId: p.counterpartId ?? null,
        lastNudgeAt: p.lastNudgeAt === null ? null : Date.parse(p.lastNudgeAt),
        nudgeCount: p.nudgeCount,
      })),
      history,
      nowMs,
    );
    put("promises.state.offers", admit.offers.slice(-200));
    out.offered = admit.admitted.length;
    deps.logger?.log("info", "promise sweep", { ...out });
    return out;
  };

  const offers = (): PromiseRow[] => {
    if (!settings().enabled) return [];
    const s = store();
    const nowMs = clock.now();
    return offersOn()
      .map((o) => s.get(o.id))
      .filter((p): p is PromiseRow => p !== undefined && nudgeEligible(p, nowMs));
  };

  // --- the brief ----------------------------------------------------------------------------

  const briefLines = (surface?: string): { text: string; link?: string }[] => {
    if (surface === "channel" || !settings().enabled) return [];
    const s = store();
    const nowMs = clock.now();
    const rows = active(s.list("all", { limit: 500 }));
    const confirm = s.list("confirm", { limit: 500 }).length;
    // The brief is stored in the Feed, which every paired device reads: text only for what a
    // remote viewer may see. The rest is one generic line (promise scrub, design 7.2).
    const ok = vis.remoteVisible(rows.map((r) => r.id));
    const dayOf = (iso: string | null | undefined) => {
      const ms = Date.parse(iso ?? "");
      return Number.isNaN(ms) ? null : promiseLocalDay(ms, tz());
    };
    const today = promiseLocalDay(nowMs, tz());
    const tomorrow = promiseLocalDay(nowMs + DAY_MS, tz());
    const same = (
      a: ReturnType<typeof promiseLocalDay> | null,
      b: ReturnType<typeof promiseLocalDay>,
    ) => a !== null && a.y === b.y && a.m === b.m && a.d === b.d;
    const mine = rows.filter((p) => p.direction === "i_owe" && hasConfidentPromiseDue(p));
    const dueToday = mine.filter((p) => p.status === "open" && same(dayOf(p.dueAt), today));
    const dueTomorrow = mine.filter((p) => p.status === "open" && same(dayOf(p.dueAt), tomorrow));
    const missed = mine.filter((p) => p.status === "broken");
    const late = offers();
    const shown = (list: PromiseRow[]) => list.filter((p) => ok.has(p.id));
    const names = (list: PromiseRow[]) => {
      const t = shown(list)
        .slice(0, 2)
        .map((p) => p.text.replace(/\s+/g, " ").slice(0, 80));
      const more = shown(list).length - t.length;
      return t.join("; ") + (more > 0 ? ` and ${more} more` : "");
    };
    const lines: { text: string; link?: string }[] = [];
    const link = "/memory/promises";
    if (shown(dueToday).length + shown(missed).length > 0) {
      const parts = [
        shown(dueToday).length > 0 ? `Due today: ${names(dueToday)}` : "",
        shown(missed).length > 0 ? `Missed: ${names(missed)}` : "",
      ].filter((x) => x !== "");
      lines.push({ text: parts.join(". "), link });
    }
    if (shown(dueTomorrow).length > 0)
      lines.push({ text: `Due tomorrow: ${names(dueTomorrow)}`, link });
    const lateShown = shown(late);
    if (lateShown.length > 0) {
      const p = lateShown[0] as PromiseRow;
      const days = Math.max(1, Math.floor((nowMs - Date.parse(p.dueAt ?? p.createdAt)) / DAY_MS));
      const who = (p.counterpartLabel ?? "Someone").split(/\s+/)[0] ?? "Someone";
      lines.push({
        text: `Late: ${who}'s ${p.text.slice(0, 80)}, ${days} ${days === 1 ? "day" : "days"}. Draft a nudge?`,
        link,
      });
    }
    const hidden = [...dueToday, ...dueTomorrow, ...missed, ...late].filter(
      (p) => !ok.has(p.id),
    ).length;
    if (hidden > 0)
      lines.push({
        text: `${hidden} more ${hidden === 1 ? "promise needs" : "promises need"} you: open Psyche on your Mac`,
        link,
      });
    if (confirm > 0)
      lines.push({ text: `${confirm} ${confirm === 1 ? "promise" : "promises"} to confirm`, link });
    return lines.slice(0, 4);
  };

  // --- daily.followups.* shims --------------------------------------------------------------

  const legacy = (p: PromiseRow): DailyFollowup => ({
    id: p.id,
    text: p.text.slice(0, 500),
    source:
      p.sourceKind === "mail"
        ? "sent_mail"
        : p.sourceKind === "messages"
          ? "message"
          : p.sourceKind === "chat"
            ? "chat"
            : "manual",
    status:
      p.status === "snoozed"
        ? "snoozed"
        : p.status === "done"
          ? "done"
          : p.status === "dismissed" || p.status === "released"
            ? "dismissed"
            : "open",
    ...(p.dueAt == null ? {} : { dueAt: p.dueAt }),
    ...(p.snoozedUntil == null ? {} : { snoozedUntil: p.snoozedUntil }),
    createdAt: p.createdAt,
  });
  const visibleTo = (call: Call, rows: PromiseRow[]): PromiseRow[] => {
    if (viewerOfCall(call).full) return rows;
    const ok = vis.remoteVisible(rows.map((r) => r.id));
    return rows.filter((r) => ok.has(r.id));
  };

  const withShims = (base: Record<string, HandlerDef>): Record<string, HandlerDef> => {
    const out = { ...base };
    const wrap = (name: string, shim: (call: Call, params: never) => unknown): void => {
      const orig = base[name];
      if (orig === undefined) return;
      out[name] = {
        ...orig,
        run: (call: Call, params: never) =>
          settings().enabled ? shim(call, params) : orig.run(call, params),
      };
    };
    wrap("daily.followups.list", (call, params: MethodParams<"daily.followups.list">) => {
      const want = new Set(params.status ?? ["open", "snoozed"]);
      const rows = store()
        .list("all", { limit: 500 })
        .filter((p) => p.direction === "i_owe" && p.status !== "suggested")
        .map(legacy)
        .filter((f) => want.has(f.status));
      const ids = new Set(visibleTo(call, store().list("all", { limit: 500 })).map((p) => p.id));
      return {
        followups: rows.filter((f) => ids.has(f.id)),
      } satisfies MethodResult<"daily.followups.list">;
    });
    wrap("daily.followups.update", (call, params: MethodParams<"daily.followups.update">) => {
      const s = store();
      const p = s.get(params.id);
      if (p === undefined || visibleTo(call, [p]).length === 0) return notFound();
      const input: PromiseActionInput =
        params.action === "snooze"
          ? {
              action: "snooze",
              until: params.until ?? new Date(clock.now() + DAY_MS).toISOString(),
            }
          : params.action === "done"
            ? { action: "done" }
            : params.action === "dismiss"
              ? { action: "dismiss" }
              : { action: "reopen" };
      const next = s.act(params.id, input);
      publishUpdated(next);
      return { followup: legacy(next) } satisfies MethodResult<"daily.followups.update">;
    });
    wrap("daily.followups.ingest", async (call, params: MethodParams<"daily.followups.ingest">) => {
      // Rules only, on the owner's own text. Messages need the model path to attribute who spoke.
      if (params.source === "message")
        return { added: [] } satisfies MethodResult<"daily.followups.ingest">;
      const s = store();
      const before = new Set(s.list("all", { limit: 500 }).map((p) => p.id));
      const item: LaneItem = {
        source: params.source === "chat" ? "chat" : "mail",
        sourceRef: params.sourceLink ?? `ingest:${sha(params.text).slice(0, 16)}`,
        threadId: null,
        author: "owner",
        counterpartId: null,
        counterpartLabel: null,
        sentAt: new Date(clock.now()).toISOString(),
        text: params.text,
      };
      const { runRulesOnly } = await import("@psyche/memory");
      runRulesOnly([item], {
        store: s,
        redact: deps.redact,
        ownerNames: deps.ownerNames(),
        zone: tz(),
        budget: new PromiseBudget({ clock, zone: tz() }),
        seen,
        mutedThreads: mutedThreads(),
        mutedEntities: mutedEntities(),
        isExcluded,
      });
      const added = s.list("all", { limit: 500 }).filter((p) => !before.has(p.id));
      for (const p of added) publishUpdated(p);
      return {
        added: visibleTo(call, added).map(legacy),
      } satisfies MethodResult<"daily.followups.ingest">;
    });
    return out;
  };

  // --- jobs and hooks -----------------------------------------------------------------------

  const job = (name: string, run: () => Promise<string>): ProactiveJob => ({
    name,
    rerunOnInterrupt: true,
    matches: (a) => parseJobMarker(a.prompt)?.job === name,
    run: async () => ({ status: "done", summary: await run() }),
  });
  const jobs = (): ProactiveJob[] => [
    job(PROMISE_SCAN_JOB, async () => {
      const r = await scan();
      return r.skipped === undefined
        ? `promises: ${r.items} items read, ${r.created} new, ${r.merged} merged, ${r.calls} model calls`
        : `promises: skipped (${r.skipped})`;
    }),
    job(PROMISE_SWEEP_JOB, async () => {
      const r = await sweep();
      return `promises: ${r.broken} broken, ${r.warned} warned, ${r.done} done, ${r.offered} nudges offered`;
    }),
  ];
  const ensureSchedules = async (scheduler: SchedulerLike, timezone: string): Promise<void> => {
    const enabled = settings().enabled;
    for (const [name, schedule, title] of [
      [PROMISE_SCAN_JOB, PROMISE_SCAN_SCHEDULE, "Look for promises"],
      [PROMISE_SWEEP_JOB, PROMISE_SWEEP_SCHEDULE, "Check promises"],
    ] as const) {
      const prompt = jobMarker(name, "all");
      const fields = {
        title,
        schedule,
        timezone,
        sessionTarget: "main",
        delivery: {},
        prompt,
        enabled,
        scratch: null,
      };
      const existing = (await scheduler.list()).find((a) => a.prompt.trim() === prompt);
      if (existing === undefined)
        await scheduler.create({ kind: "cron", system: true, ...fields } as never);
      else await scheduler.update(existing.id, fields as never);
    }
  };

  const chat = promiseChatOnThreadEnd({
    enabled: () => settings().enabled && settings().sources.chat,
    snapshot: (id) => snapshotThread(db, id),
    run: (items) => runLane(items),
    ...(deps.logger === undefined ? {} : { log: deps.logger as never }),
  });

  return {
    handlers,
    ledgerOn: () => settings().enabled,
    settings,
    scan,
    sweep,
    briefLines,
    meetingTarget: () => {
      const s = settings();
      if (!s.enabled) return undefined;
      if (!s.sources.meetings) return "off";
      return { store: store(), mutedEntities: mutedEntities(), isExcluded };
    },
    chat,
    jobs,
    ensureSchedules,
    withShims,
    useSources: (sources) => {
      sourceOverride = sources;
    },
    useEvidence: (evidence) => {
      evidenceOverride = evidence;
    },
    offers,
    store,
  };
}
