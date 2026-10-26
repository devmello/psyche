import type { SpecialistJob, SpecialistRole } from "@psyche/protocol";
import { type ReactElement, useId } from "react";
import { useSpecialistJobs, useSpecialistRoles } from "../data/specialists.ts";
import { t } from "../i18n/core.ts";
import { formatRelative } from "../lib/format.ts";
import { ListItem } from "../motion/index.ts";
import { useSpecialistActions } from "./InboxRow.tsx";
import { FINISHED, roleGlyph, roleLabel } from "./model.ts";
import { SpecialistResultCard } from "./ResultCard.tsx";

/** Results stay in the Feed for a day; the Inbox keeps them. */
const FEED_WINDOW_MS = 24 * 60 * 60 * 1000;

function FeedResult({
  job,
  roles,
  now,
}: {
  job: SpecialistJob;
  roles: readonly SpecialistRole[];
  now: number;
}): ReactElement {
  const titleId = useId();
  const role = roles.find((r) => r.role === job.role);
  const label = roleLabel(job.role, roles);
  const Glyph = roleGlyph(job.role);
  const actions = useSpecialistActions(job);
  return (
    <article
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg bg-surface-raised p-4 shadow-elevation-1"
    >
      <header className="flex items-center gap-2">
        <Glyph className="size-4 shrink-0 text-label-secondary" aria-hidden="true" />
        <h3 id={titleId} className="min-w-0 flex-1 truncate text-headline text-label-primary">
          {job.title}
        </h3>
        <span className="shrink-0 text-subheadline text-label-tertiary">
          {label} · {formatRelative(job.updatedAt, now)}
        </span>
      </header>
      <SpecialistResultCard
        job={job}
        roleLabel={label}
        {...(role ? { resultKind: role.result } : {})}
        {...actions}
      />
    </article>
  );
}

/**
 * Specialists' results in the Feed (docs/agent/specialists-2026.md §6.2): only when the owner
 * turned "Show specialist results in Feed" on, and only the last day's. The Inbox is the delivery.
 */
export function FeedSpecialistResults({ now }: { now: number }): ReactElement | null {
  const headingId = useId();
  const { jobs } = useSpecialistJobs({ status: [...FINISHED] });
  const { roles } = useSpecialistRoles();
  const recent = jobs.filter(
    (j) => j.result != null && now - Date.parse(j.updatedAt) < FEED_WINDOW_MS,
  );
  if (recent.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="mb-5 flex flex-col gap-2">
      <h2 id={headingId} className="px-1 text-title-3 text-label-primary">
        {t("specialists.feed.title")}
      </h2>
      <ul className="flex flex-col gap-3">
        {recent.map((job, i) => (
          <ListItem key={job.taskId} index={i}>
            <FeedResult job={job} roles={roles} now={now} />
          </ListItem>
        ))}
      </ul>
    </section>
  );
}
