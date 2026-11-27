import { type ReactElement, useEffect, useState } from "react";
import { activeI18n, t } from "../i18n/core.ts";
import { QuietThreadsSection } from "../mail-followups/QuietThreadsSection.tsx";
import { NightShiftSection } from "../night-shift/NightShiftSection.tsx";
import { ReviewSheet } from "../night-shift/ReviewSheet.tsx";
import { FeedScreen } from "../screens/feed/FeedScreen.tsx";
import { ScreenToolbar } from "../screens/feed/ScreenToolbar.tsx";
import { useSlots } from "../slots.tsx";
import { HomeSpacesSection } from "../spaces/HomeSpacesSection.tsx";
import { PinnedWidgets } from "../widgets/PinnedWidgets.tsx";
import { CatchUp } from "./CatchUp.tsx";
import { HelperPausedLine, MovedFactsNote } from "./HomeNotes.tsx";
import { useRouteRepeat } from "./route-repeat.ts";
import {
  AskSection,
  ComingUpSection,
  GoalsSection,
  HomeQuietLine,
  KeepInTouchSection,
  MORE_ANCHORS,
  MoreSection,
  NeedsYouSection,
  SuggestionsSection,
} from "./sections.tsx";
import { useCatchUp } from "./use-catch-up.ts";
import { useNeedsYou } from "./use-needs-you.ts";

export interface HomeScreenProps {
  /** The shell's `navigate`; defaults to the slot's. */
  onNavigate?: (to: string) => void;
  /** `/home/instructions`: the brief's instructions sheet is open over Home. */
  instructionsOpen?: boolean;
  /** Scrolls this section into view on arrival (`/home#today`). */
  anchor?: string;
  /**
   * Lands on this post of Today (`/home?post=<id>#today`, which `/feed/<postId>` becomes): opens
   * "Show more" when the post is hidden, scrolls to it and flashes it. A post that no longer
   * exists leaves the owner at Today.
   */
  post?: string;
  /**
   * `/home?review=<id>`: the Night shift review sheet is open over Home (`latest` is the review
   * waiting now). Closing it goes back to `/home`.
   */
  review?: string;
  /** Fixed clock (stories, tests). */
  now?: number;
}

/**
 * Home (docs/design/home-2026.md): one calm column, read top to bottom. "Ask {persona} anything"
 * first (with things to try on a first visit); then what needs you; Today's brief (Catching up,
 * then the posts); Suggestions as one-line rows; and a closed "More" holding the quieter parts
 * (pinned widgets, Spaces, Coming up, Goals, Quiet threads, Keep in touch) and the links to the
 * deeper pages (consolidation-2026 §7: simple first, powerful one step away). A section with
 * nothing to say is not drawn, so a first visit is the Ask field and "More". Long lists stop at
 * a few and say how many more there are.
 */
export function HomeScreen({
  onNavigate,
  instructionsOpen,
  anchor,
  post,
  review,
  now,
}: HomeScreenProps): ReactElement {
  const { navigate: slotNavigate } = useSlots();
  const navigate = onNavigate ?? slotNavigate ?? (() => {});
  const [mountedAt] = useState(() => now ?? Date.now());
  // One primary action: the first Approve when something waits (the same count as the sidebar
  // badge); otherwise the Night shift review. Suggestions are always secondary.
  const waiting = useNeedsYou(now).count > 0;

  // Asking for the route the owner is already on (the brief's button, twice) lands again.
  const repeat = useRouteRepeat();
  // biome-ignore lint/correctness/useExhaustiveDependencies: repeat re-runs the scroll on a repeat click
  useEffect(() => {
    // Today lands on its own post, or on the section when the post is gone.
    if (anchor === undefined || post !== undefined) return;
    document.getElementById(anchor)?.scrollIntoView?.({ block: "start" });
  }, [anchor, post, repeat]);

  const clock = now === undefined ? {} : { now };
  // Catching up is `memory.catchup.list` (the Gateway ranks, limits and filters it); the
  // past-due questions in it are in Needs you. Nothing to say, nothing drawn.
  const catchUp = useCatchUp();
  const lead =
    catchUp.lines.length > 0 || catchUp.pendingCount > 0 ? (
      <CatchUp items={catchUp.lines} pendingCount={catchUp.pendingCount} onOpen={navigate} />
    ) : undefined;
  return (
    <div className="@container/home flex min-h-0 flex-1 flex-col" data-testid="home">
      <ScreenToolbar
        title={t("home.title")}
        meta={activeI18n().date(mountedAt, { weekday: "long", month: "long", day: "numeric" })}
      />
      <div className="mx-auto flex w-full max-w-[calc(720px+3rem)] flex-col gap-12 px-4 pt-4 pb-16 md:px-6">
        <AskSection onNavigate={navigate} accent={!waiting} />
        {/* One calm column: the four things that matter, then a closed "More". Space, not rules,
            marks each section's edge; a section with nothing to say is not drawn. */}
        <NeedsYouSection onNavigate={navigate} {...clock} />
        <NightShiftSection onNavigate={navigate} accent={!waiting} />
        <FeedScreen
          onCloseInstructions={() => navigate("/home")}
          collapseAfter={3}
          hideWhenEmpty
          {...(post === undefined ? {} : { focusPostId: post, focusTick: repeat })}
          {...(lead ? { lead } : {})}
          {...(instructionsOpen === undefined ? {} : { instructionsOpen })}
          {...clock}
        />
        <SuggestionsSection accent={false} limit={2} onNavigate={navigate} />
        <HelperPausedLine />
        <MovedFactsNote onNavigate={navigate} />
        <HomeQuietLine />
        <MoreSection
          onNavigate={navigate}
          open={anchor !== undefined && MORE_ANCHORS.includes(anchor)}
        >
          <PinnedWidgets />
          <HomeSpacesSection onNavigate={navigate} {...clock} />
          <ComingUpSection onNavigate={navigate} {...clock} />
          <GoalsSection onNavigate={navigate} />
          <QuietThreadsSection limit={2} />
          <KeepInTouchSection onNavigate={navigate} limit={2} />
        </MoreSection>
      </div>
      {review ? <ReviewSheet review={review} onClose={() => navigate("/home")} {...clock} /> : null}
    </div>
  );
}
