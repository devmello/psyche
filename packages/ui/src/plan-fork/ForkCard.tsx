import type { PlanForkBranch } from "@psyche/protocol";
import { GitCompareArrows } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useCall } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { continuePlan, usePlanFork, usePlanForkNav } from "./data.ts";
import {
  type CostTotal,
  continuePending,
  costTotals,
  formatMoney,
  formatUsd,
  isLive,
} from "./model.ts";

/** `mm:ss` since a branch started, from a fixed `now` in stories and tests. */
export function elapsed(startedAt: string | null | undefined, now: number): string {
  if (startedAt == null) return "0:00";
  const s = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function totalText(total: CostTotal): string {
  const money = formatMoney(total.amount, total.currency);
  const per = t(`planFork.period.${total.period}`);
  return total.includesEstimate ? t("planFork.total.estimate", { money, per }) : `${money} ${per}`;
}

/** One line of what a branch is doing now. */
export function branchLine(b: PlanForkBranch, step: string | undefined): string {
  if (b.status === "queued") return t("planFork.card.waiting");
  if (b.status === "running") return step ?? t("planFork.card.working");
  if (b.status === "reported") return t("planFork.card.reported");
  if (b.status === "budget_stopped") return t("planFork.card.budgetStopped");
  if (b.status === "cancelled") return t("planFork.card.cancelled");
  return b.error ?? t("planFork.card.failed");
}

/**
 * The fork card in the transcript (`plan_fork` block, §5.1). Running: one line per branch with its
 * live step, elapsed time and spend against the cap, and Cancel. Ready: the headline, the totals
 * per branch and Compare. The text it shows is read with `planForks.get`, never from the block.
 */
export function PlanForkCard({ forkId, now }: { forkId: string; now?: number }): ReactElement {
  const { fork, branches, steps, loading, error } = usePlanFork(forkId);
  const nav = usePlanForkNav();
  const call = useCall();
  const [busy, setBusy] = useState(false);
  const clock = now ?? Date.now();
  if (fork == null) {
    return (
      <p className="m-0 text-callout text-label-secondary" data-testid="plan-fork-card">
        {loading ? t("planFork.card.loading") : error ? t("planFork.card.unavailable") : ""}
      </p>
    );
  }
  const title = branches.map((b) => b.label).join(` ${t("planFork.card.vs")} `);
  const live = isLive(fork.status);
  return (
    <section
      aria-label={t("planFork.card.aria", { title })}
      data-testid="plan-fork-card"
      data-status={fork.status}
      className="my-2 flex flex-col gap-2 rounded-lg border border-separator bg-surface-raised px-4 py-3"
    >
      <h3 className="m-0 flex items-center gap-2 text-body font-medium text-label-primary">
        <GitCompareArrows className="size-4 text-label-secondary" aria-hidden="true" />
        {title}
      </h3>
      {live ? (
        <>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {branches.map((b) => (
              <li key={b.id} className="flex items-baseline gap-2 text-callout">
                <span className="font-medium text-label-primary">{b.label}</span>
                <span className="min-w-0 flex-1 truncate text-label-secondary">
                  {branchLine(b, steps[b.id])}
                </span>
                <span className="tabular-nums text-label-tertiary">
                  {b.status === "running" ? elapsed(b.startedAt, clock) : ""}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2 text-callout text-label-secondary">
            <span className="tabular-nums">
              {t("planFork.card.spend", {
                spent: formatUsd(fork.spentUsd),
                cap: formatUsd(fork.budgetUsd),
              })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                call("planForks.cancel", { forkId })
                  .catch(() => {})
                  .finally(() => setBusy(false));
              }}
            >
              {t("planFork.cancel")}
            </Button>
          </div>
        </>
      ) : fork.status === "ready" || fork.status === "taken" ? (
        <>
          {fork.comparison != null ? (
            <p className="m-0 text-callout text-label-secondary">
              {branches.some((b) => b.scrub?.textHidden === true)
                ? t("planFork.hiddenText")
                : fork.comparison.headline}
            </p>
          ) : null}
          <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-callout">
            {branches.map((b) => {
              const totals = b.report == null ? [] : costTotals(b.report.costs);
              return (
                <li key={b.id} className="flex flex-col">
                  <span className="font-medium text-label-primary">{b.label}</span>
                  <span className="text-label-secondary">
                    {b.scrub?.totalsHidden === true
                      ? t("planFork.totalOnMac")
                      : totals.length > 0
                        ? totals.map(totalText).join(" · ")
                        : t("planFork.total.none")}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between gap-2">
            <span className="text-callout text-label-secondary">
              {fork.status === "taken" ? t("planFork.card.taken") : ""}
            </span>
            {continuePending(fork) ? (
              <ContinueButton forkId={forkId} branchId={fork.takenBranchId} />
            ) : (
              <Button
                variant={fork.status === "taken" ? "outline" : "default"}
                size="sm"
                onClick={() => nav?.openPlans(forkId)}
                disabled={nav == null}
              >
                {t("planFork.compare")}
              </Button>
            )}
          </div>
        </>
      ) : (
        <p className="m-0 text-callout text-label-secondary">
          {t(`planFork.status.${fork.status}`)}
        </p>
      )}
    </section>
  );
}

/**
 * Continue, for a plan taken while the chat was busy: the remaining steps have not started. One
 * tap starts them (`planForks.take` with `continue`); a busy chat says so and keeps the button.
 */
export function ContinueButton({
  forkId,
  branchId,
  onStarted,
}: {
  forkId: string;
  branchId: string;
  onStarted?: () => void;
}): ReactElement {
  const call = useCall();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        disabled={busy}
        data-testid="plan-continue"
        onClick={() => {
          setBusy(true);
          setNotice(null);
          continuePlan(call, { forkId, branchId })
            .then((r) => {
              if (r === "busy") setNotice(t("planFork.continue.busy"));
              else onStarted?.();
            })
            .catch((err: unknown) => setNotice(describeError(err)))
            .finally(() => setBusy(false));
        }}
      >
        {t("planFork.continue")}
      </Button>
      {notice != null ? (
        <span role="alert" className="text-footnote text-danger-text">
          {notice}
        </span>
      ) : null}
    </span>
  );
}

/** The line a taken plan leaves in the parent chat (`plan_taken` block). */
export function PlanTakenLine({
  forkId,
  branchId,
}: {
  forkId: string;
  branchId: string;
}): ReactElement {
  const { fork, branches } = usePlanFork(forkId);
  const nav = usePlanForkNav();
  const label = branches.find((b) => b.id === branchId)?.label ?? "";
  return (
    <p className="m-0 my-2 text-callout text-label-secondary" data-testid="plan-taken">
      {t("planFork.taken.line", { label })}{" "}
      {nav != null ? (
        <button
          type="button"
          className="cursor-default text-label-primary underline underline-offset-2"
          onClick={() => nav.openPlans(forkId)}
        >
          {t("planFork.taken.open")}
        </button>
      ) : null}
      {fork != null && continuePending(fork) && fork.takenBranchId === branchId ? (
        <ContinueButton forkId={forkId} branchId={branchId} />
      ) : null}
    </p>
  );
}
