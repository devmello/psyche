import { type ReactElement, useEffect, useState } from "react";
import { useNotifications } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { FeedScreen } from "../screens/feed/FeedScreen.tsx";
import { ScreenToolbar } from "../screens/feed/ScreenToolbar.tsx";
import { needsYou } from "../screens/inbox/InboxScreen.tsx";
import { useSlots } from "../slots.tsx";
import { PinnedWidgets } from "../widgets/PinnedWidgets.tsx";
import { CatchUp, type CatchUpItem } from "./CatchUp.tsx";
import { useRouteRepeat } from "./route-repeat.ts";
import {
  AskSection,
  ComingUpSection,
  GoalsSection,
  KeepInTouchSection,
  MoreSection,
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
  /**
   * Lands on this post of Today (`/home?post=<id>#today`, which `/feed/<postId>` becomes): opens
   * "Show more" when the post is hidden, scrolls to it and flashes it. A post that no longer
   * exists leaves the owner at Today.
   */
  post?: string;
  /**
   * The brief's "Catching up" rows (projects, to-dos, due work, mail). Nothing supplies them
   * yet; the memory-for-everything work will (docs/design/home-2026.md §5). Absent or empty, the
   * block is not drawn.
   */
  catchUp?: readonly CatchUpItem[];
  /** Fixed clock (stories, tests). */
  now?: number;
}

/**
 * Home (docs/design/home-2026.md): one column, read top to bottom, each part ruled off from the
 * next. "Ask {persona} anything" first (with things to try on a first visit); then what needs
 * you; your pinned widgets; Today's brief (Catching up, then the posts); Suggestions; and the
 * quieter trackers, Coming up, Goals and Keep in touch; a line of links to the deeper pages at
 * the foot (consolidation-2026 §7: simple first, powerful one step away). Each section is the
 * component its old page used, and a section with nothing to say is not drawn, so a first visit
 * is the Ask field and a footer. Long lists stop at a few and say how many more there are.
 */
export function HomeScreen({
  onNavigate,
  instructionsOpen,
  anchor,
  post,
  catchUp,
  now,
}: HomeScreenProps): ReactElement {
  const { navigate: slotNavigate } = useSlots();
  const navigate = onNavigate ?? slotNavigate ?? (() => {});
  const [mountedAt] = useState(() => now ?? Date.now());
  // The accent goes to the first Approve when something waits; otherwise to the first idea.
  const waiting = needsYou(useNotifications().unresolved, now ?? mountedAt).length > 0;

  // Asking for the route the owner is already on (the brief's button, twice) lands again.
  const repeat = useRouteRepeat();
  // biome-ignore lint/correctness/useExhaustiveDependencies: repeat re-runs the scroll on a repeat click
  useEffect(() => {
    // Today lands on its own post, or on the section when the post is gone.
    if (anchor === undefined || post !== undefined) return;
    document.getElementById(anchor)?.scrollIntoView?.({ block: "start" });
  }, [anchor, post, repeat]);

  const clock = now === undefined ? {} : { now };
  const lead =
    catchUp && catchUp.length > 0 ? (
      <CatchUp items={catchUp} now={now ?? mountedAt} onOpen={navigate} />
    ) : undefined;
  return (
    <div className="@container/home flex min-h-0 flex-1 flex-col" data-testid="home">
      <ScreenToolbar
        title={t("home.title")}
        meta={activeI18n().date(mountedAt, { weekday: "long", month: "long", day: "numeric" })}
      />
      <div className="mx-auto flex w-full max-w-[calc(720px+3rem)] flex-col gap-10 px-4 pt-4 pb-16 md:px-6">
        <AskSection onNavigate={navigate} accent={!waiting} />
        {/* One column. A rule and generous space mark each section's edge; a section that is not
            drawn leaves no gap, because the rule belongs to whichever section follows. */}
        <div className="flex flex-col [&>*+*]:mt-10 [&>*+*]:border-t [&>*+*]:border-separator [&>*+*]:pt-10">
          <NeedsYouSection onNavigate={navigate} {...clock} />
          <PinnedWidgets />
          <FeedScreen
            onCloseInstructions={() => navigate("/home")}
            collapseAfter={3}
            hideWhenEmpty
            {...(post === undefined ? {} : { focusPostId: post, focusTick: repeat })}
            {...(lead ? { lead } : {})}
            {...(instructionsOpen === undefined ? {} : { instructionsOpen })}
            {...clock}
          />
          <SuggestionsSection accent={!waiting} limit={2} onNavigate={navigate} />
          <ComingUpSection onNavigate={navigate} {...clock} />
          <GoalsSection onNavigate={navigate} />
          <KeepInTouchSection onNavigate={navigate} limit={2} />
          <MoreSection onNavigate={navigate} />
        </div>
      </div>
    </div>
  );
}
