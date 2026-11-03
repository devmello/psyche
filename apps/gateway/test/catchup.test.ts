import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setSetting } from "@psyche/db";
import { type AgentMemoryAccess, EverythingStore, GraphStore } from "@psyche/memory";
import {
  DailyService,
  FollowupStore,
  feedTools,
  readDailySettings,
  type StoredPost,
} from "@psyche/proactive";
import { type DailyBrief, PsycheError, validateResult } from "@psyche/protocol";
import { createSearchIndex, feedDoc, searchEverything } from "@psyche/search";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Catchup,
  composeCatchup,
  readSurfaceSettings,
  readWorkSettings,
} from "../src/compose/catchup.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Monday 2 Nov 2026, noon UTC. */
const NOW = Date.parse("2026-11-02T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const LOCAL_ACCESS: AgentMemoryAccess = {
  mode: "accepted",
  seesSensitive: false,
  sourceAllowed: () => true,
};

function setup() {
  const clock = new FakeClock(NOW - 2 * DAY);
  const db = openDb(":memory:");
  const graph = new GraphStore({ sqlite: db.sqlite, clock });
  const em = new EverythingStore({ sqlite: db.sqlite, graph, clock });
  let access: AgentMemoryAccess = LOCAL_ACCESS;
  const catchup = composeCatchup({
    db,
    clock,
    graph,
    em,
    access: () => access,
    timeZone: () => "UTC",
  });

  // The world: written five days ago, so everything since is "what changed".
  const course = graph.createEntity({ kind: "project", name: "MATH 21", projectType: "course" });
  const assignment = (name: string, dueAt: string, parent?: string) => {
    const a = graph.createEntity({ kind: "assignment", name, dueAt });
    if (parent !== undefined)
      graph.setEdge({ src: a.id, rel: "part_of", dst: parent, provenance: "owner" });
    return a;
  };
  const hw7 = assignment("Lecture Work 7", "2026-11-05T23:59:00.000Z", course.id);
  const deck = assignment("Q3 board deck", "2026-11-03T08:00:00.000Z");
  const quiz = assignment("Quiz 3", "2026-11-02T20:00:00.000Z");
  const chem = assignment("CHEM lab report", "2026-11-01T12:00:00.000Z");
  const person = (name: string, email: string) =>
    graph.createEntity({ kind: "person", name, identifiers: [{ kind: "email", value: email }] });
  const sam = person("Sam", "sam@example.com");
  const ava = person("Ava", "ava@example.com");
  const quinn = person("Professor Quinn", "quinn@example.com");
  graph.setFact({ entityId: ava.id, attribute: "birthday", value: "Nov 5", provenance: "owner" });
  graph.setFact({ entityId: ava.id, attribute: "city", value: "Santa Cruz", provenance: "owner" });
  graph.setEdge({ src: hw7.id, rel: "assigned_by", dst: quinn.id, provenance: "owner" });
  const party = graph.createEntity({
    kind: "event",
    name: "Ava's surprise party",
    dueAt: "2026-11-04T18:00:00.000Z",
  });
  const midterm = graph.createEntity({
    kind: "event",
    name: "Midterm",
    dueAt: "2026-11-04T17:00:00.000Z",
  });
  graph.setEdge({ src: midterm.id, rel: "part_of", dst: course.id, provenance: "owner" });
  graph.setFact({
    entityId: hw7.id,
    attribute: "stopped_at",
    value: "problem 4b",
    provenance: "owner",
  });
  graph.upsertInteraction({
    kind: "chat",
    source: "psyche",
    externalRef: "c1",
    occurredAt: iso(NOW - 3 * HOUR),
    direction: "both",
    subject: "chat",
    gist: "Ava is going through a divorce",
    participants: [{ entityId: ava.id, role: "from" }],
    subjects: [{ entityId: hw7.id, linkedBy: "owner" }],
  });
  graph.upsertInteraction({
    kind: "file",
    source: "files",
    externalRef: "f1",
    occurredAt: iso(NOW - HOUR),
    direction: "none",
    subject: "MATH21/hw7.tex",
    link: "file:///Users/me/MATH21/hw7.tex",
    participants: [],
    subjects: [{ entityId: hw7.id, linkedBy: "rule" }],
  });
  graph.upsertInteraction({
    kind: "mail",
    source: "apple:mail",
    externalRef: "m1",
    occurredAt: iso(NOW - 2 * HOUR),
    direction: "in",
    subject: "Updated numbers attached",
    threadKey: "t1",
    participants: [{ entityId: sam.id, role: "from" }],
    subjects: [{ entityId: deck.id, linkedBy: "rule" }],
  });
  graph.suggest({
    kind: "assignment",
    entityIds: [course.id],
    name: "Lecture Work 8",
    reason: "From Canvas mail",
    dueAt: "2026-11-03T12:00:00.000Z",
  });
  clock.set(NOW);

  const comingUpBase = () => [
    { text: "Ava turns 7 on Friday (Nov 5)", link: `/agent/soul?entity=${ava.id}` },
    { text: "Ava's surprise party on Wednesday", link: `/agent/soul?entity=${party.id}` },
    { text: "Midterm on Wednesday", link: `/agent/soul?entity=${midterm.id}` },
  ];
  const keepBase = () => [
    { text: "You haven't replied to Sam in 9 days.", link: `/agent/soul?entity=${sam.id}` },
  ];
  const posts: StoredPost[] = [];
  const reminders = {
    execute: async () => ({
      output: { reminders: [{ title: "Lecture Work 7" }, { title: "Pay rent" }] },
    }),
  };
  const daily = new DailyService({
    clock,
    scheduler: undefined as never,
    tools: { get: (n: string) => (n === "reminders_list" ? (reminders as never) : undefined) },
    feed: { insert: (p) => void posts.push(p as StoredPost) },
    settings: () => ({
      ...readDailySettings({ get: () => undefined }),
      notify: false,
    }),
    followups: new FollowupStore({ get: () => undefined, set: () => {} }, () => clock.now()),
    timezone: "UTC",
    newId: () => "post_1",
    comingUp: catchup.comingUp(comingUpBase),
    keepInTouch: catchup.keepInTouch(keepBase),
    catchUp: catchup.daily,
  });
  const on = (work: Record<string, unknown> = {}) =>
    setSetting(db, "memory.work", { enabled: true, ...work });
  return {
    clock,
    db,
    graph,
    em,
    catchup,
    daily,
    posts,
    on,
    setAccess: (a: AgentMemoryAccess) => {
      access = a;
    },
    ids: { course, hw7, deck, quiz, chem, sam, ava, quinn, party, midterm },
  };
}

type World = ReturnType<typeof setup>;
const call = <M extends "memory.catchup.list" | "memory.catchup.act" | "memory.catchup.seen">(
  c: Catchup,
  method: M,
  params: Record<string, unknown>,
) => {
  const def = c.handlers[method] as unknown as {
    run: (c: unknown, p: unknown) => Promise<unknown>;
  };
  return def.run({}, params).then((r) => {
    validateResult(method, r);
    return r;
  }) as Promise<never>;
};
const list = async (w: World, surface: "home" | "brief", limit?: number) =>
  (await call(w.catchup, "memory.catchup.list", {
    surface,
    ...(limit === undefined ? {} : { limit }),
  })) as {
    items: { entityId: string; title: string; line: string; changes: unknown[]; status: string }[];
    pendingCount: number;
    hiddenCount: number;
  };
const sectionOf = (b: DailyBrief, id: string) => b.sections.find((s) => s.id === id);

describe("settings", () => {
  it("read as the owner's decisions when nothing is stored", () => {
    expect(readWorkSettings(() => undefined)).toEqual({
      enabled: false,
      remind: { enabled: false, dueSoonHours: 24, at: "wrapup", dayOf: false },
    });
    const s = readSurfaceSettings(() => undefined);
    expect(s.birthdays).toBe(true);
    expect(s.tiers.people.brief).toBe(false);
  });

  it("read the stored object and the flat keys, flat winning", () => {
    const store: Record<string, unknown> = {
      "memory.work": { enabled: true, remind: { enabled: false, dueSoonHours: 12 } },
      "memory.work.remind.enabled": true,
      "memory.surfaces.tiers.people.brief": true,
    };
    const get = (k: string) => store[k];
    expect(readWorkSettings(get)).toMatchObject({
      enabled: true,
      remind: { enabled: true, dueSoonHours: 12 },
    });
    expect(readSurfaceSettings(get).tiers.people.brief).toBe(true);
    expect(readWorkSettings(() => 5).enabled).toBe(false);
  });
});

describe("memory.catchup.list", () => {
  it("is empty while work memory is off", async () => {
    const w = setup();
    expect(await list(w, "brief")).toMatchObject({ items: [], pendingCount: 0 });
  });

  it("ranks the open work, ask first, with pending counted and never listed", async () => {
    const w = setup();
    w.on();
    const out = await list(w, "brief");
    expect(out.items.map((i) => i.title)).toEqual([
      "CHEM lab report",
      "Q3 board deck",
      "Quiz 3",
      "Lecture Work 7",
    ]);
    expect(out.items[0]).toMatchObject({
      line: "Did you finish CHEM lab report? It was due yesterday.",
      status: "overdue",
    });
    expect(out.items[1]?.line).toBe(
      "Q3 board deck: due tomorrow, not started. New: Sam: “Updated numbers attached” (Mon)",
    );
    expect(out.items[3]?.line).toBe(
      "MATH 21 · Lecture Work 7: due Thu, in progress. You stopped at problem 4b.",
    );
    expect(out.pendingCount).toBe(1);
    expect(JSON.stringify(out)).not.toContain("Lecture Work 8");
  });

  it("gives Home at most three, and respects a smaller limit", async () => {
    const w = setup();
    w.on();
    expect((await list(w, "home")).items).toHaveLength(3);
    expect((await list(w, "brief", 2)).items).toHaveLength(2);
  });

  it("leaves out Keep private items and honours the kind switch", async () => {
    const w = setup();
    w.on();
    w.graph.updateEntity(w.ids.deck.id, { private: true });
    expect((await list(w, "brief")).items.map((i) => i.title)).not.toContain("Q3 board deck");
    setSetting(w.db, "memory.surfaces", { kinds: { assignment: false } });
    expect((await list(w, "brief")).items.map((i) => i.title)).toEqual(["Midterm"]);
  });

  it("shows no mail subject once the work-mail tier is off for the brief", async () => {
    const w = setup();
    w.on();
    setSetting(w.db, "memory.surfaces", { tiers: { workMail: { brief: false } } });
    const text = JSON.stringify(await list(w, "brief"));
    expect(text).not.toContain("Updated numbers");
    expect(text).toContain("Q3 board deck");
  });
});

describe("memory.catchup.act and seen", () => {
  it("done, submitted and drop go through the status state machine and leave the list", async () => {
    const w = setup();
    w.on();
    await call(w.catchup, "memory.catchup.act", { entityId: w.ids.chem.id, action: "submitted" });
    expect(w.graph.getEntity(w.ids.chem.id)?.workStatus).toBe("submitted");
    await call(w.catchup, "memory.catchup.act", { entityId: w.ids.deck.id, action: "drop" });
    expect(w.graph.getEntity(w.ids.deck.id)?.workStatus).toBe("dropped");
    const res = await call(w.catchup, "memory.catchup.act", {
      entityId: w.ids.hw7.id,
      action: "done",
    });
    expect((res as { entity: { workStatus: string } }).entity.workStatus).toBe("done");
    expect((await list(w, "brief")).items.map((i) => i.title)).toEqual(["Quiz 3", "Midterm"]);
  });

  it("answers the past-due ask: a new date moves it, no date brings it back tomorrow", async () => {
    const w = setup();
    w.on();
    await call(w.catchup, "memory.catchup.act", {
      entityId: w.ids.chem.id,
      action: "still_working",
      until: "2026-11-09T12:00:00.000Z",
    });
    expect(w.graph.getEntity(w.ids.chem.id)?.dueAt).toBe("2026-11-09T12:00:00.000Z");
    expect(w.graph.getEntity(w.ids.chem.id)?.workStatus).toBe("not_started");
    const items = (await list(w, "brief")).items;
    expect(items.find((i) => i.title === "CHEM lab report")?.line).toBe(
      "CHEM lab report: due Nov 9, not started.",
    );

    await call(w.catchup, "memory.catchup.act", {
      entityId: w.ids.quiz.id,
      action: "still_working",
    });
    expect((await list(w, "brief")).items.map((i) => i.title)).not.toContain("Quiz 3");
    w.clock.advance(DAY + HOUR);
    // Silence never changes status.
    expect(w.graph.getEntity(w.ids.quiz.id)?.workStatus).toBe("not_started");
  });

  it("snoozes until a time, and refuses a time in the past", async () => {
    const w = setup();
    w.on();
    await call(w.catchup, "memory.catchup.act", {
      entityId: w.ids.deck.id,
      action: "snooze",
      until: iso(NOW + 6 * HOUR),
    });
    expect((await list(w, "brief")).items.map((i) => i.title)).not.toContain("Q3 board deck");
    w.clock.advance(7 * HOUR);
    expect((await list(w, "brief")).items.map((i) => i.title)).toContain("Q3 board deck");
    const bad = call(w.catchup, "memory.catchup.act", {
      entityId: w.ids.deck.id,
      action: "snooze",
      until: iso(NOW - HOUR),
    });
    await expect(bad).rejects.toBeInstanceOf(PsycheError);
  });

  it("refuses to hand in a project, and an entity that is not work", async () => {
    const w = setup();
    w.on();
    const submit = call(w.catchup, "memory.catchup.act", {
      entityId: w.ids.course.id,
      action: "submitted",
    });
    await expect(submit).rejects.toMatchObject({ code: "invalid_params" });
    const person = call(w.catchup, "memory.catchup.act", {
      entityId: w.ids.ava.id,
      action: "done",
    });
    await expect(person).rejects.toMatchObject({ code: "not_found" });
  });

  it("seen advances 'what changed' and counts only work items", async () => {
    const w = setup();
    w.on();
    const before = (await list(w, "brief")).items.find((i) => i.title === "Q3 board deck");
    expect(before?.changes).toHaveLength(1);
    const res = await call(w.catchup, "memory.catchup.seen", {
      entityIds: [w.ids.deck.id, w.ids.ava.id, "nope"],
    });
    expect(res).toEqual({ seen: 1 });
    const after = (await list(w, "brief")).items.find((i) => i.title === "Q3 board deck");
    expect(after?.changes).toEqual([]);
    expect(after?.line).toBe("Q3 board deck: due tomorrow, not started.");
  });
});

describe("the brief", () => {
  it("shows Catching up from the fixtures, in the place of due", async () => {
    const w = setup();
    w.on();
    const brief = await w.daily.assemble("morning");
    // No calendar or mail connector in the fixtures, so those two say so and nothing else.
    expect(brief.sections.map((s) => s.id)).toEqual([
      "calendar",
      "mail",
      "catching_up",
      "followups",
      "coming_up",
    ]);
    expect(sectionOf(brief, "due")).toBeUndefined();
    const items = sectionOf(brief, "catching_up")?.items ?? [];
    expect(items.map((i) => i.text)).toEqual([
      "Did you finish CHEM lab report? It was due yesterday.",
      "Q3 board deck: due tomorrow, not started. New: Sam: “Updated numbers attached” (Mon)",
      "Quiz 3: due today, not started.",
      "MATH 21 · Lecture Work 7: due Thu, in progress. You stopped at problem 4b.",
      // The reminder "Lecture Work 7" is covered by its line; "Pay rent" is not work.
      "Pay rent",
      "1 new to-do to confirm",
    ]);
    expect(items[0]?.link).toBe(`/memory?entity=${w.ids.chem.id}`);
    expect(items.at(-1)?.link).toBe("/memory/review");
  });

  it("with work off, due is unchanged", async () => {
    const w = setup();
    const brief = await w.daily.assemble("morning");
    expect(sectionOf(brief, "catching_up")).toBeUndefined();
    expect(sectionOf(brief, "due")?.items.map((i) => i.text)).toEqual([
      "Lecture Work 7",
      "Pay rent",
    ]);
    setSetting(w.db, "memory.work", { enabled: false });
    expect((await w.daily.assemble("morning")).sections.map((s) => s.id)).toContain("due");
  });

  it("the wrap-up lists what was worked on today and what is due tomorrow", async () => {
    const w = setup();
    w.on();
    const brief = await w.daily.assemble("evening");
    expect(sectionOf(brief, "worked_on")?.items.map((i) => i.text)).toEqual([
      "MATH 21 · Lecture Work 7: edited files, chatted with Psyche.",
    ]);
    expect(sectionOf(brief, "tomorrow")?.items.map((i) => i.text)).toEqual([
      expect.stringContaining("Q3 board deck: due tomorrow"),
      "Quiz 3: due today, not started.",
    ]);
    expect(brief.sections.length).toBeLessThanOrEqual(8);
  });
});

describe("with the people tier off, no person fact, gist or relation appears on any surface", () => {
  const FORBIDDEN = [
    "Santa Cruz",
    "divorce",
    "Professor Quinn",
    "Quinn",
    "assigned",
    "surprise party",
    "haven't replied",
  ];

  function everySurface(w: World) {
    const out: Record<string, unknown> = {};
    for (const surface of ["brief", "channel"] as const) {
      out[`morning:${surface}`] = w.catchup.daily.morning(surface);
      out[`evening:${surface}`] = w.catchup.daily.evening(surface);
      out[`coming:${surface}`] = w.catchup.comingUp(() => [
        { text: "Ava turns 7 on Friday (Nov 5)", link: `/agent/soul?entity=${w.ids.ava.id}` },
        { text: "Ava's surprise party on Wednesday", link: `/agent/soul?entity=${w.ids.party.id}` },
      ])?.(surface);
      out[`keep:${surface}`] = w.catchup.keepInTouch(() => [
        { text: "You haven't replied to Sam", link: `/agent/soul?entity=${w.ids.sam.id}` },
      ])?.(surface);
    }
    return out;
  }

  it("on every surface", async () => {
    const w = setup();
    w.on({ remind: { enabled: true, dayOf: true } });
    const home = await list(w, "home");
    const brief = await list(w, "brief");
    const text = JSON.stringify({
      home,
      brief,
      ...everySurface(w),
      notice: w.catchup.daily.notice("wrapup"),
    });
    for (const word of FORBIDDEN) expect(text).not.toContain(word);
    // The one people-tier thing allowed by default is the birthday date (W1), in the brief only.
    const coming = everySurface(w);
    expect(JSON.stringify(coming["coming:brief"])).toContain("Ava turns 7");
    expect(coming["coming:channel"]).toEqual([]);
    expect(coming["keep:brief"]).toEqual([]);
    expect(coming["keep:channel"]).toEqual([]);
  });

  it("the brief post itself carries none of it", async () => {
    const w = setup();
    w.on();
    await w.daily.run("morning");
    const post = w.posts[0] as StoredPost;
    for (const word of FORBIDDEN) {
      expect(post.bodyMd).not.toContain(word);
      expect(JSON.stringify(post.card)).not.toContain(word);
    }
    expect(post.bodyMd).toContain("Ava turns 7");
  });

  it("opening the tier for the brief opens the brief only", async () => {
    const w = setup();
    w.on();
    setSetting(w.db, "memory.surfaces", { tiers: { people: { brief: true } } });
    const s = everySurface(w);
    expect(JSON.stringify(s["coming:brief"])).toContain("surprise party");
    expect(JSON.stringify(s["keep:brief"])).toContain("haven't replied");
    expect(s["coming:channel"]).toEqual([]);
    expect(s["keep:channel"]).toEqual([]);
  });

  it("turning birthdays off removes them", () => {
    const w = setup();
    w.on();
    setSetting(w.db, "memory.surfaces", { birthdays: false });
    expect(JSON.stringify(everySurface(w)["coming:brief"])).not.toContain("Ava turns 7");
  });
});

describe("pending suggestions never surface", () => {
  it("not as items, lines, worked-on, notices or on any surface, only as a count", async () => {
    const w = setup();
    w.on({ remind: { enabled: true } });
    const all = JSON.stringify({
      home: await list(w, "home"),
      brief: await list(w, "brief"),
      morning: w.catchup.daily.morning("brief").lines,
      channel: w.catchup.daily.morning("channel").lines,
      evening: w.catchup.daily.evening("brief"),
      notice: w.catchup.daily.notice("wrapup"),
    });
    expect(all).not.toContain("Lecture Work 8");
    expect((await list(w, "home")).pendingCount).toBe(1);
    expect(w.catchup.daily.morning("brief").pending?.text).toBe("1 new to-do to confirm");
    // The owner's answer is what makes it an item.
    const [s] = w.graph.suggestions(["pending"]);
    w.graph.answerSuggestion((s as { id: string }).id, "accept");
    expect((await list(w, "brief")).items.map((i) => i.title)).toContain("Lecture Work 8");
    expect((await list(w, "brief")).pendingCount).toBe(0);
  });
});

describe("the due-soon notification (W4)", () => {
  it("is off by default", () => {
    const w = setup();
    w.on();
    expect(w.catchup.daily.notice("wrapup")).toBeUndefined();
    expect(w.catchup.daily.notice("dayOf")).toBeUndefined();
  });

  it("when on, is one message a day for the next 24 hours, and never twice", () => {
    const w = setup();
    w.on({ remind: { enabled: true } });
    const n = w.catchup.daily.notice("wrapup");
    expect(n).toMatchObject({
      title: "Due soon",
      body: "2 things due tomorrow: Quiz 3, Q3 board deck.",
      route: "/memory?kind=due",
    });
    expect(w.catchup.daily.notice("wrapup")).toBeUndefined();
    w.clock.advance(DAY);
    expect(w.catchup.daily.notice("wrapup")).toBeUndefined();
  });

  it("the morning message is its own switch", () => {
    const w = setup();
    w.on({ remind: { enabled: true, dayOf: true } });
    expect(w.catchup.daily.notice("dayOf")).toMatchObject({
      title: "Due today",
      body: "1 thing due today: Quiz 3.",
    });
    expect(w.catchup.daily.notice("dayOf")).toBeUndefined();
  });

  it("counts instead of naming when the notification surface is not open for work", () => {
    const w = setup();
    w.on({ remind: { enabled: true } });
    setSetting(w.db, "memory.surfaces", { tiers: { work: { notification: false } } });
    expect(w.catchup.daily.notice("wrapup")).toBeUndefined();
  });

  it("never notifies while work memory is off", () => {
    const w = setup();
    setSetting(w.db, "memory.work", { enabled: false, remind: { enabled: true } });
    expect(w.catchup.daily.notice("wrapup")).toBeUndefined();
  });
});

describe("feed.list for the agent re-applies agent access to catch-up lines", () => {
  async function post(w: World) {
    w.on();
    await w.daily.run("morning");
    return w.posts[0] as StoredPost;
  }
  const agentFeed = (w: World, p: StoredPost) =>
    feedTools(
      {
        store: { list: () => ({ posts: [p], nextCursor: null }) },
        forAgent: (x: StoredPost) => w.catchup.agentView(x),
        nextBriefAt: async () => null,
      } as never,
      { now: () => NOW } as never,
    ).find((t) => t.spec.name === "feed.list");
  const readFeed = async (w: World, p: StoredPost) => {
    const tool = agentFeed(w, p);
    if (tool?.run === undefined) throw new Error("feed.list is not registered");
    const r = await tool.run({}, {} as never);
    return r as { output: { posts: { body: string }[] }; provenance: string };
  };

  it("with agentAccess none, every memory line is '1 item hidden'", async () => {
    const w = setup();
    const p = await post(w);
    w.setAccess({ ...LOCAL_ACCESS, mode: "none" });
    const r = await readFeed(w, p);
    const body = r.output.posts[0]?.body ?? "";
    for (const secret of ["Q3 board deck", "Lecture Work 7", "CHEM", "Ava", "Updated numbers"]) {
      expect(body).not.toContain(secret);
    }
    expect(body).toMatch(/\d+ items? hidden/);
    // Lines without an entity behind them are untouched.
    expect(body).toContain("Pay rent");
    // Untrusted lines taint the turn as usual.
    expect(r.provenance).toBe("untrusted");
  });

  it("the owner's own post is not rewritten", async () => {
    const w = setup();
    const p = await post(w);
    w.setAccess({ ...LOCAL_ACCESS, mode: "none" });
    expect(p.bodyMd).toContain("Q3 board deck");
    expect(JSON.stringify(p.card)).toContain("Q3 board deck");
  });

  it("with access on, the agent sees the brief as it is", async () => {
    const w = setup();
    const p = await post(w);
    expect(w.catchup.agentView(p)).toBe(p);
    const body = (await readFeed(w, p)).output.posts[0]?.body ?? "";
    expect(body).toContain("Q3 board deck");
  });

  it("hides only the lines learned from a source the agent may not search", async () => {
    const w = setup();
    const p = await post(w);
    w.setAccess({ ...LOCAL_ACCESS, sourceAllowed: (s) => s !== "mail" });
    const body = (await readFeed(w, p)).output.posts[0]?.body ?? "";
    expect(body).not.toContain("Q3 board deck");
    expect(body).not.toContain("Updated numbers");
    expect(body).toContain("Lecture Work 7");
    expect(body).toContain("1 item hidden");
  });

  it("leaves a post that is not a brief alone", async () => {
    const w = setup();
    const p = { ...(await post(w)), card: undefined } as StoredPost;
    expect(w.catchup.agentView(p)).toBe(p);
  });
});

describe("the search index never holds catch-up lines (agent search bypass)", () => {
  async function indexed(w: World) {
    w.on();
    await w.daily.run("morning");
    const post = w.posts[0] as StoredPost;
    const index = createSearchIndex({ now: () => NOW });
    await index.index(feedDoc(post));
    return { post, index };
  }
  const agentSearch = async (index: ReturnType<typeof createSearchIndex>, query: string) =>
    (await searchEverything({ index }, { query }, { threadId: "t1" })).output.hits;

  it("with agentAccess none, an agent search for a catch-up item's title returns nothing", async () => {
    const w = setup();
    const { post, index } = await indexed(w);
    w.setAccess({ ...LOCAL_ACCESS, mode: "none" });
    // The lines are in the brief the owner reads...
    expect(post.bodyMd).toContain("Q3 board deck");
    // ...and nowhere in the index.
    for (const title of ["Q3 board deck", "Lecture Work 7", "CHEM lab report", "Updated numbers"])
      expect(await agentSearch(index, title)).toEqual([]);
  });

  it("holds for every access mode, because the lines are never indexed", async () => {
    const w = setup();
    const { index } = await indexed(w);
    for (const mode of ["none", "accepted", "all"] as const) {
      w.setAccess({ ...LOCAL_ACCESS, mode });
      expect(await agentSearch(index, "Ava turns 7")).toEqual([]);
      expect(await agentSearch(index, "Q3 board deck")).toEqual([]);
    }
  });

  it("still indexes the plain lines of the brief", async () => {
    const w = setup();
    const { index } = await indexed(w);
    expect((await agentSearch(index, "Pay rent")).length).toBe(1);
  });
});

describe("composition", () => {
  let home = "";
  let composed: ComposedGateway | null = null;
  afterEach(async () => {
    await composed?.stop("test");
    composed = null;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("serves memory.catchup.* and hooks the Feed's agent view", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-catchup-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      timeZone: "UTC",
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const names = Object.keys(composed.proactive.handlers);
    for (const m of ["memory.catchup.list", "memory.catchup.act", "memory.catchup.seen"])
      expect(names).toContain(m);
    const def = composed.proactive.handlers["memory.catchup.list"] as unknown as {
      run: (c: unknown, p: unknown) => Promise<unknown>;
    };
    const res = (await def.run({}, { surface: "home" })) as { items: unknown[] };
    expect(res.items).toEqual([]);
  });
});
