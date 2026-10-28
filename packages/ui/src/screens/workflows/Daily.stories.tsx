import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement, ReactNode } from "react";
import {
  dailyFollowups,
  eveningWrapup,
  morningBrief,
  morningBriefNoConnectors,
  userAutomation,
} from "../../fixtures/daily.ts";
import { withWorld } from "../../stories/harness.tsx";
import { AutomationsPanel, DailyPanel, FollowupsList } from "../settings/DailySection.tsx";
import { DailyCard } from "./DailyCard.tsx";

/** The morning brief, evening wrap-up, Settings → Daily, Follow-ups and Automations. */
const meta = {
  title: "Cards/Daily",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

function Column({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="@container/column mx-auto flex max-w-[640px] flex-col gap-4 p-6">
      {children}
    </div>
  );
}

export const MorningBrief: Story = {
  render: () => (
    <Column>
      <DailyCard brief={morningBrief()} onOpen={noop} onFollowup={noop} />
    </Column>
  ),
};
export const MorningNoConnectors: Story = {
  render: () => (
    <Column>
      <DailyCard brief={morningBriefNoConnectors()} />
    </Column>
  ),
};
export const EveningWrapup: Story = {
  render: () => (
    <Column>
      <DailyCard brief={eveningWrapup()} onFollowup={noop} onCarryOver={noop} />
    </Column>
  ),
};
export const SettingsDefaults: Story = {
  render: () => (
    <Column>
      <DailyPanel values={{}} onChange={noop} onPreview={noop} />
    </Column>
  ),
};
export const SettingsOn: Story = {
  render: () => (
    <Column>
      <DailyPanel
        values={{
          "daily.brief.enabled": true,
          "daily.wrapup.enabled": true,
          "daily.messages": true,
        }}
        onChange={noop}
      />
    </Column>
  ),
};
export const Followups: Story = {
  render: () => (
    <Column>
      <FollowupsList followups={dailyFollowups()} onUpdate={noop} onOpen={noop} />
    </Column>
  ),
};
export const FollowupsEmpty: Story = {
  render: () => (
    <Column>
      <FollowupsList followups={[]} onUpdate={noop} />
    </Column>
  ),
};
const templates = [
  { id: "friday-shipped", text: "Every Friday at 5pm, summarise what I shipped this week" },
  { id: "monday-plan", text: "Every Monday at 9am, help me plan the week" },
];
const autoProps = {
  templates,
  draft: null,
  onParse: noop,
  onConfirm: noop,
  onCancelDraft: noop,
  onToggle: noop,
  onEdit: noop,
  onDelete: noop,
};
export const AutomationsList: Story = {
  render: () => (
    <Column>
      <AutomationsPanel
        {...autoProps}
        automations={[
          userAutomation(),
          userAutomation({ id: "auto_2", title: "Monday plan", enabled: false }),
        ]}
      />
    </Column>
  ),
};
export const AutomationConfirmCard: Story = {
  render: () => (
    <Column>
      <AutomationsPanel
        {...autoProps}
        automations={[]}
        draft={{
          title: "Weekly shipped summary",
          kind: "cron",
          schedule: "0 17 * * 5",
          timezone: "America/Los_Angeles",
          prompt: "Summarise what I shipped this week.",
          humanSchedule: "Every Friday at 5:00 PM",
        }}
      />
    </Column>
  ),
};
export const AutomationParseError: Story = {
  render: () => (
    <Column>
      <AutomationsPanel
        {...autoProps}
        automations={[]}
        parseError="I couldn't find a schedule in that."
      />
    </Column>
  ),
};
