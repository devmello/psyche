import { createHash } from "node:crypto";
import type {
  Clock,
  EverythingMemorySettings,
  GraphEntity,
  ModelProvider,
  ModelRef,
  QuarantineReason,
} from "@psyche/protocol";
import type Database from "better-sqlite3";
import type { EverythingStore } from "../graph/everything.ts";
import { normalizeName } from "../graph/normalize.ts";
import type { GraphStore } from "../graph/store.ts";
import { cleanItemText } from "./clean.ts";
import { callExtractor } from "./extractor.ts";
import { checkGates, type GateReason, type SystemState } from "./gates.ts";
import { EXTRACT_SYSTEM_PROMPT, estimateExtractTokens } from "./prompt.ts";
import {
  citationSource,
  type ItemReader,
  type OwnerItem,
  READABLE_SOURCES,
  type ReadableSource,
  type ReaderCursor,
} from "./reader.ts";
import { screenItem } from "./screen.ts";
import { createExtractionSink } from "./sink.ts";
import {
  type BatchCandidate,
  type BatchItem,
  newNightLimits,
  type OwnerProposal,
  rejectBatch,
  type ValidationSettings,
  validateExtraction,
} from "./validate.ts";

/**
 * The nightly everything-memory pass over the owner's OWN items (docs/design/everything-memory-2026.md
 * §6, §13 EM3). Third-party text is not read here (EM5): the reader only returns provenance
 * `owner`. Every model output goes through `validateExtraction` and the `ExtractionSink`.
 */

export const MAX_ITEMS_PER_BATCH = 8;
export const MAX_TOKENS_PER_BATCH = 6000;
export const PAGE_ITEMS = 40;
/** Missed nights catch up this many days at a time, oldest first (§6.1). */
export const CATCH_UP_DAYS = 3;
/** A local model's time box per night (§6.6). */
export const LOCAL_TIME_BOX_MS = 45 * 60_000;
const MIN_ITEM_CHARS = 20;
const DAY_MS = 86_400_000;
/** Output allowance counted against the budget per batch when no usage is reported. */
const OUTPUT_ALLOWANCE = 600;

export interface ModelChoice {
  provider: ModelProvider;
  model: ModelRef;
}

export interface PassDeps {
  graph: GraphStore;
  em: EverythingStore;
  /** The same database as `graph` (for the extracted-items cache). */
  sqlite: Database.Database;
  reader: ItemReader;
  settings: EverythingMemorySettings;
  state: SystemState;
  clock: Clock;
  timeZone: string;
  /** The model for a kind; undefined while none is configured for it. */
  modelFor: (kind: "cloud" | "local") => ModelChoice | undefined;
  /** The owner confirmed the local-model RAM warning. */
  localModelConfirmed?: boolean;
  localModelBytes?: number;
  manual?: boolean;
  signal?: AbortSignal;
  /**
   * The existing people-graph model pass, folded into the same window and budget (§6.8). Gets
   * the tokens left tonight; returns what it used. Skipped when the model setting is `none`.
   */
  graphModelPass?: (tokensLeft: number) => Promise<{ tokens: number }>;
  /** Facts the owner stated about themselves: proposals for USER.md review, never graph facts. */
  onOwnerProposals?: (proposals: OwnerProposal[]) => void;
  localMinutes?: number;
}

export interface PassReport {
  ran: boolean;
  /** Why it did not run. */
  gate?: GateReason | "no_owner_entity";
  runId?: string;
  itemsRead: number;
  itemsFiltered: number;
  batches: number;
  tokensIn: number;
  tokensOut: number;
  factsStored: number;
  edgesStored: number;
  dropped: Record<string, number>;
  quarantined: number;
  /** Items left for tomorrow because the budget, the time box or the catch-up window ended. */
  deferred: number;
  ownerProposals: OwnerProposal[];
  error: string | null;
}

const empty = (): PassReport => ({
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
  error: null,
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const cursorKey = (s: ReadableSource) => `everything:${s}`;

export function validationSettings(settings: EverythingMemorySettings): ValidationSettings {
  return {
    sensitive: settings.sensitive,
    // Facts one person's text asserts about another: third-party text only, off until EM5.
    allowAboutOther: false,
    autoAcceptOwnerAuthored: settings.review.autoAcceptOwnerAuthored,
  };
}

function modelKindFor(
  settings: EverythingMemorySettings,
  source: ReadableSource,
): "none" | "cloud" | "local" {
  const per = (
    settings.model.perSource as Record<string, { kind: "none" | "cloud" | "local" }> | undefined
  )?.[source];
  return (per ?? settings.model.default).kind;
}

/** People whose full name or alias appears in the text, if that name is unique among people. */
class NameIndex {
  readonly #byName = new Map<string, GraphEntity | null>();

  constructor(people: GraphEntity[]) {
    for (const p of people) {
      if (p.isOwner || p.status !== "active" || p.hidden) continue;
      for (const n of [p.name, ...p.aliases]) {
        const key = words(n);
        if (key.length < 3 || !key.includes(" ")) continue; // full names only: "Sam" alone is ambiguous
        const had = this.#byName.get(key);
        this.#byName.set(key, had === undefined || had?.id === p.id ? p : null);
      }
    }
  }

  find(text: string, cap = 6): GraphEntity[] {
    const hay = ` ${words(text)} `;
    const out = new Map<string, GraphEntity>();
    for (const [name, p] of this.#byName) {
      if (p !== null && hay.includes(` ${name} `)) out.set(p.id, p);
      if (out.size >= cap) break;
    }
    return [...out.values()];
  }
}

function words(s: string): string {
  return normalizeName(s)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface Prepared {
  item: BatchItem;
  mentions: GraphEntity[];
  group: string;
  tokens: number;
}

/** Runs the pass if the gates allow it. Never throws on a model or source problem. */
export async function runEverythingPass(deps: PassDeps): Promise<PassReport> {
  const { settings, graph, em } = deps;
  const report = empty();
  const now = deps.clock.now();
  const gate = checkGates({
    settings,
    state: deps.state,
    localMinutes: deps.localMinutes ?? 0,
    localModelConfirmed: deps.localModelConfirmed === true,
    ...(deps.localModelBytes === undefined ? {} : { localModelBytes: deps.localModelBytes }),
    ...(deps.manual === undefined ? {} : { manual: deps.manual }),
  });
  if (!gate.ok) return { ...report, gate: gate.reason };
  const owner = graph.ownerEntity();
  if (owner === undefined) return { ...report, gate: "no_owner_entity" };

  const sources = READABLE_SOURCES.filter(
    (s) => settings.sources[s] === true && modelKindFor(settings, s) !== "none",
  );
  const choices = new Map<ReadableSource, ModelChoice>();
  for (const s of sources) {
    const kind = modelKindFor(settings, s) as "cloud" | "local";
    const choice = deps.modelFor(kind);
    if (choice !== undefined) choices.set(s, choice);
  }
  const runModel = [...choices.values()][0]?.model ?? null;
  const runId = em.startRun({ model: runModel, sources: [...choices.keys()] });
  report.ran = true;
  report.runId = runId;

  const sink = createExtractionSink(em, { runId, extractor: runModel ?? "unknown" });
  const limits = newNightLimits();
  const vset = validationSettings(settings);
  const names = new NameIndex(graph.listEntities(["person"]));
  const budget = settings.maxTokensPerNight;
  const localStarted = now;
  const usesLocal = [...choices.keys()].some((s) => modelKindFor(settings, s) === "local");
  let stopped = false;
  const stopReason = (): boolean =>
    stopped ||
    deps.signal?.aborted === true ||
    (usesLocal && deps.clock.now() - localStarted > LOCAL_TIME_BOX_MS) ||
    report.tokensIn + report.tokensOut >= budget;

  try {
    for (const [source, choice] of choices) {
      if (stopReason()) {
        stopped = true;
        break;
      }
      const stored = graph.cursor(cursorKey(source)) as ReaderCursor | null | undefined;
      let cursor: ReaderCursor = stored ?? {
        updatedMs: now - Number(settings.schedule.backfillDays) * DAY_MS,
        rowid: 0,
      };
      for (;;) {
        if (stopReason()) {
          stopped = true;
          break;
        }
        const page = deps.reader.read(source, cursor, {
          limit: PAGE_ITEMS,
          windowDays: CATCH_UP_DAYS,
        });
        if (page.next === undefined) break;
        report.itemsRead += page.items.length + page.skippedUntrusted;
        report.itemsFiltered += page.skippedUntrusted;
        const prepared = prepare(page.items, deps, names, report, sink);
        const batches = groupBatches(prepared);
        const need = batches.reduce(
          (n, b) =>
            n +
            b.reduce((m, p) => m + p.tokens, 0) +
            estimateExtractTokens(EXTRACT_SYSTEM_PROMPT) +
            OUTPUT_ALLOWANCE,
          0,
        );
        if (report.tokensIn + report.tokensOut + need > budget && batches.length > 0) {
          // The rest waits for tomorrow: the cursor stays before this page.
          report.deferred += prepared.length;
          stopped = true;
          break;
        }
        for (const batch of batches) {
          await runBatch(batch, choice, deps, owner, sink, limits, vset, runId, report);
        }
        cursor = page.next;
        graph.setCursor(cursorKey(source), cursor);
        if (!page.hasMore) break;
      }
    }
    if (deps.graphModelPass !== undefined && !stopped && choices.size > 0) {
      const left = budget - report.tokensIn - report.tokensOut;
      if (left > 0) {
        const used = await deps.graphModelPass(left).catch(() => ({ tokens: 0 }));
        report.tokensOut += used.tokens;
      }
    }
    em.runRetention({
      pendingDays: settings.retention.pendingDays,
      untrustedAcceptedMonths: settings.retention.untrustedAcceptedMonths,
      quarantineDays: settings.retention.quarantineDays,
      runLogDays: settings.retention.runLogDays,
    });
  } catch (err) {
    report.error = err instanceof Error ? err.message.slice(0, 300) : "failed";
  }
  if (deps.onOwnerProposals !== undefined && report.ownerProposals.length > 0) {
    deps.onOwnerProposals(report.ownerProposals);
  }
  em.finishRun(runId, {
    itemsRead: report.itemsRead,
    itemsFiltered: report.itemsFiltered,
    batches: report.batches,
    tokensIn: report.tokensIn,
    tokensOut: report.tokensOut,
    factsProposed: report.factsStored + report.edgesStored,
    factsDropped: report.dropped,
    quarantined: report.quarantined,
    deferred: report.deferred,
    error: report.error,
  });
  return report;
}

/** Pre-filter (§6.3) and cleaning. Items the model never needs to see are settled here. */
function prepare(
  items: OwnerItem[],
  deps: PassDeps,
  names: NameIndex,
  report: PassReport,
  sink: ReturnType<typeof createExtractionSink>,
): Prepared[] {
  const out: Prepared[] = [];
  const seen = deps.sqlite.prepare(
    "SELECT source_hash FROM memory_extracted_items WHERE source = ? AND source_ref = ?",
  );
  for (const it of items) {
    const cleaned = cleanItemText(`${it.title}\n\n${it.body}`.trim(), { format: "text" });
    if (cleaned.text.length < MIN_ITEM_CHARS) {
      report.itemsFiltered++;
      continue;
    }
    const hash = sha(cleaned.text);
    const prior = seen.get(it.source, it.docId) as { source_hash: string } | undefined;
    if (prior?.source_hash === hash && !deps.em.isReleased(citationSource(it.source), it.docId)) {
      report.itemsFiltered++;
      continue;
    }
    const mentions = names.find(cleaned.text);
    const item: BatchItem = {
      handle: "",
      source: citationSource(it.source),
      sourceRef: it.docId,
      trust: "owner",
      authorHandle: "p0",
      participantHandles: [],
      mentionHandles: [],
      text: cleaned.text,
      sourceHash: hash,
      observedAt: new Date(it.createdMs).toISOString(),
      hiddenRemoved: cleaned.hiddenRemoved,
      rawLength: cleaned.rawLength,
      visibleLength: cleaned.visibleLength,
    };
    const screened = screenItem({
      text: item.text,
      trust: "owner",
      hiddenRemoved: cleaned.hiddenRemoved,
    }).reasons as QuarantineReason[];
    if (screened.length > 0) {
      // The model never sees an item that trips the deterministic screen.
      sink.quarantine({
        source: item.source,
        sourceRef: item.sourceRef,
        reasons: screened,
        excerpt: item.text.slice(0, 300),
      });
      report.quarantined++;
      markExtracted(deps, item, report.runId);
      continue;
    }
    out.push({
      item,
      mentions,
      group: it.threadId ?? `${it.source}:${new Date(it.createdMs).toISOString().slice(0, 10)}`,
      tokens: estimateExtractTokens(item.text) + 30,
    });
  }
  return out;
}

function markExtracted(deps: PassDeps, item: BatchItem, runId: string | undefined): void {
  deps.sqlite
    .prepare(
      `INSERT INTO memory_extracted_items (source, source_ref, source_hash, run_id, extracted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source, source_ref) DO UPDATE SET source_hash = excluded.source_hash,
         run_id = excluded.run_id, extracted_at = excluded.extracted_at`,
    )
    .run(
      item.source,
      item.sourceRef,
      item.sourceHash,
      runId ?? null,
      new Date(deps.clock.now()).toISOString(),
    );
}

/** Items of one conversation or day together, up to 8 items or ~6k tokens a call (§6.4). */
export function groupBatches(prepared: Prepared[]): Prepared[][] {
  const byGroup = new Map<string, Prepared[]>();
  for (const p of prepared) {
    const list = byGroup.get(p.group) ?? [];
    list.push(p);
    byGroup.set(p.group, list);
  }
  const batches: Prepared[][] = [];
  for (const list of byGroup.values()) {
    let cur: Prepared[] = [];
    let tokens = 0;
    for (const p of list) {
      if (
        cur.length >= MAX_ITEMS_PER_BATCH ||
        (cur.length > 0 && tokens + p.tokens > MAX_TOKENS_PER_BATCH)
      ) {
        batches.push(cur);
        cur = [];
        tokens = 0;
      }
      cur.push(p);
      tokens += p.tokens;
    }
    if (cur.length > 0) batches.push(cur);
  }
  return batches;
}

async function runBatch(
  batch: Prepared[],
  choice: ModelChoice,
  deps: PassDeps,
  owner: GraphEntity,
  sink: ReturnType<typeof createExtractionSink>,
  limits: ReturnType<typeof newNightLimits>,
  vset: ValidationSettings,
  runId: string,
  report: PassReport,
): Promise<void> {
  // Opaque handles: p0 is the owner, then each person named in the batch; i1.. are the items.
  const people = new Map<string, { handle: string; entity: GraphEntity }>();
  const candidates: BatchCandidate[] = [{ handle: "p0", entityId: owner.id, isOwner: true }];
  const items: BatchItem[] = batch.map((p, i) => {
    const mentionHandles: string[] = [];
    for (const m of p.mentions) {
      let h = people.get(m.id);
      if (h === undefined) {
        h = { handle: `p${people.size + 1}`, entity: m };
        people.set(m.id, h);
        candidates.push({ handle: h.handle, entityId: m.id, isOwner: false });
      }
      mentionHandles.push(h.handle);
    }
    return { ...p.item, handle: `i${i + 1}`, mentionHandles, participantHandles: mentionHandles };
  });
  const listing = [
    { handle: "p0", name: owner.name, isOwner: true },
    ...[...people.values()].map((p) => ({ handle: p.handle, name: p.entity.name, isOwner: false })),
  ];
  report.batches++;
  let failures = 0;
  for (;;) {
    const result = await callExtractor({
      provider: choice.provider,
      model: choice.model,
      items,
      people: listing,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    // Providers that report usage are trusted; otherwise estimate from what was sent.
    report.tokensIn +=
      result.tokensIn > 0
        ? result.tokensIn
        : estimateExtractTokens(items.map((i) => i.text).join("")) +
          estimateExtractTokens(EXTRACT_SYSTEM_PROMPT);
    report.tokensOut += result.tokensIn > 0 ? result.tokensOut : OUTPUT_ALLOWANCE / 2;
    if (result.ok) {
      const v = validateExtraction({
        output: result.output,
        items,
        candidates,
        sink,
        settings: vset,
        limits,
        now: deps.clock.now(),
      });
      report.factsStored += v.factsStored;
      report.edgesStored += v.edgesStored;
      report.quarantined += v.quarantined.length;
      for (const [k, n] of Object.entries(v.dropped))
        report.dropped[k] = (report.dropped[k] ?? 0) + n;
      report.ownerProposals.push(...v.ownerProposals);
      break;
    }
    failures++;
    report.dropped[`batch_${result.reason}`] = (report.dropped[`batch_${result.reason}`] ?? 0) + 1;
    if (rejectBatch(items, sink, failures)) {
      report.quarantined += items.length;
      break;
    }
  }
  for (const it of items) markExtracted(deps, it, runId);
}

/**
 * The pass as a nightly step: runs inside the dreaming window after the graph poll (§6.1) and
 * returns one diary line. `deps` is read fresh each night, so a changed setting takes effect then.
 */
export function everythingNightlyStep(deps: () => PassDeps): () => Promise<string | undefined> {
  return async () => {
    const r = await runEverythingPass(deps());
    if (!r.ran) return undefined;
    const bits = [`${r.factsStored} facts proposed from ${r.itemsRead} items`];
    if (r.quarantined > 0) bits.push(`${r.quarantined} quarantined`);
    if (r.deferred > 0) bits.push(`${r.deferred} left for tomorrow`);
    if (r.error !== null) bits.push("stopped early");
    return `everything memory: ${bits.join(", ")}`;
  };
}
