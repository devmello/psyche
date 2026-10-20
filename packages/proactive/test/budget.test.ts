import { createDbSessionResolver, createDeliverer, SqliteScheduler } from "@psyche/scheduler";
import {
  createIdGenerator,
  FakeClock,
  FakeMemoryStore,
  FakeNotifier,
  FakeTaskEngine,
} from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  createEmbedder,
  FeedService,
  GoalsService,
  hackerNewsSource,
  IdeasService,
  PROACTIVITY_BUDGET,
  rssSource,
  withProactiveJobs,
} from "../src/index.ts";
import { fixtureFetch, INTERESTS } from "./fixtures/feeds.ts";
import { asleep, RecordingLauncher, T0, testDb } from "./helpers.ts";

/**
 * The proactivity audit (architecture §2 principle 10, ADR-012, security §3): one simulated day
 * with every proactive producer on one real scheduler, driven tick by tick. Every item must be
 * bounded, attributable and dismissible, and nothing proactive may send, write a task, or reach
 * the agent except the heartbeat's light, budgeted run.
 */
describe("proactivity budget audit", () => {
  it("a full day of heartbeat, check-ins, watches, the brief and ideas stays inside the budget", async () => {
    const clock = new FakeClock(T0);
    const db = testDb(clock);
    const notifier = new FakeNotifier({ clock });
    const tasks = new FakeTaskEngine({ clock });
    const memory = new FakeMemoryStore({
      clock,
      files: {
        "interests.md": INTERESTS,
        "memory/2026-10-17.md":
          "# 2026-10-17\n\n- 09:00 [owner] I need to renew my passport.\n- 09:10 [owner] I want to learn the piano.\n",
        "memory/2026-10-18.md":
          "# 2026-10-18\n\n- 09:00 [owner] I need to renew my passport soon.\n- 09:10 [owner] I want to learn the piano this winter.\n",
      },
    });
    const agent = new RecordingLauncher();
    const heartbeat = new RecordingLauncher();
    let beats = 0;
    heartbeat.respond = () =>
      ++beats === 3
        ? { status: "done", summary: "Your 3pm moved to 4pm." }
        : { status: "no_reply", summary: null };
    const sends: string[] = [];
    let price = "$120";
    const ids = createIdGenerator({ prefix: "s" });
    const { fetch } = fixtureFetch();
    let jobs: ReturnType<typeof withProactiveJobs> | null = null;
    const scheduler = new SqliteScheduler({
      db,
      clock,
      timers: asleep,
      newId: () => ids.next(),
      launcher: {
        launch: (r) => (jobs as NonNullable<typeof jobs>).launch(r),
      },
      sessions: createDbSessionResolver(db),
      notifier,
      deliverer: createDeliverer({
        notifier,
        sendToChannel: async (_c, text) => void sends.push(text),
      }),
      watchFetch: async () => ({ status: 200, text: `fee: ${price}` }),
    });
    const goals = new GoalsService({
      db: db.sqlite,
      clock,
      scheduler,
      notifier,
      tasks,
      timezone: "UTC",
    });
    const feed = new FeedService({
      db: db.sqlite,
      clock,
      scheduler,
      memory,
      embedder: createEmbedder(undefined),
      fetch,
      sources: [rssSource("https://robotreport.example/feed"), hackerNewsSource()],
      timezone: "UTC",
    });
    const sessions = createDbSessionResolver(db);
    const ideas = new IdeasService({
      db: db.sqlite,
      clock,
      scheduler,
      tasks,
      mainThread: () => sessions.resolve("main", { automation: {} as never, runId: "" }),
      memory,
      goals,
      notifier,
      signals: async () =>
        Array.from({ length: 8 }, (_, i) => ({
          source: "billing",
          kind: "subscription" as const,
          ref: `s${i}`,
          title: `Service ${i}`,
        })),
      timezone: "UTC",
    });
    jobs = withProactiveJobs(agent, {
      jobs: [goals.checkinJob(), feed.job(), ideas.job()],
      heartbeat,
    });

    // Everything a real Gateway schedules.
    await scheduler.ensureHeartbeat({
      everyMinutes: 30,
      activeHours: { start: 8, end: 22 },
      timezone: "UTC",
    });
    const { goal } = await goals.create({
      title: "Run a half marathon",
      category: "health",
      cadence: "0 8 * * *",
      milestones: [{ title: "10k" }],
    });
    await goals.addWatch(goal.id, {
      url: "https://race.example/fee",
      check: "price_below",
      selector: "fee:",
      threshold: 100,
      every: "PT6H",
    });
    await feed.ensureDailyBrief({ timezone: "UTC" });
    await ideas.ensureSchedules({ timezone: "UTC" });

    // One day in 30-minute ticks; the price drops in the afternoon.
    for (let t = T0 + 1_800_000; t <= T0 + 24 * 3_600_000; t += 1_800_000) {
      clock.set(t);
      if (t >= T0 + 7 * 3_600_000) price = "$95";
      await scheduler.tick(t);
      await scheduler.idle();
    }

    const all = await notifier.list();
    const byKind = (k: string) => all.filter((n) => n.kind === k);
    const heartbeatRuns = scheduler.runs(
      (await scheduler.list({ kind: "heartbeat" }))[0]?.id ?? "",
    ).runs;
    expect(heartbeatRuns.length).toBe(heartbeat.requests.length);
    expect(heartbeat.requests.every((r) => r.lightContext)).toBe(true);
    // Heartbeat: at most one notification per run, none for NO_REPLY.
    expect(all.filter((n) => n.body === "Your 3pm moved to 4pm.")).toHaveLength(1);
    // Check-ins: one reminder row per goal (dedupe), however many runs.
    expect(byKind("reminder")).toHaveLength(1);
    // Watch: the price drop produced one alert.
    expect(all.filter((n) => n.body.startsWith("Price 95"))).toHaveLength(1);
    // Brief: one briefing notification, 5–10 cited, reasoned posts at most.
    expect(byKind("briefing")).toHaveLength(1);
    const { posts } = await feed.list();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.length).toBeLessThanOrEqual(PROACTIVITY_BUDGET.brief.maxPosts);
    expect(posts.every((p) => p.citations.length > 0 && p.reasons.length > 0)).toBe(true);
    expect(posts.filter((p) => p.exploration).length).toBeLessThanOrEqual(
      PROACTIVITY_BUDGET.brief.explorationSlots.max,
    );
    // Ideas: one window, at most perWindow delivered, each with evidence.
    const delivered = (await ideas.list()).ideas;
    expect(delivered.length).toBeLessThanOrEqual(PROACTIVITY_BUDGET.ideas.perWindow);
    expect(delivered.length).toBeGreaterThan(0);
    expect(
      delivered.every(
        (i) =>
          i.evidence.length > 0 && i.acceptanceProb >= PROACTIVITY_BUDGET.ideas.minAcceptanceProb,
      ),
    ).toBe(true);
    expect(all.filter((n) => n.route === "/ideas")).toHaveLength(1);
    // Goal candidates: confirm-first and bounded.
    const candidates = await goals.list({ status: ["candidate"] });
    expect(candidates.map((g) => g.title)).toEqual(["Learn the piano"]);
    expect(candidates.length).toBeLessThanOrEqual(PROACTIVITY_BUDGET.goals.maxOpenCandidates);

    // Attributable: every notification routes to what raised it. Dismissible: all resolve.
    expect(all.every((n) => typeof n.route === "string" && n.route.startsWith("/"))).toBe(true);
    for (const n of all) await notifier.resolve(n.id);
    expect(await notifier.list({ unresolvedOnly: true })).toEqual([]);
    for (const p of posts) await feed.feedback({ postId: p.id, feedback: "not_interested" });
    for (const i of delivered) await ideas.dismiss(i.id, "not_now");
    await goals.decide(candidates[0]?.id ?? "", "reject");

    // Nothing proactive sent, created work, or reached the agent beyond the heartbeat.
    expect(sends).toEqual([]);
    expect(await tasks.list()).toEqual([]);
    expect(agent.requests).toEqual([]);
    expect(all.filter((n) => n.kind === "approval")).toEqual([]);
    // Total interruptions for the day, all kinds together: small and countable.
    expect(all.length).toBeLessThanOrEqual(5);
  });
});
