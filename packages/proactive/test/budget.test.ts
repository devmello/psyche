import { type AgentToolRegistration, defineTool } from "@psyche/agent-core";
import { createPermissionBroker } from "@psyche/permissions";
import type { GraphLoop, ModelEvent, ModelRequest } from "@psyche/protocol";
import { createDbSessionResolver, createDeliverer, SqliteScheduler } from "@psyche/scheduler";
import {
  createIdGenerator,
  FakeClock,
  FakeMemoryStore,
  FakeModelProvider,
  FakeNotifier,
  FakeTaskEngine,
} from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { FeedStore } from "../src/feed/store.ts";
import {
  createEmbedder,
  DigestService,
  FeedService,
  GoalsService,
  hackerNewsSource,
  IdeasService,
  MeetingNotesService,
  MeetingPrepService,
  PROACTIVITY_BUDGET,
  ProposalService,
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

  it("a day of the mail and meeting workflows stays inside their bounds (#670)", async () => {
    const day = Date.parse("2026-10-26T06:00:00Z");
    const clock = new FakeClock(day);
    const db = testDb(clock);
    const notifier = new FakeNotifier({ clock });
    const ids = createIdGenerator({ prefix: "w" });
    const iso = (h: number, m = 0) => new Date(day + ((h - 6) * 60 + m) * 60_000).toISOString();
    const writes: string[] = [];
    const tool = (
      name: string,
      run: (p: Record<string, unknown>) => unknown,
      sideEffect: "read" | "write" = "read",
    ) =>
      defineTool({
        name,
        description: name,
        input: Type.Object({}, { additionalProperties: true }),
        sideEffect,
        run: async (p) => {
          if (sideEffect !== "read") writes.push(name);
          return { output: run(p as Record<string, unknown>), provenance: "untrusted" };
        },
      });
    const inbox = [
      {
        id: "m1",
        from: "Dana <dana@client.example>",
        subject: "Pricing question",
        body: "Can you confirm the price by Friday?",
      },
      {
        id: "m2",
        from: "Lee <lee@vendor.example>",
        subject: "Contract draft",
        body: "Draft attached.",
      },
    ];
    const me = { name: "Sam", email: "sam@acme.example", status: "accepted", organizer: true };
    const events = [
      {
        id: "e1",
        title: "Dana / Sam",
        start: iso(11),
        end: iso(11, 30),
        attendees: [
          me,
          { name: "Dana", email: "dana@client.example", status: "accepted", organizer: false },
        ],
      },
      {
        id: "e2",
        title: "Lee / Sam",
        start: iso(15),
        end: iso(15, 30),
        attendees: [
          me,
          { name: "Lee", email: "lee@vendor.example", status: "accepted", organizer: false },
        ],
      },
    ];
    const tools = new Map<string, AgentToolRegistration>([
      [
        "mail_search",
        tool("mail_search", () => ({
          messages: inbox.map((m) => ({
            id: m.id,
            from: m.from,
            subject: m.subject,
            account: "Work",
            mailbox: "INBOX",
            date: iso(5),
            read: false,
          })),
        })),
      ],
      [
        "mail_read",
        tool("mail_read", (p) => ({ body: inbox.find((m) => m.id === p.id)?.body ?? "" })),
      ],
      [
        "calendar_list_events",
        tool("calendar_list_events", (p) => ({
          events: events.filter((e) => e.end > String(p.from) && e.start < String(p.to)),
        })),
      ],
      ["mail_set_flags", tool("mail_set_flags", () => ({ ok: true }), "write")],
      ["reminders_create", tool("reminders_create", () => ({ id: "r" }), "write")],
      ["mail_send", tool("mail_send", () => ({ ok: true }), "write")],
    ]);
    const lookup = { get: (n: string) => tools.get(n) };
    const say = (text: string): ModelEvent[] => [
      { type: "text_delta", text },
      {
        type: "usage",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
      },
      { type: "finish", reason: "stop" },
    ];
    const provider = new FakeModelProvider();
    for (let i = 0; i < 40; i += 1) {
      provider.enqueue((r: ModelRequest) => {
        const system = r.system ?? "";
        if (system.includes("sort the owner's new email")) {
          return say(
            JSON.stringify([
              {
                n: 1,
                category: "needs_you",
                because: "confirm the price by Friday",
                summary: "Price by Friday",
              },
              { n: 2, category: "fyi", summary: "Contract draft" },
            ]),
          );
        }
        if (system.includes("prepare for a meeting"))
          return say(JSON.stringify({ why: "Follow-up", agenda: [] }));
        return say(
          JSON.stringify({
            summary: ["Agreed on price"],
            decisions: [],
            actionItems: [
              {
                text: "Send the quote",
                owner: "owner",
                quote: "I will send the quote",
                at: "0:10",
              },
            ],
            openQuestions: [],
          }),
        );
      });
    }
    const broker = createPermissionBroker({
      clock,
      approvers: { device: async () => undefined, isOwnerSender: async () => false },
    });
    const proposals = new ProposalService({
      db: db.sqlite,
      clock,
      broker,
      tools: lookup,
      mainThread: async () => "thr_main",
    });
    const feed = new FeedStore(db.sqlite);
    const nudge: GraphLoop = {
      id: "loop_w1",
      direction: "waiting_on",
      text: "Lee to send the signed contract",
      evidence: null,
      counterpartId: null,
      projectId: null,
      dueAt: iso(6),
      status: "open",
      sourceInteractionId: null,
      provenance: "untrusted",
      confidence: 0.9,
      detectedBy: "rule",
      createdAt: iso(6),
      closedAt: null,
      closedBy: null,
    };
    let jobs: ReturnType<typeof withProactiveJobs> | null = null;
    const agent = new RecordingLauncher();
    const scheduler = new SqliteScheduler({
      db,
      clock,
      timers: asleep,
      newId: () => ids.next(),
      launcher: { launch: (r) => (jobs as NonNullable<typeof jobs>).launch(r) },
      sessions: createDbSessionResolver(db),
      notifier,
    });
    const prep = new MeetingPrepService({
      db: db.sqlite,
      clock,
      scheduler,
      tools: lookup,
      feed,
      notifier,
      provider,
      model: "fake/utility",
      ownerAddresses: async () => ["sam@acme.example"],
      timezone: "UTC",
    });
    const digest = new DigestService({
      db: db.sqlite,
      clock,
      scheduler,
      tools: lookup,
      memory: new FakeMemoryStore({ clock }),
      proposals,
      feed,
      notifier,
      provider,
      model: "fake/utility",
      loops: async () => [nudge],
      meetingLines: () => prep.digestLinesToday(),
      timezone: "UTC",
    });
    const notes = new MeetingNotesService({
      clock,
      tools: lookup,
      feed,
      notifier,
      proposals,
      provider,
      primary: "fake/primary",
      timezone: "UTC",
    });
    jobs = withProactiveJobs(agent, { jobs: [prep.job(), digest.job()] });
    await digest.ensureSchedule({ timezone: "UTC" });
    await prep.ensureSchedule({ timezone: "UTC" });

    for (let t = day + 1_800_000; t <= day + 18 * 3_600_000; t += 1_800_000) {
      clock.set(t);
      await scheduler.tick(t);
      await scheduler.idle();
      // After the 11:00 meeting the owner drops its recording in: one notes post.
      if (t === day + 6 * 3_600_000) {
        await notes.fromTranscript({
          segments: [
            { text: "I will send the quote today", startMs: 10_000, endMs: 14_000, final: true },
          ],
          startedAt: iso(11),
          durationMs: 30 * 60_000,
          title: "Dana call",
          provenance: "untrusted",
        });
      }
    }

    const all = await notifier.list();
    const kinds = (k: string) => all.filter((n) => n.kind === k);
    // One digest notification, one prep notification per meeting (≤ 4 a day), one per notes post.
    expect(kinds("briefing")).toHaveLength(PROACTIVITY_BUDGET.mail.digestNotificationsPerDay);
    expect(kinds("reminder")).toHaveLength(2);
    expect(kinds("reminder").length).toBeLessThanOrEqual(
      PROACTIVITY_BUDGET.meetings.prepNotificationsPerDay,
    );
    expect(kinds("task_done")).toHaveLength(
      PROACTIVITY_BUDGET.meetings.notesNotificationsPerRecording,
    );
    const posts = feed.list({}).posts;
    expect(posts.filter((p) => p.kind === "digest")).toHaveLength(1);
    expect(posts.filter((p) => p.kind === "meeting_prep")).toHaveLength(2);
    expect(posts.filter((p) => p.kind === "meeting_notes")).toHaveLength(1);
    const digestCard = posts.find((p) => p.kind === "digest")?.card;
    expect(
      digestCard?.type === "digest" && digestCard.digest.waitingOn.map((w) => w.loop.id),
    ).toEqual(["loop_w1"]);
    // Attributable and dismissible; nothing written or sent; every change waits on a card.
    expect(all.every((n) => typeof n.route === "string" && n.route.startsWith("/"))).toBe(true);
    for (const n of all) await notifier.resolve(n.id);
    expect(await notifier.list({ unresolvedOnly: true })).toEqual([]);
    expect(writes).toEqual([]);
    expect(proposals.list({}).proposals.every((p) => p.status === "pending")).toBe(true);
    expect(agent.requests).toEqual([]);
  });
});
