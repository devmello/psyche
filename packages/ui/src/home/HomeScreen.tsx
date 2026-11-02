import { type ReactElement, useEffect, useState } from "react";
import { useNotifications } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { FeedScreen } from "../screens/feed/FeedScreen.tsx";
import { ScreenToolbar } from "../screens/feed/ScreenToolbar.tsx";
import { needsYou } from "../screens/inbox/InboxScreen.tsx";
import { useSlots } from "../slots.tsx";
import { PinnedWidgets } from "../widgets/PinnedWidgets.tsx";
import {
  AboutYouLink,
  ComingUpSection,
  GoalsSection,
  KeepInTouchSection,
  NeedsYouSection,
  SuggestionsSection,
} from "./sections.tsx";

export interface HomeScreenProps {
  /** The shell's `navigate`; defaults to the slot's. */
  onNavigate?: (to: string) => void;
  /** `/home/instructions`: the brief's instructions sheet is open over Home. */
  instructionsOpen?: boolean;
  /** Scrolls this section into view on arrival (`/home#today`). */
  anchor?: string;
  /** Fixed clock (stories, tests). */
  now?: number;
}

/**
 * Home (docs/design/consolidation-2026.md §3.1): what needs you and what is coming, on one page.
 * The main column is the day (Needs you, Pinned, Today's brief, Suggestions); the side column is
 * at a glance (Coming up, Goals, Keep in touch, and the way into "{persona} & you"). Each section
 * is the component its old page used, and a section with nothing to say is not drawn. Under
 * 896 px of content the columns stack, main first.
 */
export function HomeScreen({
  onNavigate,
  instructionsOpen,
  anchor,
  now,
}: HomeScreenProps): ReactElement {
  const { navigate: slotNavigate } = useSlots();
  const navigate = onNavigate ?? slotNavigate ?? (() => {});
  const [mountedAt] = useState(() => now ?? Date.now());
  // The accent goes to the first Approve when something waits; otherwise to the first idea.
  const waiting = needsYou(useNotifications().unresolved, now ?? mountedAt).length > 0;

  useEffect(() => {
    if (anchor === undefined) return;
    document.getElementById(anchor)?.scrollIntoView?.({ block: "start" });
  }, [anchor]);

  const clock = now === undefined ? {} : { now };
  return (
    <div className="@container/home flex min-h-0 flex-1 flex-col" data-testid="home">
      <ScreenToolbar
        title={t("home.title")}
        meta={activeI18n().date(mountedAt, { weekday: "long", month: "long", day: "numeric" })}
      />
      <div className="mx-auto grid w-full max-w-[calc(1120px+3rem)] gap-8 px-4 pt-4 pb-12 md:px-6 @4xl/home:grid-cols-[minmax(0,1fr)_20rem] @4xl/home:gap-10">
        <div className="flex min-w-0 flex-col gap-8">
          <NeedsYouSection onNavigate={navigate} {...clock} />
          <PinnedWidgets />
          <FeedScreen
            layout="section"
            onCloseInstructions={() => navigate("/home")}
            {...(instructionsOpen === undefined ? {} : { instructionsOpen })}
            {...clock}
          />
          <SuggestionsSection accent={!waiting} onNavigate={navigate} />
        </div>
        <aside aria-label={t("home.side")} className="flex min-w-0 flex-col gap-8">
          <ComingUpSection onNavigate={navigate} {...clock} />
          <GoalsSection onNavigate={navigate} />
          <KeepInTouchSection onNavigate={navigate} />
          <AboutYouLink onNavigate={navigate} />
        </aside>
      </div>
    </div>
  );
}
