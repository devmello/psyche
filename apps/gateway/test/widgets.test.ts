import { getWidget, openDb, type PsycheDb } from "@psyche/db";
import type { EventName, EventPayload, WidgetSpec } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadingOf } from "../src/compose/capabilities.ts";
import { mergeTaint, WIDGET_PUBLISH_MS, WidgetStore } from "../src/widgets/store.ts";
import { widgetTools } from "../src/widgets/tools.ts";

const spec = (over: Partial<WidgetSpec> = {}): WidgetSpec => ({
  v: 1,
  title: "Cleanup",
  fallbackText: "Cleanup 3 of 5",
  root: {
    id: "root",
    type: "stack",
    children: [
      { id: "p", type: "progress", label: "Cleanup", value: 3, max: 5 },
      { id: "steps", type: "checklist", items: [{ id: "s1", label: "Archive", state: "done" }] },
    ],
  },
  ...over,
});

type Ev = { event: string; payload: Record<string, unknown>; threadId?: string | undefined };

describe("WidgetStore", () => {
  let db: PsycheDb;
  let events: Ev[];
  let now: number;
  let timers: Array<{ fn: () => void; at: number }>;
  let store: WidgetStore;
  const owner = { kind: "run" as const, runId: "run_1" };
  const mk = (title = "W", thread = "thr_1") =>
    store.create({ threadId: thread, messageId: "msg_1", spec: spec({ title }), taint: [], owner });

  beforeEach(() => {
    db = openDb(":memory:");
    events = [];
    now = Date.parse("2026-11-02T10:00:00Z");
    timers = [];
    store = new WidgetStore({
      db,
      now: () => now,
      publish: <E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string) => {
        events.push({ event, payload: payload as Record<string, unknown>, threadId });
      },
      setTimer: (fn, ms) => {
        const t = { fn, at: now + ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        timers = timers.filter((x) => x !== t);
      },
    });
  });
  afterEach(() => db.close());

  const runTimers = () => {
    const due = timers;
    timers = [];
    for (const t of due) t.fn();
  };

  it("rejects a bad spec with paths the model can act on, and stores nothing", () => {
    const bad = spec({
      root: { id: "root", type: "button", label: "Allow", action: { kind: "reply", text: "x" } },
    });
    expect(() =>
      store.create({ threadId: "thr_1", messageId: "m", spec: bad, taint: [], owner }),
    ).toThrow(/root\.label: Labels that read like an approval/);
    expect(store.list("thr_1")).toEqual([]);
  });

  it("patches by node id, bumps rev, and publishes the ops", () => {
    const w = mk();
    const next = store.patch({
      widgetId: w.id,
      threadId: "thr_1",
      baseRev: 1,
      ops: [{ op: "set", id: "p", props: { value: 4 } }],
      taint: [],
    });
    expect(next.rev).toBe(2);
    expect(getWidget(db, w.id)?.rev).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "widget.updated",
      threadId: "thr_1",
      payload: { widgetId: w.id, rev: 2, fromRev: 1, ops: [{ op: "set", id: "p" }] },
    });
  });

  it("returns an actionable conflict for a stale baseRev and an invalid result", () => {
    const w = mk();
    store.patch({
      widgetId: w.id,
      threadId: "thr_1",
      ops: [{ op: "set", id: "p", props: { value: 4 } }],
      taint: [],
    });
    expect(() =>
      store.patch({
        widgetId: w.id,
        threadId: "thr_1",
        baseRev: 1,
        ops: [{ op: "set", id: "p", props: { value: 5 } }],
        taint: [],
      }),
    ).toThrow(/Stale baseRev 1.*rev 2/);
    expect(() =>
      store.patch({
        widgetId: w.id,
        threadId: "thr_1",
        ops: [{ op: "set", id: "nope", props: {} }],
        taint: [],
      }),
    ).toThrow(/No node or item with id 'nope'/);
    expect(getWidget(db, w.id)?.rev).toBe(2);
  });

  it("patches only in the same thread; other threads see it as missing (D9)", () => {
    const w = mk();
    expect(() =>
      store.patch({
        widgetId: w.id,
        threadId: "thr_other",
        ops: [{ op: "meta", title: "x" }],
        taint: [],
      }),
    ).toThrow(/No widget/);
    expect(store.list("thr_other")).toEqual([]);
  });

  it("coalesces patches to at most 4 events a second, each spanning its revisions", () => {
    const w = mk();
    for (const v of [1, 2, 3]) {
      store.patch({
        widgetId: w.id,
        threadId: "thr_1",
        ops: [{ op: "set", id: "p", props: { value: v } }],
        taint: [],
      });
      now += 10;
    }
    // The first goes out at once (nothing published before); the rest wait for the window.
    expect(events).toHaveLength(1);
    now += WIDGET_PUBLISH_MS;
    runTimers();
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({ fromRev: 2, rev: 4 });
    expect(events[1]?.payload.ops).toHaveLength(2);
  });

  it("keeps taint monotone: patches add sources, a clean patch never removes them", () => {
    const w = store.create({
      threadId: "thr_1",
      messageId: "m",
      spec: spec(),
      taint: [{ sourceKind: "web", origin: "https://a.example" }],
      owner,
    });
    const a = store.patch({
      widgetId: w.id,
      threadId: "thr_1",
      ops: [{ op: "meta", title: "A" }],
      taint: [{ sourceKind: "email", sender: "x@y.z" }],
    });
    expect(a.taint.map((t) => t.sourceKind)).toEqual(["web", "email"]);
    const b = store.patch({
      widgetId: w.id,
      threadId: "thr_1",
      ops: [{ op: "meta", title: "B" }],
      taint: [],
    });
    expect(b.taint).toHaveLength(2);
    expect(mergeTaint(b.taint, b.taint)).toHaveLength(2);
  });

  it("caps live widgets at 8: the least recently patched freezes first (D6)", () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      now += 1000;
      ids.push(mk(`W${i}`).id);
    }
    // Patch the oldest so it is no longer the least recently patched.
    now += 1000;
    store.patch({
      widgetId: ids[0] as string,
      threadId: "thr_1",
      ops: [{ op: "meta", title: "fresh" }],
      taint: [],
    });
    now += 1000;
    const ninth = mk("W9");
    expect(getWidget(db, ids[1] as string)?.state).toBe("frozen");
    expect(getWidget(db, ids[0] as string)?.state).toBe("live");
    expect(getWidget(db, ninth.id)?.state).toBe("live");
    const frozenEvent = events.find((e) => e.payload.state === "frozen");
    expect(frozenEvent?.payload).toMatchObject({ widgetId: ids[1], ops: [] });
    expect(() =>
      store.patch({
        widgetId: ids[1] as string,
        threadId: "thr_1",
        ops: [{ op: "meta", title: "x" }],
        taint: [],
      }),
    ).toThrow(/frozen/);
  });

  it("freezes a task's widgets when the task ends, but not bound ones or a run's (D9)", () => {
    const plain = store.create({
      threadId: "thr_1",
      messageId: "m",
      spec: spec(),
      taint: [],
      owner: { kind: "task", taskId: "tsk_1" },
    });
    const bound = store.create({
      threadId: "thr_1",
      messageId: "m",
      spec: spec({
        root: {
          id: "p",
          type: "progress",
          label: "x",
          bind: { source: "task", id: "tsk_1", field: "progress" },
        },
      }),
      taint: [],
      owner: { kind: "task", taskId: "tsk_1" },
    });
    const run = mk("run-owned");
    const other = store.create({
      threadId: "thr_1",
      messageId: "m",
      spec: spec(),
      taint: [],
      owner: { kind: "task", taskId: "tsk_2" },
    });
    expect(store.freezeOwnedBy("task", "tsk_1")).toBe(1);
    expect(getWidget(db, plain.id)?.state).toBe("frozen");
    expect(getWidget(db, bound.id)?.state).toBe("live");
    expect(getWidget(db, run.id)?.state).toBe("live");
    expect(getWidget(db, other.id)?.state).toBe("live");
    expect(events.find((e) => e.payload.widgetId === plain.id)?.payload).toMatchObject({
      state: "frozen",
      ops: [],
    });
  });

  it("freezes after 7 days without a patch", () => {
    const w = mk();
    now += 8 * 24 * 60 * 60 * 1000;
    expect(store.list("thr_1")[0]).toMatchObject({ id: w.id, state: "frozen" });
  });
});

describe("widget tools", () => {
  it("are deferred by default (loaded on demand), not always on", () => {
    for (const n of ["render_ui", "update_ui", "list_ui"])
      expect(loadingOf(n, {})).toBe("on_demand");
  });

  it("render_ui attaches the turn's taint, emits a ui block on the turn's message, and update_ui/list_ui follow", async () => {
    const db = openDb(":memory:");
    const store = new WidgetStore({ db, publish: () => {} });
    const [render, update, list] = widgetTools(store);
    const blocks: unknown[] = [];
    const ctx = {
      callId: "tc_1",
      threadId: "thr_1",
      runId: "run_1",
      taint: true,
      taintSources: [{ sourceKind: "web", origin: "https://evil.example" }],
      signal: new AbortController().signal,
      onUpdate: () => {},
      turn: { emitBlock: (b: unknown) => blocks.push(b), messageId: () => "msg_42" },
    } as never;
    const made = await render?.run?.({ spec: spec() }, ctx);
    const out = made?.output as { widgetId: string; rev: number };
    expect(out.rev).toBe(1);
    expect(blocks).toEqual([{ type: "ui", widgetId: out.widgetId }]);
    const stored = getWidget(db, out.widgetId);
    expect(stored).toMatchObject({ messageId: "msg_42", owner: { kind: "run", runId: "run_1" } });
    expect(stored?.taint).toEqual([{ sourceKind: "web", origin: "https://evil.example" }]);
    const patched = await update?.run?.(
      { widgetId: out.widgetId, ops: [{ op: "set", id: "p", props: { value: 5 } }] },
      ctx,
    );
    expect(patched?.output).toMatchObject({ rev: 2 });
    const listed = await list?.run?.({}, ctx);
    expect(listed?.output).toMatchObject({
      widgets: [{ id: out.widgetId, rev: 2, state: "live" }],
    });
    const bad = await render?.run?.({ spec: spec({ title: "" }) }, ctx);
    expect(bad?.isError).toBe(true);
    expect(JSON.stringify(bad?.output)).toMatch(/Fix these/);
    db.close();
  });

  it("taints a widget made in a tainted turn even when only the flag is known", async () => {
    const db = openDb(":memory:");
    const store = new WidgetStore({ db, publish: () => {} });
    const [render] = widgetTools(store);
    const ctx = {
      callId: "t",
      threadId: "thr_1",
      runId: "r",
      taint: true,
      signal: new AbortController().signal,
      onUpdate: () => {},
      turn: { emitBlock: () => {}, messageId: () => "m" },
    } as never;
    const made = await render?.run?.({ spec: spec() }, ctx);
    const id = (made?.output as { widgetId: string } | undefined)?.widgetId ?? "";
    expect(getWidget(db, id)?.taint).toHaveLength(1);
    db.close();
  });
});
