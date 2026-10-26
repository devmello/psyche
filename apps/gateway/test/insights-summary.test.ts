import { createRun, createThread, openDb, type PsycheDb, updateRun } from "@psyche/db";
import type { MethodParams, MethodResult } from "@psyche/protocol";
import { validateParams } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insightsHandlers } from "../src/compose/insights.ts";

// Sunday 2026-10-25, 18:00 UTC = 11:00 in Los Angeles.
const NOW = new Date("2026-10-25T18:00:00.000Z");
const MODEL = "anthropic/claude-sonnet-5-5";

let db: PsycheDb;
let chat: string;
let incognito: string;
let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

beforeEach(() => {
  db = openDb(":memory:");
  chat = createThread(db, { kind: "main", sessionKey: "owner:main" }).id;
  incognito = createThread(db, { kind: "incognito", sessionKey: "owner:incognito" }).id;
});
afterEach(() => db.close());

function run(
  startedAt: string,
  o: {
    threadId?: string;
    kind?: "chat" | "task" | "automation" | "subagent";
    status?: "done" | "failed" | "cancelled";
    ms?: number;
    automationRunId?: string;
  } = {},
) {
  const r = createRun(db, {
    threadId: o.threadId ?? chat,
    modelRef: MODEL,
    startedAt,
    ...(o.kind === undefined ? {} : { kind: o.kind }),
    ...(o.automationRunId === undefined ? {} : { automationRunId: o.automationRunId }),
  });
  updateRun(db, r.id, {
    status: o.status ?? "done",
    endedAt: new Date(Date.parse(startedAt) + (o.ms ?? 1000)).toISOString(),
  });
  return r.id;
}

function approval(status: string, at: string, threadId: string | null = chat) {
  db.sqlite
    .prepare(
      `INSERT INTO approvals (id, kind, summary, details, binding_hash, grant_key, device_only,
         requires_authentication, taint, thread_id, surfaces, scopes_offered, answer_tokens, status,
         request_input, boot_id, requested_at, expires_at, decided_at, created_at, updated_at)
       VALUES (?, 'tool', 's', '{}', 'h', 'g', 0, 0, 0, ?, '[]', '[]', '[]', ?, '{}', 'b', ?, ?, ?, ?, ?)`,
    )
    .run(id("ap"), threadId, status, at, at, status === "expired" ? null : at, at, at);
}

function artifact(type: string, at: string, versions: string[] = [], threadId: string = chat) {
  const aid = id("art");
  db.sqlite
    .prepare(
      `INSERT INTO artifacts (id, library_item_id, type, title, name_slug, thread_id, version,
         content, bytes, hash, created_at, updated_at)
       VALUES (?, 'lib', ?, 't', 't', ?, 1, '', 0, 'h', ?, ?)`,
    )
    .run(aid, type, threadId, at, at);
  for (const [i, v] of [at, ...versions].entries()) {
    db.sqlite
      .prepare(
        `INSERT INTO artifact_versions (artifact_id, version, author, kind, snapshot, bytes, hash,
           summary, created_at) VALUES (?, ?, 'agent', 'snapshot', '', 0, 'h', 's', ?)`,
      )
      .run(aid, i + 1, v);
  }
}

function specialist(outcome: string | null, at: string, threadId: string = chat) {
  const spec = outcome === null ? { result: null } : { result: { outcome } };
  db.sqlite
    .prepare(
      `INSERT INTO tasks (id, thread_id, title, goal, created_from, specialist, created_at, updated_at)
       VALUES (?, ?, 't', 'g', 'subagent', ?, ?, ?)`,
    )
    .run(id("task"), threadId, JSON.stringify(spec), at, at);
}

function automation(title: string): { automationId: string; automationRunId: () => string } {
  const automationId = id("auto");
  db.sqlite
    .prepare(
      `INSERT INTO automations (id, kind, title, schedule, timezone, prompt, created_at, updated_at)
       VALUES (?, 'cron', ?, '0 8 * * *', 'UTC', 'p', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(automationId, title);
  return {
    automationId,
    automationRunId: () => {
      const rid = id("arun");
      db.sqlite
        .prepare(
          `INSERT INTO automation_runs (id, automation_id, trigger, scheduled_for, started_at, created_at)
           VALUES (?, ?, 'schedule', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
        )
        .run(rid, automationId);
      return rid;
    },
  };
}

function person(name: string, kind = "person") {
  const eid = id("ent");
  db.sqlite
    .prepare(
      `INSERT INTO graph_entities (id, kind, name, sort_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(eid, kind, name, name.toLowerCase());
  return eid;
}

function interaction(entityIds: string[], at: string) {
  const iid = id("int");
  db.sqlite
    .prepare(
      `INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, created_at)
       VALUES (?, 'mail', 'mail', ?, ?, 'in', ?)`,
    )
    .run(iid, iid, at, at);
  for (const e of entityIds) {
    db.sqlite
      .prepare(
        "INSERT INTO graph_participants (interaction_id, entity_id, role) VALUES (?, ?, 'from')",
      )
      .run(iid, e);
  }
}

function openLoop(counterpartId: string, status = "open") {
  db.sqlite
    .prepare(
      `INSERT INTO graph_loops (id, direction, text, counterpart_id, status, provenance, confidence,
         detected_by, dedupe_key, created_at, updated_at)
       VALUES (?, 'i_owe', 'x', ?, ?, 'agent', 0.9, 'model', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(id("loop"), counterpartId, status, id("dk"));
}

function summary(params: MethodParams<"insights.summary">) {
  validateParams("insights.summary", params);
  const h = insightsHandlers({ db, now: () => NOW });
  return h["insights.summary"]?.run(
    {} as never,
    params as never,
  ) as MethodResult<"insights.summary">;
}

describe("insights.summary", () => {
  it("is all zeros and firstActivityAt null for a new install", () => {
    const s = summary({ window: "7d" });
    expect(s.firstActivityAt).toBeNull();
    expect(s.totals.runs).toEqual({ task: 0, chat: 0, automation: 0, subagent: 0 });
    expect(s.totals.busiestDay).toBeNull();
    expect(s.totals.topAutomation).toBeNull();
    expect(s.previous?.runsDone).toBe(0);
    expect(s.days).toHaveLength(7);
    expect(s.days.at(-1)?.date).toBe("2026-10-25");
    expect(s.topEntities).toEqual([]);
  });

  it("counts runs by kind and status, with wall time and the busiest day", () => {
    run("2026-10-25T09:00:00.000Z", { kind: "chat", ms: 2000 });
    run("2026-10-25T10:00:00.000Z", { kind: "task", ms: 3000 });
    run("2026-10-25T11:00:00.000Z", { kind: "task", status: "failed", ms: 500 });
    run("2026-10-25T11:30:00.000Z", { kind: "subagent", ms: 100 });
    run("2026-10-22T12:00:00.000Z", { kind: "chat", ms: 1000 });
    run("2026-10-10T12:00:00.000Z", { kind: "chat" }); // outside 7d
    const s = summary({ window: "7d" });
    expect(s.totals.runs).toEqual({ task: 2, chat: 2, automation: 0, subagent: 1 });
    expect(s.totals.runsDone).toBe(4);
    expect(s.totals.runsFailed).toBe(1);
    expect(s.totals.runsByKind.task).toEqual({ done: 1, failed: 1 });
    expect(s.totals.runsByKind.chat).toEqual({ done: 2, failed: 0 });
    expect(s.totals.wallMs).toBe(2000 + 3000 + 500 + 100 + 1000);
    expect(s.totals.busiestDay).toEqual({ date: "2026-10-25", runs: 3 });
    const last = s.days.at(-1);
    expect(last?.runs).toEqual({ task: 2, chat: 1, automation: 0 });
    expect(last?.failed).toBe(1);
    expect(last?.wallMs).toBe(5600);
    expect(s.firstActivityAt).toBe("2026-10-10T12:00:00.000Z");
    expect(s.range.to).toBe(NOW.toISOString());
  });

  it("splits finished runs by kind, so a failed automation is not a failed task", () => {
    run("2026-10-25T09:00:00.000Z", { kind: "task" });
    run("2026-10-25T09:10:00.000Z", { kind: "chat" });
    run("2026-10-25T09:20:00.000Z", { kind: "chat", status: "failed" });
    run("2026-10-25T09:30:00.000Z", { kind: "automation" });
    run("2026-10-25T09:40:00.000Z", { kind: "automation" });
    run("2026-10-25T09:50:00.000Z", { kind: "automation", status: "failed" });
    run("2026-10-25T10:00:00.000Z", { kind: "subagent", status: "failed" });
    const t = summary({ window: "7d" }).totals;
    expect(t.runsByKind).toEqual({
      task: { done: 1, failed: 0 },
      chat: { done: 1, failed: 1 },
      automation: { done: 2, failed: 1 },
      subagent: { done: 0, failed: 1 },
    });
    expect(t.runsDone).toBe(4);
    expect(t.runsFailed).toBe(3);
  });

  it("infers a missing run kind from its links", () => {
    const a = automation("Morning brief");
    run("2026-10-25T09:00:00.000Z", { automationRunId: a.automationRunId() });
    run("2026-10-25T09:05:00.000Z");
    const s = summary({ window: "7d" });
    expect(s.totals.runs.automation).toBe(1);
    expect(s.totals.runs.chat).toBe(1);
  });

  it("leaves out everything from incognito threads", () => {
    run("2026-10-25T09:00:00.000Z", { threadId: incognito });
    approval("approved", "2026-10-25T09:00:00.000Z", incognito);
    artifact("text", "2026-10-25T09:00:00.000Z", [], incognito);
    specialist("done", "2026-10-25T09:00:00.000Z", incognito);
    const s = summary({ window: "30d" });
    expect(s.firstActivityAt).toBeNull();
    expect(s.totals.runs.chat).toBe(0);
    expect(s.totals.approvals.approved).toBe(0);
    expect(s.totals.artifacts.created).toBe(0);
    expect(s.totals.specialists.done).toBe(0);
  });

  it("counts approvals, artifacts and specialist jobs inside the window only", () => {
    approval("approved", "2026-10-24T09:00:00.000Z");
    approval("approved", "2026-10-23T09:00:00.000Z");
    approval("denied", "2026-10-23T10:00:00.000Z");
    approval("expired", "2026-10-22T10:00:00.000Z");
    approval("pending", "2026-10-22T10:00:00.000Z");
    approval("approved", "2026-10-01T10:00:00.000Z"); // before 7d
    artifact("chart", "2026-10-24T09:00:00.000Z", ["2026-10-24T10:00:00.000Z"]);
    artifact("text", "2026-10-20T09:00:00.000Z");
    artifact("text", "2026-09-01T09:00:00.000Z", ["2026-10-21T09:00:00.000Z"]); // new version only
    specialist("done", "2026-10-24T09:00:00.000Z");
    specialist("partial", "2026-10-24T09:00:00.000Z");
    specialist("failed", "2026-10-24T09:00:00.000Z");
    specialist("cancelled", "2026-10-24T09:00:00.000Z");
    specialist(null, "2026-10-24T09:00:00.000Z");
    specialist("done", "2026-10-01T09:00:00.000Z");
    const s = summary({ window: "7d" });
    expect(s.totals.approvals).toEqual({ approved: 2, denied: 1, expired: 1 });
    expect(s.totals.artifacts).toEqual({ created: 2, versions: 4, charts: 1 });
    expect(s.totals.specialists).toEqual({ done: 1, partial: 1, failed: 1 });
  });

  it("computes the previous period of the same length, before the window", () => {
    run("2026-10-25T09:00:00.000Z");
    run("2026-10-15T09:00:00.000Z"); // 30d window only
    run("2026-10-12T09:00:00.000Z", { status: "failed" }); // 30d window only
    run("2026-09-20T09:00:00.000Z"); // the previous 30 days only
    const week = summary({ window: "7d" });
    expect(week.totals.runs.chat).toBe(1);
    expect(week.previous?.runs.chat).toBe(2);
    expect(week.previous?.runsFailed).toBe(1);
    const month = summary({ window: "30d" });
    expect(month.totals.runs.chat).toBe(3);
    expect(month.previous?.runs.chat).toBe(1);
    expect(month.days).toHaveLength(30);
  });

  it("buckets days in the caller's time zone", () => {
    run("2026-10-25T01:00:00.000Z"); // yesterday evening in Los Angeles
    expect(summary({ window: "7d", timeZone: "UTC" }).days.at(-1)?.runs.chat).toBe(1);
    const la = summary({ window: "7d", timeZone: "America/Los_Angeles" });
    expect(la.days.at(-1)?.runs.chat).toBe(0);
    expect(la.days.at(-2)?.date).toBe("2026-10-24");
    expect(la.days.at(-2)?.runs.chat).toBe(1);
  });

  it("starts the window at local midnight, DST included", () => {
    // Los Angeles fell back on 2026-11-01; check a window across it with a later "now".
    const h = insightsHandlers({ db, now: () => new Date("2026-11-03T20:00:00.000Z") });
    run("2026-11-01T07:30:00.000Z"); // 2026-11-01 00:30 PDT
    run("2026-11-01T08:30:00.000Z"); // 2026-11-01 00:30 PST (the repeated hour)
    const s = h["insights.summary"]?.run(
      {} as never,
      {
        window: "7d",
        timeZone: "America/Los_Angeles",
      } as never,
    ) as MethodResult<"insights.summary">;
    const nov1 = s.days.find((d) => d.date === "2026-11-01");
    expect(nov1?.runs.chat).toBe(2);
    expect(new Set(s.days.map((d) => d.date)).size).toBe(7);
    expect(s.range.from).toBe("2026-10-28T07:00:00.000Z");
  });

  it('"all" has no previous period, all-time totals, and the last 53 weeks of days', () => {
    run("2026-10-25T09:00:00.000Z");
    run("2025-02-01T09:00:00.000Z"); // older than 53 weeks
    const s = summary({ window: "all" });
    expect(s.previous).toBeNull();
    expect(s.days).toHaveLength(371);
    expect(s.days.at(-1)?.date).toBe("2026-10-25");
    expect(s.days[0]?.date).toBe("2025-10-20");
    expect(s.totals.runs.chat).toBe(2);
    expect(s.firstActivityAt).toBe("2025-02-01T09:00:00.000Z");
    expect(s.range.from).toBe("2025-02-01T09:00:00.000Z");
    expect(s.days.reduce((n, d) => n + d.runs.chat, 0)).toBe(1);
  });

  it("names the automation that ran most", () => {
    const brief = automation("Morning brief");
    const digest = automation("Weekly digest");
    for (let i = 0; i < 3; i += 1) {
      run(`2026-10-2${i}T08:00:00.000Z`, { automationRunId: brief.automationRunId() });
    }
    run("2026-10-24T08:00:00.000Z", { automationRunId: digest.automationRunId() });
    const s = summary({ window: "7d" });
    expect(s.totals.topAutomation).toEqual({
      automationId: brief.automationId,
      title: "Morning brief",
      runs: 3,
    });
    expect(s.totals.runs.automation).toBe(4);
  });

  it("ranks entities by interactions in the window, with open loops, capped at 12", () => {
    const ada = person("Ada");
    const bo = person("Bo");
    const acme = person("Acme", "org");
    interaction([ada, bo], "2026-10-24T09:00:00.000Z");
    interaction([ada], "2026-10-25T09:00:00.000Z");
    interaction([ada, acme], "2026-10-20T09:00:00.000Z");
    interaction([bo], "2026-09-01T09:00:00.000Z"); // outside 30d
    openLoop(ada);
    openLoop(ada);
    openLoop(ada, "done");
    const s = summary({ window: "30d" });
    expect(s.topEntities.map((e) => [e.name, e.interactions])).toEqual([
      ["Ada", 3],
      ["Bo", 1],
      ["Acme", 1],
    ]);
    expect(s.topEntities[0]).toMatchObject({
      entityId: ada,
      kind: "person",
      lastInteractionAt: "2026-10-25T09:00:00.000Z",
      openLoops: 2,
    });
    const all = summary({ window: "all" });
    expect(all.topEntities.find((e) => e.name === "Bo")?.interactions).toBe(2);

    for (let i = 0; i < 15; i += 1) interaction([person(`P${i}`)], "2026-10-24T09:00:00.000Z");
    expect(summary({ window: "30d" }).topEntities).toHaveLength(12);
  });

  it("skips hidden, archived and owner entities", () => {
    const hidden = person("Hidden");
    const gone = person("Gone");
    const me = person("Me");
    db.sqlite.prepare("UPDATE graph_entities SET hidden = 1 WHERE id = ?").run(hidden);
    db.sqlite.prepare("UPDATE graph_entities SET status = 'merged' WHERE id = ?").run(gone);
    db.sqlite.prepare("UPDATE graph_entities SET is_owner = 1 WHERE id = ?").run(me);
    interaction([hidden, gone, me], "2026-10-24T09:00:00.000Z");
    expect(summary({ window: "30d" }).topEntities).toEqual([]);
  });

  it("refuses an unknown time zone", () => {
    expect(() => summary({ window: "7d", timeZone: "Mars/Olympus" })).toThrow(/time zone/);
  });
});
