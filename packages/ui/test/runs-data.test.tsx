import {
  createValidator,
  type PsycheTrace,
  PsycheTrace as PsycheTraceSchema,
} from "@psyche/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  GatewayProvider,
  GatewayStore,
  useRun,
  useRunFrames,
  useRunStep,
  useRunSteps,
  useRunsList,
} from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW, IDS, runTraceWorld, TRACE_IDS, traceSteps } from "../src/fixtures/index.ts";

/** Run trace T1: the UI data layer over the MockGateway's runs.* (run-trace §4.4). */

const R = TRACE_IDS.runs;

function setup() {
  const gateway = new MockGateway(runTraceWorld(), { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GatewayProvider client={gateway} store={store}>
      {children}
    </GatewayProvider>
  );
  return { gateway, store, wrapper };
}

const fromBase64 = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

describe("useRun", () => {
  it("loads a done run with its steps in seq order, its helper, and no retained thinking text", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useRun(R.done), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.run?.title).toBe("Lisbon research");
    expect(result.current.steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const group = result.current.steps.filter((s) => s.groupId === TRACE_IDS.groups.searches);
    expect(group).toHaveLength(3);
    expect(result.current.children.map((c) => c.id)).toEqual([R.helper]);
    // runs.get never carries the kept thinking text: runs.step does.
    expect(result.current.steps[0]?.text?.full).toBeUndefined();
    expect(result.current.steps[0]?.text?.summary).toContain("Search flights");
  });

  it("exports a psyche-trace+json document and Markdown that round-trip", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useRun(R.done), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const json = await result.current.exportTrace("psyche-trace+json");
    const trace = JSON.parse(fromBase64(json.dataBase64 ?? "")) as PsycheTrace;
    expect(createValidator(PsycheTraceSchema).check(trace)).toBe(true);
    expect(trace.children.map((c) => c.run.id)).toEqual([R.helper]);
    expect(trace.steps.find((s) => s.id === "stp_trace_lisbon_02")?.input).toEqual({
      query: "Lisbon flights",
      from: "SFO",
      month: "May",
    });
    const md = await result.current.exportTrace("markdown");
    expect(md.mime).toBe("text/markdown");
    expect(fromBase64(md.dataBase64 ?? "")).toContain("# Lisbon research (done)");
  });

  it("deletes the trace and keeps the run", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useRun(R.failed), { wrapper });
    await waitFor(() => expect(result.current.steps.length).toBe(3));
    await act(() => result.current.deleteTrace());
    expect(result.current.steps).toEqual([]);
    expect(result.current.run?.id).toBe(R.failed);
  });
});

describe("useRunSteps", () => {
  it("follows run.step live: new steps, upserts and retained text that events never carry", async () => {
    const { gateway, store, wrapper } = setup();
    const { result } = renderHook(() => useRunSteps(R.live), { wrapper });
    await waitFor(() => expect(result.current.steps).toHaveLength(3));
    const running = result.current.steps[2];
    expect(running?.status).toBe("running");
    act(() => {
      gateway.setStep({
        ...(running as NonNullable<typeof running>),
        status: "ok",
        endedAt: FIXTURE_NOW,
        progress: undefined,
      });
      gateway.setStep({
        id: "stp_trace_dentist_04",
        runId: R.live,
        seq: 4,
        kind: "approval",
        status: "waiting",
        label: "Waiting for you to approve holding 2:30",
        startedAt: FIXTURE_NOW,
        endedAt: null,
        attempt: 1,
      });
    });
    expect(result.current.steps.map((s) => [s.seq, s.status])).toEqual([
      [1, "ok"],
      [2, "ok"],
      [3, "ok"],
      [4, "waiting"],
    ]);
    // An event's thinking step never carries full text; a kept one stays.
    const thinking = traceSteps().find((s) => s.id === "rsn_trace_lisbon_01");
    store.update((s) => ({
      ...s,
      runSteps: { ...s.runSteps, [R.done]: [thinking as NonNullable<typeof thinking>] },
    }));
    act(() => gateway.setStep(thinking as NonNullable<typeof thinking>));
    expect(store.getState().runSteps[R.done]?.[0]?.text?.full).toContain("Jane wants");
  });

  it("catches up from the last seq after an event gap", async () => {
    const { gateway, wrapper } = setup();
    const { result } = renderHook(() => useRunSteps(R.live), { wrapper });
    await waitFor(() => expect(result.current.steps).toHaveLength(3));
    gateway.world.runSteps?.push({
      id: "stp_trace_dentist_05",
      runId: R.live,
      seq: 4,
      kind: "tool",
      status: "running",
      label: "Holding 2:30",
      startedAt: FIXTURE_NOW,
      endedAt: null,
      attempt: 1,
    });
    const liveRun = gateway.world.runs.find((r) => r.id === R.live) as NonNullable<
      (typeof gateway.world.runs)[number]
    >;
    // The store has seen an event, then misses one: the gap reloads from the last seq.
    act(() => gateway.setRun(liveRun));
    gateway.skipEvents(1);
    act(() => gateway.setRun(liveRun));
    await waitFor(() => expect(result.current.steps).toHaveLength(4));
    const steps = gateway.calls.filter((c) => c.method === "runs.steps");
    expect(steps.at(-1)?.params).toMatchObject({ runId: R.live, afterSeq: 3 });
  });
});

describe("useRunStep and useRunFrames", () => {
  it("reads a step's payloads and retained thinking text", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useRunStep(R.done, "stp_trace_lisbon_02"), { wrapper });
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    expect(result.current.detail?.input).toMatchObject({ query: "Lisbon flights" });
    const thinking = renderHook(() => useRunStep(R.done, "rsn_trace_lisbon_01"), { wrapper });
    await waitFor(() => expect(thinking.result.current.detail).not.toBeNull());
    expect(thinking.result.current.detail?.step.text?.full).toContain("Jane wants");
  });

  it("lists a run's frames, per step, and reads one", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useRunFrames(R.failed, "stp_trace_audit_02"), { wrapper });
    await waitFor(() => expect(result.current.frames).toHaveLength(2));
    const img = await result.current.image(1, "thumb");
    expect(img.mime).toBe("image/png");
  });
});

describe("useRunsList", () => {
  it("lists runs newest first with durations for an automation, and adds live runs", async () => {
    const { gateway, wrapper } = setup();
    const { result } = renderHook(
      () => useRunsList({ automationId: IDS.automations.morningBrief }),
      {
        wrapper,
      },
    );
    await waitFor(() => expect(result.current.runs).toHaveLength(10));
    expect(result.current.runs[0]?.durationsMs).toHaveLength(10);
    const tasks = renderHook(() => useRunsList({ kind: "task" }), { wrapper });
    await waitFor(() => expect(tasks.result.current.runs).toHaveLength(2));
    act(() =>
      gateway.setRun({
        ...(gateway.world.runs.find((r) => r.id === R.live) as NonNullable<
          (typeof gateway.world.runs)[number]
        >),
        id: "run_trace_new",
        startedAt: FIXTURE_NOW,
      }),
    );
    expect(tasks.result.current.runs.map((r) => r.id)[0]).toBe("run_trace_new");
  });
});
