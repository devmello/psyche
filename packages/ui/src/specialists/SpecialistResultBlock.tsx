import type { ReactElement } from "react";
import { Card, type CardStatusInfo } from "../blocks/card.tsx";
import { useSpecialistJob, useSpecialistRoles } from "../data/specialists.ts";
import { t } from "../i18n/core.ts";
import { useSpecialistActions } from "./InboxRow.tsx";
import { roleGlyph, roleLabel } from "./model.ts";
import { SpecialistResultCard } from "./ResultCard.tsx";

/** A job's status on the one card vocabulary (specialists §6.2 words map one to one). */
function statusOf(status: string): CardStatusInfo {
  switch (status) {
    case "queued":
      return { status: "pending" };
    case "working":
      return { status: "running" };
    case "needs_you":
      return { status: "waiting" };
    case "done":
      return { status: "done" };
    case "partial":
      return { status: "done", warning: true };
    case "failed":
      return { status: "failed" };
    default:
      return { status: "cancelled" };
  }
}

/**
 * A specialist's result in the thread that spawned it (chat-experience-2026 §4.5, decision 7).
 * It reads the job by id, so the card stays live (a retry, a late edit) and the Feed and Inbox
 * show the same result. Output class: a summary card here, the full run in the job's thread.
 */
export function SpecialistResultBlockView({ taskId }: { taskId: string }): ReactElement | null {
  const { job, loading } = useSpecialistJob(taskId);
  const { roles } = useSpecialistRoles();
  const actions = useSpecialistActions(job);
  if (job === null)
    return loading ? (
      <div
        className="my-2 h-12 max-w-md animate-pulse rounded-lg bg-gray-3"
        role="status"
        aria-label={t("blocks.message.loading", { what: "item" })}
      />
    ) : (
      <p className="my-1 text-sm text-muted-foreground">
        {t("blocks.message.missing", { what: "item" })}
      </p>
    );
  const label = roleLabel(job.role, roles);
  const role = roles.find((r) => r.role === job.role);
  const Glyph = roleGlyph(job.role);
  return (
    <Card
      label={t("specialists.block.label", { title: job.title, role: label })}
      icon={<Glyph />}
      title={job.title}
      status={statusOf(job.status)}
      meta={label}
      createdAt={job.updatedAt}
    >
      <SpecialistResultCard
        job={job}
        roleLabel={label}
        {...(role ? { resultKind: role.result } : {})}
        {...actions}
      />
    </Card>
  );
}
