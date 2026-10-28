import { sanitizeDisplay } from "@psyche/permissions/cards";
import type { Block, Message } from "@psyche/protocol";
import { ArrowDown } from "lucide-react";
import * as m from "motion/react-m";
import { type ReactElement, type ReactNode, useEffect, useId, useState } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import { DelayedSkeleton } from "../components/DelayedSkeleton.tsx";
import { StatusGlyph } from "../components/status.tsx";
import { Button } from "../components/ui/button.tsx";
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
import { MapBlock } from "../map/MapBlock.tsx";
import { fade, motionSpring, Presence, spring } from "../motion/index.ts";
import { usePersona, useSlots } from "../slots.tsx";
import { SpecialistResultBlockView } from "../specialists/SpecialistResultBlock.tsx";
import { ReceiptFeedback } from "../teaching/ReceiptFeedback.tsx";
import { LearnedLine, TaughtLine } from "../teaching/TaughtLine.tsx";
import { ApprovalCard, focusApproval } from "./ApprovalCard.tsx";
import { ArtifactCard, FileCard } from "./ArtifactCard.tsx";
import { Checklist, PlanCard } from "./Checklist.tsx";
import { ContextCard } from "./ContextCard.tsx";
import { useEntersLater } from "./card-enter.tsx";
import { Markdown } from "./Markdown.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { ReceiptLine } from "./Receipt.tsx";
import { RelatedThreads } from "./RelatedThreads.tsx";
import { type BlockContext, RegisteredBlock, registerBlock } from "./registry.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { type ToolCallItem, ToolRun } from "./ToolRun.tsx";
import { answerValues, blocksToShow, useThreadBlocks } from "./thread-blocks.tsx";
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
  return <DelayedSkeleton label={t("blocks.message.loading", { what })} />;
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
export function ApprovalPointer({ approvalId }: { approvalId: string }): ReactElement {
  const { approval, loading } = useApproval(approvalId);
  const persona = usePersona();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
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
        // Answered, the card stays part of the record as a one-line receipt; Details opens it.
        <m.div
          key="answered"
          layoutId={`approval-${approval.id}`}
          transition={{ layout: motionSpring(spring.emphasis), ...fade.animate.transition }}
          className="my-0.5"
          data-testid="approval-result"
          {...fade}
        >
          <p className="flex items-center gap-1.5 text-callout text-label-secondary">
            <StatusGlyph
              status={approval.status === "approved" ? "done" : "failed"}
              className="[&_svg]:size-3.5"
            />
            <span className="min-w-0 truncate">
              {t("blocks.message.receipt", {
                status: approval.status,
                scope: approval.scopeGranted ?? "once",
                summary,
              })}
            </span>
            <Button
              variant="plain"
              size="xs"
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={t(
                expanded ? "blocks.message.hideDetailsOf" : "blocks.message.showDetailsOf",
                { summary },
              )}
              onClick={() => setExpanded((e) => !e)}
            >
              {t(expanded ? "blocks.message.hideDetails" : "blocks.message.showDetails")}
            </Button>
          </p>
          <div id={detailsId}>
            {expanded ? (
              <div className="mt-1.5">
                <ApprovalCard
                  approval={approval}
                  canAnswer={false}
                  persona={persona.name}
                  armDelayMs={0}
                />
              </div>
            ) : null}
          </div>
        </m.div>
      )}
    </Presence>
  );
}

function QuestionBlockView({ inputRequestId }: { inputRequestId: string }): ReactElement | null {
  const { request, loading, answer } = useQuestion(inputRequestId);
  const persona = usePersona();
  const slots = useSlots();
  if (request === null) return loading ? <Skeleton what="question" /> : <Missing what="question" />;
  // Answered, the card is gone: the transcript keeps just the answer, in the user's style (the
  // thread drops even that when a user message already says it). The model still has both.
  if (request.status === "answered") {
    const values = answerValues(request.answer);
    if (values.length === 0) return null;
    return (
      <p className="my-1 flex justify-end" data-testid="question-answer-line">
        <span className="max-w-[80%] truncate rounded-xl bg-fill-secondary px-3 py-1 text-callout text-label-primary">
          {t("blocks.question.answerLine", {
            answer: values.map((v) => sanitizeDisplay(v)).join(" · "),
          })}
        </span>
      </p>
    );
  }
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
    <ReceiptLine
      receipt={receipt}
      {...(slots.openReceipt ? { onOpen: slots.openReceipt } : {})}
      menu={<ReceiptFeedback receipt={receipt} />}
    />
  );
}

/** Artifacts the canvas already opened on its own this session (never twice). */
const autoOpened = new Set<string>();

function ArtifactBlockView({
  artifactId,
  preview,
  runId,
}: {
  artifactId: string;
  preview?: string | undefined;
  runId?: string | null | undefined;
}): ReactElement {
  const { artifact, loading } = useArtifact(artifactId);
  const slots = useSlots();
  // Auto-open (chat-experience-2026 §4.2, decision 3): only a new artifact arriving live from
  // the owner's own run in this chat opens the canvas; history, automations, channels and
  // specialists leave just the card.
  const live = useEntersLater(artifact?.updatedAt ?? null);
  const foreground = useStoreState((s) => {
    const run = runId == null ? undefined : s.runs[runId];
    // An unknown run is not assumed to be the owner's: no auto-open without knowing.
    return (
      run !== undefined &&
      (run.origin === undefined || run.origin === "owner") &&
      run.taskId === null &&
      run.automationRunId === null &&
      run.parentRunId === null &&
      run.specialist === undefined
    );
  });
  useEffect(() => {
    if (artifact === null || !live || !foreground || artifact.version !== 1) return;
    if (slots.openArtifact === undefined || autoOpened.has(artifact.id)) return;
    autoOpened.add(artifact.id);
    slots.openArtifact(artifact);
  }, [artifact, live, foreground, slots.openArtifact]);
  if (artifact === null)
    return loading ? <Skeleton what="artifact" /> : <Missing what="artifact" />;
  if (artifact.type === "map") return <MapBlock artifact={artifact} />;
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
  // `planId` names the task whose approved plan this is (docs/archive/status/s12.md, gap 2).
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
  return blocksToShow({ id: "", blocks }, null);
}

export function MessageBlocks({
  message,
  streamingText,
  pinChecklist = false,
  onWrapUpAction,
}: MessageBlocksProps): ReactElement {
  const out: ReactNode[] = [];
  // One row per tool call and one notice per approval across the thread (#569, #555).
  const blocks = blocksToShow(message, useThreadBlocks());
  const ctx: BlockContext = {
    message,
    pinChecklist,
    onWrapUpAction,
    untrusted: message.provenance === "untrusted",
  };
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
    out.push(<RegisteredBlock key={key} block={b} ctx={ctx} />);
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

/** The built-in block types (data model §9.1), registered at load. */
registerBlock("text", {
  View: ({ block, ctx }) => (
    <div className={ctx.untrusted ? "border-s-2 border-untrusted ps-2" : undefined}>
      <Markdown>{block.md}</Markdown>
    </div>
  ),
});
registerBlock("checklist", {
  View: ({ block, ctx }) => <Checklist items={block.items} pinned={ctx.pinChecklist} />,
});
registerBlock("plan", { View: ({ block }) => <PlanBlockView planId={block.planId} /> });
registerBlock("approval", {
  View: ({ block }) => <ApprovalPointer approvalId={block.approvalId} />,
});
registerBlock("question", {
  View: ({ block }) => <QuestionBlockView inputRequestId={block.inputRequestId} />,
});
registerBlock("artifact", {
  View: ({ block, ctx }) => (
    <ArtifactBlockView
      artifactId={block.artifactId}
      preview={block.preview}
      runId={ctx.message.runId}
    />
  ),
});
registerBlock("file", {
  View: ({ block }) => <FileBlockView libraryItemId={block.libraryItemId} />,
});
registerBlock("context", { View: ({ block }) => <ContextCard block={block} /> });
registerBlock("receipt", { View: ({ block }) => <ReceiptBlockView receiptId={block.receiptId} /> });
registerBlock("task", { View: ({ block }) => <TaskBlockView taskId={block.taskId} /> });
registerBlock("wrap_up", {
  View: ({ block, ctx }) => (
    <WrapUpBox block={block} {...(ctx.onWrapUpAction ? { onAction: ctx.onWrapUpAction } : {})} />
  ),
});
registerBlock("related_threads", { View: ({ block }) => <RelatedThreads block={block} /> });
registerBlock("learned", { View: ({ block }) => <LearnedLine items={block.items} /> });
registerBlock("taught", {
  View: ({ block }) => (
    <TaughtLine
      feedbackId={block.feedbackId}
      lessonId={block.lessonId}
      statement={block.statement}
    />
  ),
});
registerBlock("specialist_result", {
  View: ({ block }) => <SpecialistResultBlockView taskId={block.taskId} />,
});
// Folded into runs above, and drawn by MessageView as a system notice.
registerBlock("tool_call", { View: () => null });
registerBlock("compaction", { View: () => null });
