import type {
  ApprovalHint,
  SpecialistJob,
  SpecialistResultKind,
  SpecialistRole,
} from "@psyche/protocol";
import {
  CalendarRange,
  Code,
  FolderTree,
  type LucideIcon,
  PenLine,
  Search,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import type { StepStatusKind } from "../components/status.tsx";
import { activeI18n, isMessageId, t } from "../i18n/core.ts";
import { formatDuration } from "../lib/format.ts";

/**
 * The specialist surfaces' shared words and numbers (docs/agent/specialists-2026.md §6): role
 * glyphs and labels, the one status vocabulary, the Inbox row's second line and the pre-flight.
 */

export type JobStatus = SpecialistJob["status"];

const ROLE_GLYPH: Record<string, LucideIcon> = {
  researcher: Search,
  shopper: ShoppingBag,
  coder: Code,
  organizer: FolderTree,
  writer: PenLine,
  planner: CalendarRange,
};

/** The role's glyph; a skill-defined role gets the generic one. */
export function roleGlyph(role: string): LucideIcon {
  return ROLE_GLYPH[role] ?? Sparkles;
}

/** "Researcher": the role's label from Settings, else the id in sentence case. */
export function roleLabel(role: string, roles?: readonly SpecialistRole[]): string {
  const known = roles?.find((r) => r.role === role)?.label;
  if (known) return known;
  const words = role.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "the researcher": role names are lowercase common nouns in prose (§6.5). */
export function roleNoun(label: string): string {
  return activeI18n().messageLocale.startsWith("en") ? label.toLowerCase() : label;
}

export function statusLabel(status: JobStatus): string {
  return t(`specialists.status.${status}`);
}

/** The shared status glyph for a job's status. */
export function statusGlyph(status: JobStatus): StepStatusKind {
  switch (status) {
    case "queued":
      return "pending";
    case "working":
      return "running";
    case "needs_you":
      return "waiting";
    case "done":
      return "done";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export const FINISHED: readonly JobStatus[] = ["done", "partial", "failed", "cancelled"];

export const isFinished = (job: Pick<SpecialistJob, "status">): boolean =>
  FINISHED.includes(job.status);

/** "$0.84" in the owner's number format. */
export function formatUsd(n: number): string {
  return activeI18n().number(n, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n < 10 ? 2 : 0,
  });
}

/** "182k": compact token counts. */
export function formatTokenCount(n: number): string {
  const num = (v: number) => activeI18n().number(v, { maximumFractionDigits: 1 });
  if (n < 1000) return num(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${num(k >= 100 ? Math.round(k) : Math.round(k * 10) / 10)}k`;
  }
  return `${num(Math.round((n / 1_000_000) * 10) / 10)}M`;
}

/** What stopped a partial job, as a noun phrase ("token budget", "deadline"), or null. */
export function stopPhrase(stopReason: string | undefined): string | null {
  if (stopReason === undefined) return null;
  if (stopReason === "deadline") return t("specialists.stop.deadline");
  const which = stopReason.startsWith("budget:") ? stopReason.slice(7) : null;
  if (which === "tokens" || which === "costUsd" || which === "minutes" || which === "steps")
    return t(`specialists.stop.${which}`);
  if (which === "cost") return t("specialists.stop.costUsd");
  if (which === "wallMs" || which === "time") return t("specialists.stop.minutes");
  return null;
}

/** "3 findings", "2 items", "4 changes": what a result holds, by the role's result kind. */
export function resultCount(job: SpecialistJob, kind?: SpecialistResultKind): string | null {
  const r = job.result;
  if (r == null) return null;
  if (kind === "items")
    return r.findings.length > 0 ? t("specialists.count.items", { n: r.findings.length }) : null;
  if (kind === "changes")
    return r.receipts.length > 0 ? t("specialists.count.changes", { n: r.receipts.length }) : null;
  if (kind === "draft" || kind === "plan")
    return r.artifacts.length > 0 ? t("specialists.count.files", { n: r.artifacts.length }) : null;
  return r.findings.length > 0 ? t("specialists.count.findings", { n: r.findings.length }) : null;
}

/**
 * The Inbox row's second line (§6.2): "Done · 3 findings · $0.84 · 22 min", "Partial · token
 * budget", "Needs you · Waiting for your approval", "Queued · 2nd · starts when a slot frees".
 */
export function jobLine(job: SpecialistJob, kind?: SpecialistResultKind): string {
  const parts = [statusLabel(job.status)];
  const used = job.budget.used;
  switch (job.status) {
    case "done": {
      const count = resultCount(job, kind);
      if (count) parts.push(count);
      if (used.costUsd != null) parts.push(formatUsd(used.costUsd));
      if (used.wallMs > 0) parts.push(formatDuration(used.wallMs));
      break;
    }
    case "partial": {
      const stop = stopPhrase(job.result?.stopReason);
      if (stop) parts.push(stop);
      else {
        const count = resultCount(job, kind);
        if (count) parts.push(count);
      }
      break;
    }
    case "queued":
      if (job.queuePosition != null)
        parts.push(t("specialists.queuedAt", { n: job.queuePosition }));
      break;
    case "working":
    case "needs_you":
      if (job.lastStep) parts.push(job.lastStep);
      break;
    case "failed":
    case "cancelled":
      if (used.wallMs > 0) parts.push(formatDuration(used.wallMs));
      break;
  }
  return parts.join(" · ");
}

/** The card's first line in Psyche's voice (§6.2 copy), from the outcome and the receipts. */
export function headline(job: SpecialistJob, label: string): string {
  const r = job.result;
  const role = label;
  const task = job.title;
  switch (r?.outcome ?? job.status) {
    case "done":
      return t("specialists.card.done", { role, task });
    case "partial": {
      const stop = stopPhrase(r?.stopReason);
      return stop
        ? t("specialists.card.partial", { budget: stop })
        : t("specialists.card.partialOther");
    }
    case "failed": {
      const line = t("specialists.card.failed", { role, task });
      // "Nothing was sent or bought" only when it is true: no receipts at all.
      return (r?.receipts.length ?? 0) === 0
        ? `${line} ${t("specialists.card.nothingSent")}`
        : line;
    }
    case "cancelled":
      return t("specialists.card.cancelled", { n: r?.receipts.length ?? 0 });
    default:
      return job.title;
  }
}

/**
 * One pre-flight hint (`SpecialistJob.preflight`, §4.4) in the owner's language: the catalogue's
 * line for its kind, else the runtime's. It grants nothing.
 */
export function preflightLabel(hint: ApprovalHint): string {
  const id = `specialists.preflight.${hint.kind}`;
  const label = isMessageId(id) ? t(id) : hint.label;
  return hint.estimate === undefined
    ? label
    : t("specialists.preflight.estimate", { label, n: hint.estimate });
}

/** What "Give it more" asks for: each limit +50% (§4.6), never above the role's caps. */
export function moreBudget(
  limit: SpecialistJob["budget"]["limit"],
  caps?: SpecialistRole["caps"],
): { tokens?: number; costUsd?: number; minutes?: number } {
  const grow = (
    n: number | null | undefined,
    cap: number | undefined,
    round: (x: number) => number,
  ) =>
    n == null ? undefined : Math.max(n, Math.min(round(n * 1.5), cap ?? Number.POSITIVE_INFINITY));
  const tokens = grow(limit.tokens, caps?.tokens, Math.round);
  const costUsd = grow(limit.costUsd, caps?.costUsd, (x) => Math.round(x * 100) / 100);
  const minutes = grow(
    limit.wallMs == null ? undefined : Math.round(limit.wallMs / 60_000),
    caps?.minutes,
    Math.round,
  );
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(minutes === undefined ? {} : { minutes }),
  };
}
