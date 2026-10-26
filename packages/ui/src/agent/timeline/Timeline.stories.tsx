import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { at, today } from "../../fixtures/ids.ts";
import type { FixtureWorld } from "../../fixtures/index.ts";
import { runTraceWorld, TRACE_IDS, traceLongRun } from "../../fixtures/runs.ts";
import { medianFps } from "../../motion/fps-probe.ts";
import { STORY_NOW, withWorld } from "../../stories/harness.tsx";
import { TimelineView } from "./TimelineView.tsx";

/**
 * The run trace's Timeline in the agent sheet (docs/design/run-trace-2026.md §3.3–§3.5, §3.8):
 * done, running, failed with the diagnosis, a helper unfolded, mid-replay, frames, expired
 * detail, compact web, and 2,000 steps with the fps probe.
 */

const R = TRACE_IDS.runs;

/** Adds the run-trace fixtures to the story world. */
function trace(edit?: (w: FixtureWorld) => void): (w: FixtureWorld) => void {
  return (w) => {
    const tw = runTraceWorld();
    w.runs = [...w.runs.filter((r) => !tw.runs.some((x) => x.id === r.id)), ...tw.runs];
    w.runSteps = tw.runSteps;
    w.runFrames = tw.runFrames;
    w.runPayloads = tw.runPayloads;
    w.automationRuns = tw.automationRuns;
    edit?.(w);
  };
}

function Frame({ width = 940, children }: { width?: number; children: ReactNode }): ReactElement {
  return (
    <div className="flex h-[700px] flex-col bg-canvas p-3" style={{ width }}>
      {children}
    </div>
  );
}

const meta = {
  title: "Agent/Timeline",
  decorators: [withWorld({ edit: trace() })],
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Done: Story = {
  render: () => (
    <Frame>
      <TimelineView runId={R.done} now={STORY_NOW} onBack={() => {}} onRetry={() => {}} />
    </Frame>
  ),
};

export const Running: Story = {
  render: () => (
    <Frame>
      <TimelineView runId={R.live} now={STORY_NOW} onStop={() => {}} onPause={() => {}} />
    </Frame>
  ),
};

/** A live run scripted on a timer (run.step events every 1.2 s); no baseline, it moves. */
export const RunningScripted: Story = {
  tags: ["no-visual"],
  decorators: [
    withWorld({
      edit: trace(),
      onGateway: (gw) => {
        let n = 3;
        const timer = setInterval(() => {
          n += 1;
          const now = new Date().toISOString();
          gw.setStep({
            id: `stp_trace_dentist_${String(n).padStart(2, "0")}`,
            runId: R.live,
            seq: n,
            kind: "tool",
            status: "running",
            label: `Checking week ${n - 2}`,
            doneLabel: `Checked week ${n - 2}`,
            target: "ortizdental.example",
            startedAt: now,
            endedAt: null,
            attempt: 1,
          });
          if (n > 12) clearInterval(timer);
        }, 1200);
      },
    }),
  ],
  render: () => (
    <Frame>
      <TimelineView runId={R.live} onStop={() => {}} />
    </Frame>
  ),
};

export const FailedWithBanner: Story = {
  render: () => (
    <Frame>
      <TimelineView runId={R.failed} now={STORY_NOW} onRetry={() => {}} onBack={() => {}} />
    </Frame>
  ),
};

/** An authorisation failure offers Reconnect (what you can do). */
export const FailedReconnect: Story = {
  decorators: [
    withWorld({
      edit: trace((w) => {
        w.runSteps = (w.runSteps ?? []).map((s) =>
          s.id === "stp_trace_audit_02"
            ? {
                ...s,
                label: "Creating the calendar event",
                error: {
                  code: "forbidden",
                  message: "403 from Google Calendar.",
                  retryable: false,
                },
              }
            : s,
        );
      }),
    }),
  ],
  render: () => (
    <Frame>
      <TimelineView runId={R.failed} now={STORY_NOW} onRetry={() => {}} onReconnect={() => {}} />
    </Frame>
  ),
};

export const HelperUnfolded: Story = {
  render: () => (
    <Frame>
      <TimelineView runId={R.done} now={STORY_NOW} initialStepId="stp_trace_helper_01" />
    </Frame>
  ),
};

/** Paused mid-replay: later steps are hidden, the running ones show their bar so far. */
export const ReplayMidScrub: Story = {
  render: () => (
    <Frame>
      <TimelineView
        runId={R.done}
        now={STORY_NOW}
        initialReplayAt={Date.parse(today("09:20", "30"))}
      />
    </Frame>
  ),
};

export const Frames: Story = {
  render: () => (
    <Frame>
      <TimelineView
        runId={R.failed}
        now={STORY_NOW}
        initialStepId="stp_trace_audit_02"
        initialTab="frames"
      />
    </Frame>
  ),
};

/** Thinking past its retention keeps its label and timing and says why the detail is gone. */
export const ExpiredDetail: Story = {
  decorators: [
    withWorld({
      edit: trace((w) => {
        w.runSteps = (w.runSteps ?? []).map((s) =>
          s.id === "rsn_trace_lisbon_01" && s.text
            ? { ...s, text: { summary: s.text.summary, expiresAt: at(-3600) } }
            : s,
        );
      }),
    }),
  ],
  render: () => (
    <Frame>
      <TimelineView runId={R.done} now={STORY_NOW} initialStepId="rsn_trace_lisbon_01" />
    </Frame>
  ),
};

export const CompactWeb: Story = {
  render: () => (
    <Frame width={390}>
      <TimelineView runId={R.failed} now={STORY_NOW} onBack={() => {}} />
    </Frame>
  ),
};

function FpsProbe({ children }: { children: ReactNode }): ReactElement {
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="waterfall"] .overflow-auto',
    );
    if (!scroller) return;
    const intervals: number[] = [];
    let last = 0;
    let first = 0;
    let handle = 0;
    const tick = (ts: number) => {
      if (first === 0) first = ts;
      else intervals.push(ts - last);
      last = ts;
      // Scroll the waterfall steadily while measuring, so the virtualiser works every frame.
      scroller.scrollTop += 40;
      if (ts - first < 3000) handle = requestAnimationFrame(tick);
      else setFps(medianFps(intervals));
    };
    const start = setTimeout(() => {
      handle = requestAnimationFrame(tick);
    }, 300);
    return () => {
      clearTimeout(start);
      cancelAnimationFrame(handle);
    };
  }, []);
  return (
    <div className="flex flex-col gap-2">
      <output className="text-callout text-label-secondary" data-testid="fps">
        {fps === null ? "measuring…" : `${fps} fps`}
      </output>
      {children}
    </div>
  );
}

/** 2,000 steps, virtualised; the probe scrolls the waterfall for 3 s and reports the median. */
export const TwoThousandSteps: Story = {
  tags: ["no-visual"],
  decorators: [
    withWorld({
      edit: trace((w) => {
        const long = traceLongRun(2000);
        w.runs = [...w.runs, long.run];
        w.runSteps = [...(w.runSteps ?? []), ...long.steps];
      }),
    }),
  ],
  render: () => (
    <FpsProbe>
      <Frame>
        <TimelineView runId="run_trace_long" now={STORY_NOW} />
      </Frame>
    </FpsProbe>
  ),
};
