import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { IDS } from "../fixtures/index.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { AgentHeader } from "./AgentHeader.tsx";
import { AgentSheetBody, type AgentTab } from "./AgentSheet.tsx";
import { ApprovalsPanel } from "./ApprovalsPanel.tsx";
import { SoulMemoryPanel } from "./SoulMemoryPanel.tsx";
import { UpcomingPanel } from "./UpcomingPanel.tsx";

const meta = {
  title: "Agent/Header and sheet",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Header: Story = {
  render: () => (
    <AgentHeader
      onOpenSheet={() => {}}
      mode="balanced"
      onModeChange={() => {}}
      model="anthropic/claude-sonnet-5-5"
      onOpenModelPicker={() => {}}
      onOpenInbox={() => {}}
    />
  ),
};

export const HeaderIdle: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.approvals = w.approvals.filter((a) => a.status !== "pending");
        w.inputRequests = w.inputRequests.filter((q) => q.status !== "open");
        w.tasks = w.tasks.map((t) => ({ ...t, status: "done" as const }));
      },
    }),
  ],
  render: () => <AgentHeader onOpenSheet={() => {}} mode="balanced" />,
};

export const HeaderOffline: Story = {
  decorators: [withWorld({ options: { connection: "offline" } })],
  render: () => <AgentHeader onOpenSheet={() => {}} />,
};

function SheetBody({ initial }: { initial: AgentTab }) {
  const [tab, setTab] = useState<AgentTab>(initial);
  return (
    <div className="flex h-[640px] max-w-xl flex-col p-4">
      <AgentSheetBody tab={tab} onTabChange={setTab} now={STORY_NOW} />
    </div>
  );
}

export const SheetActivity: Story = { render: () => <SheetBody initial="activity" /> };
export const SheetApprovals: Story = { render: () => <SheetBody initial="approvals" /> };
export const SheetUpcoming: Story = { render: () => <SheetBody initial="upcoming" /> };
export const SheetSoulAndMemory: Story = { render: () => <SheetBody initial="soul" /> };

export const ActivityTaskDetail: Story = {
  render: () => <ActivityPanel initialTaskId={IDS.tasks.dentist} now={STORY_NOW} />,
};
export const ActivityEmpty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.tasks = [];
      },
    }),
  ],
  render: () => <ActivityPanel now={STORY_NOW} />,
};
export const ApprovalsNothingNeedsYou: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.approvals = [];
      },
    }),
  ],
  render: () => <ApprovalsPanel now={STORY_NOW} />,
};
export const UpcomingEmpty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.automations = [];
      },
    }),
  ],
  render: () => <UpcomingPanel now={STORY_NOW} />,
};
export const SoulDailyNote: Story = {
  render: () => (
    <SoulMemoryPanel
      initialFile="memory/2026-10-18.md"
      onStartIncognito={() => {}}
      onImport={() => {}}
    />
  ),
};
