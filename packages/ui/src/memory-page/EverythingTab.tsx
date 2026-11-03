import { MEMORY_REVIEW_ROUTE } from "@psyche/protocol";
import type { ReactElement } from "react";
import { GroupedList } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import { useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { usePersona } from "../slots.tsx";
import { EntityRows, Quiet, UpcomingList } from "./KindTabs.tsx";
import { type MemoryKind, memoryHref } from "./kinds.ts";

const ACTIVE_SHOWN = 5;
const PEOPLE_SHOWN = 6;
const EVENTS_SHOWN = 5;

function SeeAll({ kind, onNavigate }: { kind: MemoryKind; onNavigate: (to: string) => void }) {
  return (
    <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate(memoryHref(kind))}>
      {t("memory.page.seeAll")}
    </Button>
  );
}

/**
 * Everything: a short overview that shows a section only when the existing `memory.entities.*`
 * methods give it something (docs/design/memory-everything-2026.md §6.2). Work due and Recently
 * learned join it when their stores exist.
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

  const active = (projects.data?.entities ?? []).filter(
    (e) => !e.isOwner && (e.projectStatus ?? "active") === "active",
  );
  const inTouch = (people.data?.entities ?? [])
    .filter((e) => !e.isOwner && e.lastInteractionAt !== null)
    .sort((a, b) => (b.lastInteractionAt ?? "").localeCompare(a.lastInteractionAt ?? ""));
  const upcoming = coming.data?.items ?? [];
  const loading = projects.loading || people.loading || coming.loading;

  if (pending === 0 && active.length === 0 && inTouch.length === 0 && upcoming.length === 0) {
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
