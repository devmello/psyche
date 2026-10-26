import type { ApprovalRequest, InputRequest, Message, Run, ToolCall } from "@psyche/protocol";
import { useReducedMotionConfig } from "motion/react";
import * as m from "motion/react-m";
import { type ReactElement, useMemo, useState } from "react";
import { ApprovalPointer } from "../blocks/MessageBlocks.tsx";
import { toolGlyph, toolIcon } from "../blocks/ToolRun.tsx";
import type { ThreadBlockIndex } from "../blocks/thread-blocks.tsx";
import { StatusGlyph, type StatusKind } from "../components/status.tsx";
import { useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { displaySummary } from "../lib/cards.ts";
import { formatDuration } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";
import { fade, Presence } from "../motion/index.ts";

/** Run states in which the run is still in progress, paused on the owner included. */
const ACTIVE: readonly Run["status"][] = ["running", "awaiting_approval", "awaiting_input"];

/** How many steps show before "Show all". */
export const VISIBLE_STEPS = 5;
/** Silence after which the current step says so (a frozen run must be visible). */
export const STALL_MS = 30_000;

export type RunStep =
  | {
      kind: "tool";
      id: string;
      at: number;
      endedAt: number | null;
      status: StatusKind;
      label: string;
      tool: string;
    }
  | { kind: "text"; id: string; at: number; status: StatusKind; label: string }
  | {
      kind: "approval";
      id: string;
      at: number;
      status: StatusKind;
      label: string;
      approvalId: string;
    }
  | { kind: "question"; id: string; at: number; status: StatusKind; label: string };

/** The run a log is about: its id and, once a `run.updated` has arrived, when it started. */
export interface ActiveRun {
  id: string;
  startedAt: string | null;
}

/**
 * The thread's run in progress, if any: the latest active run the store has seen, or, for a
 * thread loaded mid-run (runs arrive only by event), the run holding its transcript writer.
 */
export function activeRun(
  runs: Readonly<Record<string, Run>>,
  threadId: string,
  activeWriterRunId: string | null = null,
): ActiveRun | null {
  let found: Run | null = null;
  for (const r of Object.values(runs)) {
    if (r.threadId !== threadId || !ACTIVE.includes(r.status)) continue;
    if (found === null || r.startedAt > found.startedAt) found = r;
  }
  if (found !== null) return { id: found.id, startedAt: found.startedAt };
  if (activeWriterRunId === null) return null;
  const known = runs[activeWriterRunId];
  if (known !== undefined && !ACTIVE.includes(known.status)) return null;
  return { id: activeWriterRunId, startedAt: known?.startedAt ?? null };
}

/**
 * A run's steps in order (#623): each tool call (one row per call id, in its latest state,
 * labelled as its block says when the transcript has it), the approvals and questions it raised,
 * and "Writing…" while the reply streams. Committed text is not repeated (the transcript shows it
 * just above), and the Gateway streams no reasoning yet, so there are no thinking steps (#623).
 */
export function runSteps(input: {
  run: ActiveRun;
  threadId: string;
  messages: readonly Message[];
  toolCalls: Readonly<Record<string, ToolCall>>;
  approvals: Readonly<Record<string, ApprovalRequest>>;
  questions: Readonly<Record<string, InputRequest>>;
  index: ThreadBlockIndex | null;
  streamingText?: string | null;
}): RunStep[] {
  const { run, threadId, index } = input;
  // A run known only by its transcript writer has no start time: its first message stands in.
  const firstMessage = input.messages.find((m) => m.runId === run.id);
  const runStart =
    run.startedAt !== null
      ? Date.parse(run.startedAt)
      : firstMessage
        ? Date.parse(firstMessage.createdAt)
        : Number.POSITIVE_INFINITY;
  const steps: RunStep[] = [];
  // Calls the store has seen by event, and (for a thread loaded mid-run, whose calls arrive only
  // as transcript blocks) the run's committed tool blocks, one step per call id either way.
  const seen = new Set<string>();
  for (const call of Object.values(input.toolCalls)) {
    if (call.runId !== run.id) continue;
    seen.add(call.id);
    const block = index?.toolLatest.get(call.id);
    steps.push({
      kind: "tool",
      id: call.id,
      at: Date.parse(call.startedAt),
      endedAt: call.endedAt == null ? null : Date.parse(call.endedAt),
      status: toolGlyph(call.status),
      label: block?.level1 ?? call.target?.display ?? call.target?.value ?? call.tool,
      tool: call.tool,
    });
  }
  for (const msg of input.messages) {
    if (msg.runId !== run.id) continue;
    for (const b of msg.blocks) {
      if (b.type !== "tool_call" || seen.has(b.toolCallId)) continue;
      seen.add(b.toolCallId);
      const latest = index?.toolLatest.get(b.toolCallId) ?? b;
      steps.push({
        kind: "tool",
        id: b.toolCallId,
        at: Date.parse(msg.createdAt),
        endedAt: null,
        status: toolGlyph(latest.status),
        label: latest.level1,
        tool: latest.tool,
      });
    }
  }
  // Approvals the run asked for: by run id, and every approval block in the run's messages (the
  // transcript leaves those out while the run works, so each must appear here).
  const approvalAt = new Map<string, number>();
  for (const a of Object.values(input.approvals)) {
    if (a.requestedBy.runId === run.id) approvalAt.set(a.id, Date.parse(a.requestedAt));
  }
  for (const msg of input.messages) {
    if (msg.runId !== run.id) continue;
    for (const b of msg.blocks) {
      if (b.type !== "approval" || approvalAt.has(b.approvalId)) continue;
      const known = input.approvals[b.approvalId];
      approvalAt.set(
        b.approvalId,
        known ? Date.parse(known.requestedAt) : Date.parse(msg.createdAt),
      );
    }
  }
  for (const [id, at] of approvalAt) {
    const a = input.approvals[id];
    steps.push({
      kind: "approval",
      id,
      at,
      status:
        a === undefined || a.status === "pending"
          ? "waiting"
          : a.status === "approved"
            ? "done"
            : "failed",
      label: a === undefined ? "" : displaySummary(a),
      approvalId: id,
    });
  }
  for (const q of Object.values(input.questions)) {
    if (q.threadId !== threadId || Date.parse(q.createdAt) < runStart) continue;
    const question = q.questions[0]?.question ?? "";
    steps.push({
      kind: "question",
      id: q.id,
      at: Date.parse(q.createdAt),
      status: q.status === "open" ? "waiting" : q.status === "answered" ? "done" : "cancelled",
      label:
        q.status === "open"
          ? t("chat.steps.question", { question })
          : t("chat.steps.answered", { question }),
    });
  }
  steps.sort((a, b) => a.at - b.at);
  // The reply itself is in the transcript above; the log only says that it is being written.
  if (input.streamingText)
    steps.push({
      kind: "text",
      id: "streaming",
      at: Number.POSITIVE_INFINITY,
      status: "running",
      label: t("chat.steps.writing"),
    });
  return steps;
}

/** The last time anything happened in the run, in ms: a step started or finished. */
export function lastActivity(run: ActiveRun, steps: readonly RunStep[]): number {
  let last = run.startedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(run.startedAt);
  for (const s of steps) {
    if (Number.isFinite(s.at)) last = Math.max(last, s.at);
    if (s.kind === "tool" && s.endedAt !== null) last = Math.max(last, s.endedAt);
  }
  return last;
}

/** The thread's active run and its steps, from the store. */
export function useRunSteps(
  threadId: string,
  index: ThreadBlockIndex | null,
  streamingText: string | null,
): { run: ActiveRun | null; steps: RunStep[] } {
  const runs = useStoreState((s) => s.runs);
  const writer = useStoreState((s) => s.threads[threadId]?.thread.activeWriterRunId ?? null);
  const messages = useStoreState((s) => s.messages[threadId]);
  const toolCalls = useStoreState((s) => s.toolCalls);
  const approvals = useStoreState((s) => s.approvals);
  const questions = useStoreState((s) => s.inputRequests);
  return useMemo(() => {
    const run = activeRun(runs, threadId, writer);
    if (run === null) return { run, steps: [] };
    return {
      run,
      steps: runSteps({
        run,
        threadId,
        messages: messages ?? [],
        toolCalls,
        approvals,
        questions,
        index,
        streamingText,
      }),
    };
  }, [runs, writer, threadId, messages, toolCalls, approvals, questions, index, streamingText]);
}

/** The working pulse on the current step (motion.md §4.6): stops within 5 s, static if reduced. */
function Pulse(): ReactElement {
  const reduce = useReducedMotionConfig();
  return (
    <m.span
      className="size-2 shrink-0 rounded-full bg-label-secondary"
      aria-hidden="true"
      {...(reduce
        ? {}
        : {
            animate: { opacity: [0.4, 1, 0.4] },
            transition: { duration: 1.2, ease: "linear", repeat: 3 },
          })}
    />
  );
}

function StepIcon({ step }: { step: RunStep }): ReactElement | null {
  if (step.kind !== "tool") return null;
  const Icon = toolIcon(step.tool);
  return <Icon className="size-4 shrink-0 text-label-secondary" aria-hidden="true" />;
}

/**
 * A run's step log while it works (#623), under the last message: one line per step in order,
 * the current step marked with the working pulse, failed steps in red, and a "No response for
 * 42 s" hint when nothing has happened for 30 s, so a frozen run is visible. The last five show,
 * plus any step waiting on the owner; "Show all (n)" opens the rest. When the run ends the log gives way to the transcript's
 * grouped tool rows (#619), which hold the same calls.
 */
export function RunStepLog({
  persona,
  run,
  steps,
  now: fixedNow,
}: {
  persona: string;
  /** Null between a send and the run's first event. */
  run: ActiveRun | null;
  steps: readonly RunStep[];
  now?: number;
}): ReactElement {
  const now = useNow(1000, fixedNow);
  const [all, setAll] = useState(false);
  const current = [...steps]
    .reverse()
    .find((s) => s.status === "running" || s.status === "waiting");
  const last = run === null ? Number.NEGATIVE_INFINITY : lastActivity(run, steps);
  const quiet = Number.isFinite(last) ? now - last : 0;
  const stalled = run !== null && quiet >= STALL_MS && current?.status !== "waiting";
  // The last five, plus anything waiting on the owner (an approval, a question): never hidden.
  const shown = all
    ? steps
    : steps.filter((s, i) => i >= steps.length - VISIBLE_STEPS || s.status === "waiting");
  const hidden = steps.length - shown.length;
  return (
    <section
      className="mt-3 ps-7"
      aria-label={t("chat.steps.label")}
      data-testid="run-step-log"
      data-stalled={stalled ? "true" : undefined}
    >
      {hidden > 0 || (all && steps.length > VISIBLE_STEPS) ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="-ms-1 mb-1 inline-flex h-6 cursor-default items-center rounded-sm px-1 text-callout text-label-secondary outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) hover:bg-fill-tertiary hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {all ? t("chat.steps.showFewer") : t("chat.steps.showAll", { n: steps.length })}
        </button>
      ) : null}
      <ol className="flex flex-col gap-0.5">
        <Presence initial={false}>
          {shown.map((step) => {
            const isCurrent = step === current;
            const failed = step.status === "failed";
            const done = step.kind === "tool" && step.endedAt !== null;
            const text = (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  failed
                    ? "text-danger-text"
                    : isCurrent
                      ? "text-label-primary"
                      : "text-label-secondary",
                )}
              >
                {step.label}
              </span>
            );
            return (
              <m.li
                key={step.id}
                layout="position"
                className="flex min-h-6 items-center gap-2 text-body"
                data-step={step.kind}
                data-status={step.status}
                {...fade}
              >
                <StepIcon step={step} />
                {step.kind === "approval" ? (
                  // The transcript's own pointer: it opens the dock card while pending, and is the
                  // card's morph target (`layoutId`) once answered (§5.3).
                  <span className="min-w-0 flex-1">
                    <ApprovalPointer approvalId={step.approvalId} />
                  </span>
                ) : (
                  text
                )}
                {step.kind === "tool" && done && step.endedAt !== null ? (
                  <span className="shrink-0 text-callout text-label-tertiary tabular-nums">
                    {formatDuration(step.endedAt - step.at)}
                  </span>
                ) : null}
                {step.kind === "approval" ? null : isCurrent && step.status === "running" ? (
                  <Pulse />
                ) : (
                  <StatusGlyph
                    status={step.status}
                    label={t(`chat.steps.status.${step.status}`)}
                    className="[&_svg]:size-3.5"
                  />
                )}
              </m.li>
            );
          })}
        </Presence>
      </ol>
      {/* One polite line for the run's state, so the log itself is not read on every step. */}
      <p
        role="status"
        aria-live="polite"
        className="mt-1 flex items-center gap-2 text-callout text-label-secondary"
        data-testid="chat-working"
      >
        {current === undefined || steps.length === 0 ? <Pulse /> : null}
        {stalled
          ? t("chat.steps.stalled", { duration: formatDuration(quiet) })
          : current?.status === "waiting"
            ? t("chat.steps.waiting", { name: persona })
            : t("chat.thread.working", { name: persona })}
      </p>
    </section>
  );
}
