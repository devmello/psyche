import type { AgentToolRegistry } from "@psyche/agent-core";
import { getSetting, type PsycheDb } from "@psyche/db";
import type { SqliteMemoryStore } from "@psyche/memory";
import type { PsycheNotifier } from "@psyche/notifications";
import type { PsychePermissionBroker } from "@psyche/permissions";
import {
  appleMailSource,
  arxivSource,
  createFeedHandlers,
  createGoalHandlers,
  createIdeaHandlers,
  createProposalHandlers,
  FeedService,
  type FeedSource,
  GoalsService,
  gmailSource,
  HEARTBEAT_TASK_BUDGET,
  hackerNewsSource,
  IdeasService,
  MailWatcher,
  ProposalService,
  publicFetch,
  rssSource,
  type SignalsProvider,
  withProactiveJobs,
} from "@psyche/proactive";
import type { Clock, EventName, EventPayload, ModelProvider, ModelRef } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import {
  createDbSessionResolver,
  createTaskLauncher,
  type RunLauncher,
  type SqliteScheduler,
} from "@psyche/scheduler";
import type { SqliteTaskEngine, TaskWorkerPool } from "@psyche/tasks";
import type { Call, HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import { mountParamsOnly, surfaceOf } from "./handlers.ts";

/**
 * Proactive surfaces (S15; features O2, O5–O9): goals with check-ins on the scheduler, the
 * Feed (daily brief and briefings run in-process by the pipeline, posts and feedback over
 * `feed.*`), Ideas (nightly mining at 02:30 and a 09:00 delivery window, `ideas.*`; accepted
 * ideas become task cards in the main thread or automations), and the heartbeat on a launcher bounded by `HEARTBEAT_TASK_BUDGET` (under 5k tokens
 * per run). Proactive automations are recognised by their prompt marker and run in-process (no
 * agent turn); everything else reaches the agent launcher unchanged.
 *
 * Feed sources come from the `feed.sources` setting (admin-only):
 * `{ rss?: string[], hackerNews?: boolean, arxiv?: boolean }`; default Hacker News and arXiv on.
 * Network reads use `publicFetch` until S09 exports its SSRF-policed fetch.
 */

export interface FeedSourcesSetting {
  rss?: string[];
  hackerNews?: boolean;
  arxiv?: boolean;
}

export function feedSourcesFrom(value: unknown): FeedSource[] {
  const s = (value ?? {}) as FeedSourcesSetting;
  const out: FeedSource[] = [];
  for (const url of Array.isArray(s.rss) ? s.rss : []) {
    if (typeof url === "string" && /^https?:\/\//.test(url)) out.push(rssSource(url));
  }
  if (s.hackerNews !== false) out.push(hackerNewsSource());
  if (s.arxiv !== false) out.push(arxivSource());
  return out;
}

export interface ProactiveSetup {
  db: PsycheDb;
  clock: Clock;
  scheduler: SqliteScheduler;
  notifier: PsycheNotifier;
  tasks: SqliteTaskEngine;
  memory: SqliteMemoryStore;
  /** The utility model for the Feed's rerank and post writing. */
  provider: ModelProvider;
  model: ModelRef;
  publish<E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string): void;
  timeZone?: string;
  logger?: Logger;
  /** Connector signals for Ideas (unanswered mail, subscriptions, trips); S09 supplies them. */
  signals?: SignalsProvider;
  /** Batch proposals (mail and meeting workflows §8.1): the broker the composition hands out. */
  broker?: PsychePermissionBroker;
  /** The loop's tool registry: approved proposals run their calls through it. */
  registry?: AgentToolRegistry;
}

export interface ComposedProactive {
  readonly goals: GoalsService;
  readonly feed: FeedService;
  readonly ideas: IdeasService;
  /** The new-mail poller (mail and meeting workflows §4.7); it reads mail only for listeners. */
  readonly mailWatch: MailWatcher;
  /** Batch proposals, when the composition gave a broker and a registry. */
  readonly proposals: ProposalService | undefined;
  readonly handlers: Record<string, HandlerDef>;
  /** The scheduler's launcher: proactive jobs in-process, the heartbeat bounded, the rest to `inner`. */
  launcher(inner: RunLauncher, pool: TaskWorkerPool): RunLauncher;
  /** After the Gateway listens: re-create check-ins the scheduler lost, drop orphans. */
  start(): Promise<void>;
  stop(): void;
}

export function composeProactive(setup: ProactiveSetup): ComposedProactive {
  const {
    db,
    clock,
    scheduler,
    notifier,
    tasks,
    memory,
    provider,
    model,
    publish,
    timeZone,
    logger,
    signals,
    broker,
    registry,
  } = setup;
  const goals = new GoalsService({
    db: db.sqlite,
    clock,
    scheduler,
    notifier,
    tasks,
    ...(timeZone === undefined ? {} : { timezone: timeZone }),
    onEvent: (e) => publish(e.event, e.payload),
  });
  const feed = new FeedService({
    db: db.sqlite,
    clock,
    scheduler,
    memory,
    provider,
    model,
    fetch: publicFetch(),
    sources: feedSourcesFrom(getSetting(db, "feed.sources")?.value),
    ...(timeZone === undefined ? {} : { timezone: timeZone }),
    onEvent: (e) => publish(e.event, e.payload as never),
  });
  const sessions = createDbSessionResolver(db);
  const ideas = new IdeasService({
    db: db.sqlite,
    clock,
    scheduler,
    tasks,
    // Accepted ideas land in the owner's main thread as task cards (O8).
    mainThread: () => sessions.resolve("main", { automation: {} as never, runId: "" }),
    memory,
    goals,
    notifier,
    ...(signals === undefined ? {} : { signals }),
    ...(timeZone === undefined ? {} : { timezone: timeZone }),
    onEvent: (e) => publish(e.event, e.payload),
    onError: (err) =>
      logger?.log("warn", "idea mining step failed", { code: PsycheError.from(err).code }),
  });
  const proposals =
    broker === undefined || registry === undefined
      ? undefined
      : new ProposalService({
          db: db.sqlite,
          clock,
          broker,
          tools: registry,
          mainThread: () => sessions.resolve("main", { automation: {} as never, runId: "" }),
          onEvent: (e) => publish(e.event, e.payload),
          onError: (err) =>
            logger?.log("warn", "proposal run failed", { code: PsycheError.from(err).code }),
        });
  // Wave 1 has no push for new mail: poll through whichever mail tools are connected (§4.7).
  const mailWatch = new MailWatcher({
    scheduler,
    clock,
    sources: () =>
      registry === undefined ? [] : [appleMailSource(registry), gmailSource(registry)],
    ...(timeZone === undefined ? {} : { timezone: timeZone }),
    onError: (err) => logger?.log("warn", "mail poll failed", { code: PsycheError.from(err).code }),
  });
  const proposalHandlers: Record<string, HandlerDef> = {};
  if (proposals !== undefined) {
    // `proposals.approve` hands the caller the answer token of its own surface only (§3.7).
    for (const [name, fn] of Object.entries(createProposalHandlers(proposals))) {
      proposalHandlers[name] = {
        run: (call: Call, params: never) =>
          (fn as (p: unknown, c: { surface: string }) => Promise<unknown>)(params, {
            surface: surfaceOf(db, call.identity.deviceId),
          }),
      };
    }
  }
  return {
    goals,
    feed,
    ideas,
    mailWatch,
    proposals,
    handlers: {
      ...mountParamsOnly(createGoalHandlers(goals) as never),
      ...mountParamsOnly(createFeedHandlers(feed) as never),
      ...mountParamsOnly(createIdeaHandlers(ideas) as never),
      ...proposalHandlers,
    },
    launcher: (inner, pool) =>
      withProactiveJobs(inner, {
        jobs: [goals.checkinJob(), feed.job(), ideas.job(), mailWatch.job()],
        heartbeat: createTaskLauncher({ engine: tasks, pool, budget: HEARTBEAT_TASK_BUDGET }),
        onError: (err) =>
          logger?.log("warn", "proactive job failed", { code: PsycheError.from(err).code }),
      }),
    async start() {
      try {
        await goals.start();
        await feed.ensureDailyBrief();
        await ideas.ensureSchedules();
        await mailWatch.ensureSchedule();
      } catch (err) {
        logger?.log("warn", "proactive schedule sync failed", { code: PsycheError.from(err).code });
      }
    },
    stop() {
      proposals?.stop();
    },
  };
}
