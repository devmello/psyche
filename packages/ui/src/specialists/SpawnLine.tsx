import type { SpecialistJob, SpecialistRole } from "@psyche/protocol";
import type { ReactElement } from "react";
import { agentTimelineHref } from "../agent/AgentSheet.tsx";
import { StatusGlyph } from "../components/status.tsx";
import { t } from "../i18n/core.ts";
import { useSlots } from "../slots.tsx";
import {
  isFinished,
  jobLine,
  preflightLabel,
  roleGlyph,
  roleLabel,
  roleNoun,
  statusGlyph,
  statusLabel,
} from "./model.ts";

/**
 * The parent thread's line for one job it started (docs/agent/specialists-2026.md §6.1): "Started
 * the researcher · Apartments near the office", where it stands, and a link to its Timeline
 * (the job's own thread until it has a run). Until the job ends, the pre-flight says what it will
 * ask first ("Will ask before opening new sites"); it grants nothing.
 */
export function SpecialistSpawnLine({
  job,
  roles,
}: {
  job: SpecialistJob;
  roles?: readonly SpecialistRole[];
}): ReactElement {
  const { navigate } = useSlots();
  const role = roles?.find((r) => r.role === job.role);
  const label = roleLabel(job.role, roles);
  const Glyph = roleGlyph(job.role);
  // The runtime's pre-flight from the spawn; it says what the job will ask while it runs.
  const hints = isFinished(job) ? [] : (job.preflight ?? []);
  const open = () => navigate?.(job.runId ? agentTimelineHref(job.runId) : `/chat/${job.threadId}`);
  const line = t("specialists.spawn.line", { role: roleNoun(label), title: job.title });
  return (
    <li className="flex flex-col gap-0.5" data-testid="specialist-spawn" data-status={job.status}>
      <button
        type="button"
        onClick={open}
        aria-label={t("specialists.spawn.label", {
          role: label,
          title: job.title,
          status: statusLabel(job.status),
        })}
        className="-mx-1 flex min-h-7 min-w-0 cursor-default items-center gap-2 rounded-sm px-1 text-start text-callout text-label-secondary outline-none hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <StatusGlyph status={statusGlyph(job.status)} morph className="[&_svg]:size-3.5" />
        <Glyph className="size-3.5 shrink-0 text-label-tertiary" aria-hidden="true" />
        <span className="min-w-0 truncate">
          <span className="text-label-primary">{line}</span>
          <span aria-hidden="true"> · </span>
          <span className="tabular-nums">{jobLine(job, role?.result)}</span>
        </span>
        <span className="ms-auto shrink-0 text-accent-11">
          {t("specialists.action.timeline")} <span aria-hidden="true">›</span>
        </span>
      </button>
      {hints.length > 0 ? (
        <p className="ps-[2.875rem] text-subheadline text-label-tertiary">
          <span className="sr-only">{t("specialists.preflight.label")}: </span>
          {hints.map(preflightLabel).join(" · ")}
        </p>
      ) : null}
    </li>
  );
}

/** The jobs one run started, in the order it started them. */
export function SpecialistSpawns({
  jobs,
  roles,
}: {
  jobs: readonly SpecialistJob[];
  roles?: readonly SpecialistRole[];
}): ReactElement | null {
  if (jobs.length === 0) return null;
  const ordered = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <ul className="mt-1 mb-2 flex flex-col gap-1 ps-7" data-testid="specialist-spawns">
      {ordered.map((job) => (
        <SpecialistSpawnLine key={job.taskId} job={job} {...(roles ? { roles } : {})} />
      ))}
    </ul>
  );
}
