import type { SpaceSummary } from "@psyche/protocol";
import { ChevronRight, Plus } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { useNow } from "../lib/use-now.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { NewSpaceDialog } from "./NewSpaceDialog.tsx";
import { byRecentActivity, spaceHref, spaceLine, useSpaces } from "./use-spaces.ts";

/** Home shows the four most recently active Spaces. */
export const HOME_SPACES_LIMIT = 4;

/** One Space as a row: its name, a second line made by code, and a chevron. */
export function SpaceRow({
  space,
  now,
  onOpen,
}: {
  space: SpaceSummary;
  now: number;
  onOpen: (space: SpaceSummary) => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={t("spaces.open", { name: space.name })}
      onClick={() => onOpen(space)}
      className="flex min-h-11 w-full cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 text-start outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-label-primary">{space.name}</span>
        <span className="truncate text-callout text-label-secondary">{spaceLine(space, now)}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-label-tertiary rtl:rotate-180" aria-hidden />
    </button>
  );
}

/**
 * Home's Spaces section (docs/design/spaces-2026.md §7.1), after Pinned: the four most recently
 * active Spaces, "All Spaces" and "+". Private Spaces never show here, and a Home with no Space
 * does not draw the section (⌘K and the chat's Space menu make the first one).
 */
export function HomeSpacesSection({
  onNavigate,
  now: fixedNow,
}: {
  onNavigate: (to: string) => void;
  now?: number;
}): ReactElement | null {
  const { spaces } = useSpaces();
  const now = useNow(60_000, fixedNow);
  const [adding, setAdding] = useState(false);
  const shown = byRecentActivity(spaces.filter((s) => !s.private && s.archivedAt == null)).slice(
    0,
    HOME_SPACES_LIMIT,
  );
  if (shown.length === 0) return null;
  return (
    <ScreenSection
      id="spaces"
      title={t("spaces.title")}
      large
      description={t("spaces.hint")}
      actions={
        <>
          <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate("/spaces")}>
            {t("spaces.all")}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("spaces.new")}
            title={t("spaces.new")}
            onClick={() => setAdding(true)}
          >
            <Plus aria-hidden="true" />
          </Button>
        </>
      }
    >
      <ul
        aria-label={t("spaces.list.label")}
        className="flex flex-col rounded-lg bg-surface-raised p-1 shadow-elevation-1"
      >
        {shown.map((space) => (
          <li key={space.id}>
            <SpaceRow space={space} now={now} onOpen={(s) => onNavigate(spaceHref(s.id))} />
          </li>
        ))}
      </ul>
      <NewSpaceDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(id) => onNavigate(spaceHref(id))}
      />
    </ScreenSection>
  );
}
