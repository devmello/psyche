import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useState } from "react";
import type { FixtureWorld } from "../fixtures/index.ts";
import { runTraceWorld } from "../fixtures/runs.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import {
  AGENT_PANEL_WIDTH,
  AgentRouteSheet,
  AgentSheet,
  AgentSheetPanel,
  type AgentTab,
} from "./AgentSheet.tsx";
import { ApprovalsPanel } from "./ApprovalsPanel.tsx";
import { SoulMemoryPanel } from "./SoulMemoryPanel.tsx";

/**
 * The slim agent sheet (docs/design/agent-overview-2026.md §4): a 420 px opaque right sheet
 * (level 3, over a scrim) with the 64 px header (avatar, name, the Now / next line, "Open
 * overview") and two full-width segments, Approvals and Soul & Memory. `Inline*` is the 400 px
 * panel the shell puts beside the content on wide windows (#625). The visual baseline shoots
 * Agent/* in light and dark.
 */
const meta = {
  title: "Agent/Sheet",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function OpenSheet({
  initial,
  side = "right",
  view,
}: {
  initial: AgentTab;
  side?: "right" | "bottom";
  view?: "decided";
}) {
  const [tab, setTab] = useState<AgentTab>(initial);
  return (
    <AgentSheet
      open
      side={side}
      onOpenChange={() => {}}
      tab={tab}
      onTabChange={setTab}
      {...(view ? { view } : {})}
      now={STORY_NOW}
    />
  );
}

/** Nothing pending and nothing running: "Idle · next: …" and the empty Approvals state. */
function quiet(w: FixtureWorld): void {
  w.runs = [];
  w.tasks = [];
  w.approvals = [];
  w.inputRequests = [];
  w.threads = w.threads.map((e) => ({ ...e, thread: { ...e.thread, activeWriterRunId: null } }));
}

/** A run in flight and nothing waiting: "Working on … · 0:42". */
function working(w: FixtureWorld): void {
  const tw = runTraceWorld();
  w.runs = [...tw.runs];
  w.runSteps = tw.runSteps;
  w.runFrames = tw.runFrames;
  w.runPayloads = tw.runPayloads;
  w.automationRuns = tw.automationRuns;
  w.approvals = [];
  w.inputRequests = [];
}

/** Approvals are waiting: "Waiting for you · N approvals", cards under Needs you. */
export const Approvals: Story = { render: () => <OpenSheet initial="approvals" /> };
export const SoulAndMemory: Story = { render: () => <OpenSheet initial="soul" /> };
export const Waiting: Story = { render: () => <OpenSheet initial="approvals" /> };
export const Working: Story = {
  decorators: [withWorld({ edit: working })],
  render: () => <OpenSheet initial="approvals" />,
};
export const Idle: Story = {
  decorators: [withWorld({ edit: quiet })],
  render: () => <OpenSheet initial="approvals" />,
};
/** Nothing pending, nothing scheduled: the empty state and a bare "Idle". */
export const Empty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        quiet(w);
        w.automations = [];
      },
    }),
  ],
  render: () => <OpenSheet initial="approvals" />,
};
/** `/agent/approvals?view=decided`: "Decided recently" opens expanded. */
export const DecidedRecently: Story = {
  render: () => <OpenSheet initial="approvals" view="decided" />,
};

/** #625: the inline panel the shell puts beside the content on wide windows. */
function InlinePanel({ initial }: { initial: AgentTab }) {
  const [tab, setTab] = useState<AgentTab>(initial);
  return (
    <div className="flex h-dvh bg-canvas">
      <div className="min-w-0 flex-1" />
      <div className="h-full shrink-0" style={{ width: AGENT_PANEL_WIDTH }}>
        <AgentSheetPanel tab={tab} onTabChange={setTab} onClose={() => {}} now={STORY_NOW} />
      </div>
    </div>
  );
}
export const Inline: Story = { render: () => <InlinePanel initial="approvals" /> };
export const InlineSoul: Story = { render: () => <InlinePanel initial="soul" /> };

/** `/agent/soul?file=USER.md`: the route opens the sheet and the file in the editor sheet. */
export const RouteWithFile: Story = {
  render: () => (
    <AgentRouteSheet
      route={{ tab: "soul", file: "USER.md" }}
      onTabChange={() => {}}
      onClose={() => {}}
    />
  ),
};

/** Compact (§5.11): the same sheet from the bottom, with a grabber. */
export const Compact: Story = {
  render: () => <OpenSheet initial="approvals" side="bottom" />,
};

/** The panels on their own sit in the sheet's 20 px gutter, 420 px wide. */
function Gutter({ children }: { children: ReactNode }) {
  return <div className="w-[420px] p-5">{children}</div>;
}

export const ApprovalsNothingNeedsYou: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.approvals = [];
      },
    }),
  ],
  render: () => (
    <Gutter>
      <ApprovalsPanel now={STORY_NOW} />
    </Gutter>
  ),
};
export const SoulDailyNote: Story = {
  render: () => (
    <Gutter>
      <SoulMemoryPanel
        initialFile="memory/2026-10-18.md"
        onStartIncognito={() => {}}
        onImport={() => {}}
      />
    </Gutter>
  ),
};
