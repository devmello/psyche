import type {
  ComingUpItem,
  GraphEntityKind,
  GraphProjectStatus,
  GraphProjectType,
} from "@psyche/protocol";
import { Plus } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { toast } from "sonner";
import { GroupedList } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { EntityRow } from "../people/EntityRow.tsx";
import type { EntitySummary } from "../people/types.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { SegmentedRadio } from "../screens/settings/SegmentedRadio.tsx";
import { entityHref } from "./kinds.ts";
import { ProjectRow } from "./WorkRow.tsx";
import { useProjects, useWorkWrites } from "./work-hooks.ts";

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
const PROJECT_TYPES: readonly GraphProjectType[] = ["project", "course"];

/** One line to add a project or course (§6.2): a name and what it is; the rest is on its page. */
function AddProject({
  onAdded,
  onClose,
}: {
  onAdded: (id: string) => void;
  onClose: () => void;
}): ReactElement {
  const inputId = useId();
  const writes = useWorkWrites();
  const [name, setName] = useState("");
  const [type, setType] = useState<GraphProjectType>("project");
  const submit = async () => {
    const value = name.trim();
    if (value === "") return;
    const id = await writes.addProject({ name: value, projectType: type });
    if (id === null) return;
    toast(t("work.projects.added", { name: value }));
    onAdded(id);
  };
  return (
    <form
      aria-label={t("work.projects.label")}
      className="flex flex-col gap-2 rounded-lg bg-surface-raised p-3 shadow-elevation-1"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <label htmlFor={inputId} className="text-body text-label-primary">
        {t("work.projects.label")}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          autoFocus
          value={name}
          placeholder={t("work.projects.placeholder")}
          onChange={(e) => setName(e.target.value)}
          className="min-w-48 flex-1"
        />
        <SegmentedRadio
          label={t("work.projects.type")}
          value={type}
          onChange={setType}
          options={PROJECT_TYPES.map((p) => ({ value: p, label: t(`work.projects.type.${p}`) }))}
        />
        <Button type="submit" size="sm" disabled={writes.busy || name.trim() === ""}>
          {t("work.add.submit")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t("work.add.cancel")}
        </Button>
      </div>
      <p className="text-callout text-label-secondary">{t("work.projects.hint")}</p>
    </form>
  );
}

/**
 * Projects and courses, filtered Active / Paused / Done (§6.2). Each row shows its kind, status,
 * due date and a stale mark; Add makes a project or a course and opens its page.
 */
export function ProjectsTab({
  now,
  onNavigate,
}: {
  now: number;
  onNavigate: (to: string) => void;
}): ReactElement {
  const [status, setStatus] = useState<GraphProjectStatus>("active");
  const [adding, setAdding] = useState(false);
  const { projects, loading } = useProjects();
  const rows = projects.filter((e) => (e.projectStatus ?? "active") === status);
  return (
    <section
      aria-label={t("memory.page.kind.projects")}
      data-testid="memory-projects"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedRadio
          label={t("memory.page.projects.filter")}
          value={status}
          onChange={setStatus}
          options={STATUSES.map((s) => ({ value: s, label: t(`people.project.status.${s}`) }))}
        />
        {adding ? null : (
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            {t("work.projects.add")}
          </Button>
        )}
      </div>
      {adding ? (
        <AddProject
          onAdded={(id) => {
            setAdding(false);
            onNavigate(entityHref(id));
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
      <GroupedList>
        {rows.length === 0 ? (
          loading ? null : (
            <Quiet>{t("memory.page.projects.empty")}</Quiet>
          )
        ) : (
          <div className="flex flex-col p-1">
            {rows.map((p) => (
              <ProjectRow
                key={p.id}
                item={p}
                now={now}
                onOpen={(id) => onNavigate(entityHref(id))}
              />
            ))}
          </div>
        )}
      </GroupedList>
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
