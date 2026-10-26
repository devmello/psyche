import type { RunFrame, RunStep } from "@psyche/protocol";
import { type ReactElement, type ReactNode, type RefObject, useState } from "react";
import { JsonView } from "../../components/json-view.tsx";
import { StatusGlyph, stepStatusKind } from "../../components/status.tsx";
import { formatStepDuration } from "../../components/steps/LiveDuration.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx";
import { useRunStep } from "../../data/runs.ts";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/index.ts";
import { formatTime } from "../../lib/format.ts";
import { tokens as formatTokens, usd } from "../../screens/settings/UsageSection.tsx";
import { type FrameImage, FrameViewer } from "./FrameViewer.tsx";
import { ms, type TraceRow } from "./model.ts";

/**
 * The step inspector (docs/design/run-trace-2026.md §3.3): Overview, Input, Output, Timing, Cost
 * and Frames for the selected step. Inputs and outputs are read with `runs.step` only when their
 * tab opens; redactions show as tokens (`‹redacted›`, `‹vault: name›`), and Copy copies the
 * redacted text. A failed task opens here on its failed step's Output.
 */

export type InspectorTab = "overview" | "input" | "output" | "timing" | "cost" | "frames";
export const INSPECTOR_TABS: readonly InspectorTab[] = [
  "overview",
  "input",
  "output",
  "timing",
  "cost",
  "frames",
];

export interface StepLinks {
  onOpenRun?: (runId: string) => void;
  onOpenApproval?: (approvalId: string) => void;
  onOpenReceipt?: (receiptId: string) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenMemory?: (path: string) => void;
}

export interface StepInspectorProps extends StepLinks {
  row: TraceRow | null;
  /** Every step of the row's run, for "why" (the Thinking step just before). */
  runSteps: readonly RunStep[];
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  frames: readonly RunFrame[];
  frameSeq: number | null;
  onFrameSelect: (seq: number) => void;
  image: FrameImage;
  now: number;
  /** Days thinking text and frames are kept (`data.reasoningRetentionDays`, default 7). */
  retentionDays?: number;
  panelRef?: RefObject<HTMLElement | null>;
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <>
      <dt className="text-callout text-label-secondary">{label}</dt>
      <dd className="min-w-0 text-body text-label-primary">{children}</dd>
    </>
  );
}

function iso(t0: number): string {
  return new Date(t0).toISOString();
}

/** Thinking text kept past its retention reads as gone, not empty (§3.8). */
function expired(step: RunStep, now: number): boolean {
  const at = ms(step.text?.expiresAt);
  return at !== null && at <= now;
}

function Payload({
  value,
  preview,
  truncated,
  empty,
}: {
  value: unknown;
  preview: string | undefined;
  truncated: boolean;
  empty: string;
}): ReactElement {
  const [raw, setRaw] = useState(false);
  if (value === undefined && preview === undefined)
    return <p className="text-body text-label-secondary">{empty}</p>;
  const shown = value === undefined ? preview : value;
  const structured = typeof shown === "object" && shown !== null;
  return (
    <div className="flex flex-col gap-1.5">
      {structured ? (
        <div className="flex justify-end">
          <Button size="xs" variant="ghost" aria-pressed={raw} onClick={() => setRaw((r) => !r)}>
            {t("agent.timeline.raw")}
          </Button>
        </div>
      ) : null}
      {structured && !raw ? (
        <JsonView value={shown} />
      ) : (
        <pre className="max-h-96 overflow-auto rounded-md bg-fill-quaternary p-3 font-mono text-callout whitespace-pre-wrap break-words">
          {typeof shown === "string" ? shown : JSON.stringify(shown)}
        </pre>
      )}
      {truncated ? (
        <p className="text-caption text-label-tertiary">{t("agent.timeline.truncated")}</p>
      ) : null}
    </div>
  );
}

export function StepInspector({
  row,
  runSteps,
  tab,
  onTabChange,
  frames,
  frameSeq,
  onFrameSelect,
  image,
  now,
  retentionDays = 7,
  panelRef,
  onOpenRun,
  onOpenApproval,
  onOpenReceipt,
  onOpenArtifact,
  onOpenMemory,
}: StepInspectorProps): ReactElement {
  const step = row?.step ?? null;
  const needsDetail =
    step !== null &&
    (tab === "input" ||
      tab === "output" ||
      (tab === "overview" && step.kind === "thinking" && !expired(step, now)));
  const { detail, loading } = useRunStep(
    needsDetail ? (row?.runId ?? null) : null,
    needsDetail ? (step?.id ?? null) : null,
  );
  if (row === null || step === null) {
    return (
      <section
        ref={panelRef}
        tabIndex={-1}
        aria-label={t("agent.timeline.inspector.label")}
        className="flex flex-1 items-center justify-center p-4 text-center text-body text-label-secondary outline-none"
      >
        {row?.type === "group"
          ? t("agent.timeline.group", { n: row.children.length })
          : t("agent.timeline.inspector.empty")}
      </section>
    );
  }
  const why = [...runSteps]
    .filter((s) => s.seq < step.seq && s.kind === "thinking")
    .sort((a, b) => b.seq - a.seq)[0];
  const start = row.start;
  const end = row.end;
  const stepFrames = frames.filter((f) => f.stepId === step.id);
  const waitMs = step.kind === "approval" || step.kind === "question" ? (end ?? now) - start : null;
  const fullThinking = detail?.step.text?.full ?? step.text?.full;
  const usage = step.usage;
  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-label={t("agent.timeline.inspector.label")}
      className="flex min-h-0 flex-1 flex-col gap-2 outline-none"
      data-testid="step-inspector"
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusGlyph
          status={stepStatusKind(step.status)}
          label={t(`agent.timeline.status.${step.status}` as MessageId)}
          className="size-4 shrink-0"
        />
        <h3 className="min-w-0 flex-1 truncate text-headline">{row.label}</h3>
        <span className="shrink-0 text-callout text-label-secondary tabular-nums">
          {formatStepDuration((end ?? now) - start)}
        </span>
      </div>
      <Tabs
        value={tab}
        onValueChange={(v) => onTabChange(v as InspectorTab)}
        className="min-h-0 flex-1"
      >
        <TabsList aria-label={t("agent.timeline.inspector.label")} className="w-full">
          {INSPECTOR_TABS.map((k) => (
            <TabsTrigger key={k} value={k} className="min-w-0 px-1 text-callout">
              {t(`agent.timeline.tab.${k}` as MessageId)}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto pt-2">
          <TabsContent value="overview" className="flex flex-col gap-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
              <Field label={t("agent.timeline.field.status")}>
                {t(`agent.timeline.status.${step.status}` as MessageId)}
                {step.attempt > 1 ? ` · ${t("agent.timeline.attempt", { n: step.attempt })}` : ""}
              </Field>
              <Field label={t("agent.timeline.field.kind")}>
                {t(`agent.timeline.kind.${step.kind}` as MessageId)}
              </Field>
              {step.target ? (
                <Field label={t("agent.timeline.field.target")}>{step.target}</Field>
              ) : null}
              {step.modelRef ? (
                <Field label={t("agent.timeline.field.model")}>{step.modelRef}</Field>
              ) : null}
              {step.progress?.message ? (
                <Field label={t("agent.timeline.field.progress")}>{step.progress.message}</Field>
              ) : null}
              {step.error ? (
                <Field label={t("agent.timeline.status.failed")}>
                  <span className="text-danger-text">
                    {t("agent.timeline.error", {
                      code: step.error.code,
                      message: step.error.message,
                    })}
                  </span>
                </Field>
              ) : null}
            </dl>
            {step.kind === "thinking" ? (
              expired(step, now) ? (
                <p className="text-callout text-label-secondary">
                  {step.text?.summary ? `${step.text.summary} · ` : ""}
                  {t("agent.timeline.expired", { days: retentionDays })}
                </p>
              ) : loading && fullThinking === undefined ? (
                <Skeleton className="h-16" />
              ) : (
                <blockquote className="border-s-2 border-separator ps-3 text-reading whitespace-pre-wrap text-label-primary">
                  {fullThinking ?? step.text?.summary}
                </blockquote>
              )
            ) : why?.text?.summary ? (
              <figure className="flex flex-col gap-1">
                <figcaption className="text-callout text-label-secondary">
                  {t("agent.timeline.field.why")}
                </figcaption>
                <blockquote className="border-s-2 border-separator ps-3 text-body text-label-primary">
                  {why.text.summary}
                </blockquote>
              </figure>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {step.receiptId && onOpenReceipt ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onOpenReceipt(step.receiptId as string)}
                >
                  {t("agent.timeline.link.receipt")}
                </Button>
              ) : null}
              {step.approvalId && onOpenApproval ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onOpenApproval(step.approvalId as string)}
                >
                  {t("agent.timeline.link.approval")}
                </Button>
              ) : null}
              {step.artifactId && onOpenArtifact ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onOpenArtifact(step.artifactId as string)}
                >
                  {t("agent.timeline.link.artifact")}
                </Button>
              ) : null}
              {step.memoryPath && onOpenMemory ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onOpenMemory(step.memoryPath as string)}
                >
                  {t("agent.timeline.link.memory", { path: step.memoryPath })}
                </Button>
              ) : null}
              {step.childRunId && onOpenRun ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onOpenRun(step.childRunId as string)}
                >
                  {t("agent.timeline.link.helper")}
                </Button>
              ) : null}
            </div>
          </TabsContent>
          <TabsContent value="input">
            {loading && detail === null ? (
              <Skeleton className="h-24" />
            ) : (
              <Payload
                value={detail?.input}
                preview={step.preview?.input}
                truncated={false}
                empty={t("agent.timeline.noInput")}
              />
            )}
          </TabsContent>
          <TabsContent value="output" className="flex flex-col gap-2">
            {step.error ? (
              <p className="rounded-md bg-danger-surface px-3 py-2 text-body">
                <span className="font-mono text-danger-text">{step.error.code}</span>
                {` · ${step.error.message}`}
              </p>
            ) : null}
            {loading && detail === null ? (
              <Skeleton className="h-24" />
            ) : step.payloadRef?.output && detail !== null && detail.output === undefined ? (
              <p className="text-body text-label-secondary">{t("agent.timeline.outputExpired")}</p>
            ) : (
              <Payload
                value={detail?.output}
                preview={step.preview?.output}
                truncated={detail?.truncated ?? false}
                empty={t("agent.timeline.noOutput")}
              />
            )}
          </TabsContent>
          <TabsContent value="timing">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 tabular-nums">
              <Field label={t("agent.timeline.time.started")}>
                <time dateTime={iso(start)}>{formatTime(iso(start))}</time>
              </Field>
              {end !== null ? (
                <Field label={t("agent.timeline.time.ended")}>
                  <time dateTime={iso(end)}>{formatTime(iso(end))}</time>
                </Field>
              ) : null}
              <Field label={t("agent.timeline.time.duration")}>
                {formatStepDuration((end ?? now) - start)}
              </Field>
              {waitMs !== null ? (
                <Field label={t("agent.timeline.time.waiting")}>{formatStepDuration(waitMs)}</Field>
              ) : null}
            </dl>
            {step.attempts && step.attempts.length > 0 ? (
              <section className="mt-3 flex flex-col gap-1">
                <h4 className="text-headline">{t("agent.timeline.time.attempts")}</h4>
                <ol className="flex flex-col gap-1 text-callout">
                  {[
                    ...step.attempts,
                    {
                      startedAt: step.startedAt,
                      endedAt: step.endedAt,
                      status: step.status,
                      error: step.error,
                    },
                  ].map((a, i) => {
                    const a0 = ms(a.startedAt) ?? start;
                    const a1 = ms(a.endedAt) ?? now;
                    return (
                      <li key={a.startedAt} className="flex flex-col">
                        <span>
                          {t("agent.timeline.time.attemptRow", {
                            n: i + 1,
                            status: t(`agent.timeline.status.${a.status}` as MessageId),
                            duration: formatStepDuration(a1 - a0),
                          })}
                        </span>
                        {a.error ? (
                          <span className="text-label-secondary">
                            {t("agent.timeline.error", {
                              code: a.error.code,
                              message: a.error.message,
                            })}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : null}
          </TabsContent>
          <TabsContent value="cost">
            {usage ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 tabular-nums">
                <Field label={t("agent.timeline.cost.input")}>{formatTokens(usage.input)}</Field>
                <Field label={t("agent.timeline.cost.output")}>{formatTokens(usage.output)}</Field>
                <Field label={t("agent.timeline.cost.cacheRead")}>
                  {formatTokens(usage.cacheRead)}
                </Field>
                <Field label={t("agent.timeline.cost.cacheWrite")}>
                  {formatTokens(usage.cacheWrite)}
                </Field>
                <Field label={t("agent.timeline.cost.reasoning")}>
                  {formatTokens(usage.reasoning)}
                </Field>
                <Field label={t("agent.timeline.cost.total")}>
                  {usage.costUsd == null ? t("agent.timeline.unknown") : usd(usage.costUsd)}
                </Field>
              </dl>
            ) : row.foldable && row.rollup.tokens !== null ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 tabular-nums">
                <Field label={t("agent.timeline.cost.tokens")}>
                  {formatTokens(row.rollup.tokens)}
                </Field>
                <Field label={t("agent.timeline.cost.total")}>
                  {row.rollup.costUsd === null
                    ? t("agent.timeline.unknown")
                    : usd(row.rollup.costUsd)}
                </Field>
              </dl>
            ) : (
              <p className="text-body text-label-secondary">{t("agent.timeline.cost.none")}</p>
            )}
          </TabsContent>
          <TabsContent value="frames">
            {stepFrames.length > 0 ? (
              <FrameViewer
                runId={row.runId}
                step={step}
                frames={stepFrames}
                image={image}
                seq={frameSeq}
                onSelect={onFrameSelect}
                retentionDays={retentionDays}
              />
            ) : (
              <p className="text-body text-label-secondary">{t("agent.timeline.frames.none")}</p>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </section>
  );
}
