import { MEMORY_REVIEW_ROUTE } from "@psyche/protocol";
import type { ReactElement } from "react";
import { GroupedList } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import { useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { usePersona } from "../slots.tsx";
import { EntityRows, Quiet, UpcomingList } from "./KindTabs.tsx";
import { entityHref, type MemoryKind, memoryHref } from "./kinds.ts";
import { WorkRow } from "./WorkRow.tsx";
import { isClosed } from "./work.ts";
import { useAssignments, useWorkWrites } from "./work-hooks.ts";

const ACTIVE_SHOWN = 5;
const PEOPLE_SHOWN = 6;
const EVENTS_SHOWN = 5;
const DUE_SHOWN = 5;

function SeeAll({ kind, onNavigate }: { kind: MemoryKind; onNavigate: (to: string) => void }) {
  return (
    <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate(memoryHref(kind))}>
      {t("memory.page.seeAll")}
    </Button>
  );
}

/**
 * Everything: a short overview that shows a section only when the existing `memory.entities.*`
 * methods give it something (docs/design/memory-everything-2026.md §6.2): To review, Due soon
 * (the top five of Work due), active projects, people and Coming up. Recently learned joins it
 * when its store exists.
 */
export function EverythingTab({
  now,
  pending,
  onNavigate,
}: {
  now: number;
  /** Facts waiting for the owner's OK (the Review link's count). */
  pending: number;
  onNavigate: (to: string) => void;
}): ReactElement | null {
  const persona = usePersona();
  const projects = useGatewayQuery("memory.entities.search", {
    q: "",
    kinds: ["project"],
    limit: 100,
  });
  const people = useGatewayQuery("memory.entities.search", {
    q: "",
    kinds: ["person"],
    limit: 30,
  });
  const coming = useGatewayQuery("memory.upcoming", { days: 30 });
  const work = useAssignments();
  const writes = useWorkWrites();

  const active = (projects.data?.entities ?? []).filter(
    (e) => !e.isOwner && (e.projectStatus ?? "active") === "active",
  );
  const inTouch = (people.data?.entities ?? [])
    .filter((e) => !e.isOwner && e.lastInteractionAt !== null)
    .sort((a, b) => (b.lastInteractionAt ?? "").localeCompare(a.lastInteractionAt ?? ""));
  const upcoming = coming.data?.items ?? [];
  // What is still owed, soonest first (past due leads); an item with no date is not "soon", and
  // a handed-in one needs nothing more.
  const dueSoon = work.assignments
    .filter((a) => a.dueAt != null && !isClosed(a.workStatus) && a.workStatus !== "submitted")
    .sort((a, b) => Date.parse(a.dueAt ?? "") - Date.parse(b.dueAt ?? ""))
    .slice(0, DUE_SHOWN);
  const loading = projects.loading || people.loading || coming.loading || work.loading;

  if (
    pending === 0 &&
    dueSoon.length === 0 &&
    active.length === 0 &&
    inTouch.length === 0 &&
    upcoming.length === 0
  ) {
    return loading ? null : (
      <GroupedList>
        <Quiet>{t("memory.page.everything.empty", { persona: persona.name })}</Quiet>
      </GroupedList>
    );
  }

  return (
    <div className="flex flex-col gap-8" data-testid="memory-everything">
      {pending > 0 ? (
        <ScreenSection
          id="memory-to-review"
          title={t("memory.page.everything.review")}
          needsYou
          actions={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onNavigate(MEMORY_REVIEW_ROUTE)}
            >
              {t("memory.page.review")}
            </Button>
          }
        >
          <GroupedList>
            <Quiet>{t("memory.page.everything.reviewCount", { n: pending })}</Quiet>
          </GroupedList>
        </ScreenSection>
      ) : null}
      {dueSoon.length > 0 ? (
        <ScreenSection
          id="memory-due-soon"
          title={t("memory.page.everything.due")}
          needsYou={dueSoon.some((a) => Date.parse(a.dueAt ?? "") < now)}
          actions={<SeeAll kind="due" onNavigate={onNavigate} />}
        >
          <GroupedList>
            {dueSoon.map((item) => (
              <WorkRow
                key={item.id}
                item={item}
                now={now}
                busy={writes.busy}
                onOpen={(id) => onNavigate(entityHref(id))}
                onSetStatus={(a, status) => void writes.setStatus(a, status)}
              />
            ))}
          </GroupedList>
        </ScreenSection>
      ) : null}
      {active.length > 0 ? (
        <ScreenSection
          id="memory-active-projects"
          title={t("memory.page.everything.projects")}
          actions={<SeeAll kind="projects" onNavigate={onNavigate} />}
        >
          <GroupedList>
            <EntityRows
              entities={active.slice(0, ACTIVE_SHOWN)}
              now={now}
              onNavigate={onNavigate}
            />
          </GroupedList>
        </ScreenSection>
      ) : null}
      {inTouch.length > 0 ? (
        <ScreenSection
          id="memory-in-touch"
          title={t("memory.page.everything.people")}
          actions={<SeeAll kind="people" onNavigate={onNavigate} />}
        >
          <GroupedList>
            <EntityRows
              entities={inTouch.slice(0, PEOPLE_SHOWN)}
              now={now}
              onNavigate={onNavigate}
            />
          </GroupedList>
        </ScreenSection>
      ) : null}
      {upcoming.length > 0 ? (
        <ScreenSection
          id="memory-coming-up"
          title={t("memory.page.everything.events")}
          actions={<SeeAll kind="events" onNavigate={onNavigate} />}
        >
          <GroupedList>
            <UpcomingList items={upcoming.slice(0, EVENTS_SHOWN)} onNavigate={onNavigate} />
          </GroupedList>
        </ScreenSection>
      ) : null}
    </div>
  );
}
