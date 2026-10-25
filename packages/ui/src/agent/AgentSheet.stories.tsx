import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useState } from "react";
import { IDS } from "../fixtures/index.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { AgentRouteSheet, AgentSheet, type AgentTab } from "./AgentSheet.tsx";
import { ApprovalsPanel } from "./ApprovalsPanel.tsx";
import { SoulMemoryPanel } from "./SoulMemoryPanel.tsx";
import { UpcomingPanel } from "./UpcomingPanel.tsx";

/**
 * The agent sheet (docs/design/redesign-2026.md §5.7): a 420 px opaque right sheet (level 3, over a scrim) with a 64 px
 * header and segmented tabs, and its four panels in populated, empty, loading and error states.
 * The visual baseline shoots Agent/* in light and dark.
 */
const meta = {
  title: "Agent/Sheet",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function OpenSheet({ initial, side = "right" }: { initial: AgentTab; side?: "right" | "bottom" }) {
  const [tab, setTab] = useState<AgentTab>(initial);
  return (
    <AgentSheet
      open
      side={side}
      onOpenChange={() => {}}
      tab={tab}
      onTabChange={setTab}
      now={STORY_NOW}
    />
  );
}

export const Activity: Story = { render: () => <OpenSheet initial="activity" /> };
export const Approvals: Story = { render: () => <OpenSheet initial="approvals" /> };
export const Upcoming: Story = { render: () => <OpenSheet initial="upcoming" /> };
export const SoulAndMemory: Story = { render: () => <OpenSheet initial="soul" /> };

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
  render: () => <OpenSheet initial="activity" side="bottom" />,
};

/** The panels on their own sit in the sheet's 20 px gutter, 420 px wide. */
function Gutter({ children }: { children: ReactNode }) {
  return <div className="w-[420px] p-5">{children}</div>;
}

export const ActivityTaskDetail: Story = {
  render: () => (
    <Gutter>
      <ActivityPanel initialTaskId={IDS.tasks.dentist} now={STORY_NOW} />
    </Gutter>
  ),
};
export const ActivityEmpty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.tasks = [];
      },
    }),
  ],
  render: () => (
    <Gutter>
      <ActivityPanel now={STORY_NOW} />
    </Gutter>
  ),
};
export const ActivityError: Story = {
  decorators: [withWorld({ onGateway: (g) => g.failNext("tasks.list", "unavailable") })],
  render: () => (
    <Gutter>
      <ActivityPanel now={STORY_NOW} />
    </Gutter>
  ),
};
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
export const UpcomingEmpty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.automations = [];
      },
    }),
  ],
  render: () => (
    <Gutter>
      <UpcomingPanel now={STORY_NOW} />
    </Gutter>
  ),
};
export const UpcomingError: Story = {
  decorators: [withWorld({ onGateway: (g) => g.failNext("automations.list", "unavailable") })],
  render: () => (
    <Gutter>
      <UpcomingPanel now={STORY_NOW} />
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
