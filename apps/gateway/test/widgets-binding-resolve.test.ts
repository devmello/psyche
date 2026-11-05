import { createRun, createThread, insertWidget, openDb, upsertToolCall } from "@psyche/db";
import type { WidgetSpec } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import type { ComposeServices } from "../src/compose/services.ts";
import { composeWidgets } from "../src/compose/widgets.ts";
import type { Call } from "../src/context.ts";
import { ResearchTracker } from "../src/widgets/resolve.ts";

const spec = (bind: Record<string, unknown>, type = "progress"): WidgetSpec => ({
  v: 1,
  title: "T",
  fallbackText: "fb",
  root: { id: "root", type: "stack", children: [{ id: "n", type, label: "x", bind }] },
});

function setup() {
  const db = openDb(":memory:");
  createThread(db, { id: "thr_1", kind: "main", sessionKey: "main:1" });
  createThread(db, { id: "thr_2", kind: "main", sessionKey: "main:2" });
  createRun(db, { id: "run_1", threadId: "thr_1", modelRef: "m/x" });
  createRun(db, { id: "run_2", threadId: "thr_2", modelRef: "m/x" });
  let frame: ((f: string) => void) | undefined;
  const part = composeWidgets({
    db,
    tools: { register: () => () => {} },
    publish: () => {},
  } as unknown as ComposeServices);
  part.start?.({
    bus: {
      subscribe: (_s: unknown, cb: (f: string) => void) => {
        frame = cb;
        return () => {};
      },
    },
  } as never);
  const call = { ctx: { db } } as unknown as Call;
  const handler = part.handlers?.["widgets.binding.resolve"];
  if (handler === undefined) throw new Error("handler missing");
  const run = handler.run as unknown as (c: Call, p: unknown) => unknown;
  const resolve = (widgetId: string, nodeId = "n") => run(call, { widgetId, nodeId });
  const widget = (s: WidgetSpec, threadId = "thr_1") =>
    insertWidget(db, {
      threadId,
      messageId: "m1",
      spec: s,
      taint: [],
      owner: { kind: "run", runId: "run_1" },
    });
  const emit = (toolCallId: string, event: unknown) =>
    frame?.(JSON.stringify({ event: "research.progress", payload: { toolCallId, event } }));
  return { db, resolve, widget, emit };
}

describe("widgets.binding.resolve", () => {
  it("reads a tool call's status, and hides another chat's call", () => {
    const { db, resolve, widget } = setup();
    upsertToolCall(db, { id: "tc_a", runId: "run_1", tool: "web.fetch", status: "running" });
    upsertToolCall(db, { id: "tc_b", runId: "run_2", tool: "web.fetch", status: "ok" });
    const w = widget(spec({ source: "tool_call", id: "tc_a", field: "status" }, "status"));
    expect(resolve(w.id)).toEqual({ available: true, status: "running" });
    upsertToolCall(db, { id: "tc_a", runId: "run_1", tool: "web.fetch", status: "ok" });
    expect(resolve(w.id)).toEqual({ available: true, status: "ok" });
    const other = widget(spec({ source: "tool_call", id: "tc_b", field: "status" }, "status"));
    expect(resolve(other.id)).toEqual({ available: false });
    const gone = widget(spec({ source: "tool_call", id: "tc_nope", field: "status" }, "status"));
    expect(resolve(gone.id)).toEqual({ available: false });
  });

  it("folds research progress events into steps, claims and sources", () => {
    const { db, resolve, widget, emit } = setup();
    upsertToolCall(db, { id: "tc_r", runId: "run_1", tool: "research_run", status: "running" });
    const w = widget(spec({ source: "research", id: "tc_r", field: "progress" }));
    expect(resolve(w.id)).toEqual({
      available: true,
      status: "running",
      claims: 0,
      sources: 0,
      step: 0,
      steps: 7,
    });
    emit("tc_r", { type: "step", step: "read" });
    emit("tc_r", { type: "source", url: "https://a.example", title: "A", status: "reading" });
    emit("tc_r", { type: "source", url: "https://a.example", title: "A", status: "read" });
    emit("tc_r", { type: "source", url: "https://b.example", title: "B", status: "read" });
    emit("tc_r", { type: "claims", count: 4 });
    expect(resolve(w.id)).toMatchObject({ status: "running", claims: 4, sources: 2, step: 3 });
    emit("tc_r", { type: "done", artifactId: "art_1" });
    expect(resolve(w.id)).toMatchObject({ status: "done", step: 7 });
  });

  it("reads a research call that ended without events as done, or stopped", () => {
    const { db, resolve, widget } = setup();
    upsertToolCall(db, { id: "tc_d", runId: "run_1", tool: "research_run", status: "ok" });
    upsertToolCall(db, { id: "tc_f", runId: "run_1", tool: "research_run", status: "failed" });
    const d = widget(spec({ source: "research", id: "tc_d", field: "status" }, "status"));
    const f = widget(spec({ source: "research", id: "tc_f", field: "status" }, "status"));
    expect(resolve(d.id)).toMatchObject({ available: true, status: "done" });
    expect(resolve(f.id)).toMatchObject({ available: true, status: "cancelled" });
  });

  it("refuses a non-research call under a research binding and other sources", () => {
    const { db, resolve, widget } = setup();
    upsertToolCall(db, { id: "tc_a", runId: "run_1", tool: "web.fetch", status: "ok" });
    const w = widget(spec({ source: "research", id: "tc_a", field: "status" }, "status"));
    expect(resolve(w.id)).toEqual({ available: false });
    const t = widget(spec({ source: "task", id: "tsk_1", field: "progress" }));
    expect(() => resolve(t.id)).toThrow(/Only tool_call and research/);
    expect(() => resolve("nope")).toThrow(/No such widget/);
    expect(() => resolve(w.id, "zz")).toThrow(/No such binding/);
  });
});

describe("ResearchTracker", () => {
  it("drops the oldest fold past its cap", () => {
    const t = new ResearchTracker(2);
    for (const id of ["a", "b", "c"]) t.apply(id, { type: "claims", count: 1 });
    expect(t.get("a")).toBeUndefined();
    expect(t.get("c")?.claims).toBe(1);
  });
});
