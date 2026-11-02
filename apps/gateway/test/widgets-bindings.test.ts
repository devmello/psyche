import { createRun, createThread, openDb, type PsycheDb, upsertToolCall } from "@psyche/db";
import type { WidgetSpec } from "@psyche/protocol";
import { SqliteTaskEngine } from "@psyche/tasks";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWidgetBindings } from "../src/widgets/bindings.ts";
import { WidgetStore } from "../src/widgets/store.ts";

const specWith = (bind: Record<string, unknown>, node: Record<string, unknown>): WidgetSpec => ({
  v: 1,
  title: "Bound",
  fallbackText: "Bound widget",
  root: { id: "root", type: "stack", children: [{ id: "n", bind, ...node }] },
});
const progress = { type: "progress", label: "Run" };

describe("widget bindings (gateway)", () => {
  let db: PsycheDb;
  let tasks: SqliteTaskEngine;
  let store: WidgetStore;
  const owner = { kind: "run" as const, runId: "run_1" };
  const create = (spec: WidgetSpec, thread = "thr_1") =>
    store.create({ threadId: thread, messageId: "m", spec, taint: [], owner });

  beforeEach(() => {
    const clock = new FakeClock();
    db = openDb(":memory:", { now: () => new Date(clock.now()).toISOString() });
    createThread(db, { id: "thr_1", kind: "main", sessionKey: "main:1" });
    createThread(db, { id: "thr_2", kind: "main", sessionKey: "main:2" });
    tasks = new SqliteTaskEngine({ db, clock });
    store = new WidgetStore({
      db,
      publish: () => {},
      bindings: (root, thread) => checkWidgetBindings(db, root, thread),
    });
  });
  afterEach(() => db.close());

  it("binds to a task of this chat and carries the task's taint into the widget", async () => {
    const t = await tasks.create({
      threadId: "thr_1",
      title: "Sync",
      goal: "g",
      createdFrom: "chat",
      taint: true,
      taintSources: [{ sourceKind: "web", origin: "https://x.example" }],
    });
    const w = create(specWith({ source: "task", id: t.id, field: "progress" }, progress));
    expect(w.taint).toEqual([{ sourceKind: "web", origin: "https://x.example" }]);
  });

  it("rejects another chat's task, a missing one and a wrong field the same actionable way", async () => {
    const other = await tasks.create({
      threadId: "thr_2",
      title: "O",
      goal: "g",
      createdFrom: "chat",
    });
    for (const id of [other.id, "tsk_nope"]) {
      expect(() => create(specWith({ source: "task", id, field: "progress" }, progress))).toThrow(
        /no such task in this chat/,
      );
    }
    expect(() => create(specWith({ source: "task", id: "x", field: "nope" }, progress))).toThrow(
      /not a bindable field of task/,
    );
  });

  it("binds a tool call and a research call of this chat, with tool taint, and not another chat's", () => {
    createRun(db, { id: "run_1", threadId: "thr_1", modelRef: "m/x" });
    createRun(db, { id: "run_2", threadId: "thr_2", modelRef: "m/x" });
    upsertToolCall(db, {
      id: "tc_a",
      runId: "run_1",
      tool: "web.fetch",
      status: "running",
      taintOut: true,
    });
    upsertToolCall(db, { id: "tc_r", runId: "run_1", tool: "research_run", status: "running" });
    upsertToolCall(db, { id: "tc_o", runId: "run_2", tool: "research_run", status: "running" });
    const a = create(
      specWith(
        { source: "tool_call", id: "tc_a", field: "status" },
        { type: "status", label: "…", tone: "neutral" },
      ),
    );
    expect(a.taint).toEqual([{ sourceKind: "web.fetch", toolCallId: "tc_a" }]);
    expect(() =>
      create(specWith({ source: "research", id: "tc_a", field: "progress" }, progress)),
    ).toThrow(/no such research/);
    create(specWith({ source: "research", id: "tc_r", field: "progress" }, progress));
    expect(() =>
      create(specWith({ source: "research", id: "tc_o", field: "progress" }, progress)),
    ).toThrow(/no such research/);
  });

  it("checks bindings again on a patch that adds one, and adds the taint", async () => {
    const own = await tasks.create({
      threadId: "thr_1",
      title: "Own",
      goal: "g",
      createdFrom: "chat",
      taint: true,
    });
    const other = await tasks.create({
      threadId: "thr_2",
      title: "O",
      goal: "g",
      createdFrom: "chat",
    });
    const w = create(specWith({ source: "task", id: own.id, field: "progress" }, progress));
    const plain = store.create({
      threadId: "thr_1",
      messageId: "m",
      spec: {
        ...specWith({ source: "task", id: own.id, field: "progress" }, progress),
        root: { id: "root", type: "progress", label: "x", value: 1 },
      },
      taint: [],
      owner,
    });
    expect(plain.taint).toEqual([]);
    expect(() =>
      store.patch({
        widgetId: plain.id,
        threadId: "thr_1",
        ops: [
          {
            op: "set",
            id: "root",
            props: { bind: { source: "task", id: other.id, field: "progress" } },
          },
        ],
        taint: [],
      }),
    ).toThrow(/no such task in this chat/);
    const next = store.patch({
      widgetId: plain.id,
      threadId: "thr_1",
      ops: [
        {
          op: "set",
          id: "root",
          props: { bind: { source: "task", id: own.id, field: "progress" } },
        },
      ],
      taint: [],
    });
    expect(next.taint).toEqual([{ sourceKind: "task" }]);
    expect(w.taint).toEqual([{ sourceKind: "task" }]);
  });

  it("lets any chat bind an existing automation but not a missing one", () => {
    expect(() =>
      create(
        specWith(
          { source: "automation", id: "aut_nope", field: "status" },
          { type: "status", label: "a", tone: "neutral" },
        ),
      ),
    ).toThrow(/no such automation\./);
  });
});
