import type { SpecialistJob, SpecialistResultKind } from "@psyche/protocol";
import { ExternalLink, FileText, ShieldAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { agentTimelineHref } from "../agent/AgentSheet.tsx";
import { ReceiptLine } from "../blocks/Receipt.tsx";
import { StatusGlyph } from "../components/status.tsx";
import { Button } from "../components/ui/button.tsx";
import { useArtifact, useLibraryItem, useReceipt } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { formatDuration } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { useSlots } from "../slots.tsx";
import { formatTokenCount, formatUsd, headline } from "./model.ts";

/** Findings shown before "Show all" (§6.2). */
export const FINDINGS_SHOWN = 3;

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  // A heading, not a region: several cards on one page repeat these names.
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-subheadline font-medium text-label-secondary">{title}</h4>
      {children}
    </div>
  );
}

/** A source URL as its host, opened outside the app. */
function SourceLink({ url }: { url: string }): ReactElement {
  const { openExternal } = useSlots();
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Not a URL: show it as written.
  }
  return (
    <button
      type="button"
      onClick={() => void openExternal?.(url)}
      className="inline-flex cursor-default items-center gap-1 rounded-xs text-callout text-accent-11 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${t("specialists.card.source")}: ${host}`}
    >
      {host}
      <ExternalLink className="size-3" aria-hidden="true" />
    </button>
  );
}

/** An artifact or Library item the job made, as a chip that opens it in its pane. */
function FileChip({ id }: { id: string }): ReactElement | null {
  const { openArtifact, openLibraryItem } = useSlots();
  const art = useArtifact(id);
  const lib = useLibraryItem(art.artifact === null && art.error !== null ? id : null);
  const name = art.artifact?.title ?? lib.item?.name;
  if (name === undefined) return null;
  return (
    <button
      type="button"
      onClick={() => {
        if (art.artifact) openArtifact?.(art.artifact);
        else if (lib.item) openLibraryItem?.(lib.item);
      }}
      className="inline-flex h-7 max-w-full cursor-default items-center gap-1.5 rounded-sm bg-fill-tertiary px-2 text-callout text-label-primary outline-none hover:bg-fill-secondary focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FileText className="size-3.5 shrink-0 text-label-secondary" aria-hidden="true" />
      <span className="truncate">{name}</span>
    </button>
  );
}

function ReceiptItem({ id }: { id: string }): ReactElement | null {
  const { openReceipt } = useSlots();
  const { receipt } = useReceipt(id);
  if (receipt === null) return null;
  return (
    <li>
      <ReceiptLine receipt={receipt} {...(openReceipt ? { onOpen: openReceipt } : {})} />
    </li>
  );
}

/** "182k of 400k tokens · $0.84 of $2.00 · 22 min of 30 min · 31 steps". */
export function usageLine(job: SpecialistJob): string {
  const { used, limit } = job.budget;
  const parts = [
    limit.tokens
      ? t("specialists.usage.tokens", {
          used: formatTokenCount(used.tokens),
          limit: formatTokenCount(limit.tokens),
        })
      : t("specialists.usage.tokensOnly", { used: formatTokenCount(used.tokens) }),
  ];
  if (used.costUsd == null) parts.push(t("specialists.usage.unpriced"));
  else
    parts.push(
      limit.costUsd != null
        ? t("specialists.usage.of", {
            used: formatUsd(used.costUsd),
            limit: formatUsd(limit.costUsd),
          })
        : formatUsd(used.costUsd),
    );
  parts.push(
    limit.wallMs
      ? t("specialists.usage.of", {
          used: formatDuration(used.wallMs),
          limit: formatDuration(limit.wallMs),
        })
      : formatDuration(used.wallMs),
  );
  parts.push(t("specialists.usage.steps", { n: used.steps }));
  return parts.join(" · ");
}

export interface SpecialistResultCardProps {
  job: SpecialistJob;
  /** The role's label ("Researcher") and what kind of result it makes. */
  roleLabel: string;
  resultKind?: SpecialistResultKind;
  /** A `next` follow-up: the parent thread's composer gets its message. */
  onNext?: (message: string) => void;
  onOpenThread?: () => void;
  onRetry?: () => void;
  retrying?: boolean;
  /** Drawn as a raised card (Feed) rather than inside an Inbox row. */
  framed?: boolean;
  /** Findings open past the first three (stories). */
  defaultShowAll?: boolean;
  className?: string;
}

/**
 * A specialist's one result (docs/agent/specialists-2026.md §6.2): Psyche's line on how it
 * ended, the report's summary, findings or items (collapsed after 3), files, what's missing,
 * "What it did" as receipts, the evaluator's check, usage against the budget, the taint note,
 * and up to two follow-ups plus Open thread, Timeline and Retry. Report text is data: it was
 * sanitized by the Gateway and is shown as plain text.
 */
export function SpecialistResultCard({
  job,
  roleLabel,
  resultKind,
  onNext,
  onOpenThread,
  onRetry,
  retrying = false,
  framed = false,
  defaultShowAll = false,
  className,
}: SpecialistResultCardProps): ReactElement | null {
  const { navigate } = useSlots();
  const [showAll, setShowAll] = useState(defaultShowAll);
  const r = job.result;
  if (r == null) return null;
  const findings = showAll ? r.findings : r.findings.slice(0, FINDINGS_SHOWN);
  const failed = r.outcome === "failed";
  const retryable = r.outcome === "partial" || r.outcome === "failed";
  const verdict = r.evaluator;
  return (
    <div
      className={cn(
        "flex flex-col gap-3 text-body",
        framed ? "rounded-lg bg-surface-raised p-4 shadow-elevation-1" : "",
        className,
      )}
      data-testid="specialist-result"
      data-outcome={r.outcome}
    >
      <div className="flex flex-col gap-1">
        <p className={cn("text-headline", failed ? "text-danger-text" : "text-label-primary")}>
          {headline(job, roleLabel)}
        </p>
        {r.summary ? <p className="text-label-primary">{r.summary}</p> : null}
      </div>

      {r.findings.length > 0 ? (
        <Section
          title={
            resultKind === "items" ? t("specialists.card.items") : t("specialists.card.findings")
          }
        >
          <ul className="flex flex-col gap-2">
            {findings.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: findings have no id and never reorder
              <li key={i} className="flex flex-col gap-0.5">
                <span className="text-label-primary">{f.title}</span>
                {f.detail ? (
                  <span className="text-callout text-label-secondary">{f.detail}</span>
                ) : null}
                {f.sources && f.sources.length > 0 ? (
                  <span className="flex flex-wrap gap-x-3">
                    {f.sources.map((s) => (
                      <SourceLink key={s} url={s} />
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {r.findings.length > FINDINGS_SHOWN ? (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
              className="self-start rounded-xs text-callout text-accent-11 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showAll
                ? t("specialists.card.showFewer")
                : t("specialists.card.showAll", { n: r.findings.length })}
            </button>
          ) : null}
        </Section>
      ) : null}

      {r.artifacts.length > 0 ? (
        <Section title={t("specialists.card.files")}>
          <div className="flex flex-wrap gap-1.5">
            {r.artifacts.map((id) => (
              <FileChip key={id} id={id} />
            ))}
          </div>
        </Section>
      ) : null}

      {r.gaps.length > 0 ? (
        <Section title={t("specialists.card.gaps")}>
          <ul className="flex list-disc flex-col gap-0.5 ps-5 text-callout text-label-secondary">
            {r.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={t("specialists.card.whatItDid")}>
        {r.receipts.length > 0 ? (
          <ul className="flex flex-col">
            {r.receipts.map((id) => (
              <ReceiptItem key={id} id={id} />
            ))}
          </ul>
        ) : (
          <p className="text-callout text-label-secondary">{t("specialists.card.nothingDone")}</p>
        )}
        {verdict ? (
          <p className="flex items-center gap-1.5 text-callout text-label-secondary">
            <StatusGlyph
              status={verdict.verdict === "done" ? "done" : "waiting"}
              className="[&_svg]:size-3.5"
            />
            {t(`specialists.evaluator.${verdict.verdict}`, { reason: verdict.reason })}
          </p>
        ) : null}
        {(r.defaultsUsed ?? []).map((label) => (
          <p key={label} className="text-callout text-label-secondary">
            {t("specialists.card.defaultUsed", { label })}
          </p>
        ))}
      </Section>

      <Section title={t("specialists.card.usage")}>
        <p className="text-callout text-label-secondary tabular-nums">
          {usageLine(job)}
          {job.budget.used.retried?.costUsd != null && job.budget.used.retried.costUsd > 0 ? (
            <>
              {" · "}
              {t("specialists.usage.retried", {
                cost: formatUsd(job.budget.used.retried.costUsd),
              })}
            </>
          ) : null}
        </p>
      </Section>

      {r.tainted ? (
        <p className="flex items-start gap-1.5 text-callout text-label-secondary">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-approval-text" aria-hidden="true" />
          {t("specialists.card.taint")}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {r.next.map((n, i) => (
          <Button
            key={n.label}
            type="button"
            size="sm"
            variant={i === 0 ? "outline" : "ghost"}
            onClick={() => onNext?.(n.message)}
          >
            {n.label}
          </Button>
        ))}
        {retryable && onRetry ? (
          <Button
            type="button"
            size="sm"
            variant={r.next.length === 0 ? "outline" : "ghost"}
            disabled={retrying}
            onClick={onRetry}
          >
            {t("specialists.action.retry")}
          </Button>
        ) : null}
        {onOpenThread ? (
          <Button type="button" size="sm" variant="ghost" onClick={onOpenThread}>
            {t("specialists.action.openThread")}
          </Button>
        ) : null}
        {job.runId ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => job.runId && navigate?.(agentTimelineHref(job.runId))}
          >
            {t("specialists.action.timeline")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
