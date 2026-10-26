import type { FeedbackEvent, FeedbackTarget, GrowthMetric, ModelEvent } from "@psyche/protocol";
import { createIdGenerator, FakeModelProvider, FakePermissionBroker } from "@psyche/testing";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHandlers } from "../src/handlers.ts";
import {
  computeGrowth,
  DEFAULT_TEACHING_SETTINGS,
  type FeedbackContext,
  type GrowthData,
  LessonWriter,
  MIN_EVENTS_FOR_RATE,
  milestones,
  type StoredLesson,
  TeachingService,
  TeachingStore,
} from "../src/teaching/index.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * Growth (§3.4), retention and forgetting (§3.5) of the teaching loop, on fixtures: rates only
 * with enough history, counts beside every rate, the agent against its own previous window,
 * milestones as dated facts; 180-day retention keeps weekly counts; forget-everything restores
 * the owner's files; export and reset cover both tables.
 */

let envs: TestEnv[] = [];
afterEach(async () => {
  for (const e of envs) await e.cleanup();
  envs = [];
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function event(
  id: string,
  kind: FeedbackEvent["kind"],
  daysAgo: number,
  extra: Partial<FeedbackEvent> = {},
): FeedbackEvent {
  return {
    id,
    kind,
    target: { type: "message", id: `m_${id}` },
    text: kind === "correction" ? "Shorter." : null,
    reason: null,
    scope: null,
    detail: null,
    surface: "desktop",
    lessonId: null,
    createdAt: iso(daysAgo),
    ...extra,
  };
}

function lesson(id: string, daysAgo: number, extra: Partial<StoredLesson> = {}): StoredLesson {
  return {
    id,
    kind: "style",
    origin: "stated",
    statement: `Lesson ${id}`,
    scope: { global: true },
    destination: { type: "file", path: "SOUL.md", section: "How I write for you", lineId: id },
    previous: null,
    value: `Lesson ${id}`,
    sources: [],
    confidence: 0.9,
    status: "active",
    refinedCount: 0,
    supersedes: null,
    lastAppliedAt: null,
    createdAt: iso(daysAgo),
    confirmedAt: null,
    forgottenAt: null,
    approvalId: null,
    lastConfirmedAt: null,
    updatedAt: iso(daysAgo),
    ...extra,
  };
}

const empty: GrowthData = {
  now: NOW,
  events: [],
  lessons: [],
  weekly: [],
  approvals: [],
  tasks: [],
  automations: [],
};

const byId = (metrics: GrowthMetric[], id: GrowthMetric["id"]) =>
  metrics.find((m) => m.id === id && m.skill === undefined) as GrowthMetric;

describe("growth.summary (§3.4)", () => {
  it("is empty and honest with no history: zero counts, null rates, no milestones", () => {
    const g = computeGrowth("30d", empty);
    expect(g).toMatchObject({
      window: "30d",
      lessons: { learned: 0, refined: 0, confirmed: 0, forgotten: 0 },
      milestones: [],
      timeline: [],
      since: null,
    });
    for (const m of g.metrics) {
      expect(m).toMatchObject({ count: 0, total: 0, rate: null, previousRate: null });
    }
  });

  it("shows counts but no rate below 10 events, and a rate with the previous window above it", () => {
    // 3 corrections this week, 2 made lessons: counts only.
    const small: GrowthData = {
      ...empty,
      events: [
        event("e1", "correction", 1, { lessonId: "l1" }),
        event("e2", "correction", 2, { lessonId: "l2" }),
        event("e3", "correction", 3),
      ],
      lessons: [lesson("l1", 1, { sources: ["e1"] }), lesson("l2", 2, { sources: ["e2"] })],
    };
    const g = computeGrowth("7d", small);
    expect(byId(g.metrics, "corrections_applied")).toMatchObject({
      count: 2,
      total: 3,
      rate: null,
    });
    expect(byId(g.metrics, "corrections_applied").evidence).toEqual(["l1", "l2"]);
    expect(g.lessons.learned).toBe(2);

    // 12 decided approvals this week (9 unchanged), 10 the week before (5 unchanged).
    const approvals = [
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `a${i}`,
        kind: "send_email",
        status: i < 11 ? "approved" : "denied",
        decidedAt: iso(1),
        scopesOffered: ["once", "task"] as ("once" | "task")[],
        scopeGranted: (i < 9 ? "task" : i < 11 ? "once" : null) as "once" | "task" | null,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `p${i}`,
        kind: "send_email",
        status: "approved",
        decidedAt: iso(10),
        scopesOffered: ["once", "task"] as ("once" | "task")[],
        scopeGranted: (i < 5 ? "task" : "once") as "once" | "task",
      })),
      // A lesson's own card and a plan approval never count.
      {
        id: "lesson_card",
        kind: "memory_protected_write",
        status: "approved",
        decidedAt: iso(1),
        scopesOffered: ["once"] as "once"[],
        scopeGranted: "once" as const,
        fromLesson: { lessonId: "l1" },
      },
    ];
    const g2 = computeGrowth("7d", { ...small, approvals });
    expect(byId(g2.metrics, "approvals_without_change")).toMatchObject({
      count: 9,
      total: 12,
      rate: 0.75,
      previousCount: 5,
      previousTotal: 10,
      previousRate: 0.5,
    });
    expect(
      byId(computeGrowth("all", { ...small, approvals }).metrics, "approvals_without_change"),
    ).toMatchObject({
      previousCount: null,
      previousRate: null,
    });
    expect(MIN_EVENTS_FOR_RATE).toBe(10);
  });

  it("drafts sent as-is come from the weekly send counts minus heavy edits", () => {
    const g = computeGrowth("30d", {
      ...empty,
      weekly: [{ week: "2026-10-19", kind: "draft_sent", count: 12 }],
      events: [event("d1", "draft_edited", 2), event("d2", "draft_edited", 3)],
    });
    expect(byId(g.metrics, "drafts_sent_as_is")).toMatchObject({
      count: 10,
      total: 12,
      rate: 0.833,
    });
    expect(byId(g.metrics, "drafts_sent_as_is").evidence).toEqual(["d1", "d2"]);
  });

  it("repeat corrections: a correction on a destination that already had a lesson", () => {
    const g = computeGrowth("30d", {
      ...empty,
      events: [
        event("e1", "correction", 5, { lessonId: "l1" }),
        event("e2", "correction", 4, { lessonId: "l1" }),
        event("e3", "correction", 3, { lessonId: "l2" }),
      ],
      lessons: [
        lesson("l1", 5, { sources: ["e1", "e2"] }),
        lesson("l2", 3, { sources: ["e3"], refinedCount: 1, supersedes: "l0" }),
      ],
    });
    expect(byId(g.metrics, "repeat_corrections")).toMatchObject({ count: 2, total: 3 });
    expect(byId(g.metrics, "repeat_corrections").evidence.sort()).toEqual(["e2", "e3"]);
    expect(g.lessons.refined).toBe(1);
  });

  it("task success overall and per skill, with counts", () => {
    const tasks = [
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `t${i}`,
        status: "done",
        completedAt: iso(1),
        skill: "expenses",
      })),
      { id: "f1", status: "failed", completedAt: iso(1), skill: "expenses" },
      { id: "c1", status: "cancelled", completedAt: iso(2) },
      { id: "r1", status: "running", completedAt: null },
    ];
    const g = computeGrowth("7d", { ...empty, tasks });
    expect(byId(g.metrics, "task_success")).toMatchObject({ count: 8, total: 10, rate: 0.8 });
    expect(g.metrics.find((m) => m.skill === "expenses")).toMatchObject({
      count: 8,
      total: 9,
      rate: null,
    });
  });

  it("milestones are dated facts; the timeline mixes lessons and milestones newest first", () => {
    const lessons = Array.from({ length: 10 }, (_, i) => lesson(`l${i}`, 40 - i));
    const data: GrowthData = {
      ...empty,
      lessons: [
        ...lessons,
        lesson("declined", 1, { status: "dormant" }),
        lesson("waiting", 1, { status: "proposed" }),
      ],
      startedAt: iso(45),
      automations: [
        { id: "sys", title: "Memory dreaming", createdAt: iso(44), system: true },
        { id: "a1", title: "Morning brief", createdAt: iso(20) },
      ],
      tasks: Array.from({ length: 100 }, (_, i) => ({
        id: `t${i}`,
        status: "done",
        completedAt: iso(30 - i * 0.1),
      })),
    };
    const ms = milestones(data);
    expect(ms.map((m) => m.kind).sort()).toEqual([
      "first_automation",
      "first_lesson",
      "first_month",
      "first_week",
      "lessons_10",
      "tasks_100",
    ]);
    expect(ms.map((m) => m.at)).toEqual([...ms.map((m) => m.at)].sort());
    expect(ms.find((m) => m.kind === "first_automation")).toMatchObject({
      subject: "Morning brief",
      ref: "a1",
    });
    expect(ms.find((m) => m.kind === "lessons_10")?.at).toBe(iso(31));
    const g = computeGrowth("all", data);
    expect(g.lessons.learned).toBe(10); // declined and waiting lessons were never written
    expect(g.timeline.map((t) => t.at)).toEqual([...g.timeline.map((t) => t.at)].sort().reverse());
    expect(g.timeline.some((t) => t.type === "milestone")).toBe(true);
    expect(g.since).toBe(iso(40));
  });
});

// --- Retention, forget everything, export and reset ------------------------------------------

const reply = (lessons: unknown[]): ModelEvent[] => [
  { type: "text_delta", text: JSON.stringify({ lessons }) },
  {
    type: "usage",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];
const message: FeedbackTarget = { type: "message", id: "msg_1", threadId: "thr_1" };
const owner: FeedbackContext = {
  sender: { kind: "device", deviceId: "dev_owner" },
  surface: "desktop",
};

async function setup() {
  const env = await makeEnv();
  envs.push(env);
  const provider = new FakeModelProvider();
  const store = new TeachingStore({ sqlite: env.db.sqlite, clock: env.clock });
  const service = new TeachingService({
    store,
    writer: new LessonWriter({ memory: env.store }),
    broker: new FakePermissionBroker({ clock: env.clock, ids: createIdGenerator() }),
    provider,
    model: "fake/utility",
    clock: env.clock,
    settings: () => DEFAULT_TEACHING_SETTINGS,
    surfaces: ["desktop"],
  });
  const teach = (text: string, person: string) => {
    provider.script([
      reply([{ kind: "style", statement: text, value: text, scope: "person", person }]),
    ]);
    return service.give({ target: message, kind: "correction", text }, owner);
  };
  return {
    env,
    store,
    service,
    teach,
    read: async (p: string) => (await env.store.readFile(p))?.content ?? "",
  };
}

describe("retention and forgetting (§3.5)", () => {
  it("drops feedback older than 180 days and keeps the weekly counts", async () => {
    const h = await setup();
    await h.service.give({ target: message, kind: "helpful" }, owner);
    h.env.clock.advance(181 * DAY);
    await h.service.give({ target: message, kind: "helpful" }, owner);
    expect(h.service.retain()).toBe(1);
    expect(h.store.listEvents().events).toHaveLength(1);
    expect(h.store.weekly().reduce((n, w) => n + w.count, 0)).toBe(2);
  });

  it("forget everything removes every learned line, deletes the feedback and keeps the owner's text", async () => {
    const h = await setup();
    const before = await h.read("USER.md");
    await h.teach("Open with 'Hi Jane'.", "jane@example.com");
    await h.teach("Sign off with '— P'.", "sam@example.com");
    expect(await h.read("USER.md")).toContain("Hi Jane");
    expect(await h.service.forgetAll({ dryRun: true })).toEqual({ lessons: 2, events: 2 });
    expect(await h.service.forgetAll()).toEqual({ lessons: 2, events: 2 });
    const after = await h.read("USER.md");
    expect(after).not.toContain("Hi Jane");
    expect(after).not.toContain("Sign off");
    // Every line the owner had is still there.
    for (const line of before.split("\n").filter((l) => l.trim() !== ""))
      expect(after).toContain(line);
    expect(h.store.listEvents().events).toHaveLength(0);
    expect(h.store.allLessons().every((l) => l.status === "forgotten")).toBe(true);
  });

  it("memory.export adds lessons.json and feedback.json; memory.reset clears both tables", async () => {
    const h = await setup();
    const r = await h.teach("Open with 'Hi Jane'.", "jane@example.com");
    const handlers = createMemoryHandlers(h.env.store, { teaching: h.store });
    const out = await handlers["memory.export"]({} as never);
    const zip = unzipSync(Buffer.from(out.data, "base64"));
    const lessons = JSON.parse(strFromU8(zip["lessons.json"] as Uint8Array)) as { id: string }[];
    const feedback = JSON.parse(strFromU8(zip["feedback.json"] as Uint8Array)) as { id: string }[];
    expect(lessons.map((l) => l.id)).toEqual([r.lesson?.id]);
    expect(feedback.map((e) => e.id)).toEqual([r.event.id]);
    expect(strFromU8(zip["README.txt"] as Uint8Array)).toContain("lessons.json");
    // The export never carries the store's bookkeeping columns.
    expect(Object.keys(lessons[0] as object)).not.toContain("approvalId");

    await handlers["memory.reset"]({ dryRun: true } as never);
    expect(h.store.allLessons()).toHaveLength(1);
    await handlers["memory.reset"]({} as never);
    expect(h.store.allLessons()).toHaveLength(0);
    expect(h.store.listEvents().events).toHaveLength(0);
    expect(h.store.weekly()).toEqual([]);
  });

  it("a draft sent as written counts as an outcome; a heavy edit is draft_edited evidence", async () => {
    const h = await setup();
    const draft: FeedbackTarget = { type: "draft", id: "d1", threadId: "thr_1" };
    expect(
      await h.service.recordDraftSent({ target: draft, editDistance: 0.05 }, owner),
    ).toBeUndefined();
    const edited = await h.service.recordDraftSent(
      {
        target: { ...draft, id: "d2" },
        editDistance: 0.42,
        beforeSha256: "sha256:aa",
        afterSha256: "sha256:bb",
      },
      owner,
    );
    expect(edited).toMatchObject({
      kind: "draft_edited",
      detail: { editDistance: 0.42, beforeSha256: "sha256:aa" },
    });
    expect(h.store.weekly().find((w) => w.kind === "draft_sent")?.count).toBe(2);
  });
});
