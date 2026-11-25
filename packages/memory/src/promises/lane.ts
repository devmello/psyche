import type { Clock } from "@psyche/protocol";
import { sha256 } from "../graph/normalize.ts";
import { findCandidates, judgeSentence, sentencesOf, threadHash } from "./cues.ts";
import { parseDue, resolveDue } from "./due-text.ts";
import {
  buildLanePrompt,
  cleanForPrompt,
  type LaneSnippet,
  type OpenPromise,
  type PromptGroup,
} from "./prompt.ts";
import { parseLaneOutput } from "./schema.ts";
import type { PromiseCitationInput, PromiseInput, PromiseStore } from "./store.ts";
import { type AcceptedItem, validateLaneOutput, whatProblem } from "./validate.ts";

/**
 * The promise lane (design 3.2, 3.3, 3.6): items in, ledger rows out. Two stages with a ledger of
 * what was already read between them.
 *
 * 1. `prefilter` (no model): drop muted threads and people first, then redact, then find cue
 *    sentences and cut snippets. Items with no candidate never reach a model.
 * 2. `extractSnippets`: batches of at most 20 snippets in 6 counterpart groups under 8k tokens,
 *    one tool-less call each, inside the daily budget. What the budget leaves is returned as
 *    `queued` for the 03:00 catch-up, which calls the same function with its own budget.
 *
 * With no model (the setting is None, or `callsPerDay` is 0) `runRulesOnly` reads only the owner's
 * own sentences in sent mail and chat, and opens `suggested` rows at 0.65 (design 3.6).
 *
 * Trust is not decided here. `PromiseStore.add` turns anything not in the owner's own words, and
 * every promise by someone else, into `suggested`; the validator checks what the model said.
 */

export type LaneSource = "mail" | "messages" | "meeting" | "chat";

/** One thing a reader found: a mail body, a message, a notes segment, a chat turn. */
export interface LaneItem {
  source: LaneSource;
  sourceRef: string;
  /** The thread or conversation, for muting and for the quiet-thread match. */
  threadId: string | null;
  /** Who wrote it. `owner` text may be the owner's own words about someone else's promise. */
  author: "owner" | "counterpart";
  counterpartId: string | null;
  counterpartLabel: string | null;
  sentAt: string;
  /** Cleaned text: mail already cut to the author's own words by `graph/own-words.ts`. */
  text: string;
  /** People in the thread, the owner included. Group rules (design 3.1) read it. */
  groupSize?: number;
}

export interface PrefilterOptions {
  redact: (text: string) => string;
  /** `promises.state.mutedThreads`: `sha256(source|threadId)`. */
  mutedThreads?: ReadonlySet<string>;
  /** `promises.state.muted`: entity ids. */
  mutedEntities?: ReadonlySet<string>;
  /** Excluded, hidden or forgotten people (design 7.1). */
  isExcluded?: (entityId: string) => boolean;
  /** `promises.state.cuesOff`. */
  cuesOff?: ReadonlySet<string>;
  seen?: SeenLedger;
}

export interface SeenLedger {
  has(hash: string): boolean;
  add(hash: string): void;
}

export interface PrefilterReport {
  items: number;
  snippets: number;
  muted: number;
  excluded: number;
  groupRules: number;
  seen: number;
  noCandidate: number;
}

const MAX_GROUP_MAIL = 9;
const MAX_GROUP_MESSAGES = 8;

/** A quoted reply or an "On … wrote:" tail belongs to somebody else. */
function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:On .{5,120} wrote:|-{2,}\s*Original Message|From:\s)/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

const reportsOthers = (item: LaneItem): boolean =>
  item.author === "owner" && (item.source === "chat" || item.source === "meeting");

export function prefilter(
  items: readonly LaneItem[],
  options: PrefilterOptions,
): { snippets: LaneSnippet[]; report: PrefilterReport } {
  const report: PrefilterReport = {
    items: items.length,
    snippets: 0,
    muted: 0,
    excluded: 0,
    groupRules: 0,
    seen: 0,
    noCandidate: 0,
  };
  const snippets: LaneSnippet[] = [];
  for (const item of items) {
    // Muted comes first and costs nothing: a muted thread's text is never redacted, split or read.
    if (
      item.threadId !== null &&
      options.mutedThreads?.has(threadHash(item.source, item.threadId)) === true
    ) {
      report.muted++;
      continue;
    }
    if (
      item.counterpartId !== null &&
      (options.mutedEntities?.has(item.counterpartId) === true ||
        options.isExcluded?.(item.counterpartId) === true)
    ) {
      report.excluded++;
      continue;
    }
    // Other people's words are read in one-to-one threads and small groups; a big group's text
    // and any group of Messages beyond the owner's own are not.
    const size = item.groupSize ?? 2;
    if (
      (item.source === "messages" && size > 2 && item.author !== "owner") ||
      (item.source === "messages" && size > MAX_GROUP_MESSAGES) ||
      (item.source === "mail" && size > MAX_GROUP_MAIL)
    ) {
      report.groupRules++;
      continue;
    }
    // Redact first, on the whole item. Everything below, including the 600-character cut, works
    // on redacted text, so a secret cannot straddle a cut (psyche-permissions 3f).
    const safe = options.redact(item.source === "mail" ? stripQuoted(item.text) : item.text);
    const candidates = findCandidates(safe, {
      ...(options.cuesOff === undefined ? {} : { cuesOff: options.cuesOff }),
    });
    if (candidates.length === 0) {
      report.noCandidate++;
      continue;
    }
    for (const c of candidates) {
      const hash = sha256(`${item.source}\n${item.sourceRef}\n${c.snippet}`);
      if (options.seen?.has(hash) === true) {
        report.seen++;
        continue;
      }
      snippets.push({
        hash,
        source: item.source,
        sourceRef: item.sourceRef,
        threadKey: item.threadId,
        author: item.author,
        reportsOthers: reportsOthers(item),
        counterpartId: item.counterpartId,
        counterpartLabel: item.counterpartLabel,
        sentAt: item.sentAt,
        text: c.snippet,
        cue: c.cue,
      });
    }
  }
  report.snippets = snippets.length;
  return { snippets, report };
}

// --- the budget -----------------------------------------------------------------------------

export const DEFAULT_CALLS_PER_DAY = 40;
export const MAX_CALLS_PER_DAY = 200;
export const DEFAULT_TOKENS_PER_DAY = 200_000;

export interface BudgetUsage {
  /** Local calendar day the counts belong to (`YYYY-MM-DD`). */
  day: string;
  calls: number;
  tokens: number;
}

/**
 * Calls and tokens spent today, in the owner's zone. A new local day starts from zero. The caller
 * persists `usage` after each run (`promises.budget` state); the catch-up keeps its own instance.
 */
export class PromiseBudget {
  readonly callsPerDay: number;
  readonly tokensPerDay: number;
  #usage: BudgetUsage;
  readonly #clock: Clock;
  readonly #zone: string;

  constructor(options: {
    callsPerDay?: number;
    tokensPerDay?: number;
    usage?: BudgetUsage;
    clock: Clock;
    zone: string;
  }) {
    this.callsPerDay = Math.min(
      Math.max(0, Math.floor(options.callsPerDay ?? DEFAULT_CALLS_PER_DAY)),
      MAX_CALLS_PER_DAY,
    );
    this.tokensPerDay = Math.max(0, Math.floor(options.tokensPerDay ?? DEFAULT_TOKENS_PER_DAY));
    this.#clock = options.clock;
    this.#zone = options.zone;
    this.#usage = options.usage ?? { day: this.#today(), calls: 0, tokens: 0 };
  }

  #today(): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.#zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(this.#clock.now()));
  }

  #roll(): void {
    const today = this.#today();
    if (this.#usage.day !== today) this.#usage = { day: today, calls: 0, tokens: 0 };
  }

  get usage(): BudgetUsage {
    this.#roll();
    return { ...this.#usage };
  }

  /** Whether one more call of about `estimate` input tokens fits. */
  canSpend(estimate: number): boolean {
    this.#roll();
    return (
      this.#usage.calls < this.callsPerDay && this.#usage.tokens + estimate <= this.tokensPerDay
    );
  }

  record(tokens: number): void {
    this.#roll();
    this.#usage.calls += 1;
    this.#usage.tokens += Math.max(0, Math.floor(tokens));
  }
}

// --- the model stage ------------------------------------------------------------------------

export interface LaneCompleteRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
}
export type LaneComplete = (
  request: LaneCompleteRequest,
) => Promise<{ text: string; tokens?: number }>;

export interface LaneDeps {
  store: PromiseStore;
  redact: (text: string) => string;
  ownerNames: readonly string[];
  zone: string;
  budget: PromiseBudget;
  /** The model call: tool-less, on the utility tier. Absent means the setting is None. */
  complete?: LaneComplete;
  seen?: SeenLedger;
  /** The owner's last "Not a promise" quotes (owner words only). */
  negativeExamples?: () => readonly string[];
  /** Replaces the default open-promise lookup. */
  openPromises?: (counterpartId: string) => OpenPromise[];
  /** Names of other people in the owner's life, so rules-only skips a promise to someone absent. */
  otherPeople?: readonly string[];
}

export const MAX_BATCH_SNIPPETS = 20;
export const MAX_BATCH_GROUPS = 6;
export const MAX_BATCH_TOKENS = 8_000;
const BASE_TOKENS = 1_200;

export interface PendingUpdate {
  loopId: string;
  type: "done" | "renegotiate_agreed" | "release";
  newDue: string | null;
  quote: string;
  source: LaneSource;
  sourceRef: string;
  author: "owner" | "counterpart";
}

export interface LaneReport {
  mode: "model" | "rules";
  calls: number;
  tokens: number;
  failedCalls: number;
  invalidReplies: number;
  created: number;
  merged: number;
  rejected: number;
  proposed: number;
  dropped: Record<string, number>;
  /** Redacted snippets the budget did not reach (or a failed call held back): the catch-up reads them. */
  queued: LaneSnippet[];
  /** Done, agreed and release signals for the done-signal wave; nothing here acts on them. */
  updates: PendingUpdate[];
}

const emptyReport = (mode: LaneReport["mode"]): LaneReport => ({
  mode,
  calls: 0,
  tokens: 0,
  failedCalls: 0,
  invalidReplies: 0,
  created: 0,
  merged: 0,
  rejected: 0,
  proposed: 0,
  dropped: {},
  queued: [],
  updates: [],
});

const CITATION_SOURCE: Record<LaneSource, PromiseCitationInput["source"]> = {
  mail: "mail",
  messages: "messages",
  meeting: "notes",
  chat: "chats",
};

function openPromisesFor(store: PromiseStore, counterpartId: string | null): OpenPromise[] {
  if (counterpartId === null) return [];
  return store
    .list("all", { entityId: counterpartId, limit: 100 })
    .filter((p) => ["suggested", "open", "snoozed", "broken"].includes(p.state))
    .slice(-10)
    .map((p) => ({
      id: p.id,
      promiser: p.direction === "i_owe" ? ("owner" as const) : ("counterpart" as const),
      what: p.text,
      due: p.dueAt === null || p.dueAt === undefined ? null : p.dueAt.slice(0, 10),
    }));
}

const groupKey = (s: LaneSnippet): string =>
  s.counterpartId ?? (s.counterpartLabel === null ? "none" : `label:${s.counterpartLabel}`);

/** Batches within the call limits; a group's snippets may spread over two batches. */
function plan(snippets: readonly LaneSnippet[]): LaneSnippet[][] {
  const byGroup = new Map<string, LaneSnippet[]>();
  for (const s of snippets) {
    const k = groupKey(s);
    byGroup.set(k, [...(byGroup.get(k) ?? []), s]);
  }
  const batches: LaneSnippet[][] = [];
  let current: LaneSnippet[] = [];
  let groups = new Set<string>();
  let tokens = BASE_TOKENS;
  const flush = () => {
    if (current.length > 0) batches.push(current);
    current = [];
    groups = new Set();
    tokens = BASE_TOKENS;
  };
  for (const [key, list] of byGroup) {
    for (const s of list) {
      const cost = Math.ceil(s.text.length / 4) + 70 + (groups.has(key) ? 0 : 300);
      if (
        current.length >= MAX_BATCH_SNIPPETS ||
        (!groups.has(key) && groups.size >= MAX_BATCH_GROUPS) ||
        tokens + cost > MAX_BATCH_TOKENS
      ) {
        flush();
      }
      const fresh = !groups.has(key);
      groups.add(key);
      tokens += Math.ceil(s.text.length / 4) + 70 + (fresh ? 300 : 0);
      current.push(s);
    }
  }
  flush();
  return batches;
}

function toInput(a: AcceptedItem, direction: "i_owe" | "waiting_on"): PromiseInput {
  const s = a.snippet;
  const provenance = s.author === "owner" ? ("owner" as const) : ("untrusted" as const);
  return {
    direction,
    what: a.what,
    counterpartId: s.counterpartId,
    counterpartLabel: s.counterpartLabel,
    ...(a.due.at === null
      ? { dueKind: "none" as const }
      : {
          dueAt: a.due.at,
          dueKind: a.due.kind,
          dueConfidence: a.due.confidence,
        }),
    dueText: a.due.text,
    whatAction: a.action,
    provenance,
    confidence: a.confidence,
    detectedBy: "model",
    sourceKind: s.source,
    threadKey: s.threadKey,
    evidence: a.quote,
    citation: {
      source: CITATION_SOURCE[s.source],
      sourceRef: s.sourceRef,
      quote: a.quote,
      provenance,
      observedAt: s.sentAt,
    },
  };
}

/** Apply what the validator accepted. Returns counts; every write goes through the store. */
function apply(accepted: readonly AcceptedItem[], deps: LaneDeps, report: LaneReport): void {
  const drop = (reason: string) => {
    report.dropped[reason] = (report.dropped[reason] ?? 0) + 1;
  };
  for (const a of accepted) {
    const direction = a.promiser === "owner" ? "i_owe" : "waiting_on";
    const input = toInput(a, direction);
    try {
      if (a.kind === "new") {
        const r = deps.store.add(input);
        if (r.kind === "created") report.created++;
        else if (r.kind === "merged") report.merged++;
        else {
          report.rejected++;
          drop(`store_${r.reason}`);
        }
        continue;
      }
      const target = a.sameAs;
      if (target === undefined) continue;
      if (a.kind === "same_as") {
        deps.store.mention(target.loopId, input);
        report.merged++;
        continue;
      }
      const u = a.update;
      if (u === null) continue;
      if (u.type === "renegotiate_proposed" && u.newDue !== null) {
        const sentAt = Date.parse(a.snippet.sentAt);
        const when = resolveDue(
          { text: null, date: u.newDue, time: null, kind: "explicit", confidence: 0.8 },
          Number.isNaN(sentAt) ? Date.now() : sentAt,
          deps.zone,
        );
        if (when.at === null) {
          drop("update_bad_date");
          continue;
        }
        deps.store.renegotiateProposed(target.loopId, {
          proposedDueAt: when.at,
          citation: input.citation as PromiseCitationInput,
          by: "model",
        });
        report.proposed++;
        continue;
      }
      // Done, agreed and release belong to the done-signal wave: they are returned, not applied.
      if (u.type !== "renegotiate_proposed") {
        report.updates.push({
          loopId: target.loopId,
          type: u.type,
          newDue: u.newDue,
          quote: a.quote,
          source: a.snippet.source,
          sourceRef: a.snippet.sourceRef,
          author: a.snippet.author,
        });
      }
    } catch {
      // A promise closed or deleted since the model saw it: this item is moot, the rest go on.
      drop("store_error");
    }
  }
}

/**
 * Reads prefiltered snippets with the model, inside the budget. Snippets are marked seen once a
 * call has completed (even with an unusable reply, so a hostile snippet cannot cost a call a day);
 * snippets a call failed on, or the budget did not reach, come back in `queued`.
 */
export async function extractSnippets(
  snippets: readonly LaneSnippet[],
  deps: LaneDeps,
  options: { signal?: AbortSignal } = {},
): Promise<LaneReport> {
  const report = emptyReport("model");
  const complete = deps.complete;
  if (complete === undefined) {
    report.queued = [...snippets];
    return report;
  }
  const batches = plan(snippets);
  for (const [bi, batch] of batches.entries()) {
    const keys = [...new Set(batch.map(groupKey))];
    const groups: PromptGroup[] = keys.map((key) => {
      const members = batch.filter((s) => groupKey(s) === key);
      const cid = members[0]?.counterpartId ?? null;
      const open =
        cid === null ? [] : (deps.openPromises?.(cid) ?? openPromisesFor(deps.store, cid));
      return { key, open, snippets: members };
    });
    const prompt = buildLanePrompt(groups, {
      ownerNames: deps.ownerNames,
      zone: deps.zone,
      redact: deps.redact,
      ...(deps.negativeExamples === undefined ? {} : { negativeExamples: deps.negativeExamples() }),
    });
    if (options.signal?.aborted === true || !deps.budget.canSpend(prompt.estimatedTokens)) {
      // The rest waits for the catch-up. Nothing is dropped.
      report.queued.push(...batches.slice(bi).flat());
      break;
    }
    let reply: { text: string; tokens?: number };
    try {
      reply = await complete({ system: prompt.system, user: prompt.user, maxOutputTokens: 1_500 });
    } catch {
      report.failedCalls++;
      report.queued.push(...batch);
      continue;
    }
    const used = reply.tokens ?? prompt.estimatedTokens + Math.ceil(reply.text.length / 4);
    deps.budget.record(used);
    report.calls++;
    report.tokens += used;
    for (const s of batch) deps.seen?.add(s.hash);
    const output = parseLaneOutput(reply.text);
    if (output === undefined) {
      report.invalidReplies++;
      continue;
    }
    const checked = validateLaneOutput(output, prompt, { timeZone: deps.zone });
    for (const [reason, n] of Object.entries(checked.dropped)) {
      report.dropped[reason] = (report.dropped[reason] ?? 0) + n;
    }
    apply(checked.accepted, deps, report);
  }
  return report;
}

// --- rules only -----------------------------------------------------------------------------

export const RULES_CONFIDENCE = 0.65;

const SEND_WORDS = /\b(?:send|share|forward|email|mail|attach)\b/i;

function mentionsOther(sentence: string, names: readonly string[]): boolean {
  const folded = sentence.toLowerCase();
  return names.some((n) => n.trim().length >= 3 && folded.includes(n.trim().toLowerCase()));
}

/**
 * No model (design 3.6): the cues and the due parser on the owner's own sentences in sent mail
 * and chat open `i_owe` rows as `suggested`, at confidence 0.65. Other people's words are never
 * read, and neither are Messages or meeting notes, which need the model to attribute who spoke.
 */
export function runRulesOnly(
  items: readonly LaneItem[],
  deps: LaneDeps & PrefilterOptions,
): LaneReport {
  const report = emptyReport("rules");
  const eligible = items.filter(
    (i) => i.author === "owner" && (i.source === "mail" || i.source === "chat"),
  );
  // Same gates as the model path, so the two modes mute and exclude identically.
  const { snippets } = prefilter(eligible, deps);
  const byHash = new Map(snippets.map((s) => [s.hash, s]));
  for (const s of byHash.values()) {
    // The snippet may hold neighbours; the promise is the sentence that carries the cue.
    for (const sentence of sentencesOf(s.text)) {
      const verdict = judgeSentence(sentence, {
        requireObject: true,
        ...(deps.cuesOff === undefined ? {} : { cuesOff: deps.cuesOff }),
      });
      if (verdict === null) continue;
      if (mentionsOther(sentence, deps.otherPeople ?? [])) {
        report.dropped.other_person = (report.dropped.other_person ?? 0) + 1;
        continue;
      }
      const tail = sentence.slice(verdict.at);
      const what = (
        verdict.lang === "en"
          ? tail.replace(/^(?:i'll|i will|i'm going to|i am going to|i'm gonna|let me)\s+/i, "")
          : tail
      )
        .replace(/[.!\s]+$/, "")
        .slice(0, 120)
        .trim();
      const problem = whatProblem(what);
      if (problem !== undefined) {
        report.dropped[problem] = (report.dropped[problem] ?? 0) + 1;
        continue;
      }
      const sentAt = Date.parse(s.sentAt);
      const due = parseDue(sentence, Number.isNaN(sentAt) ? Date.now() : sentAt, deps.zone);
      const quote = cleanForPrompt(deps.redact, sentence, 200);
      const r = deps.store.add({
        direction: "i_owe",
        what,
        counterpartId: s.counterpartId,
        counterpartLabel: s.counterpartLabel,
        ...(due.at === null
          ? { dueKind: "none" as const }
          : { dueAt: due.at, dueKind: due.kind, dueConfidence: due.confidence }),
        whatAction: SEND_WORDS.test(what) ? "send" : "do",
        provenance: "owner",
        confidence: RULES_CONFIDENCE,
        detectedBy: "rule",
        sourceKind: s.source,
        threadKey: s.threadKey,
        evidence: quote,
        citation: {
          source: CITATION_SOURCE[s.source],
          sourceRef: s.sourceRef,
          quote,
          provenance: "owner",
          observedAt: s.sentAt,
        },
      });
      if (r.kind === "created") report.created++;
      else if (r.kind === "merged") report.merged++;
      else report.rejected++;
    }
    deps.seen?.add(s.hash);
  }
  return report;
}

/** Items in, ledger rows out: the model path when a model and budget exist, rules-only otherwise. */
export async function runPromiseLane(
  items: readonly LaneItem[],
  deps: LaneDeps & PrefilterOptions,
  options: { signal?: AbortSignal } = {},
): Promise<LaneReport> {
  if (deps.complete === undefined || deps.budget.callsPerDay === 0)
    return runRulesOnly(items, deps);
  const { snippets } = prefilter(items, deps);
  return extractSnippets(snippets, deps, options);
}
