import { BrainCircuit } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { KeepInTouchSection } from "../home/sections.tsx";
import { t } from "../i18n/core.ts";
import { ScreenColumn, ScreenToolbar, ToolbarLabel } from "../screens/feed/ScreenToolbar.tsx";
import { useSlots } from "../slots.tsx";
import { PeopleSheetSection } from "./PeopleSheetSection.tsx";

export interface PeopleScreenProps {
  /** `/people?entity=<id>` opens that person's or project's card. */
  initialEntity?: string;
  onNavigate?: (to: string) => void;
}

/**
 * People (docs/design/consolidation-2026.md §3.2): the people and projects Psyche knows, at page
 * width, with Keep in touch above them when relationship nudges are on. It used to be a section
 * of Soul & Memory; the persona files and memory controls stay there (the toolbar links to them).
 */
export function PeopleScreen({ initialEntity, onNavigate }: PeopleScreenProps): ReactElement {
  const { navigate: slotNavigate } = useSlots();
  const navigate = onNavigate ?? slotNavigate ?? (() => {});
  return (
    <section aria-label={t("people.page.title")} data-testid="people">
      <ScreenToolbar
        title={t("people.page.title")}
        actions={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            title={t("people.page.memory")}
            onClick={() => navigate("/agent/soul")}
          >
            <BrainCircuit aria-hidden="true" />
            <ToolbarLabel>{t("people.page.memory")}</ToolbarLabel>
          </Button>
        }
      />
      <ScreenColumn width="wide" className="gap-8">
        <KeepInTouchSection onNavigate={navigate} limit={5} showPeopleLink={false} />
        <PeopleSheetSection page {...(initialEntity ? { initialEntity } : {})} />
      </ScreenColumn>
    </section>
  );
}
