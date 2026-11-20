import type { ApprovalRequest, InputRequest, Message, Run, ToolCall } from "@psyche/protocol";
import { ChevronRight } from "lucide-react";
import * as m from "motion/react-m";
import { type ReactElement, useMemo, useState } from "react";
import { ApprovalPointer } from "../blocks/MessageBlocks.tsx";
import { toolGlyph } from "../blocks/ToolRun.tsx";
import type { ThreadBlockIndex } from "../blocks/thread-blocks.tsx";
import type { StatusKind } from "../components/status.tsx";
import { LiveDuration } from "../components/steps/LiveDuration.tsx";
import { useStoreState } from "../data/index.ts";
import type { ReasoningStep } from "../data/state.ts";
import { t } from "../i18n/core.ts";
import { displaySummary } from "../lib/cards.ts";
import { formatDuration } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";
import { Disclosure, fade, Presence, WorkingPulse } from "../motion/index.ts";
import { RailLine, RailNode } from "./RailNode.tsx";
import { KEEP_DONE, railItems } from "./run-progress.ts";

/** Run states in which the run is still in progress, paused on the owner included. */
const ACTIVE: readonly Run["status"][] = ["running", "awaiting_approval", "awaiting_input"];

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
  | { kind: "question"; id: string; at: number; status: StatusKind; label: string }
  | {
      kind: "thinking";
      id: string;
      at: number;
      updatedAt: number;
      status: StatusKind;
      /** The first line, shown collapsed. */
      label: string;
      /** The whole text (or the provider's summary), shown expanded. */
      full: string;
    };

/** The first non-empty line of a reasoning text, trimmed for one row. */
function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
      .find((l) => l !== "") ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

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
    // A Task, automation or helper run on the thread is background work, not the chat turn.
    if (r.kind !== undefined && r.kind !== "chat" && r.id !== activeWriterRunId) continue;
    // A paused turn holds the transcript writer; a paused run that doesn't is stale state.
    if (r.status !== "running" && r.id !== activeWriterRunId) continue;
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
  /** Reasoning steps streamed by `chat.reasoning` (#633); none when the setting is off. */
  reasoning?: Readonly<Record<string, ReasoningStep>>;
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
  for (const r of Object.values(input.reasoning ?? {})) {
    if (r.runId !== run.id) continue;
    const full = (r.summary ?? r.text).trim();
    steps.push({
      kind: "thinking",
      id: r.stepId,
      at: Date.parse(r.startedAt),
      updatedAt: Date.parse(r.updatedAt),
      status: r.done ? "done" : "running",
      label: firstLine(full),
      full,
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
    if (s.kind === "thinking") last = Math.max(last, s.updatedAt);
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
  const reasoning = useStoreState((s) => s.reasoning);
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
        reasoning,
        index,
        streamingText,
      }),
    };
  }, [
    runs,
    writer,
    threadId,
    messages,
    toolCalls,
    approvals,
    questions,
    reasoning,
    index,
    streamingText,
  ]);
}

/**
 * A reasoning step (#633): "Thinking: <first line>" collapsed, the whole text on expand. It grows
 * as deltas arrive; the rail's marker says whether it is still going.
 */
function ThinkingStep({
  step,
  current,
}: {
  step: Extract<RunStep, { kind: "thinking" }>;
  current: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const id = `thinking-${step.id}`;
  const expandable = step.full !== "" && step.full !== step.label;
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? id : undefined}
        data-role="label"
        className={cn(
          "-ms-1 flex h-7 min-w-0 flex-1 cursor-default items-center gap-1 rounded-sm px-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-100",
          expandable && "hover:bg-fill-tertiary",
          current ? "text-label-primary" : "text-label-secondary",
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {step.label === ""
            ? t("chat.steps.thinkingEmpty")
            : t("chat.steps.thinking", { text: step.label })}
        </span>
        {expandable ? (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-label-tertiary transition-transform duration-(--spring-snappy-duration) ease-(--spring-snappy)",
              open ? "rotate-90" : "rtl:rotate-180",
            )}
            aria-hidden="true"
          />
        ) : null}
      </button>
      <Disclosure open={open && expandable}>
        <p
          id={id}
          className="mb-1 max-h-60 overflow-y-auto whitespace-pre-wrap text-callout text-label-secondary"
        >
          {step.full}
        </p>
      </Disclosure>
    </div>
  );
}

/**
 * A run's step rail while it works (#623), under the last message: one row per step in order on a
 * thin vertical line, so where the agent is reads at a glance.
 * - The step in progress has the one moving mark (an ink dot with a halo), a plain-language
 *   label ("Reading Q3 notes.pdf") and its elapsed time, ticking.
 * - A finished step settles to a quiet check with its duration.
 * - A step waiting on the owner is the only filled marker, on an amber row tagged "Needs you";
 *   it is never folded away.
 * - Finished steps beyond the last two fold into "n earlier steps done"; failures stay in view.
 * - "No response for 42 s" appears after 30 s of silence, so a frozen run is visible.
 * When the run ends the rail gives way to the transcript's grouped tool rows (#619).
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
  const items = railItems(steps, all);
  const doneCount = steps.filter((s) => s.status === "done").length;
  return (
    <section
      className="mt-3 ps-7"
      aria-label={t("chat.steps.label")}
      data-testid="run-step-log"
      data-stalled={stalled ? "true" : undefined}
      data-waiting={current?.status === "waiting" ? "true" : undefined}
    >
      <ol className="flex flex-col">
        <Presence initial={false}>
          {items.map((item, idx) => {
            const more = idx < items.length - 1;
            if (item.kind === "earlier")
              return (
                <m.li
                  key="earlier"
                  layout="position"
                  className="relative flex min-h-7 items-center gap-2 text-body"
                  data-step="earlier"
                  {...fade}
                >
                  <RailLine show={more} state="done" />
                  <RailNode state="done" />
                  <button
                    type="button"
                    onClick={() => setAll(true)}
                    className="-ms-1 inline-flex h-6 cursor-default items-center rounded-sm px-1 text-callout text-label-secondary outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) hover:bg-fill-tertiary hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t("chat.steps.earlier", { n: item.count })}
                  </button>
                </m.li>
              );
            const { step, state, isNow } = item;
            const timed = Number.isFinite(step.at);
            const label =
              step.kind === "approval" ? (
                // The transcript's own pointer: it opens the dock card while pending, and is the
                // card's morph target (`layoutId`) once answered (§5.3).
                <span className="min-w-0 flex-1 leading-7" data-role="label">
                  <ApprovalPointer approvalId={step.approvalId} bare />
                </span>
              ) : step.kind === "thinking" ? null : (
                <span
                  data-role="label"
                  className={cn(
                    "min-w-0 flex-1 truncate leading-7",
                    state === "failed"
                      ? "text-danger-text"
                      : state === "current" || state === "waiting"
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
                className={cn(
                  "relative flex flex-col text-body",
                  state === "waiting" &&
                    "-ms-2 my-0.5 rounded-md bg-approval-surface ps-2 pe-2 ring-1 ring-approval-border",
                )}
                data-step={step.kind}
                data-status={step.status}
                data-state={state}
                data-now={isNow ? "true" : undefined}
                {...fade}
              >
                <RailLine show={more} state={state} inset={state === "waiting"} />
                <div className="flex items-start gap-2">
                  <span className="flex h-7 items-center">
                    <RailNode state={state} />
                  </span>
                  {step.kind === "thinking" ? <ThinkingStep step={step} current={isNow} /> : label}
                  <span className="sr-only">{t(`chat.steps.status.${step.status}`)}</span>
                  {state === "waiting" ? (
                    <span className="shrink-0 text-callout font-medium leading-7 text-approval-text">
                      {t("chat.steps.needsYou")}
                    </span>
                  ) : null}
                  {timed && (state === "current" || state === "waiting") ? (
                    <LiveDuration
                      startedAt={step.at}
                      {...(fixedNow === undefined ? {} : { now: fixedNow })}
                      className="text-callout leading-7 text-label-secondary"
                    />
                  ) : step.kind === "tool" && step.endedAt !== null ? (
                    <span
                      className="shrink-0 text-callout leading-7 text-label-tertiary tabular-nums"
                      data-role="duration"
                    >
                      {formatDuration(step.endedAt - step.at)}
                    </span>
                  ) : null}
                </div>
              </m.li>
            );
          })}
        </Presence>
      </ol>
      {all && doneCount > KEEP_DONE ? (
        <button
          type="button"
          onClick={() => setAll(false)}
          className="-ms-1 mt-1 inline-flex h-6 cursor-default items-center rounded-sm px-1 text-callout text-label-secondary outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) hover:bg-fill-tertiary hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("chat.steps.showFewer")}
        </button>
      ) : null}
      {/* One polite line for the run's state, so the log itself is not read on every step. */}
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "mt-1 flex items-center gap-2 text-callout",
          current?.status === "waiting" ? "text-approval-text" : "text-label-secondary",
        )}
        data-testid="chat-working"
      >
        {current === undefined || steps.length === 0 ? <WorkingPulse /> : null}
        {stalled
          ? t("chat.steps.stalled", { duration: formatDuration(quiet) })
          : current?.status === "waiting"
            ? t("chat.steps.waiting", { name: persona })
            : t("chat.thread.working", { name: persona })}
      </p>
    </section>
  );
}
