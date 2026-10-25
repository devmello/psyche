import type { Block, Message } from "@psyche/protocol";
import { ArrowDown } from "lucide-react";
import * as m from "motion/react-m";
import type { ReactElement, ReactNode } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import { StatusGlyph } from "../components/status.tsx";
import {
  useApproval,
  useArtifact,
  useLibraryItem,
  useQuestion,
  useReceipt,
  useStoreState,
  useTask,
} from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { displaySummary } from "../lib/cards.ts";
import { fade, motionSpring, Presence, spring } from "../motion/index.ts";
import { usePersona, useSlots } from "../slots.tsx";
import { focusApproval } from "./ApprovalCard.tsx";
import { ArtifactCard, FileCard } from "./ArtifactCard.tsx";
import { Checklist, PlanCard } from "./Checklist.tsx";
import { Markdown } from "./Markdown.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { ReceiptLine } from "./Receipt.tsx";
import { RelatedThreads } from "./RelatedThreads.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { type ToolCallItem, ToolRun } from "./ToolRun.tsx";
import type { ToolCallBlock } from "./types.ts";
import { WrapUpBox } from "./WrapUp.tsx";

/**
 * Renders a message's blocks deterministically (data model §9.1; architecture §4.2 step 5).
 * Consecutive tool calls fold into one run. Approvals are never rendered inside the message
 * (UI design §1.2 principle 4): the block becomes a pointer to the dock above the composer.
 */

/** What a block refers to, for its loading and missing states. */
type BlockTarget = "approval" | "question" | "receipt" | "artifact" | "file" | "task" | "plan";

function Skeleton({ what }: { what: BlockTarget }): ReactElement {
  return (
    <div
      className="my-2 h-12 max-w-md animate-pulse rounded-lg bg-gray-3"
      role="status"
      aria-label={t("blocks.message.loading", { what })}
    />
  );
}

function Missing({ what }: { what: BlockTarget }): ReactElement {
  return (
    <p className="my-1 text-sm text-muted-foreground">{t("blocks.message.missing", { what })}</p>
  );
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

/**
 * The one inline trace of an approval (§3.2, §3.3): the card itself lives in the dock. Pending, it
 * is a quiet pointer that opens and focuses the card; answered, a one-line result row. The
 * answered row shares the dock card's `layoutId`, so the card morphs into it (redesign-2026 §5.3,
 * `spring.emphasis`); under reduced motion the card fades out and the row fades in. Rows that are
 * already answered when the transcript loads appear without motion.
 */
function ApprovalPointer({ approvalId }: { approvalId: string }): ReactElement {
  const { approval, loading } = useApproval(approvalId);
  if (approval === null)
    return loading ? <Skeleton what="approval" /> : <Missing what="approval" />;
  const summary = displaySummary(approval);
  const pending = approval.status === "pending";
  return (
    <Presence mode="popLayout" initial={false}>
      {pending ? (
        <m.button
          key="pending"
          type="button"
          onClick={() => focusApproval(approval.id)}
          className="-ms-1 my-0.5 inline-flex min-h-6 cursor-default items-center gap-1.5 rounded-sm px-1 py-0.5 text-callout text-label-secondary outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) hover:bg-fill-tertiary hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("blocks.message.reviewApproval", { summary })}
          title={summary}
          {...fade}
        >
          <StatusGlyph status="waiting" className="[&_svg]:size-3.5" />
          {t("blocks.message.waitingApproval")}
          <ArrowDown className="size-3.5" aria-hidden="true" />
        </m.button>
      ) : (
        <m.p
          key="answered"
          layoutId={`approval-${approval.id}`}
          transition={{ layout: motionSpring(spring.emphasis), ...fade.animate.transition }}
          className="my-0.5 flex items-center gap-1.5 text-callout text-label-secondary"
          data-testid="approval-result"
          {...fade}
        >
          <StatusGlyph
            status={approval.status === "approved" ? "done" : "failed"}
            className="[&_svg]:size-3.5"
          />
          <span className="min-w-0 truncate">
            {t("blocks.message.decided", { status: approval.status, summary })}
          </span>
        </m.p>
      )}
    </Presence>
  );
}

function QuestionBlockView({ inputRequestId }: { inputRequestId: string }): ReactElement {
  const { request, loading, answer } = useQuestion(inputRequestId);
  const persona = usePersona();
  const slots = useSlots();
  if (request === null) return loading ? <Skeleton what="question" /> : <Missing what="question" />;
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
  if (receipt === null) return loading ? <Skeleton what="receipt" /> : <Missing what="receipt" />;
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
    return loading ? <Skeleton what="artifact" /> : <Missing what="artifact" />;
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
  if (item === null) return loading ? <Skeleton what="file" /> : <Missing what="file" />;
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
  if (t.task === null) return t.loading ? <Skeleton what="task" /> : <Missing what="task" />;
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
  if (task === null) return loading ? <Skeleton what="plan" /> : <Missing what="plan" />;
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

/**
 * One approval block per approval (#555): the Gateway can record the same approval twice in a
 * message (once from the `approval_requested` event, once from the loop's own block), which showed
 * "Approved: browser.open_tab" twice. Keeps the first; transcripts already stored render right too.
 */
export function withoutRepeatedApprovals(blocks: readonly Block[]): readonly Block[] {
  const seen = new Set<string>();
  let dropped = false;
  const out = blocks.filter((b) => {
    if (b.type !== "approval") return true;
    if (seen.has(b.approvalId)) {
      dropped = true;
      return false;
    }
    seen.add(b.approvalId);
    return true;
  });
  return dropped ? out : blocks;
}

export function MessageBlocks({
  message,
  streamingText,
  pinChecklist = false,
  onWrapUpAction,
}: MessageBlocksProps): ReactElement {
  const out: ReactNode[] = [];
  const blocks = withoutRepeatedApprovals(message.blocks);
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
        <div className={untrusted ? "border-s-2 border-untrusted ps-2" : undefined}>
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
    case "related_threads":
      return <RelatedThreads block={b} />;
    default:
      return null;
  }
}
