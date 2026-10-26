import {
  type Clock,
  type FeedPost,
  type MemoryStore,
  type ModelProvider,
  type ModelRef,
  PsycheError,
  type Usage,
} from "@psyche/protocol";
import { ulid } from "ulid";
import { PROACTIVITY_BUDGET } from "../budget.ts";
import {
  cadenceKind,
  jobMarker,
  type LaunchRequest,
  type LaunchResult,
  type ProactiveJob,
  parseJobMarker,
  type SchedulerLike,
} from "../jobs.ts";
import { type SqliteDatabase, toIso } from "../sqlite.ts";
import { createEmbedder, type Embedder } from "./embeddings.ts";
import {
  applyFeedback,
  exclusions,
  type FeedbackKind,
  hiddenHosts,
  type Ledger,
  topics as ledgerTopics,
  parseLedger,
  serializeLedger,
} from "./ledger.ts";
import { rerank, writePost } from "./model.ts";
import {
  cluster,
  gapTopics,
  pickExploration,
  type ScoredCluster,
  scoreClusters,
  seededShuffle,
  seedFrom,
} from "./rank.ts";
import {
  type Candidate,
  collect,
  type FeedSource,
  type FetchLike,
  hostOf,
  type SearchLike,
  type SourceReport,
  searchGaps,
} from "./sources.ts";
import { FeedStore, type StoredPost } from "./store.ts";

/**
 * The Feed (features O5, O6; architecture §4.11; UI §3.9). Pipeline per batch:
 *
 *   interests.md ─▶ topics + embeddings
 *   sources (RSS/Atom, HN, arXiv, saved, accounts) ─▶ candidate pool ─▶ dedupe by url
 *     ─▶ clusters (embedding ≥ 0.82 or same title) ─▶ recall × recency, minus excluded topics
 *     and hidden hosts ─▶ paid search only for uncovered topics (when configured)
 *     ─▶ shortlist (3× the bound) ─▶ seeded shuffle ─▶ utility-model rerank
 *     ─▶ top N−e posts + e exploration slots ─▶ posts written with mandatory citations
 *     ─▶ `feed_posts` rows with `reasons`, one `feed.updated` event.
 *
 * Bounded: `PROACTIVITY_BUDGET.brief` (5–10 posts, 1–2 exploration slots). Attributable: every
 * post has `citations` and `reasons`. Dismissible: `feedback` (undo with `null`). The pipeline
 * reads the web and writes `interests.md` (agent provenance) and its own table; it never sends
 * anything and never runs a tool.
 */

export const FEED_BRIEF_JOB = "feed-brief";
export const FEED_BRIEFING_JOB = "feed-briefing";
export const DAILY_BRIEF_ARG = "daily";
export const DEFAULT_BRIEF_SCHEDULE = "0 7 * * *";
export const LEDGER_PATH = "interests.md";
/**
 * The owner's free-text instructions for the Feed ("what should I write about": interests,
 * sources to favour or avoid, tone, length), edited in the Feed's instructions sheet through
 * `memory.read` / `memory.write` (#614). Read before every batch; its text goes into the rerank
 * and post-writer prompts ahead of the `interests.md` lines. It does not steer recall: "avoid
 * celebrity news" embedded as a focus would pull celebrity news in.
 */
export const FEED_INSTRUCTIONS_PATH = "feed/INSTRUCTIONS.md";
/** Instructions beyond this are cut (the prompt stays small; the editor shows the limit). */
export const MAX_FEED_INSTRUCTIONS = 4_000;
/** A url posted in the last week is not posted again. */
export const NO_REPEAT_DAYS = 7;

export type FeedEvent =
  | { event: "feed.post"; payload: { post: FeedPost } }
  | { event: "feed.updated"; payload: { posts: FeedPost[]; briefingId?: string } };

export interface FeedServiceOptions {
  db: SqliteDatabase;
  clock: Clock;
  scheduler: SchedulerLike;
  memory: Pick<MemoryStore, "readFile" | "writeFile" | "appendDailyNote">;
  /** The utility model for rerank and post writing; without it posts are templated. */
  provider?: ModelProvider;
  model?: ModelRef;
  embeddingModel?: ModelRef;
  /** Overrides the provider's `embed` (tests use the lexical embedder: the fake's is 8-dim). */
  embedder?: Embedder;
  fetch?: FetchLike;
  /** Paid search, used only for gaps and only when configured (architecture §4.11). */
  search?: SearchLike;
  sources?: readonly FeedSource[];
  newId?: () => string;
  timezone?: string;
  onEvent?: (event: FeedEvent) => void;
  maxPosts?: number;
  explorationSlots?: number;
  /** Per-batch model usage, for the owner's usage view (S03 records it). */
  onUsage?: (usage: Usage, job: string) => void;
}

export interface GenerateResult {
  posts: StoredPost[];
  batchId: string;
  reports: SourceReport[];
  usedModel: boolean;
  usage: Usage;
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    costUsd: a.costUsd + b.costUsd,
  };
}

function bad(message: string): never {
  throw new PsycheError("invalid_params", message);
}

export class FeedService {
  readonly store: FeedStore;
  readonly #o: FeedServiceOptions;

  constructor(options: FeedServiceOptions) {
    this.#o = options;
    this.store = new FeedStore(options.db);
  }

  #now(): string {
    return toIso(this.#o.clock.now());
  }

  #id(): string {
    return this.#o.newId?.() ?? ulid(this.#o.clock.now());
  }

  #emit(e: FeedEvent): void {
    this.#o.onEvent?.(structuredClone(e));
  }

  // --- ledger ----------------------------------------------------------------------------------

  async readLedger(): Promise<{ ledger: Ledger; etag?: string }> {
    const file = await this.#o.memory.readFile(LEDGER_PATH);
    if (file === undefined) return { ledger: parseLedger("# Interests\n") };
    return { ledger: parseLedger(file.content), etag: file.etag };
  }

  /**
   * The owner's feed instructions (`feed/INSTRUCTIONS.md`): HTML comments (the template's
   * hints) removed, trimmed, capped at `MAX_FEED_INSTRUCTIONS`; `undefined` when absent or empty.
   */
  async readInstructions(): Promise<string | undefined> {
    const file = await this.#o.memory.readFile(FEED_INSTRUCTIONS_PATH);
    if (file === undefined) return undefined;
    const text = file.content.replace(/<!--[\s\S]*?(-->|$)/g, "").trim();
    if (text === "") return undefined;
    return text.length > MAX_FEED_INSTRUCTIONS
      ? `${text.slice(0, MAX_FEED_INSTRUCTIONS - 1)}…`
      : text;
  }

  async #writeLedger(ledger: Ledger, etag: string | undefined): Promise<void> {
    await this.#o.memory.writeFile(LEDGER_PATH, serializeLedger(ledger), {
      provenance: "agent",
      ...(etag === undefined ? {} : { etag }),
    });
  }

  // --- schedules -------------------------------------------------------------------------------

  async #briefAutomation() {
    const marker = jobMarker(FEED_BRIEF_JOB, DAILY_BRIEF_ARG);
    return (await this.#o.scheduler.list()).find((a) => a.prompt.trim() === marker);
  }

  /** The daily brief as one system `briefing` automation (default 07:00 in the owner's zone). */
  async ensureDailyBrief(
    options: { schedule?: string; timezone?: string; enabled?: boolean } = {},
  ) {
    const fields = {
      title: "Daily brief",
      schedule: options.schedule ?? DEFAULT_BRIEF_SCHEDULE,
      timezone: options.timezone ?? this.#o.timezone ?? "UTC",
      sessionTarget: "main",
      delivery: {},
      prompt: jobMarker(FEED_BRIEF_JOB, DAILY_BRIEF_ARG),
      enabled: options.enabled ?? true,
      scratch: null,
    };
    const existing = await this.#briefAutomation();
    if (existing !== undefined) return this.#o.scheduler.update(existing.id, fields);
    return this.#o.scheduler.create({ kind: "briefing", system: true, ...fields });
  }

  /**
   * A user-defined briefing ("every weekday at 7: two things in robotics"): a `briefing`
   * automation whose prompt carries the marker and the owner's instructions. Delivery (thread,
   * channel) is the scheduler's, so the brief reaches the owner the way O1 automations do.
   */
  async createBriefing(input: {
    title: string;
    schedule: string;
    instructions: string;
    timezone?: string;
    delivery?: { thread?: string; channel?: string; none?: boolean };
  }) {
    if (input.title.trim() === "") bad("title is required");
    if (input.instructions.trim() === "") bad("instructions are required");
    const id = this.#id();
    return this.#o.scheduler.create({
      kind: cadenceKind(input.schedule) === "interval" ? "interval" : "briefing",
      title: input.title.trim(),
      schedule: input.schedule,
      timezone: input.timezone ?? this.#o.timezone ?? "UTC",
      sessionTarget: "main",
      delivery: input.delivery ?? {},
      prompt: `${jobMarker(FEED_BRIEFING_JOB, id)}\n${input.instructions.trim()}`,
      enabled: true,
      scratch: null,
    });
  }

  /** When the next daily brief runs (`feed.list.nextBriefAt`). */
  async nextBriefAt(): Promise<string | null> {
    return (await this.#briefAutomation())?.nextRunAt ?? null;
  }

  // --- the pipeline ----------------------------------------------------------------------------

  async generate(
    options: { briefingId?: string; instructions?: string; signal?: AbortSignal } = {},
  ): Promise<GenerateResult> {
    const now = this.#o.clock.now();
    const batchId = this.#id();
    let instructions = options.instructions;
    if (options.briefingId !== undefined && instructions === undefined) {
      const a = await this.#o.scheduler.get(options.briefingId);
      const marker = a === undefined ? undefined : parseJobMarker(a.prompt);
      if (a === undefined || marker?.job !== FEED_BRIEFING_JOB) {
        throw new PsycheError("not_found", `briefing ${options.briefingId} not found`);
      }
      instructions = marker.rest;
    }
    const max = Math.min(
      this.#o.maxPosts ?? PROACTIVITY_BUDGET.brief.maxPosts,
      options.briefingId === undefined
        ? PROACTIVITY_BUDGET.brief.maxPosts
        : PROACTIVITY_BUDGET.brief.maxBriefingPosts,
    );
    const slots = Math.min(
      PROACTIVITY_BUDGET.brief.explorationSlots.max,
      Math.max(
        PROACTIVITY_BUDGET.brief.explorationSlots.min,
        this.#o.explorationSlots ?? PROACTIVITY_BUDGET.brief.explorationSlots.min,
      ),
    );

    const { ledger } = await this.readLedger();
    const topics = ledgerTopics(ledger);
    const ownerInstructions = await this.readInstructions();
    const embed: Embedder =
      this.#o.embedder ??
      createEmbedder(this.#o.provider, {
        ...(this.#o.embeddingModel === undefined ? {} : { model: this.#o.embeddingModel }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    const topicVectors = await embed(topics.map((t) => t.topic));
    const excluded = exclusions(ledger);
    const excludedVectors = await embed(excluded);
    const focusVector = instructions === undefined ? undefined : (await embed([instructions]))[0];

    const fetch = this.#o.fetch;
    const ctx = {
      fetch: fetch ?? (async () => ({ status: 503, text: "" })),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      now,
      topics,
    };
    const sources =
      fetch === undefined
        ? (this.#o.sources ?? []).filter(
            (s) => !s.id.startsWith("rss:") && s.id !== "hn" && s.id !== "arxiv",
          )
        : (this.#o.sources ?? []);
    const { candidates, reports } = await collect(sources, ctx);

    // No repeats: a url posted in the last week stays out of the pool.
    const recent = this.store.recentUrls(toIso(now - NO_REPEAT_DAYS * 86_400_000));
    const fresh = candidates.filter((c) => !recent.has(c.url));

    const rankInputs = {
      topics,
      topicVectors,
      excluded,
      excludedVectors,
      hiddenHosts: hiddenHosts(ledger),
      now,
      ...(instructions === undefined || focusVector === undefined
        ? {}
        : { focus: { text: instructions, vector: focusVector } }),
    };
    let scored = scoreClusters(await cluster(fresh, embed), rankInputs);

    // Paid search only for gaps, only when configured.
    if (this.#o.search !== undefined && topics.length > 0) {
      const gaps = gapTopics(scored, topics, topicVectors);
      if (gaps.length > 0) {
        try {
          const extra = await searchGaps(this.#o.search, gaps, {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          const pool: Candidate[] = [...fresh, ...extra.filter((c) => !recent.has(c.url))];
          scored = scoreClusters(await cluster(pool, embed), rankInputs);
          reports.push({ source: "search", count: extra.length });
        } catch (e) {
          reports.push({
            source: "search",
            count: 0,
            error: e instanceof Error ? e.message : "failed",
          });
        }
      }
    }

    // Shortlist → seeded shuffle → rerank.
    const shortlistSize = Math.min(scored.length, max * 3);
    const shortlist = seededShuffle(scored.slice(0, shortlistSize), seedFrom(batchId));
    const ranked = await rerank(this.#o.provider, this.#o.model, shortlist, {
      topics,
      ...(ownerInstructions === undefined ? {} : { instructions: ownerInstructions }),
      ...(instructions === undefined ? {} : { focus: instructions }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let usage = ranked.usage;
    const exploration = pickExploration(scored, new Set(), Math.min(slots, max));
    const explorationIds = new Set(exploration.map((k) => k.id));
    const picked: { cluster: ScoredCluster; exploration: boolean }[] = [];
    for (const i of ranked.order) {
      const k = shortlist[i];
      if (k === undefined || explorationIds.has(k.id)) continue;
      if (picked.length >= max - exploration.length) break;
      picked.push({ cluster: k, exploration: false });
    }
    for (const k of exploration) picked.push({ cluster: k, exploration: true });

    // Posts, with citations enforced.
    const posts: StoredPost[] = [];
    const createdAt = this.#now();
    for (const [i, { cluster: k, exploration: isExploration }] of picked.entries()) {
      const written = await writePost(this.#o.provider, this.#o.model, k, {
        ...(ownerInstructions === undefined ? {} : { instructions: ownerInstructions }),
        ...(instructions === undefined ? {} : { focus: instructions }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      usage = addUsage(usage, written.usage);
      const reasons = [
        ...k.reasons,
        ...(isExploration ? ["exploration slot"] : []),
        ranked.usedModel && !isExploration ? `rerank #${i + 1}` : "recall order",
        ...(ownerInstructions !== undefined && ranked.usedModel ? ["feed instructions"] : []),
        written.writer === "model"
          ? "written by the model"
          : `templated${written.rejected === undefined ? "" : ` (model output rejected: ${written.rejected})`}`,
      ];
      const post: StoredPost = {
        id: this.#id(),
        title: written.title,
        bodyMd: written.bodyMd,
        citations: written.citations,
        cluster: {
          size: k.members.length,
          sources: k.members.map((m) => m.source),
          hosts: [...new Set(k.members.map((m) => m.host))],
          ...(k.interest === undefined ? {} : { topic: k.interest.topic }),
        },
        score: Math.round(k.score * 1000) / 1000,
        reasons,
        exploration: isExploration,
        briefingId: options.briefingId ?? null,
        feedback: null,
        createdAt,
        batchId,
      };
      this.store.insert(post);
      posts.push(post);
    }
    this.#o.onUsage?.(usage, options.briefingId === undefined ? "feed.brief" : "feed.briefing");
    if (posts.length > 0) {
      this.#emit({
        event: "feed.updated",
        payload: {
          posts: posts.map(toFeedPost),
          ...(options.briefingId === undefined ? {} : { briefingId: options.briefingId }),
        },
      });
    }
    return { posts, batchId, reports, usedModel: ranked.usedModel, usage };
  }

  // --- read + feedback -------------------------------------------------------------------------

  async list(
    filter: { since?: string; briefingId?: string; cursor?: string; limit?: number } = {},
  ) {
    const page = this.store.list(filter);
    return {
      posts: page.posts.map(toFeedPost),
      nextBriefAt: await this.nextBriefAt(),
      nextCursor: page.nextCursor,
    };
  }

  /** Records feedback in the ledger at once; `null` undoes the previous feedback (UI §3.9). */
  async feedback(params: {
    postId: string;
    feedback: FeedbackKind | null;
    topic?: string;
  }): Promise<{ post: FeedPost; ledgerChanges: string[] }> {
    const post = this.store.get(params.postId);
    if (post === undefined) throw new PsycheError("not_found", `post ${params.postId} not found`);
    const ctx = {
      topics: post.reasons
        .map((r) => /^interest: (.+) \d\.\d\d$/.exec(r)?.[1])
        .filter((t): t is string => t !== undefined && t !== "briefing instructions"),
      hosts: [
        ...new Set(post.citations.map((c) => c.source ?? hostOf(c.url)).filter((h) => h !== "")),
      ],
      title: post.title,
      ...(params.topic === undefined ? {} : { topic: params.topic }),
      ref: `post ${post.id}`,
      date: this.#now().slice(0, 10),
    };
    const changes: string[] = [];
    const apply = async () => {
      const { ledger, etag } = await this.readLedger();
      if (post.feedback != null)
        changes.push(...applyFeedback(ledger, post.feedback, ctx, { undo: true }));
      if (params.feedback !== null) changes.push(...applyFeedback(ledger, params.feedback, ctx));
      if (changes.length > 0) await this.#writeLedger(ledger, etag);
    };
    try {
      await apply();
    } catch (e) {
      // The owner edited the file meanwhile: read it again and apply on top of their edits.
      if (PsycheError.from(e).code !== "conflict") throw e;
      changes.length = 0;
      await apply();
    }
    this.store.setFeedback(post.id, params.feedback);
    if (changes.length > 0) {
      await this.#o.memory.appendDailyNote({
        text: `Feed feedback ${params.feedback ?? "cleared"} on "${post.title.slice(0, 80)}": ${changes.join(" | ")}`,
        provenance: "agent",
      });
    }
    const updated = toFeedPost({ ...post, feedback: params.feedback });
    this.#emit({ event: "feed.post", payload: { post: updated } });
    return { post: updated, ledgerChanges: changes };
  }

  // --- the scheduler job -----------------------------------------------------------------------

  /** Runs the daily brief and user briefings in-process (`withProactiveJobs`). */
  job(): ProactiveJob {
    return {
      name: "feed brief",
      matches: (a) => {
        const job = parseJobMarker(a.prompt)?.job;
        return job === FEED_BRIEF_JOB || job === FEED_BRIEFING_JOB;
      },
      run: (request) => this.#runJob(request),
    };
  }

  async #runJob(request: LaunchRequest): Promise<LaunchResult> {
    const marker = parseJobMarker(request.automation.prompt);
    const briefing = marker?.job === FEED_BRIEFING_JOB;
    const result = await this.generate(
      briefing ? { briefingId: request.automation.id, instructions: marker?.rest ?? "" } : {},
    );
    if (result.posts.length === 0) {
      return { status: "no_reply", summary: `No posts (${describeReports(result.reports)})` };
    }
    // `done` with the deliverable: the scheduler delivers it once (inbox `briefing`, thread or
    // channel), so the pipeline itself never notifies.
    const lines = result.posts.map(
      (p) => `• ${p.title}${p.citations[0] === undefined ? "" : ` — ${p.citations[0].url}`}`,
    );
    return {
      status: "done",
      summary: `${request.automation.title}: ${result.posts.length} posts\n${lines.join("\n")}`,
    };
  }
}

function describeReports(reports: SourceReport[]): string {
  if (reports.length === 0) return "no sources configured";
  return reports
    .map((r) => `${r.source}: ${r.error === undefined ? r.count : `failed, ${r.error}`}`)
    .join(", ");
}

export function toFeedPost(p: StoredPost): FeedPost {
  const { batchId: _batch, readAt: _read, ...post } = p;
  return post;
}
