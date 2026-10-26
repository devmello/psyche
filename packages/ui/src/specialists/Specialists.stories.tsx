import type { SpecialistJob } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement } from "react";
import { ChatThread } from "../chat/Thread.tsx";
import {
  type createFixtureWorld,
  IDS,
  SPECIALIST_IDS,
  specialistJobs,
  specialistRoles,
  withSpecialists,
} from "../fixtures/index.ts";
import { FeedScreen } from "../screens/feed/FeedScreen.tsx";
import { InboxScreen } from "../screens/inbox/InboxScreen.tsx";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { SpecialistRow } from "./InboxRow.tsx";
import { roleLabel } from "./model.ts";
import { SpecialistResultCard } from "./ResultCard.tsx";
import { SpecialistResultBlockView } from "./SpecialistResultBlock.tsx";

/** Background specialists (docs/agent/specialists-2026.md §6): result cards, rows and spawns. */
const meta = {
  title: "Specialists/Results",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

type World = ReturnType<typeof createFixtureWorld>;
const roles = specialistRoles();
const T = SPECIALIST_IDS.tasks;

function jobOf(taskId: string): SpecialistJob {
  const job = specialistJobs().find((j) => j.taskId === taskId);
  if (job === undefined) throw new Error(`fixture job ${taskId} missing`);
  return job;
}

function Card({ taskId, showAll }: { taskId: string; showAll?: boolean }): ReactElement {
  const job = jobOf(taskId);
  const role = roles.find((r) => r.role === job.role);
  return (
    <div className="mx-auto max-w-[640px] p-6">
      <SpecialistResultCard
        job={job}
        roleLabel={roleLabel(job.role, roles)}
        {...(role ? { resultKind: role.result } : {})}
        framed
        defaultShowAll={showAll ?? false}
        onNext={() => {}}
        onOpenThread={() => {}}
        onRetry={() => {}}
      />
    </div>
  );
}

export const Done: Story = { render: () => <Card taskId={T.done} /> };
export const DoneAllFindings: Story = { render: () => <Card taskId={T.done} showAll /> };
export const Partial: Story = { render: () => <Card taskId={T.partial} /> };
export const Failed: Story = { render: () => <Card taskId={T.failed} /> };
export const Cancelled: Story = { render: () => <Card taskId={T.cancelled} /> };

/** Every status as an Inbox row: queued, working, needs you, done (open), partial, failed… */
export const Rows: Story = {
  render: () => (
    <div className="mx-auto max-w-[760px] p-6">
      <ul className="flex flex-col rounded-lg bg-surface-raised shadow-elevation-1 [&>li:first-child>article]:before:hidden">
        {specialistJobs().map((job) => (
          <li key={job.taskId}>
            <SpecialistRow
              job={job}
              roles={roles}
              now={STORY_NOW}
              defaultOpen={job.taskId === T.done}
            />
          </li>
        ))}
      </ul>
    </div>
  ),
};

/** The Inbox with one result per outcome (§6.2: the Inbox is the delivery). */
export const Inbox: Story = {
  decorators: [withWorld({ edit: (w) => void withSpecialists(w, { notifications: true }) })],
  render: () => <InboxScreen now={STORY_NOW} />,
};

/** The Feed with "Show specialist results in Feed" on. */
export const Feed: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        withSpecialists(w);
        w.settings = { ...w.settings, "specialists.showInFeed": true };
        // A day's results: the done and partial ones are recent.
        w.specialistJobs = (w.specialistJobs ?? []).filter(
          (j) => j.taskId === T.done || j.taskId === T.partial,
        );
      },
    }),
  ],
  render: () => <FeedScreen now={STORY_NOW} />,
};

/** Moves four jobs onto the main thread's latest run, as if it had started them. */
function spawnedFromMain(w: World): void {
  const keep = new Set<string>([T.done, T.working, T.needsYou, T.queued]);
  w.specialistJobs = (w.specialistJobs ?? [])
    .filter((j) => keep.has(j.taskId))
    .map((j) => ({ ...j, parentThreadId: IDS.threads.main, parentRunId: IDS.runs.tax }));
}

/** The parent thread's lines (§6.1): where each job stands, its pre-flight, and the Timeline. */
export const SpawnLines: Story = {
  decorators: [withWorld({ edit: spawnedFromMain })],
  render: () => (
    <div style={{ height: 820 }}>
      <ChatThread threadId={IDS.threads.main} now={STORY_NOW} />
    </div>
  ),
};

/** A result in the thread that spawned it (chat-experience-2026 §4.5): the block's card. */
export const ResultInThread: Story = {
  render: () => (
    <div className="mx-auto flex max-w-[640px] flex-col p-6">
      <SpecialistResultBlockView taskId={T.done} />
      <SpecialistResultBlockView taskId={T.partial} />
    </div>
  ),
};
