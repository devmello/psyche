import type { RunStep } from "@psyche/protocol";
import { ArrowDown } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { focusApproval } from "../../blocks/ApprovalCard.tsx";
import { useDisclosure } from "../../blocks/disclosure.tsx";
import { formatStepDuration } from "../../components/steps/LiveDuration.tsx";
import { StepRow } from "../../components/steps/StepRow.tsx";
import { useRunFrames, useRunStep, useRunSteps, useStoreState } from "../../data/index.ts";
import { t } from "../../i18n/core.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import {
  buildRows,
  ended,
  GROUP_ROWS,
  stepGlyph,
  stepLabel,
  type TraceRow,
  timelineRoute,
  visibleRows,
} from "./model.ts";

const ms = (iso: string | null | undefined): number | undefined =>
  iso ? Date.parse(iso) : undefined;

/** The streamed text of a running thought (#635), else the retained text (`runs.step`, §4.3). */
function ThinkingDetail({ runId, step }: { runId: string; step: RunStep }): ReactElement {
  const live = useStoreState((s) => s.reasoning[step.id]);
  const kept = useRunStep(live === undefined ? runId : null, live === undefined ? step.id : null);
  const text = live ? (live.summary ?? live.text) : kept.detail?.step.text?.full;
  if (text) return <p className="max-h-60 overflow-y-auto whitespace-pre-wrap">{text}</p>;
  if (kept.loading) return <p>{t("chat.steps.thinkingLoading")}</p>;
  return (
    <p>{step.text?.expiresAt ? t("chat.steps.thinkingExpired") : (step.text?.summary ?? "")}</p>
  );
}

/** A 32 × 20 thumbnail of the latest frame a step saw; opens the Timeline on it (§3.2). */
function FrameThumb({ runId, step }: { runId: string; step: RunStep }): ReactElement | null {
  const persona = usePersona();
  const { navigate } = useSlots();
  const { image } = useRunFrames(runId, step.id);
  const [src, setSrc] = useState<string | null>(null);
  const seq = step.frames?.last;
  useEffect(() => {
    if (seq === undefined) return;
    let live = true;
    image(seq, "thumb").then(
      (f) => live && setSrc(`data:${f.mime};base64,${f.dataBase64}`),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [image, seq]);
  if (seq === undefined || src === null) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigate?.(timelineRoute(runId, step.id));
      }}
      className="shrink-0 cursor-default overflow-hidden rounded-xs outline-none ring-separator ring-1 focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("chat.steps.frame", { name: persona.name })}
    >
      <img src={src} alt="" width={32} height={20} className="block h-5 w-8 object-cover" />
    </button>
  );
}

/** A helper's work, one level under its spawn step, folding to "Helper · 6 steps · 41 s". */
function HelperStep({
  step,
  now,
  enter,
}: {
  step: RunStep;
  now?: number | undefined;
  enter: boolean;
}): ReactElement {
  const childRunId = step.childRunId ?? null;
  const { steps: child } = useRunSteps(childRunId);
  const done = ended(step);
  const label = done
    ? t("chat.steps.helper", {
        n: child.length,
        duration: formatStepDuration(
          Math.max(0, (ms(step.endedAt) ?? 0) - (ms(step.startedAt) ?? 0)),
        ),
      })
    : stepLabel(step);
  const active = [...child].reverse().find((s) => !ended(s));
  return (
    <StepRow
      status={stepGlyph(step)}
      label={label}
      startedAt={Date.parse(step.startedAt)}
      endedAt={ms(step.endedAt)}
      {...(now === undefined ? {} : { now })}
      enter={enter}
      defaultOpen={!done}
    >
      {child.length > 0 ? (
        <ul className="-ms-7 flex flex-col">
          {(done ? child : active ? [active] : child.slice(-1)).map((s) => (
            <StepRow
              key={s.id}
              level={1}
              status={stepGlyph(s)}
              label={stepLabel(s)}
              {...(s.target ? { target: s.target } : {})}
              startedAt={Date.parse(s.startedAt)}
              endedAt={ms(s.endedAt)}
              {...(now === undefined ? {} : { now })}
            />
          ))}
        </ul>
      ) : undefined}
    </StepRow>
  );
}

/** One step: the shared row, with what its kind adds (thinking text, a pointer, a frame). */
export function StepItem({
  runId,
  step,
  now,
  level = 0,
  enter = false,
}: {
  runId: string;
  step: RunStep;
  now?: number | undefined;
  level?: 0 | 1;
  enter?: boolean;
}): ReactElement {
  const { level: disclosure } = useDisclosure();
  if (step.kind === "subagent" && step.childRunId)
    return <HelperStep step={step} now={now} enter={enter} />;
  const preview =
    disclosure === 2 && (step.preview?.input || step.preview?.output) ? (
      <div className="flex flex-col gap-1 text-mono">
        {step.preview?.input ? (
          <pre className="whitespace-pre-wrap">{step.preview.input}</pre>
        ) : null}
        {step.preview?.output ? (
          <pre className="whitespace-pre-wrap">{step.preview.output}</pre>
        ) : null}
      </div>
    ) : undefined;
  const failure =
    step.status === "failed" && step.error ? (
      <p className="text-danger-text">{step.error.message}</p>
    ) : undefined;
  const frame = step.frames ? <FrameThumb runId={runId} step={step} /> : undefined;
  const detail =
    step.kind === "thinking" ? (
      <ThinkingDetail runId={runId} step={step} />
    ) : failure || preview ? (
      <>
        {failure}
        {preview}
        {frame}
      </>
    ) : undefined;
  // A row with detail is a disclosure button: the frame goes inside the detail, never nested.
  const accessory =
    step.kind === "approval" && step.status === "waiting" && step.approvalId ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (step.approvalId) focusApproval(step.approvalId);
        }}
        className="inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-sm text-approval-text outline-none hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("chat.steps.reviewApproval")}
      >
        <ArrowDown className="size-3.5" aria-hidden="true" />
      </button>
    ) : detail === undefined ? (
      frame
    ) : undefined;
  return (
    <StepRow
      status={stepGlyph(step)}
      label={stepLabel(step)}
      {...(step.target ? { target: step.target } : {})}
      startedAt={Date.parse(step.startedAt)}
      endedAt={ms(step.endedAt)}
      {...(now === undefined ? {} : { now })}
      attempt={step.attempt}
      level={level}
      accessory={accessory}
      enter={enter}
      defaultOpen={step.status === "failed"}
    >
      {detail}
    </StepRow>
  );
}

function GroupRow({
  runId,
  row,
  now,
  enter,
}: {
  runId: string;
  row: Extract<TraceRow, { type: "group" }>;
  now?: number | undefined;
  enter: boolean;
}): ReactElement {
  const [all, setAll] = useState(false);
  // Running and failed rows stay; the rest fold past three.
  const keep = row.steps.filter((s) => !ended(s) || s.status === "failed");
  const shown = all
    ? row.steps
    : [...keep, ...row.steps.filter((s) => !keep.includes(s))].slice(
        0,
        Math.max(GROUP_ROWS, keep.length),
      );
  const more = row.steps.length - shown.length;
  return (
    <li className="flex flex-col" data-step-group={row.key}>
      <span className="ms-1 flex min-h-6 items-center text-callout text-label-secondary">
        {t("chat.steps.atOnce", { n: row.steps.length })}
      </span>
      <ul className="flex flex-col">
        {row.steps
          .filter((s) => shown.includes(s))
          .map((s) => (
            <StepItem key={s.id} runId={runId} step={s} now={now} level={1} enter={enter} />
          ))}
      </ul>
      {more > 0 ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="ms-8 me-auto h-6 cursor-default rounded-sm px-1 text-callout text-label-secondary outline-none hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("chat.steps.moreAtOnce", { n: more })}
        </button>
      ) : null}
    </li>
  );
}

function RepeatRow({
  runId,
  row,
  now,
  enter,
}: {
  runId: string;
  row: Extract<TraceRow, { type: "repeat" }>;
  now?: number | undefined;
  enter: boolean;
}): ReactElement {
  const first = row.steps[0] as RunStep;
  const last = row.steps.at(-1) as RunStep;
  return (
    <StepRow
      status={stepGlyph(last)}
      label={stepLabel(first)}
      {...(first.target ? { target: first.target } : {})}
      repeats={row.steps.length}
      startedAt={Date.parse(first.startedAt)}
      endedAt={ms(last.endedAt)}
      {...(now === undefined ? {} : { now })}
      enter={enter}
    >
      <ul className="-ms-7 flex flex-col">
        {row.steps.map((s) => (
          <StepItem key={s.id} runId={runId} step={s} now={now} level={1} />
        ))}
      </ul>
    </StepRow>
  );
}

/**
 * A run's steps as rows (§3.2): groups, repeats, helpers; the last five while working, failed and
 * waiting rows always, "Show all (n)" for the rest. Only rows that arrive after the list mounted
 * enter with motion (§3.7: steps arrive one by one, no stagger).
 */
export function StepList({
  runId,
  steps,
  now,
  folding = true,
  label,
}: {
  runId: string;
  steps: readonly RunStep[];
  now?: number | undefined;
  /** Fold to the last five (while working); the expanded summary shows every row. */
  folding?: boolean;
  label: string;
}): ReactElement {
  const [all, setAll] = useState(false);
  const rows = buildRows(steps);
  const shown = folding ? visibleRows(rows, all) : rows;
  const hidden = rows.length - shown.length;
  const mounted = useRef<Set<string> | null>(null);
  if (mounted.current === null) mounted.current = new Set(rows.map((r) => r.key));
  const isNew = (key: string) => !(mounted.current as Set<string>).has(key);
  useEffect(() => {
    for (const r of rows) mounted.current?.add(r.key);
  });
  return (
    <div className="flex flex-col">
      {folding && (hidden > 0 || all) ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="me-auto mb-0.5 h-6 cursor-default rounded-sm px-1 text-callout text-label-secondary outline-none hover:bg-fill-tertiary hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {all ? t("chat.steps.showFewer") : t("chat.steps.showAll", { n: steps.length })}
        </button>
      ) : null}
      <ul aria-label={label} className="flex flex-col" data-testid="trace-steps">
        {shown.map((row) =>
          row.type === "group" ? (
            <GroupRow key={row.key} runId={runId} row={row} now={now} enter={isNew(row.key)} />
          ) : row.type === "repeat" ? (
            <RepeatRow key={row.key} runId={runId} row={row} now={now} enter={isNew(row.key)} />
          ) : (
            <StepItem
              key={row.key}
              runId={runId}
              step={row.step}
              now={now}
              enter={isNew(row.key)}
            />
          ),
        )}
      </ul>
    </div>
  );
}

/**
 * One polite line for the run (§3.2, a11y): it says when a step starts and how it ended, never
 * the ticking time. Steps already there when it mounts are not announced.
 */
export function StepAnnouncer({ steps }: { steps: readonly RunStep[] }): ReactElement {
  const seen = useRef<Map<string, RunStep["status"]> | null>(null);
  const [message, setMessage] = useState("");
  if (seen.current === null) seen.current = new Map(steps.map((s) => [s.id, s.status]));
  useEffect(() => {
    const map = seen.current as Map<string, RunStep["status"]>;
    let next: string | null = null;
    for (const s of steps) {
      const before = map.get(s.id);
      if (before === s.status) continue;
      map.set(s.id, s.status);
      const label = stepLabel(s);
      if (s.status === "running") next = t("chat.steps.announce.started", { label });
      else if (s.status === "ok") next = t("chat.steps.announce.done", { label });
      else if (s.status === "failed") next = t("chat.steps.announce.failed", { label });
      else if (s.status === "waiting") next = t("chat.steps.announce.waiting", { label });
    }
    if (next !== null) setMessage(next);
  }, [steps]);
  return (
    <p className="sr-only" role="status" aria-live="polite" data-testid="trace-announcer">
      {message}
    </p>
  );
}
