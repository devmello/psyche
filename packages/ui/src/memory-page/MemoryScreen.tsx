import { MEMORY_REVIEW_ROUTE } from "@psyche/protocol";
import { MoreHorizontal, Search } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Input } from "../components/ui/input.tsx";
import { useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { PeopleSheetSection } from "../people/PeopleSheetSection.tsx";
import { ScreenColumn, ScreenToolbar } from "../screens/feed/ScreenToolbar.tsx";
import { useSlots } from "../slots.tsx";
import { EntityPage } from "./EntityPage.tsx";
import { EverythingTab } from "./EverythingTab.tsx";
import { EventsTab, MoreTab, ProjectsTab } from "./KindTabs.tsx";
import { entityHref, MEMORY_MAP_ROUTE, type MemoryKind, memoryHref } from "./kinds.ts";
import { MemoryMapView } from "./map/MemoryMapView.tsx";
import { ReviewTab } from "./ReviewTab.tsx";
import { WorkDueTab } from "./WorkDue.tsx";

export interface MemoryScreenProps {
  /** `/memory?kind=<kind>`; People when absent. */
  kind?: MemoryKind;
  /** `/memory?entity=<id>` opens that item's page. */
  entity?: string;
  /** `/memory/review`: the review queue; `/memory?view=map`: the map. Both are in the "…" menu. */
  view?: "review" | "map";
  /** `?add=1` on Work due or Projects: open with the add form showing (⌘K's Add to-do, Add project). */
  startAdding?: boolean;
  onNavigate?: (to: string) => void;
  now?: number;
}

/** The kinds with a segment; the rest (Events, More, Everything) are in the "…" menu. */
const SEGMENT_KINDS = ["people", "projects", "due"] as const;

/**
 * Memory (docs/design/memory-everything-2026.md §6): everything Psyche remembers, by kind. The
 * toolbar is the title, a People | Projects | Work control, search and a "…" menu that holds Map,
 * Soul, Review (with its count), Events, More and Everything. People is the default; Keep in
 * touch lives on Home.
 */
export function MemoryScreen({
  kind = "people",
  entity,
  view,
  startAdding = false,
  onNavigate,
  now = Date.now(),
}: MemoryScreenProps): ReactElement {
  const { navigate: slotNavigate } = useSlots();
  const navigate = onNavigate ?? slotNavigate ?? (() => {});
  const queue = useGatewayQuery("memory.review.list", { state: ["pending"], limit: 200 });
  const pending = queue.data?.counts.pending ?? 0;
  const reviewing = view === "review" && !entity;
  const mapping = view === "map" && !entity;
  const searchId = useId();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  return (
    <section aria-label={t("memory.page.title")} data-testid="memory">
      <ScreenToolbar
        title={t("memory.page.title")}
        center={
          <Segments
            current={reviewing || mapping || entity ? null : kind}
            onChange={(k) => navigate(memoryHref(k))}
          />
        }
        actions={
          <>
            <div className="relative w-40 @max-md/toolbar:hidden">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-label-tertiary"
              />
              <label htmlFor={searchId} className="sr-only">
                {t("memory.page.search")}
              </label>
              <Input
                id={searchId}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("memory.page.search")}
                className="h-7 ps-7 text-callout"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("memory.page.moreMenu")}
                    className="text-label-secondary"
                  />
                }
              >
                <MoreHorizontal aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => navigate(MEMORY_MAP_ROUTE)}>
                  {t("memory.page.view.map")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate("/agent/soul")}>
                  {t("memory.page.soul")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate(MEMORY_REVIEW_ROUTE)}>
                  {pending > 0
                    ? t("memory.page.reviewWaiting", { n: pending })
                    : t("memory.page.review")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate(memoryHref("events"))}>
                  {t("memory.page.kind.events")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate(memoryHref("more"))}>
                  {t("memory.page.kind.more")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate(memoryHref("everything"))}>
                  {t("memory.page.kind.everything")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <ScreenColumn width="wide" className="gap-6">
        {entity ? (
          <EntityPage id={entity} now={now} onNavigate={navigate} />
        ) : mapping ? (
          <MemoryMapView onOpen={(id) => navigate(entityHref(id))} />
        ) : reviewing ? (
          <ReviewTab now={now} onPendingChange={queue.reload} />
        ) : kind === "people" ? (
          <PeopleSheetSection
            page
            query={query}
            now={now}
            onOpenEntity={(id) => navigate(entityHref(id))}
          />
        ) : kind === "projects" ? (
          <ProjectsTab now={now} onNavigate={navigate} startAdding={startAdding} query={q} />
        ) : kind === "due" ? (
          <WorkDueTab now={now} onNavigate={navigate} startAdding={startAdding} />
        ) : kind === "events" ? (
          <EventsTab now={now} onNavigate={navigate} />
        ) : kind === "more" ? (
          <MoreTab now={now} onNavigate={navigate} />
        ) : (
          <EverythingTab now={now} pending={pending} onNavigate={navigate} />
        )}
      </ScreenColumn>
    </section>
  );
}

/** People | Projects | Work: one segmented control; the other kinds are in the "…" menu. */
function Segments({
  current,
  onChange,
}: {
  current: MemoryKind | null;
  onChange: (kind: MemoryKind) => void;
}): ReactElement {
  return (
    <fieldset
      aria-label={t("memory.page.kinds")}
      className="m-0 flex min-w-0 items-center rounded-full border-0 bg-fill-quaternary p-0.5"
      data-testid="memory-kinds"
    >
      {SEGMENT_KINDS.map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={current === k}
          onClick={() => current !== k && onChange(k)}
          className={cn(
            "h-6 rounded-full px-3 text-callout outline-none transition-colors duration-(--duration-micro) focus-visible:ring-2 focus-visible:ring-ring",
            current === k
              ? "bg-surface-raised text-label-primary shadow-elevation-1"
              : "text-label-secondary",
          )}
        >
          {t(k === "due" ? "memory.page.kind.work" : `memory.page.kind.${k}`)}
        </button>
      ))}
    </fieldset>
  );
}
