import { MEMORY_REVIEW_ROUTE } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { useGatewayQuery } from "../data/hooks.ts";
import { KeepInTouchSection } from "../home/sections.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { PeopleSheetSection } from "../people/PeopleSheetSection.tsx";
import { ScreenColumn, ScreenToolbar, ToolbarLabel } from "../screens/feed/ScreenToolbar.tsx";
import { useSlots } from "../slots.tsx";
import { EntityPage } from "./EntityPage.tsx";
import { EverythingTab } from "./EverythingTab.tsx";
import { DueTab, EventsTab, MoreTab, ProjectsTab } from "./KindTabs.tsx";
import { entityHref, MEMORY_KINDS, type MemoryKind, memoryHref } from "./kinds.ts";
import { ReviewTab } from "./ReviewTab.tsx";

export interface MemoryScreenProps {
  /** `/memory?kind=<chip>`; Everything when absent. */
  kind?: MemoryKind;
  /** `/memory?entity=<id>` opens that item's page. */
  entity?: string;
  /** `/memory/review`: the review queue, a tab at the end of the chip row. */
  view?: "review";
  onNavigate?: (to: string) => void;
  now?: number;
}

/**
 * Memory (docs/design/memory-everything-2026.md §6): everything Psyche remembers, by kind. It
 * took over the sidebar's People row. The People chip is the old People page as it was, Keep in
 * touch included; Work due is empty until the work store exists. Review (the facts waiting for an
 * OK) is a link at the end of the chip row.
 */
export function MemoryScreen({
  kind = "everything",
  entity,
  view,
  onNavigate,
  now = Date.now(),
}: MemoryScreenProps): ReactElement {
  const { navigate: slotNavigate } = useSlots();
  const navigate = onNavigate ?? slotNavigate ?? (() => {});
  const queue = useGatewayQuery("memory.review.list", { state: ["pending"], limit: 200 });
  const pending = queue.data?.counts.pending ?? 0;
  const reviewing = view === "review" && !entity;

  return (
    <section aria-label={t("memory.page.title")} data-testid="memory">
      <ScreenToolbar
        title={t("memory.page.title")}
        actions={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            title={t("memory.page.soul")}
            onClick={() => navigate("/agent/soul")}
          >
            <ToolbarLabel>{t("memory.page.soul")}</ToolbarLabel>
          </Button>
        }
      />
      <ScreenColumn width="wide" className="gap-6">
        {entity ? (
          <EntityPage id={entity} now={now} onNavigate={navigate} />
        ) : (
          <>
            <nav
              aria-label={t("memory.page.kinds")}
              className="flex flex-wrap items-center gap-1"
              data-testid="memory-kinds"
            >
              {MEMORY_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-current={k === kind && !reviewing ? "page" : undefined}
                  onClick={() => navigate(memoryHref(k))}
                  className={cn(
                    "h-7 rounded-full px-3 text-callout outline-none transition-colors duration-(--duration-micro) focus-visible:ring-2 focus-visible:ring-ring",
                    k === kind && !reviewing
                      ? "bg-selection text-label-primary"
                      : "text-label-secondary hover:bg-fill-quaternary",
                  )}
                >
                  {t(`memory.page.kind.${k}`)}
                </button>
              ))}
              <button
                type="button"
                aria-current={reviewing ? "page" : undefined}
                aria-label={
                  pending > 0 ? t("memory.page.reviewWaiting", { n: pending }) : undefined
                }
                onClick={() => navigate(MEMORY_REVIEW_ROUTE)}
                className={cn(
                  "ms-auto flex h-7 items-center gap-1.5 rounded-full px-3 text-callout outline-none transition-colors duration-(--duration-micro) focus-visible:ring-2 focus-visible:ring-ring",
                  reviewing
                    ? "bg-selection text-label-primary"
                    : "text-label-secondary hover:bg-fill-quaternary",
                )}
              >
                {t("memory.page.review")}
                {pending > 0 ? (
                  <span
                    data-testid="memory-review-count"
                    className={cn(
                      "min-w-5 rounded-full px-1.5 text-center text-caption tabular-nums text-approval",
                      reviewing ? "bg-surface-raised" : "bg-approval-bg",
                    )}
                    aria-hidden="true"
                  >
                    {pending}
                  </span>
                ) : null}
              </button>
            </nav>
            {reviewing ? (
              <ReviewTab now={now} onPendingChange={queue.reload} />
            ) : kind === "people" ? (
              <div className="flex flex-col gap-8">
                <KeepInTouchSection onNavigate={navigate} limit={5} showPeopleLink={false} />
                <PeopleSheetSection
                  page
                  now={now}
                  onOpenEntity={(id) => navigate(entityHref(id))}
                />
              </div>
            ) : kind === "projects" ? (
              <ProjectsTab now={now} onNavigate={navigate} />
            ) : kind === "due" ? (
              <DueTab />
            ) : kind === "events" ? (
              <EventsTab now={now} onNavigate={navigate} />
            ) : kind === "more" ? (
              <MoreTab now={now} onNavigate={navigate} />
            ) : (
              <EverythingTab now={now} pending={pending} onNavigate={navigate} />
            )}
          </>
        )}
      </ScreenColumn>
    </section>
  );
}
