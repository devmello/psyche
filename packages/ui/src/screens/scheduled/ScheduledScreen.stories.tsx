import type { ScheduledItem } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactElement, useState } from "react";
import {
  SCHEDULED_NOW,
  SCHEDULED_ZONE,
  scheduledChanges,
  scheduledItems,
  scheduledRuns,
} from "../../fixtures/scheduled.ts";
import { withWorld } from "../../stories/harness.tsx";
import { RunChangesView, RunHistoryView } from "./RunHistory.tsx";
import { ScheduledView, type ScheduledViewProps } from "./ScheduledScreen.tsx";

/** Scheduled: everything that runs on a schedule, by who set it up. */
const meta = {
  title: "Screens/Scheduled",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

/** The screen with pause, delete and edit working on local state. */
function Interactive({
  initial = scheduledItems(),
  ...rest
}: { initial?: ScheduledItem[] } & Partial<ScheduledViewProps>): ReactElement {
  const [items, setItems] = useState(initial);
  return (
    <ScheduledView
      items={items}
      timezone={SCHEDULED_ZONE}
      now={SCHEDULED_NOW}
      onNewAutomation={noop}
      onPause={(item, paused) =>
        setItems((all) =>
          all.map((i) =>
            i.id === item.id
              ? {
                  ...i,
                  state: paused ? "paused" : "active",
                  enabled: !paused,
                  nextRunAt: paused ? null : "2026-10-29T14:30:00.000Z",
                }
              : i,
          ),
        )
      }
      onRunNow={noop}
      onDelete={(item) => setItems((all) => all.filter((i) => i.id !== item.id))}
      onOpenSettings={noop}
      onEditInChat={noop}
      onParseEdit={async (item, text) => ({
        draft: {
          title: item.title,
          kind: "cron",
          schedule: "0 9 * * 1-5",
          timezone: SCHEDULED_ZONE,
          prompt: text,
          humanSchedule: "Every weekday at 9:00 AM",
        },
      })}
      onSaveEdit={async () => {}}
      renderHistory={() => (
        <RunHistoryView
          runs={scheduledRuns()}
          now={SCHEDULED_NOW}
          timezone={SCHEDULED_ZONE}
          onOpenChat={noop}
          onOpenTranscript={noop}
          renderChanges={(run) =>
            run.runId ? <RunChangesView changes={scheduledChanges()} /> : null
          }
        />
      )}
      {...rest}
    />
  );
}

export const Default: Story = { render: () => <Interactive /> };

/** No automations yet: examples and a New automation button; Psyche's routines still show. */
export const Empty: Story = {
  render: () => <Interactive initial={scheduledItems().filter((i) => i.group === "routine")} />,
};

export const NothingScheduled: Story = { render: () => <Interactive initial={[]} /> };

export const Loading: Story = {
  render: () => <Interactive initial={[]} loading />,
};

export const LoadFailed: Story = {
  render: () => <Interactive initial={[]} error="The Gateway isn't answering" onRetry={noop} />,
};

export const RunHistory: Story = {
  render: () => (
    <div className="mx-auto flex max-w-[640px] flex-col gap-4 p-6">
      <RunHistoryView
        runs={scheduledRuns()}
        now={SCHEDULED_NOW}
        timezone={SCHEDULED_ZONE}
        onOpenChat={noop}
        onOpenTranscript={noop}
        renderChanges={(run) =>
          run.runId ? <RunChangesView changes={scheduledChanges()} /> : null
        }
      />
    </div>
  ),
};

export const RunHistoryEmpty: Story = {
  render: () => (
    <div className="mx-auto flex max-w-[640px] flex-col gap-4 p-6">
      <RunHistoryView runs={[]} now={SCHEDULED_NOW} timezone={SCHEDULED_ZONE} />
    </div>
  ),
};
