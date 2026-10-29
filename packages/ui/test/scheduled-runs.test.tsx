import type { ScheduledRunEntry } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UpcomingPanel } from "../src/agent/UpcomingPanel.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { SCHEDULED_NOW, SCHEDULED_ZONE } from "../src/fixtures/scheduled.ts";
import {
  ScheduledRuns,
  ScheduledRunsView,
  type ScheduledRunsViewProps,
} from "../src/screens/scheduled/ScheduledRuns.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const toasts = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", async (orig) => ({
  ...(await orig<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), toasts),
}));

const run = (over: Partial<ScheduledRunEntry>): ScheduledRunEntry => ({
  id: "run_x",
  automationId: "auto_x",
  title: "Friday recap",
  group: "owner",
  trigger: "schedule",
  state: "succeeded",
  reason: null,
  startedAt: new Date(SCHEDULED_NOW - 3_600_000).toISOString(),
  endedAt: new Date(SCHEDULED_NOW - 3_540_000).toISOString(),
  durationMs: 60_000,
  summary: "Sent the recap.",
  threadId: null,
  taskId: null,
  agentRunId: null,
  pendingApprovals: 0,
  ...over,
});

function renderRuns(runs: ScheduledRunEntry[], over: Partial<ScheduledRunsViewProps> = {}) {
  const props: ScheduledRunsViewProps = {
    runs,
    now: SCHEDULED_NOW,
    timezone: SCHEDULED_ZONE,
    job: "",
    state: "",
    onJobChange: vi.fn(),
    onStateChange: vi.fn(),
    onOpenApprovals: vi.fn(),
    onOpenTranscript: vi.fn(),
    ...over,
  };
  render(<ScheduledRunsView {...props} />);
  return props;
}

describe("the Runs list", () => {
  it("shows background, in-progress, failed and skipped runs with their reasons", () => {
    renderRuns([
      run({ id: "r1", title: "Daily wrap-up", routine: "daily-wrapup", group: "routine" }),
      run({ id: "r2", title: "Check parcels", state: "running", endedAt: null, durationMs: null }),
      run({ id: "r3", title: "Order", state: "failed", reason: "the shop was down" }),
      run({ id: "r4", title: "Digest", state: "skipped", reason: "on battery" }),
      run({ id: "r5", title: "Mail", state: "skipped", reason: "quiet hours" }),
    ]);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(within(items[1] as HTMLElement).getByText("Running")).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText(/still running/)).toBeTruthy();
    // A failed run never reads as succeeded.
    expect(within(items[2] as HTMLElement).getByText("Failed")).toBeTruthy();
    expect(within(items[2] as HTMLElement).queryByText("Succeeded")).toBeNull();
    expect(within(items[2] as HTMLElement).getByText("the shop was down")).toBeTruthy();
    expect(screen.getByText("Skipped: on battery")).toBeTruthy();
    expect(screen.getByText("Skipped: quiet hours")).toBeTruthy();
    // A routine is named from the catalogue and marked as Psyche's.
    expect(within(items[0] as HTMLElement).getByText(/Psyche's routine/)).toBeTruthy();
  });

  it("makes a run waiting on an approval obvious, with a button to the card", async () => {
    const props = renderRuns([
      run({
        title: "Order",
        state: "waiting",
        endedAt: null,
        durationMs: null,
        pendingApprovals: 2,
      }),
    ]);
    expect(screen.getAllByText("Waiting for approval").length).toBeGreaterThan(1);
    expect(screen.getByText("Waiting for 2 approvals.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Review the approval" }));
    expect(props.onOpenApprovals).toHaveBeenCalled();
  });

  it("filters by job and by status, and links to the Timeline", async () => {
    const onJobChange = vi.fn();
    const onStateChange = vi.fn();
    renderRuns(
      [
        run({ id: "a", automationId: "a1", title: "Alpha", agentRunId: "arun_1" }),
        run({ id: "b", automationId: "b1", title: "Beta", state: "failed", reason: "boom" }),
      ],
      { job: "b1", onJobChange, onStateChange },
    );
    // The job filter applies: only Beta's run is listed.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await userEvent.selectOptions(screen.getByLabelText("Status"), "failed");
    expect(onStateChange).toHaveBeenCalledWith("failed");
    await userEvent.selectOptions(screen.getByLabelText("Job"), "a1");
    expect(onJobChange).toHaveBeenCalledWith("a1");
  });

  it("says when nothing has run, or no run matches", () => {
    renderRuns([]);
    expect(screen.getByText("Nothing has run yet.")).toBeTruthy();
  });
});

function withGateway() {
  const ref: { gateway?: MockGateway } = {};
  return {
    ref,
    onGateway: (g: MockGateway) => {
      ref.gateway = g;
    },
  };
}

describe("Runs, wired", () => {
  it("updates live when a run starts", async () => {
    const { ref, onGateway } = withGateway();
    render(
      <StoryWorld onGateway={onGateway}>
        <ScheduledRuns now={STORY_NOW} timezone="UTC" />
      </StoryWorld>,
    );
    expect(await screen.findByText("Nothing has run yet.")).toBeTruthy();
    const gw = ref.gateway as MockGateway;
    (gw as unknown as { handlers: Record<string, unknown> }).handlers["scheduled.runs"] = () => ({
      runs: [run({ title: "Live job", state: "running", endedAt: null, durationMs: null })],
    });
    gw.emit("automation.run.started", {
      run: {
        id: "run_x",
        automationId: "auto_x",
        threadId: null,
        taskId: null,
        trigger: "schedule",
        scheduledFor: new Date(STORY_NOW).toISOString(),
        coalesced: 1,
        startedAt: new Date(STORY_NOW).toISOString(),
        endedAt: null,
        status: "running",
        summary: null,
        notificationId: null,
        runId: null,
      },
    });
    const item = await screen.findByRole("listitem");
    expect(within(item).getByText("Live job")).toBeTruthy();
    expect(within(item).getByText("Running")).toBeTruthy();
  });
});

describe("Run now in Upcoming", () => {
  it("shows Running… then the result", async () => {
    toasts.info.mockClear();
    toasts.success.mockClear();
    const { ref, onGateway } = withGateway();
    render(
      <StoryWorld onGateway={onGateway}>
        <UpcomingPanel now={STORY_NOW} />
      </StoryWorld>,
    );
    const run1 = (await screen.findAllByRole("button", { name: "Run now" }))[0] as HTMLElement;
    await userEvent.click(run1);
    expect(toasts.info).toHaveBeenCalledWith(expect.stringMatching(/^Running .+…$/));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(ref.gateway?.calls.filter((c) => c.method === "automations.run")).toHaveLength(1);
  });

  it("shows a clear error when the run can't start", async () => {
    toasts.error.mockClear();
    const { ref, onGateway } = withGateway();
    render(
      <StoryWorld onGateway={onGateway}>
        <UpcomingPanel now={STORY_NOW} />
      </StoryWorld>,
    );
    const button = (await screen.findAllByRole("button", { name: "Run now" }))[0] as HTMLElement;
    ref.gateway?.failNext(
      "automations.run",
      "conflict",
      "a run of this automation is already in progress",
    );
    await userEvent.click(button);
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(String(toasts.error.mock.calls[0]?.[0])).toMatch(/Couldn't run/);
  });
});
