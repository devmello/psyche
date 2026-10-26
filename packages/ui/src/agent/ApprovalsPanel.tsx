import type { Grant } from "@psyche/protocol";
import { ChevronRight } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApprovalCard } from "../blocks/ApprovalCard.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible.tsx";
import {
  type ApprovalView,
  useApprovals,
  useCall,
  useGatewayQuery,
  useQuestions,
  useStoreState,
} from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { displaySummary } from "../lib/cards.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { routeLink } from "../overview/overviewLinks.ts";
import { grantSubject } from "../screens/settings/PermissionsSection.tsx";
import { usePersona, useSlots } from "../slots.tsx";
import { Row } from "./MissionControl.tsx";

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
  const threads = useStoreState((s) => s.threads);
  const { pending } = approvals;
  const split = useMemo(() => {
    const live: ApprovalView[] = [];
    const deferred: ApprovalView[] = [];
    for (const v of pending) {
      const taskId = v.approval.requestedBy.taskId;
      const task = taskId == null ? undefined : tasks[taskId];
      // An automation's run, or a specialist an automation started (no parent run, §4.10).
      const unattended =
        task?.createdFrom === "automation" ||
        (task?.createdFrom === "subagent" && task.specialist?.parentRunId === null);
      (unattended && !v.canAnswer ? deferred : live).push(v);
    }
    return { live, deferred };
  }, [pending, tasks]);
  return { ...approvals, ...split, tasks, threads };
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

/** A quiet "Label (n) ▸" disclosure; the panel's secondary lists live behind these. */
function Disclosure({
  id,
  label,
  count,
  open,
  onOpenChange,
  children,
}: {
  id: string;
  label: string;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}): ReactElement {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} id={id} className="scroll-mt-2">
      <CollapsibleTrigger className="group flex w-full cursor-default items-center gap-1.5 rounded-sm py-1 text-start text-headline text-label-primary outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          aria-hidden="true"
          className="size-4 text-label-secondary transition-transform group-data-[panel-open]:rotate-90 rtl:-scale-x-100"
        />
        <span className="min-w-0 flex-1">{label}</span>
        <span className="text-callout text-label-secondary tabular-nums">{count}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Agent sheet → Approvals (agent-overview-2026 §4.1): Needs you (full cards, newest first),
 * Questions, anything an unattended run could not ask (Deferred), and two quiet disclosures,
 * Standing permissions (grants, revoke) and Decided recently (7 days). `decided` opens the
 * latter (`/agent/approvals?view=decided`).
 */
export function ApprovalsPanel({
  now: fixedNow,
  decided = false,
}: {
  now?: number;
  decided?: boolean;
}): ReactElement {
  const now = useNow(1000, fixedNow);
  const { live, deferred, recent, answer, loading, tasks, threads } = useApprovalQueue();
  const questions = useQuestions();
  const persona = usePersona();
  const slots = useSlots();
  const call = useCall();
  const grants = useGatewayQuery("grants.list", {});
  const standing = (grants.data?.grants ?? []).filter((g) => g.revokedAt == null);
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(() => new Set());
  const reloadGrants = grants.reload;
  const revoke = (g: Grant) => {
    setRevoking((r) => new Set(r).add(g.id));
    call("grants.revoke", { grantId: g.id })
      .then(() => reloadGrants())
      .catch(() => {})
      .finally(() =>
        setRevoking((r) => {
          const next = new Set(r);
          next.delete(g.id);
          return next;
        }),
      );
  };
  const recentList = recent.filter(
    (v) => now - Date.parse(v.approval.decidedAt ?? v.approval.requestedAt) < RECENT_MS,
  );
  const [grantsOpen, setGrantsOpen] = useState(false);
  const [decidedOpen, setDecidedOpen] = useState(decided);
  const decidedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!decided) return;
    setDecidedOpen(true);
    // After the disclosure has opened and the cards above have laid out.
    const frame = requestAnimationFrame(() =>
      decidedRef.current?.scrollIntoView?.({ block: "start" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [decided]);
  const overview = routeLink("/overview", slots.navigate);
  const empty = live.length === 0 && questions.open.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="approvals-needs-you" className="flex scroll-mt-2 flex-col gap-2">
        <h3 id="approvals-needs-you" className="text-title-3 text-label-primary">
          {t("agent.approvals.needsYouCount", { n: live.length })}
        </h3>
        {live.length === 0 ? (
          loading ? (
            <p className="text-body text-label-secondary">{t("common.loading")}</p>
          ) : empty ? (
            <div className="flex flex-col gap-0.5" data-testid="approvals-empty">
              <p className="text-body text-label-primary">{t("agent.approvals.nothingNeedsYou")}</p>
              <p className="text-callout text-label-secondary">
                {t("agent.sheet.nothingHint", { name: persona.name })}
              </p>
            </div>
          ) : null
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
                  parentThreadTitle={
                    task?.specialist
                      ? (threads[task.specialist.parentThreadId]?.thread.title ?? null)
                      : null
                  }
                  otherSurfaces={v.approval.surfaces.filter((s) => s !== "desktop" && s !== "web")}
                  onAnswer={(d, scope) => answer(v.approval.id, d, scope)}
                  now={now}
                />
              );
            })}
          </div>
        )}
      </section>

      {questions.open.length > 0 ? (
        <section aria-labelledby="approvals-questions" className="flex flex-col gap-1">
          <h3 id="approvals-questions" className="text-title-3 text-label-primary">
            {t("agent.sheet.questions", { n: questions.open.length })}
          </h3>
          <ul className="flex flex-col">
            {questions.open.map((q) => {
              const text = q.questions[0]?.question ?? t("agent.activity.waitingAnswer");
              return (
                <li key={q.id}>
                  <Row
                    glyph="waiting"
                    glyphLabel={t("agent.activity.waitingAnswer")}
                    title={text}
                    detail={t("agent.sheet.answerInChat")}
                    trailing={formatRelative(q.createdAt, now)}
                    {...(slots.navigate
                      ? { onOpen: () => slots.navigate?.(`/chat/${q.threadId}`), openLabel: text }
                      : {})}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {deferred.length > 0 ? (
        <section aria-labelledby="approvals-deferred" className="flex scroll-mt-2 flex-col gap-2">
          <h3 id="approvals-deferred" className="text-title-3 text-label-primary">
            {t("agent.approvals.deferredCount", { n: deferred.length })}
          </h3>
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
                      onClick={() => slots.navigate?.("/overview#now")}
                    >
                      {t("agent.approvals.openTask")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-col gap-1">
        <Disclosure
          id="approvals-grants"
          label={t("agent.sheet.standing")}
          count={standing.length}
          open={grantsOpen}
          onOpenChange={setGrantsOpen}
        >
          {standing.length === 0 ? (
            <p className="ps-5.5 py-1 text-callout text-label-secondary">
              {t("agent.sheet.noGrants")}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-separator ps-5.5 text-body">
              {standing.map((g) => (
                <li key={g.id} className="flex items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate">{grantSubject(g)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={revoking.has(g.id)}
                    aria-label={t("settings.permissions.revokeNamed", { name: grantSubject(g) })}
                    onClick={() => revoke(g)}
                  >
                    {t("settings.devices.revoke")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Disclosure>

        <div ref={decidedRef}>
          <Disclosure
            id="decided"
            label={t("agent.sheet.decidedRecently")}
            count={recentList.length}
            open={decidedOpen}
            onOpenChange={setDecidedOpen}
          >
            {recentList.length === 0 ? (
              <p className="ps-5.5 py-1 text-callout text-label-secondary">
                {t("agent.approvals.noRecent")}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-separator ps-5.5 text-body">
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
            <a
              href={overview.href}
              onClick={overview.onClick}
              className="ms-5.5 mt-1 inline-block rounded-sm text-callout text-accent-11 underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("agent.sheet.fullHistory")}
            </a>
          </Disclosure>
        </div>
      </div>
    </div>
  );
}
