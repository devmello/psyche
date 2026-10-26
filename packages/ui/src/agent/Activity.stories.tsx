import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement, ReactNode } from "react";
import type { FixtureWorld } from "../fixtures/index.ts";
import { runTraceWorld } from "../fixtures/runs.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { ActivityPanel } from "./ActivityPanel.tsx";

/**
 * Activity as mission control (docs/design/run-trace-2026.md §3.6): Needs you, Now (live
 * sparklines), Next up (honest usual durations) and Recent, opening Timelines; and the empty
 * states.
 */

function trace(w: FixtureWorld): void {
  const tw = runTraceWorld();
  w.runs = [...w.runs.filter((r) => !tw.runs.some((x) => x.id === r.id)), ...tw.runs];
  w.runSteps = tw.runSteps;
  w.runFrames = tw.runFrames;
  w.runPayloads = tw.runPayloads;
  w.automationRuns = tw.automationRuns;
}

function Sheet({ children }: { children: ReactNode }): ReactElement {
  return <div className="w-[420px] bg-canvas p-4">{children}</div>;
}

const meta = {
  title: "Agent/Activity",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const MissionControl: Story = {
  decorators: [withWorld({ edit: trace })],
  render: () => (
    <Sheet>
      <ActivityPanel now={STORY_NOW} />
    </Sheet>
  ),
};

/** Nothing running: the next automation is named with its countdown. */
export const Empty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.runs = [];
        w.tasks = [];
        w.approvals = [];
        w.inputRequests = [];
      },
    }),
  ],
  render: () => (
    <Sheet>
      <ActivityPanel now={STORY_NOW} />
    </Sheet>
  ),
};

export const EmptyNoAutomations: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.runs = [];
        w.tasks = [];
        w.approvals = [];
        w.inputRequests = [];
        w.automations = [];
      },
    }),
  ],
  render: () => (
    <Sheet>
      <ActivityPanel now={STORY_NOW} />
    </Sheet>
  ),
};

/** A run opened from Activity: its Timeline at the sheet's width. */
export const OpenedTimeline: Story = {
  decorators: [withWorld({ edit: trace })],
  render: () => (
    <div className="flex h-[700px] w-[420px] flex-col bg-canvas p-4">
      <ActivityPanel now={STORY_NOW} initialRunId="run_trace_audit" />
    </div>
  ),
};
