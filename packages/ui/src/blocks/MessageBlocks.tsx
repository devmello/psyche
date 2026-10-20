import type { Block, Message } from "@psyche/protocol";
import { ArrowDown, ShieldCheck, ShieldX } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import {
  useApproval,
  useArtifact,
  useLibraryItem,
  useQuestion,
  useReceipt,
  useStoreState,
  useTask,
} from "../data/index.ts";
import { displaySummary } from "../lib/cards.ts";
import { usePersona, useSlots } from "../slots.tsx";
import { focusApproval } from "./ApprovalCard.tsx";
import { ArtifactCard, FileCard } from "./ArtifactCard.tsx";
import { Checklist, PlanCard } from "./Checklist.tsx";
import { Markdown } from "./Markdown.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { ReceiptLine } from "./Receipt.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { type ToolCallItem, ToolRun } from "./ToolRun.tsx";
import type { ToolCallBlock } from "./types.ts";
import { WrapUpBox } from "./WrapUp.tsx";

/**
 * Renders a message's blocks deterministically (data model §9.1; architecture §4.2 step 5).
 * Consecutive tool calls fold into one run. Approvals are never rendered inside the message
 * (UI design §1.2 principle 4): the block becomes a pointer to the dock above the composer.
 */

function Skeleton({ label }: { label: string }): ReactElement {
  return (
    <div
      className="my-2 h-12 max-w-md animate-pulse rounded-lg bg-gray-3"
      role="status"
      aria-label={`Loading ${label}`}
    />
  );
}

function Missing({ what }: { what: string }): ReactElement {
  return <p className="my-1 text-sm text-muted-foreground">Psyche couldn't load this {what}.</p>;
}

function ToolRunBlock({ blocks }: { blocks: readonly ToolCallBlock[] }): ReactElement {
  const items = useStoreState((s) =>
    blocks.map((b): ToolCallItem => {
      const call = s.toolCalls[b.toolCallId] ?? null;
      return {
        block: b,
        call,
        receipt: call?.receiptId ? (s.receipts[call.receiptId] ?? null) : null,
      };
    }),
  );
  return <ToolRun items={items} />;
}

const DECIDED: Record<string, string> = {
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  invalidated: "Voided",
};

/**
 * The one inline trace of an approval (§3.2, §3.3): the card itself lives in the dock. Pending, it
 * is a quiet pointer that opens and focuses the card; answered, a one-line outcome.
 */
function ApprovalPointer({ approvalId }: { approvalId: string }): ReactElement {
  const { approval, loading } = useApproval(approvalId);
  if (approval === null)
    return loading ? <Skeleton label="approval" /> : <Missing what="approval" />;
  const summary = displaySummary(approval);
  if (approval.status === "pending")
    return (
      <button
        type="button"
        onClick={() => focusApproval(approval.id)}
        className="my-0.5 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-small text-gray-11 transition-colors hover:bg-gray-3 hover:text-foreground"
        aria-label={`Review approval: ${summary}`}
        title={summary}
      >
        <ShieldCheck className="size-3.5 text-approval-text" aria-hidden="true" />
        Waiting for your approval
        <ArrowDown className="size-3.5" aria-hidden="true" />
      </button>
    );
  const ok = approval.status === "approved";
  return (
    <p className="my-0.5 flex items-center gap-1.5 px-1 text-small text-muted-foreground">
      {ok ? (
        <ShieldCheck className="size-3.5 text-success" aria-hidden="true" />
      ) : (
        <ShieldX className="size-3.5" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate">
        {DECIDED[approval.status] ?? approval.status}: {summary}
      </span>
    </p>
  );
}

function QuestionBlockView({ inputRequestId }: { inputRequestId: string }): ReactElement {
  const { request, loading, answer } = useQuestion(inputRequestId);
  const persona = usePersona();
  const slots = useSlots();
  if (request === null)
    return loading ? <Skeleton label="question" /> : <Missing what="question" />;
  return (
    <QuestionCard
      request={request}
      persona={persona.name}
      avatar={<Avatar name={persona.name} creature={persona.creature} size={20} decorative />}
      onAnswer={answer}
      {...(slots.renderSandboxed ? { renderPreview: slots.renderSandboxed } : {})}
    />
  );
}

function ReceiptBlockView({ receiptId }: { receiptId: string }): ReactElement {
  const { receipt, loading } = useReceipt(receiptId);
  const slots = useSlots();
  if (receipt === null) return loading ? <Skeleton label="receipt" /> : <Missing what="receipt" />;
  return (
    <ReceiptLine receipt={receipt} {...(slots.openReceipt ? { onOpen: slots.openReceipt } : {})} />
  );
}

function ArtifactBlockView({
  artifactId,
  preview,
}: {
  artifactId: string;
  preview?: string | undefined;
}): ReactElement {
  const { artifact, loading } = useArtifact(artifactId);
  const slots = useSlots();
  if (artifact === null)
    return loading ? <Skeleton label="artifact" /> : <Missing what="artifact" />;
  return (
    <ArtifactCard
      artifact={artifact}
      {...(preview === undefined ? {} : { preview })}
      {...(slots.renderPreview ? { renderPreview: slots.renderPreview } : {})}
      {...(slots.openArtifact ? { onOpen: slots.openArtifact } : {})}
    />
  );
}

function FileBlockView({ libraryItemId }: { libraryItemId: string }): ReactElement {
  const { item, loading } = useLibraryItem(libraryItemId);
  const slots = useSlots();
  if (item === null) return loading ? <Skeleton label="file" /> : <Missing what="file" />;
  return (
    <FileCard
      item={item}
      {...(slots.renderPreview ? { renderPreview: slots.renderPreview } : {})}
      {...(slots.openLibraryItem ? { onOpen: slots.openLibraryItem } : {})}
    />
  );
}

function TaskBlockView({ taskId }: { taskId: string }): ReactElement {
  const t = useTask(taskId);
  const slots = useSlots();
  if (t.task === null) return t.loading ? <Skeleton label="task" /> : <Missing what="task" />;
  return (
    <TaskCard
      task={t.task}
      {...(slots.openTask ? { onOpen: slots.openTask } : {})}
      onPause={(x) => void t.pause(x.id)}
      onResume={(x) => void t.resume(x.id)}
      onCancel={(x) => void t.cancel(x.id)}
      onRetry={(x) => void t.retry(x.id)}
    />
  );
}

function PlanBlockView({ planId }: { planId: string }): ReactElement {
  // `planId` names the task whose approved plan this is (docs/status/s12.md, gap 2).
  const { task, loading } = useTask(planId);
  const slots = useSlots();
  if (task === null) return loading ? <Skeleton label="plan" /> : <Missing what="plan" />;
  if (task.plan === null || task.plan === undefined) return <Missing what="plan" />;
  return (
    <PlanCard
      title={task.title}
      steps={task.plan.steps}
      approvedAt={task.plan.approvedAt ?? null}
      {...(slots.openTask ? { onOpen: () => slots.openTask?.(task) } : {})}
    />
  );
}

export interface MessageBlocksProps {
  message: Message;
  /** Streaming text appended after the committed blocks. */
  streamingText?: string | null;
  /** Pin the checklist (only under the latest agent message). */
  pinChecklist?: boolean;
  /** Sends a wrap-up button's message. */
  onWrapUpAction?: (message: string) => void;
}

export function MessageBlocks({
  message,
  streamingText,
  pinChecklist = false,
  onWrapUpAction,
}: MessageBlocksProps): ReactElement {
  const out: ReactNode[] = [];
  const blocks = message.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as Block;
    const key = `${message.id}:${i}`;
    if (b.type === "tool_call") {
      const run: ToolCallBlock[] = [];
      while (i < blocks.length && blocks[i]?.type === "tool_call") {
        run.push(blocks[i] as ToolCallBlock);
        i++;
      }
      i--;
      out.push(<ToolRunBlock key={key} blocks={run} />);
      continue;
    }
    out.push(
      <BlockView
        key={key}
        block={b}
        pinChecklist={pinChecklist}
        onWrapUpAction={onWrapUpAction}
        untrusted={message.provenance === "untrusted"}
      />,
    );
  }
  if (streamingText)
    out.push(
      // aria-busy: the conversation log announces the reply once it commits, not every token.
      <div key="streaming" aria-busy="true">
        <Markdown streaming>{streamingText}</Markdown>
      </div>,
    );
  return <>{out}</>;
}

function BlockView({
  block: b,
  pinChecklist,
  onWrapUpAction,
  untrusted,
}: {
  block: Block;
  pinChecklist: boolean;
  onWrapUpAction?: ((message: string) => void) | undefined;
  untrusted: boolean;
}): ReactElement | null {
  switch (b.type) {
    case "text":
      return (
        <div className={untrusted ? "border-l-2 border-untrusted pl-2" : undefined}>
          <Markdown>{b.md}</Markdown>
        </div>
      );
    case "checklist":
      return <Checklist items={b.items} pinned={pinChecklist} />;
    case "plan":
      return <PlanBlockView planId={b.planId} />;
    case "approval":
      return <ApprovalPointer approvalId={b.approvalId} />;
    case "question":
      return <QuestionBlockView inputRequestId={b.inputRequestId} />;
    case "artifact":
      return <ArtifactBlockView artifactId={b.artifactId} preview={b.preview} />;
    case "file":
      return <FileBlockView libraryItemId={b.libraryItemId} />;
    case "receipt":
      return <ReceiptBlockView receiptId={b.receiptId} />;
    case "task":
      return <TaskBlockView taskId={b.taskId} />;
    case "wrap_up":
      return <WrapUpBox block={b} {...(onWrapUpAction ? { onAction: onWrapUpAction } : {})} />;
    default:
      return null;
  }
}
