import type { ComingUpItem, GraphEntityKind, GraphProjectStatus } from "@psyche/protocol";
import { CalendarClock } from "lucide-react";
import { type ReactElement, useState } from "react";
import { EmptyState, GroupedList } from "../components/page.tsx";
import { useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { EntityRow } from "../people/EntityRow.tsx";
import type { EntitySummary } from "../people/types.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { SegmentedRadio } from "../screens/settings/SegmentedRadio.tsx";
import { usePersona } from "../slots.tsx";
import { entityHref } from "./kinds.ts";

/** The quiet line in a list with nothing in it. */
export function Quiet({ children }: { children: string }): ReactElement {
  return <p className="px-3 py-2 text-body text-label-secondary">{children}</p>;
}

/** Rows for entities, each opening its page in the Memory page. */
export function EntityRows({
  entities,
  now,
  onNavigate,
}: {
  entities: readonly EntitySummary[];
  now: number;
  onNavigate: (to: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-col p-1">
      {entities.map((e) => (
        <EntityRow key={e.id} entity={e} now={now} onOpen={(x) => onNavigate(entityHref(x.id))} />
      ))}
    </div>
  );
}

/** Dates coming up, each opening the person or event it is about. */
export function UpcomingList({
  items,
  onNavigate,
}: {
  items: readonly ComingUpItem[];
  onNavigate: (to: string) => void;
}): ReactElement {
  return (
    <ul className="flex flex-col p-1">
      {items.map((i) => (
        <li key={`${i.entityId}-${i.kind}-${i.date}`}>
          <button
            type="button"
            onClick={() => onNavigate(entityHref(i.entityId))}
            className="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-start outline-none transition-colors duration-(--duration-micro) hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1 truncate text-body text-label-primary">{i.text}</span>
            <span className="shrink-0 text-callout text-label-secondary tabular-nums">
              {t("memory.page.events.when", { n: i.daysAway })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const STATUSES: readonly GraphProjectStatus[] = ["active", "paused", "done"];

/** Projects, filtered by status. */
export function ProjectsTab({
  now,
  onNavigate,
}: {
  now: number;
  onNavigate: (to: string) => void;
}): ReactElement {
  const [status, setStatus] = useState<GraphProjectStatus>("active");
  const found = useGatewayQuery("memory.entities.search", {
    q: "",
    kinds: ["project"],
    limit: 100,
  });
  const rows = (found.data?.entities ?? []).filter(
    (e) => !e.isOwner && (e.projectStatus ?? "active") === status,
  );
  return (
    <section aria-label={t("memory.page.kind.projects")} className="flex flex-col gap-3">
      <SegmentedRadio
        label={t("memory.page.projects.filter")}
        value={status}
        onChange={setStatus}
        className="self-start"
        options={STATUSES.map((s) => ({ value: s, label: t(`people.project.status.${s}`) }))}
      />
      <GroupedList>
        {rows.length === 0 ? (
          found.loading ? null : (
            <Quiet>{t("memory.page.projects.empty")}</Quiet>
          )
        ) : (
          <EntityRows entities={rows} now={now} onNavigate={onNavigate} />
        )}
      </GroupedList>
    </section>
  );
}

/** Assignments and deadlines. There is no store for them yet, so this is a calm empty page. */
export function DueTab(): ReactElement {
  const persona = usePersona();
  return (
    <section aria-label={t("memory.page.kind.due")} data-testid="memory-due">
      <EmptyState icon={CalendarClock} className="pt-[8vh]">
        <span className="block text-headline text-label-primary">{t("memory.page.due.title")}</span>
        {t("memory.page.due.body", { persona: persona.name })}
      </EmptyState>
    </section>
  );
}

/** Upcoming birthdays, anniversaries and events, then the event entities. */
export function EventsTab({
  now,
  onNavigate,
}: {
  now: number;
  onNavigate: (to: string) => void;
}): ReactElement {
  const coming = useGatewayQuery("memory.upcoming", { days: 366 });
  const events = useGatewayQuery("memory.entities.search", {
    q: "",
    kinds: ["event"],
    limit: 50,
  });
  const upcoming = coming.data?.items ?? [];
  const other = (events.data?.entities ?? []).filter((e) => !e.isOwner);
  const loading = coming.loading || events.loading;
  return (
    <section aria-label={t("memory.page.kind.events")} className="flex flex-col gap-6">
      {upcoming.length === 0 && other.length === 0 && !loading ? (
        <GroupedList>
          <Quiet>{t("memory.page.events.empty")}</Quiet>
        </GroupedList>
      ) : null}
      {upcoming.length > 0 ? (
        <ScreenSection id="memory-upcoming" title={t("memory.page.events.upcoming")}>
          <GroupedList>
            <UpcomingList items={upcoming} onNavigate={onNavigate} />
          </GroupedList>
        </ScreenSection>
      ) : null}
      {other.length > 0 ? (
        <ScreenSection id="memory-events" title={t("memory.page.events.other")}>
          <GroupedList>
            <EntityRows entities={other} now={now} onNavigate={onNavigate} />
          </GroupedList>
        </ScreenSection>
      ) : null}
    </section>
  );
}

const MORE_KINDS: readonly Extract<GraphEntityKind, "place" | "org" | "topic">[] = [
  "place",
  "org",
  "topic",
];

/** Places, organizations and topics. */
export function MoreTab({
  now,
  onNavigate,
}: {
  now: number;
  onNavigate: (to: string) => void;
}): ReactElement {
  const found = useGatewayQuery("memory.entities.search", {
    q: "",
    kinds: [...MORE_KINDS],
    limit: 100,
  });
  const rows = (found.data?.entities ?? []).filter((e) => !e.isOwner);
  return (
    <section aria-label={t("memory.page.kind.more")} className="flex flex-col gap-6">
      {rows.length === 0 && !found.loading ? (
        <GroupedList>
          <Quiet>{t("memory.page.more.empty")}</Quiet>
        </GroupedList>
      ) : null}
      {MORE_KINDS.map((kind) => {
        const group = rows.filter((e) => e.kind === kind);
        return group.length === 0 ? null : (
          <ScreenSection key={kind} id={`memory-${kind}`} title={t(`memory.page.more.${kind}`)}>
            <GroupedList>
              <EntityRows entities={group} now={now} onNavigate={onNavigate} />
            </GroupedList>
          </ScreenSection>
        );
      })}
    </section>
  );
}
