import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSheetRoute, agentTimelineHref } from "../src/agent/AgentSheet.tsx";
import { timelineAction, zoomStep } from "../src/agent/timeline/keyboard.ts";
import {
  allRows,
  buildRows,
  defaultFolded,
  failedStep,
  matchesQuery,
  traceGaps,
  visibleRows,
} from "../src/agent/timeline/model.ts";
import {
  advance,
  advanceReduced,
  eventTimes,
  failureTimes,
  stepAtTime,
  stepsAt,
} from "../src/agent/timeline/replay.ts";
import { TimelineView } from "../src/agent/timeline/TimelineView.tsx";
import { visibleRange } from "../src/agent/timeline/virtual.ts";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { today } from "../src/fixtures/ids.ts";
import {
  FIXTURE_NOW,
  runTraceWorld,
  TRACE_IDS,
  traceLongRun,
  traceSteps,
} from "../src/fixtures/index.ts";

/** Run trace T3: the Timeline's pure model, replay, keyboard map and its view (run-trace §3.3–§3.5). */

const R = TRACE_IDS.runs;
const NOW = Date.parse(FIXTURE_NOW);
const at = (hhmm: string, ss = "00") => Date.parse(today(hhmm, ss));

function stepsOf(runId: string) {
  return traceSteps().filter((s) => s.runId === runId);
}

function setup(extra?: (w: ReturnType<typeof runTraceWorld>) => void) {
  const world = runTraceWorld();
  extra?.(world);
  const gateway = new MockGateway(world, { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GatewayProvider client={gateway} store={store}>
      {children}
    </GatewayProvider>
  );
  return { gateway, store, wrapper };
}

describe("replay at a given time (pure, §3.5)", () => {
  it("hides steps not yet started and shows unfinished ones running with no end", () => {
    const steps = stepsOf(R.done);
    const mid = stepsAt(steps, at("09:20", "10"));
    expect(mid.map((s) => s.id)).toEqual([
      "rsn_trace_lisbon_01",
      "stp_trace_lisbon_02",
      "stp_trace_lisbon_03",
      "stp_trace_lisbon_04",
    ]);
    expect(mid[0]?.status).toBe("ok");
    for (const s of mid.slice(1)) {
      expect(s.status).toBe("running");
      expect(s.endedAt).toBeNull();
    }
    // The approval was waiting at 09:21:00, and nothing after it had started.
    const wait = stepsAt(steps, at("09:21", "00"));
    expect(wait.at(-1)?.id).toBe("stp_trace_lisbon_06");
    expect(wait.at(-1)?.status).toBe("waiting");
    // At the end, the trace is unchanged.
    expect(stepsAt(steps, at("09:22"))).toEqual(steps);
  });

  it("shows the attempt of a retried step that was live at that time", () => {
    const steps = stepsOf(R.failed);
    const first = stepsAt(steps, at("08:30", "20")).find((s) => s.id === "stp_trace_audit_02");
    expect(first?.status).toBe("running");
    expect(first?.attempt).toBe(1);
    expect(first?.attempts).toEqual([]);
    const gap = stepsAt(steps, at("08:30", "40")).find((s) => s.id === "stp_trace_audit_02");
    expect(gap?.status).toBe("running");
    expect(gap?.attempt).toBe(2);
    expect(gap?.attempts).toHaveLength(1);
  });

  it("plays at speed, skips idle gaps, and stops at failures and at the end", () => {
    const opts = {
      speed: 4 as const,
      end: 10_000,
      gaps: [{ from: 2_000, to: 8_000 }],
      skipWaits: true,
      stopAtFailures: true,
      failures: [9_000],
    };
    expect(advance(0, 250, opts)).toEqual({ t: 1_000, stop: null });
    // Landing inside the gap jumps to its end.
    expect(advance(1_500, 250, opts)).toEqual({ t: 8_000, stop: null });
    expect(advance(1_500, 250, { ...opts, skipWaits: false })).toEqual({ t: 2_500, stop: null });
    expect(advance(8_500, 250, opts)).toEqual({ t: 9_000, stop: "failure" });
    expect(advance(9_500, 250, opts)).toEqual({ t: 10_000, stop: "end" });
    // Reduced motion: event by event.
    expect(advanceReduced(0, [1_000, 3_000], { ...opts })).toEqual({ t: 1_000, stop: null });
  });

  it("lists events and failure times, and finds the step under the playhead", () => {
    const steps = stepsOf(R.failed);
    expect(eventTimes(steps)[0]).toBe(at("08:30", "02"));
    expect(failureTimes(steps)).toEqual([at("08:30", "40"), at("08:31", "40")]);
    expect(stepAtTime(steps, at("08:30", "05"))?.id).toBe("stp_trace_audit_01");
  });
});

describe("the row model (§3.3)", () => {
  it("groups parallel steps, nests the helper, and rolls up with — for unknown", () => {
    const helper = { [R.helper]: stepsOf(R.helper) };
    const rows = buildRows(stepsOf(R.done), helper);
    expect(rows.map((r) => r.type)).toEqual([
      "step",
      "group",
      "step",
      "step",
      "step",
      "step",
      "step",
    ]);
    const group = rows[1];
    expect(group?.children).toHaveLength(3);
    // No step in the group reported usage: unknown, never 0.
    expect(group?.rollup).toEqual({ tokens: null, costUsd: null });
    const spawn = rows.find((r) => r.id === "stp_trace_lisbon_05");
    expect(spawn?.children.map((c) => c.id)).toEqual([
      "stp_trace_helper_01",
      "stp_trace_helper_02",
    ]);
    expect(spawn?.barKind).toBe("helper");
    // The approval wait is hatched.
    expect(rows.find((r) => r.id === "stp_trace_lisbon_06")?.segments?.[0]?.kind).toBe("wait");
    // A done helper folds by default; the group stays open.
    const folded = defaultFolded(rows);
    expect(folded.has("stp_trace_lisbon_05")).toBe(true);
    expect(visibleRows(rows, folded).some((r) => r.id === "stp_trace_helper_01")).toBe(false);
    expect(visibleRows(rows, new Set()).some((r) => r.id === "stp_trace_helper_01")).toBe(true);
    // The model step's usage rolls up.
    expect(rows.find((r) => r.id === "stp_trace_lisbon_08")?.rollup.tokens).toBe(16_710);
  });

  it("collapses idle gaps, ignoring waits on you, and finds the failed step", () => {
    const rows = buildRows(stepsOf(R.done));
    const gaps = traceGaps(rows, at("09:21", "34"));
    // The helper reported back at 09:20:52, then Psyche waited for an approval until 09:21:20:
    // an idle gap over 10 s even though the approval step spans it.
    expect(gaps).toContainEqual({ from: at("09:20", "52"), to: at("09:21", "20") });
    const failedRows = buildRows(stepsOf(R.failed));
    expect(failedStep(failedRows)?.id).toBe("stp_trace_audit_02");
    expect(failedRows[1]?.attempts).toHaveLength(1);
  });

  it("searches labels, targets, previews and errors", () => {
    const rows = allRows(buildRows(stepsOf(R.failed)));
    expect(rows.filter((r) => matchesQuery(r, "too long")).map((r) => r.id)).toEqual([
      "stp_trace_audit_02",
    ]);
    expect(rows.filter((r) => matchesQuery(r, "bank.example"))).toHaveLength(2);
  });
});

describe("the keyboard map (§3.3)", () => {
  it("maps every key in the table", () => {
    const map: [Parameters<typeof timelineAction>[0], string][] = [
      [{ key: "ArrowUp" }, "prev"],
      [{ key: "ArrowDown" }, "next"],
      [{ key: "ArrowLeft" }, "fold"],
      [{ key: "ArrowRight" }, "unfold"],
      [{ key: "Enter" }, "inspect"],
      [{ key: "Escape" }, "back"],
      [{ key: " " }, "playPause"],
      [{ key: "," }, "eventBack"],
      [{ key: "." }, "eventForward"],
      [{ key: "[" }, "prevIssue"],
      [{ key: "]" }, "nextIssue"],
      [{ key: "c", metaKey: true }, "copy"],
      [{ key: "=", metaKey: true }, "zoomIn"],
      [{ key: "-", metaKey: true }, "zoomOut"],
      [{ key: "0", metaKey: true }, "zoomFit"],
    ];
    for (const [e, action] of map) expect(timelineAction(e)).toBe(action);
    // Right to left: ← unfolds.
    expect(timelineAction({ key: "ArrowLeft" }, true)).toBe("unfold");
    expect(timelineAction({ key: "c" })).toBeNull();
    expect(zoomStep(1, 1)).toBe(1.5);
    expect(zoomStep(1, -1)).toBe(1);
  });
});

describe("virtualisation (2,000 steps)", () => {
  it("renders a bounded window of rows", () => {
    expect(visibleRange(0, 600, 2000)).toEqual({ start: 0, end: 31 });
    const mid = visibleRange(28 * 1000, 600, 2000);
    expect(mid.end - mid.start).toBeLessThan(45);
    expect(visibleRange(28 * 1995, 600, 2000).end).toBe(2000);
  });

  it("keeps the DOM small for a 2,000-step task", async () => {
    const long = traceLongRun(2000);
    const { wrapper } = setup((w) => {
      w.runs = [...w.runs, long.run];
      w.runSteps = [...w.runSteps, ...long.steps];
    });
    render(<TimelineView runId="run_trace_long" now={NOW} />, { wrapper });
    const grid = await screen.findByRole("treegrid");
    const rows = buildRows(long.steps);
    const expected = visibleRows(rows, defaultFolded(rows)).length;
    expect(expected).toBeGreaterThan(2000);
    await waitFor(() => expect(grid.getAttribute("aria-rowcount")).toBe(String(expected + 1)));
    expect(within(grid).getAllByRole("row").length).toBeLessThan(60);
  });
});

describe("routes", () => {
  it("reads and writes a Timeline route with its step", () => {
    const href = agentTimelineHref(R.failed, { stepId: "stp_trace_audit_02", back: "/feed" });
    expect(href).toBe(`/agent/activity/run/${R.failed}?step=stp_trace_audit_02&from=%2Ffeed`);
    expect(agentSheetRoute(href)).toEqual({
      tab: "activity",
      runId: R.failed,
      stepId: "stp_trace_audit_02",
      back: "/feed",
    });
    // A task id still reads as before.
    expect(agentSheetRoute("/agent/activity/task_1")).toEqual({
      tab: "activity",
      taskId: "task_1",
    });
  });
});

describe("TimelineView", () => {
  it("opens a failed task on its failed step's Output, under the diagnosis", async () => {
    const { wrapper } = setup();
    render(<TimelineView runId={R.failed} now={NOW} onRetry={() => {}} />, { wrapper });
    const banner = await screen.findByTestId("failure-banner");
    expect(banner.textContent).toContain("The page took too long to load.");
    expect(banner.textContent).toContain("Tried 2 times, then stopped.");
    const row = await screen.findByRole("row", { selected: true });
    expect(row.getAttribute("data-row-id")).toBe("stp_trace_audit_02");
    expect(screen.getByRole("tab", { name: "Output", selected: true })).toBeTruthy();
  });

  it("moves, folds and jumps with the keyboard", async () => {
    const { wrapper } = setup();
    render(<TimelineView runId={R.done} now={NOW} initialStepId="rsn_trace_lisbon_01" />, {
      wrapper,
    });
    const grid = await screen.findByRole("treegrid");
    const selected = () => screen.getByRole("row", { selected: true }).getAttribute("data-row-id");
    await waitFor(() => expect(selected()).toBe("rsn_trace_lisbon_01"));
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(selected()).toBe(TRACE_IDS.groups.searches);
    // ← folds the group: its three searches leave the grid.
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    expect(screen.queryByRole("row", { name: /Searched flights/ })).toBeNull();
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(screen.getByRole("row", { name: /Searched flights/ })).toBeTruthy();
    // → on an open group moves into it.
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(selected()).toBe("stp_trace_lisbon_02");
    fireEvent.keyDown(grid, { key: "End" });
    expect(selected()).toBe("stp_trace_lisbon_09");
    // Space plays the replay; the button says Pause replay.
    fireEvent.keyDown(grid, { key: " " });
    expect(screen.getByRole("button", { name: "Pause replay" })).toBeTruthy();
    fireEvent.keyDown(grid, { key: " " });
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    // , steps back one event and the scrubber leaves the end.
    fireEvent.keyDown(grid, { key: "," });
    const slider = screen.getByRole("slider");
    expect(Number(slider.getAttribute("aria-valuenow"))).toBeLessThan(
      Number(slider.getAttribute("aria-valuemax")),
    );
  });

  it("jumps between failed or retried steps with [ and ]", async () => {
    const { wrapper } = setup();
    render(<TimelineView runId={R.failed} now={NOW} initialStepId="stp_trace_audit_01" />, {
      wrapper,
    });
    const grid = await screen.findByRole("treegrid");
    await waitFor(() =>
      expect(screen.getByRole("row", { selected: true }).getAttribute("data-row-id")).toBe(
        "stp_trace_audit_01",
      ),
    );
    fireEvent.keyDown(grid, { key: "]" });
    expect(screen.getByRole("row", { selected: true }).getAttribute("data-row-id")).toBe(
      "stp_trace_audit_02",
    );
  });

  it("finds steps in the List view with ⌘F", async () => {
    const { wrapper } = setup();
    render(<TimelineView runId={R.done} now={NOW} />, { wrapper });
    const region = await screen.findByRole("region", { name: /Timeline for Lisbon research/ });
    fireEvent.keyDown(region, { key: "f", metaKey: true });
    const search = await screen.findByRole("searchbox", { name: "Search steps" });
    await act(async () => {
      fireEvent.change(search, { target: { value: "booking.com" } });
    });
    const list = screen.getByRole("list", { name: "Steps" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  });
});

describe("TimelineView replay clock (smoothness C14)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("plays N frames without re-rendering the view N times, yet the playhead moves", async () => {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { wrapper } = setup();
    let commits = 0;
    render(
      <Profiler
        id="timeline"
        onRender={() => {
          commits += 1;
        }}
      >
        <TimelineView runId={R.done} now={NOW} />
      </Profiler>,
      { wrapper },
    );
    await screen.findByRole("treegrid");
    fireEvent.click(screen.getByRole("button", { name: "16×" }));
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const thumb = () => screen.getByRole("slider").querySelector<HTMLElement>("[data-playhead]");
    const slider = screen.getByRole("slider");
    const before = commits;
    const startX = thumb()?.style.insetInlineStart;
    const FRAMES = 120;
    const t0 = performance.now();
    for (let i = 1; i <= FRAMES; i += 1) {
      const cb = queue.shift();
      if (!cb) break;
      act(() => cb(t0 + i * 16));
    }
    expect(thumb()?.style.insetInlineStart).not.toBe(startX);
    expect(Number(slider.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    // Commits only for discrete changes (steps appearing, frames, ~1 Hz labels), not per frame.
    expect(commits - before).toBeLessThan(FRAMES / 4);
  });
});
