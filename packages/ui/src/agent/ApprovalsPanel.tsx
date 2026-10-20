import type { ReactElement } from "react";
import { ApprovalCard } from "../blocks/ApprovalCard.tsx";
import { useApprovals, useGatewayQuery, useStoreState } from "../data/index.ts";
import { displaySummary } from "../lib/cards.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { usePersona, useSlots } from "../slots.tsx";

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

function decidedWhere(by: unknown): string {
  if (by !== null && typeof by === "object") {
    if ("surface" in by && typeof by.surface === "string") return ` on ${by.surface}`;
    if ("channel" in by && typeof by.channel === "string") return ` on ${by.channel}`;
  }
  return "";
}

/**
 * Agent sheet → Approvals (UI design §3.15): Needs you (full cards, newest first), Deferred
 * (unattended runs that could not ask), Recent (7 days, who answered where), Standing grants.
 */
export function ApprovalsPanel({ now: fixedNow }: { now?: number }): ReactElement {
  const now = useNow(1000, fixedNow);
  const { pending, recent, answer, loading } = useApprovals();
  const tasks = useStoreState((s) => s.tasks);
  const persona = usePersona();
  const slots = useSlots();
  const grants = useGatewayQuery("grants.list", {});
  const standing = (grants.data?.grants ?? []).filter((g) => g.revokedAt == null);
  const live = pending.filter(
    (v) =>
      !(
        v.approval.requestedBy.taskId &&
        tasks[v.approval.requestedBy.taskId]?.createdFrom === "automation" &&
        !v.canAnswer
      ),
  );
  const deferred = pending.filter((v) => !live.includes(v));
  const recentList = recent.filter(
    (v) => now - Date.parse(v.approval.decidedAt ?? v.approval.requestedAt) < RECENT_MS,
  );

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="approvals-needs-you">
        <h3 id="approvals-needs-you" className="text-label mb-2 text-muted-foreground">
          Needs you ({live.length})
        </h3>
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {loading ? "Loading…" : "Nothing needs you."}
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

      {deferred.length > 0 ? (
        <section aria-labelledby="approvals-deferred">
          <h3 id="approvals-deferred" className="text-label mb-2 text-muted-foreground">
            Deferred ({deferred.length})
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {deferred.map((v) => (
              <li key={v.approval.id}>
                {tasks[v.approval.requestedBy.taskId ?? ""]?.title ?? "An automation"} wanted to:{" "}
                {displaySummary(v.approval)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="approvals-recent">
        <h3 id="approvals-recent" className="text-label mb-2 text-muted-foreground">
          Recent
        </h3>
        {recentList.length === 0 ? (
          <p className="text-sm text-muted-foreground">No decisions in the last 7 days.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-gray-4 text-sm">
            {recentList.map((v) => (
              <li key={v.approval.id} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate">{displaySummary(v.approval)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {v.approval.status === "approved"
                    ? `Approved${decidedWhere(v.approval.decidedBy)}`
                    : v.approval.status === "denied"
                      ? `Denied${decidedWhere(v.approval.decidedBy)}`
                      : v.approval.status === "expired"
                        ? "Expired"
                        : "Voided"}
                  {v.approval.decidedAt ? ` · ${formatRelative(v.approval.decidedAt, now)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="approvals-grants" className="flex items-center gap-2 text-sm">
        <h3 id="approvals-grants" className="text-label text-muted-foreground">
          Standing grants
        </h3>
        <span>{standing.length}</span>
        <button
          type="button"
          className="ml-auto text-accent-11 hover:underline"
          onClick={() => slots.navigate?.("/settings/permissions")}
        >
          Review in Permissions
        </button>
      </section>
    </div>
  );
}
