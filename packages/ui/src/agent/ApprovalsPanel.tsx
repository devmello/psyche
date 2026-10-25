import { ShieldCheck } from "lucide-react";
import { type ReactElement, useMemo } from "react";
import { ApprovalCard } from "../blocks/ApprovalCard.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { type ApprovalView, useApprovals, useGatewayQuery, useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { displaySummary } from "../lib/cards.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { usePersona, useSlots } from "../slots.tsx";
import { useReducedMotion } from "../theme/ThemeProvider.tsx";

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/** Where an approval was answered (a surface or a channel), or "" when unknown. */
function decidedWhere(by: unknown): string {
  if (by !== null && typeof by === "object") {
    if ("surface" in by && typeof by.surface === "string") return by.surface;
    if ("channel" in by && typeof by.channel === "string") return by.channel;
  }
  return "";
}

/**
 * Splits pending approvals into the ones you can answer here (Needs you) and the ones an
 * unattended automation run could not ask for (Deferred, §3.15). The sheet's tab badge and the
 * panel's "Needs you" count both come from here, so they always agree.
 */
export function useApprovalQueue() {
  const approvals = useApprovals();
  const tasks = useStoreState((s) => s.tasks);
  const { pending } = approvals;
  const split = useMemo(() => {
    const live: ApprovalView[] = [];
    const deferred: ApprovalView[] = [];
    for (const v of pending) {
      const taskId = v.approval.requestedBy.taskId;
      const unattended = taskId != null && tasks[taskId]?.createdFrom === "automation";
      (unattended && !v.canAnswer ? deferred : live).push(v);
    }
    return { live, deferred };
  }, [pending, tasks]);
  return { ...approvals, ...split, tasks };
}

function recentLine(v: ApprovalView): { text: string; variant: "success" | "danger" | "muted" } {
  const a = v.approval;
  const where = decidedWhere(a.decidedBy);
  if (a.status === "approved")
    return { text: t("agent.approvals.approved", { where, on: where !== "" }), variant: "success" };
  if (a.status === "denied")
    return { text: t("agent.approvals.denied", { where, on: where !== "" }), variant: "danger" };
  return {
    text: a.status === "expired" ? t("agent.approvals.expired") : t("agent.approvals.voided"),
    variant: "muted",
  };
}

const SECTIONS = [
  { id: "approvals-needs-you", label: () => t("agent.approvals.needsYou") },
  { id: "approvals-deferred", label: () => t("agent.approvals.deferred") },
  { id: "approvals-recent", label: () => t("agent.approvals.recent") },
  { id: "approvals-grants", label: () => t("agent.approvals.grants") },
] as const;

/**
 * Agent sheet → Approvals (UI design §3.15): Needs you (full cards, newest first), Deferred
 * (unattended runs that could not ask), Recent (7 days, who answered where), Standing grants.
 * A jump row at the top keeps the last three reachable below a long queue of cards.
 */
export function ApprovalsPanel({ now: fixedNow }: { now?: number }): ReactElement {
  const now = useNow(1000, fixedNow);
  const { live, deferred, recent, answer, loading, tasks } = useApprovalQueue();
  const persona = usePersona();
  const slots = useSlots();
  const grants = useGatewayQuery("grants.list", {});
  const standing = (grants.data?.grants ?? []).filter((g) => g.revokedAt == null);
  const recentList = recent.filter(
    (v) => now - Date.parse(v.approval.decidedAt ?? v.approval.requestedAt) < RECENT_MS,
  );
  const counts: Record<(typeof SECTIONS)[number]["id"], number> = {
    "approvals-needs-you": live.length,
    "approvals-deferred": deferred.length,
    "approvals-recent": recentList.length,
    "approvals-grants": standing.length,
  };
  const reducedMotion = useReducedMotion();
  const jump = (id: string) => {
    const el = document.getElementById(id);
    el?.scrollIntoView?.({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  };

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label={t("agent.approvals.sections")} className="flex flex-wrap gap-1.5">
        {SECTIONS.map((sec) => (
          <Button
            key={sec.id}
            type="button"
            size="xs"
            variant="ghost"
            className="text-label-secondary"
            onClick={() => jump(sec.id)}
          >
            {sec.label()}
            <span className="tabular-nums text-label-secondary">{counts[sec.id]}</span>
          </Button>
        ))}
      </nav>

      <section aria-labelledby="approvals-needs-you" className="flex scroll-mt-2 flex-col gap-2">
        <h3 id="approvals-needs-you" className="text-title-3 text-label-primary">
          {t("agent.approvals.needsYouCount", { n: live.length })}
        </h3>
        {live.length === 0 ? (
          <p className="text-body text-label-secondary">
            {loading ? t("common.loading") : t("agent.approvals.nothingNeedsYou")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {live.map((v) => {
              const task = v.approval.requestedBy.taskId
                ? tasks[v.approval.requestedBy.taskId]
                : undefined;
              return (
                <ApprovalCard
                  key={v.approval.id}
                  approval={v.approval}
                  canAnswer={v.canAnswer}
                  stale={v.stale}
                  persona={persona.name}
                  taskTitle={task?.title ?? null}
                  createdFrom={task?.createdFrom ?? null}
                  otherSurfaces={v.approval.surfaces.filter((s) => s !== "desktop" && s !== "web")}
                  onAnswer={(d, scope) => answer(v.approval.id, d, scope)}
                  now={now}
                />
              );
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="approvals-deferred" className="flex scroll-mt-2 flex-col gap-2">
        <h3 id="approvals-deferred" className="text-title-3 text-label-primary">
          {t("agent.approvals.deferredCount", { n: deferred.length })}
        </h3>
        {deferred.length === 0 ? (
          <p className="text-body text-label-secondary">{t("agent.approvals.noDeferred")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-separator text-body">
            {deferred.map((v) => {
              const taskId = v.approval.requestedBy.taskId;
              return (
                <li key={v.approval.id} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">
                      {tasks[taskId ?? ""]?.title ?? t("agent.approvals.anAutomation")}
                    </span>{" "}
                    <span className="text-label-secondary">
                      {t("agent.approvals.wantedTo", { what: displaySummary(v.approval) })}
                    </span>
                  </span>
                  {taskId ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => slots.navigate?.(`/agent/activity/${taskId}`)}
                    >
                      {t("agent.approvals.openTask")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="approvals-recent" className="flex scroll-mt-2 flex-col gap-2">
        <h3 id="approvals-recent" className="text-title-3 text-label-primary">
          {t("agent.approvals.recent")}
        </h3>
        {recentList.length === 0 ? (
          <p className="text-body text-label-secondary">{t("agent.approvals.noRecent")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-separator text-body">
            {recentList.map((v) => {
              const line = recentLine(v);
              return (
                <li key={v.approval.id} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate">{displaySummary(v.approval)}</span>
                  <Badge variant={line.variant}>{line.text}</Badge>
                  {v.approval.decidedAt ? (
                    <span className="shrink-0 text-callout text-label-secondary">
                      {formatRelative(v.approval.decidedAt, now)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="approvals-grants"
        className="flex scroll-mt-2 flex-col gap-2 rounded-lg bg-surface-raised shadow-elevation-1 p-3"
      >
        <h3 id="approvals-grants" className="text-title-3 text-label-primary">
          {t("agent.approvals.grants")}
        </h3>
        <div className="flex items-center gap-2 text-body">
          <ShieldCheck className="size-4 text-label-secondary" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {t("agent.approvals.grantsActive", { n: standing.length })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => slots.navigate?.("/settings/permissions")}
          >
            {t("agent.approvals.review")}
          </Button>
        </div>
      </section>
    </div>
  );
}
