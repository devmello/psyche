import type { ApprovalRequest } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement, ReactNode } from "react";
import { fakeSha } from "../../fixtures/ids.ts";
import {
  draftView,
  inboxDigest,
  markReadProposal,
  meetingNotes,
  meetingPrep,
  quietDigest,
  schedulingView,
  withWorkflows,
  workflowLoops,
} from "../../fixtures/index.ts";
import { t } from "../../i18n/core.ts";
import { STORY_NOW, withWorld } from "../../stories/harness.tsx";
import { FeedScreen } from "../feed/FeedScreen.tsx";
import { ErrorState, LoadingCards } from "../feed/states.tsx";
import { BatchCard, ProposalBatchCard } from "./BatchCard.tsx";
import { DigestCard } from "./DigestCard.tsx";
import { DraftCard } from "./DraftCard.tsx";
import { FollowUpsCard } from "./FollowUpsCard.tsx";
import { MeetingNotesCard } from "./MeetingNotesCard.tsx";
import { MeetingPrepCard } from "./MeetingPrepCard.tsx";
import { SchedulingCard } from "./SchedulingCard.tsx";

/** Mail and meeting cards (docs/workflows/mail-and-meetings-2026.md §7.1), light and dark. */
const meta = {
  title: "Cards/Workflows",
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

export const Digest: Story = {
  render: () => (
    <Column>
      <DigestCard
        digest={inboxDigest()}
        now={STORY_NOW}
        onAction={noop}
        onLoop={noop}
        onGroup={noop}
        onSettings={noop}
      />
    </Column>
  ),
};

export const DigestQuiet: Story = {
  render: () => (
    <Column>
      <DigestCard digest={quietDigest()} now={STORY_NOW} onSettings={noop} />
    </Column>
  ),
};

export const FollowUps: Story = {
  render: () => (
    <Column>
      <FollowUpsCard loops={workflowLoops()} now={STORY_NOW} onLoop={noop} />
    </Column>
  ),
};

export const FollowUpsStale: Story = {
  render: () => (
    <Column>
      <FollowUpsCard loops={workflowLoops()} now={STORY_NOW} defaultSegment="stale" onLoop={noop} />
    </Column>
  ),
};

export const FollowUpsEmpty: Story = {
  render: () => (
    <Column>
      <FollowUpsCard loops={[]} now={STORY_NOW} defaultSegment="owe" />
    </Column>
  ),
};

export const Draft: Story = {
  render: () => (
    <Column>
      <DraftCard
        draft={draftView()}
        focused
        armDelayMs={0}
        onTone={noop}
        onOpen={noop}
        onSend={noop}
      />
    </Column>
  ),
};

export const DraftRewriting: Story = {
  render: () => (
    <Column>
      <DraftCard
        draft={{ ...draftView(), status: "rewriting" }}
        armDelayMs={0}
        onTone={noop}
        onOpen={noop}
        onSend={noop}
      />
    </Column>
  ),
};

export const DraftSent: Story = {
  render: () => (
    <Column>
      <DraftCard draft={{ ...draftView(), status: "sent", commitments: [] }} armDelayMs={0} />
    </Column>
  ),
};

export const Scheduling: Story = {
  render: () => (
    <Column>
      <SchedulingCard view={schedulingView()} focused onHold={noop} onDraftReply={noop} />
    </Column>
  ),
};

export const SchedulingHeld: Story = {
  render: () => (
    <Column>
      <SchedulingCard view={{ ...schedulingView(), state: "held", holds: 3 }} onDraftReply={noop} />
    </Column>
  ),
};

export const SchedulingPicked: Story = {
  render: () => (
    <Column>
      <SchedulingCard
        view={{ ...schedulingView(), state: "picked", picked: 1, holds: 2 }}
        focused
        onConfirm={noop}
      />
    </Column>
  ),
};

export const SchedulingNoTime: Story = {
  render: () => (
    <Column>
      <SchedulingCard view={{ ...schedulingView(), slots: [] }} />
    </Column>
  ),
};

export const Prep: Story = {
  render: () => (
    <Column>
      <MeetingPrepCard prep={meetingPrep()} now={STORY_NOW} focused onJoin={noop} onSource={noop} />
    </Column>
  ),
};

export const PrepStarted: Story = {
  render: () => (
    <Column>
      <MeetingPrepCard prep={meetingPrep()} now={STORY_NOW + 60 * 60_000} onJoin={noop} />
    </Column>
  ),
};

export const PrepNothingNew: Story = {
  render: () => (
    <Column>
      <MeetingPrepCard
        prep={{
          ...meetingPrep(),
          why: undefined,
          openLoops: [],
          lastTime: [],
          worthReading: [],
          agenda: [],
          taint: false,
        }}
        now={STORY_NOW}
      />
    </Column>
  ),
};

export const Notes: Story = {
  render: () => (
    <Column>
      <MeetingNotesCard
        notes={meetingNotes()}
        focused
        onSeek={noop}
        onOpenTranscript={noop}
        onAddItems={noop}
        onDraftRecap={noop}
      />
    </Column>
  ),
};

export const NotesSummaryFailed: Story = {
  render: () => (
    <Column>
      <MeetingNotesCard
        notes={{ ...meetingNotes(), summary: [], decisions: [], openQuestions: [] }}
        onRetrySummary={noop}
        onOpenTranscript={noop}
      />
    </Column>
  ),
};

export const NotesCloudNoActions: Story = {
  render: () => (
    <Column>
      <MeetingNotesCard
        notes={{ ...meetingNotes(), actionItems: [], model: { role: "primary", remote: true } }}
        onDraftRecap={noop}
      />
    </Column>
  ),
};

export const Loading: Story = {
  render: () => (
    <Column>
      <LoadingCards label={t("common.loading")} count={2} lines={4} />
    </Column>
  ),
};

export const LoadError: Story = {
  render: () => (
    <Column>
      <ErrorState what={t("workflows.loadFailed")} retry={{ onClick: noop }} />
    </Column>
  ),
};

/** The three workflow posts in the Feed, through `FeedPostCard`'s hook. */
export const InTheFeed: Story = {
  decorators: [withWorld({ edit: (w) => void withWorkflows(w) })],
  render: () => <FeedScreen />,
};

/** The batch card (§7.2) in its states. */
const APPROVAL: ApprovalRequest = {
  id: "appr_batch",
  kind: "batch",
  summary: "Mark 6 newsletters read",
  details: {
    title: "Mark 6 newsletters read",
    count: 6,
    calls: markReadProposal().calls.map((c) => c.summary),
  },
  bindingHash: fakeSha("story:batch"),
  grantKey: "batch|fixture",
  requestedBy: { runId: "batch_run", taskId: null, threadId: null },
  requestedAt: "2026-10-18T10:12:00Z",
  expiresAt: "2026-10-18T10:22:00Z",
  surfaces: ["desktop", "web"],
  scopesOffered: ["once"],
  deviceOnly: false,
  requiresAuthentication: false,
  sideEffect: "write",
  taint: true,
  status: "pending",
  scopeGranted: null,
  decidedBy: null,
  decidedAt: null,
  grantId: null,
};

const RAN_AT = "2026-10-18T10:12:03Z";
const ran = (extra: object) =>
  markReadProposal("done", {
    createdAt: "2026-10-18T10:12:00Z",
    updatedAt: RAN_AT,
    results: markReadProposal().calls.map((_, index) => ({ index, status: "ok" as const })),
    ...extra,
  });

export const BatchAwaitingApproval: Story = {
  render: () => (
    <Column>
      <BatchCard
        proposal={markReadProposal("awaiting_approval", { approvalId: APPROVAL.id })}
        approval={APPROVAL}
        canAnswer
        onAnswer={noop}
        armDelayMs={0}
        now={STORY_NOW}
      />
    </Column>
  ),
};

export const BatchDone: Story = {
  render: () => (
    <Column>
      <BatchCard proposal={ran({})} approval={null} canAnswer={false} now={STORY_NOW} />
    </Column>
  ),
};

export const BatchDoneWithUndo: Story = {
  render: () => (
    <Column>
      <BatchCard
        proposal={ran({})}
        approval={null}
        canAnswer={false}
        onUndo={noop}
        now={Date.parse(RAN_AT) + 12_000}
        defaultExpanded
      />
    </Column>
  ),
};

export const BatchPartialFailure: Story = {
  render: () => (
    <Column>
      <BatchCard
        proposal={ran({
          status: "partial",
          results: markReadProposal().calls.map((_, index) =>
            index === 3
              ? { index, status: "failed" as const, error: "message moved" }
              : { index, status: "ok" as const },
          ),
        })}
        approval={null}
        canAnswer={false}
        onRetryFailed={noop}
        now={STORY_NOW}
        defaultExpanded
      />
    </Column>
  ),
};

export const BatchRunning: Story = {
  render: () => (
    <Column>
      <BatchCard
        proposal={markReadProposal("running", { results: [{ index: 0, status: "ok" }] })}
        approval={null}
        canAnswer={false}
        now={STORY_NOW}
        defaultExpanded
      />
    </Column>
  ),
};

export const BatchDismissed: Story = {
  render: () => (
    <Column>
      <BatchCard
        proposal={markReadProposal("dismissed")}
        approval={null}
        canAnswer={false}
        now={STORY_NOW}
      />
    </Column>
  ),
};

/** Wired to the MockGateway: opening it asks for the approval; ⌘↩ runs the calls. */
export const BatchWired: Story = {
  decorators: [withWorld({ edit: (w) => void withWorkflows(w) })],
  render: () => (
    <Column>
      <ProposalBatchCard proposalId="prop_newsletters" />
    </Column>
  ),
};
