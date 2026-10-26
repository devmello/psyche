import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "../blocks/card.tsx";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { formatTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { ScreenToolbar } from "../screens/feed/ScreenToolbar.tsx";
import { SegmentedRadio } from "../screens/settings/SegmentedRadio.tsx";
import { usePersona } from "../slots.tsx";
import { OverviewActivity } from "./ActivitySection.tsx";
import { BuiltForYou, Specialists } from "./BuiltSpecialists.tsx";
import { isNewUser, type OverviewData, useOverviewData } from "./data.ts";
import { GrowthAndPeople } from "./GrowthAndPeople.tsx";
import { NowSection } from "./NowSection.tsx";
import {
  OVERVIEW_SECTIONS,
  OverviewSection,
  type OverviewSectionId,
  sectionTitle,
} from "./OverviewSection.tsx";
import { formatPeriodRange, OVERVIEW_PERIODS, type OverviewPeriod, periodLabel } from "./period.ts";
import { RecentSection } from "./RecentSection.tsx";
import { OverviewStatusProvider, useOverviewStatusProvider } from "./SectionState.tsx";
import { OverviewSummary } from "./SummarySection.tsx";
import { UpcomingSection } from "./UpcomingSection.tsx";

/** The "Try" chips of the new-user card (§5.5); the host turns each into a real action. */
export type OverviewTry = "planWeek" | "morningBrief" | "connectMail";
const TRIES: readonly OverviewTry[] = ["planWeek", "morningBrief", "connectMail"];

export interface OverviewScreenProps {
  period: OverviewPeriod;
  onPeriodChange: (period: OverviewPeriod) => void;
  /**
   * What the sections show. Defaults to `useOverviewData()` (O1's `useInsights` once it lands);
   * stories and tests pass it directly.
   */
  data?: OverviewData;
  /** A "Try" chip was chosen in the new-user state. */
  onTry?: (kind: OverviewTry) => void;
  /** The shell's `navigate`: tiles, bars and facts link to filtered Recent runs through it. */
  onNavigate?: (to: string) => void;
  /** The current route, so the chart marks the day Recent runs is filtered to. */
  route?: string;
  /** Epoch ms for the range line and the new-user threshold (stories pin it). */
  now?: number;
  /** Scrolls this section into view on arrival (`/overview#upcoming`). */
  anchor?: string;
}

/** Sections shown while the owner is new: Now & next and Upcoming are useful from day one (§5.5). */
const NEW_USER_SECTIONS: readonly OverviewSectionId[] = ["now", "upcoming"];

/**
 * The Overview screen, "{persona} & you" (docs/design/agent-overview-2026.md §5): toolbar with
 * the period control and exact range, a jump bar that sticks after the first screenful, and the
 * section cards. This is the shell: each section renders `OverviewSection` placeholders until its
 * data PR (O4–O8) replaces the children.
 */
export function OverviewScreen({
  period,
  onPeriodChange,
  data,
  onTry,
  onNavigate,
  route,
  now,
  anchor,
}: OverviewScreenProps): ReactElement {
  const persona = usePersona();
  const fromHook = useOverviewData();
  const { firstActivityAt } = data ?? fromHook;
  // Read the clock once per mount unless the host pins it.
  const [mountedAt] = useState(() => Date.now());
  const at = now ?? mountedAt;
  const fresh = isNewUser(firstActivityAt, at);
  const visible = useMemo(
    () =>
      fresh ? OVERVIEW_SECTIONS.filter((s) => NEW_USER_SECTIONS.includes(s)) : OVERVIEW_SECTIONS,
    [fresh],
  );

  // An arrival at `/overview#upcoming` (the old sheet tabs redirect here) scrolls to the section.
  useEffect(() => {
    if (anchor === undefined) return;
    document.getElementById(anchor)?.scrollIntoView?.({ block: "start" });
  }, [anchor]);

  const { value: status, staleSince } = useOverviewStatusProvider();

  return (
    <OverviewStatusProvider value={status}>
      <div className="@container/overview flex min-h-0 flex-1 flex-col" data-testid="overview">
        <ScreenToolbar
          title={t("overview.title", { name: persona.name })}
          meta={
            <>
              {/* Polite: a period change reads the new range once, not every section. */}
              <span data-testid="overview-range" aria-live="polite">
                {formatPeriodRange(period, at, firstActivityAt)}
              </span>
              {staleSince === null ? null : (
                <span data-testid="overview-last-updated" role="status">
                  {" · "}
                  {t("overview.lastUpdated", {
                    time: formatTime(new Date(staleSince).toISOString()),
                  })}
                </span>
              )}
            </>
          }
          actions={
            <SegmentedRadio
              label={t("overview.period.label")}
              options={OVERVIEW_PERIODS.map((p) => ({ value: p, label: periodLabel(p) }))}
              value={period}
              onChange={onPeriodChange}
            />
          }
        />
        <JumpBar sections={visible} />
        <div className="mx-auto flex w-full max-w-[calc(1040px+3rem)] flex-col gap-4 px-4 pt-2 pb-12 md:px-6">
          {/* Section cards are h3s; this keeps the outline h1 → h2 → h3. */}
          <h2 className="sr-only">{t("overview.screen")}</h2>
          {fresh ? <GettingToKnowYou name={persona.name} onTry={onTry} /> : null}
          {fresh ? null : <OverviewSummary period={period} onNavigate={onNavigate} />}
          {visible.map((id) =>
            id === "now" ? (
              <NowSection key={id} {...(now === undefined ? {} : { now })} />
            ) : id === "activity" ? (
              <OverviewActivity key={id} period={period} onNavigate={onNavigate} route={route} />
            ) : id === "growth" ? (
              <GrowthAndPeople key={id} period={period} now={at} />
            ) : id === "people" ? null : id === "built" ? (
              <BuiltForYou key={id} period={period} now={at} />
            ) : id === "specialists" ? (
              <Specialists key={id} period={period} now={at} />
            ) : id === "upcoming" ? (
              <UpcomingSection key={id} {...(now === undefined ? {} : { now })} />
            ) : id === "recent" ? (
              <RecentSection
                key={id}
                period={period}
                route={route}
                onNavigate={onNavigate}
                now={at}
              />
            ) : (
              <OverviewSection key={id} id={id} />
            ),
          )}
        </div>
      </div>
    </OverviewStatusProvider>
  );
}

function GettingToKnowYou({
  name,
  onTry,
}: {
  name: string;
  onTry: ((kind: OverviewTry) => void) | undefined;
}): ReactElement {
  const label = t("overview.newUser.title", { name });
  return (
    <div data-testid="overview-new-user">
      <Card label={label} variant="framed" title={label} animate={false} className="my-0">
        <p className="text-body text-label-secondary">{t("overview.newUser.body", { name })}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-callout text-label-tertiary">{t("overview.newUser.try")}</span>
          {TRIES.map((kind) => (
            <Button key={kind} size="sm" variant="secondary" onClick={() => onTry?.(kind)}>
              {t(`overview.newUser.${kind}`, { name })}
            </Button>
          ))}
        </div>
      </Card>
    </div>
  );
}

/**
 * A quiet text-link row (not tabs) to the section anchors. It appears once the first screenful
 * has scrolled away and is hidden below 720 px (§5.1).
 */
function JumpBar({ sections }: { sections: readonly OverviewSectionId[] }): ReactElement {
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (el === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      // Above the viewport, not merely below it: the bar shows after the summary has scrolled by.
      setStuck(entry !== undefined && !entry.isIntersecting && entry.boundingClientRect.top < 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      {/* Zero-height sticky anchor: the bar appearing never shifts the page. */}
      <div className="sticky top-13 z-10 hidden h-0 @min-[720px]/overview:block">
        <nav
          aria-label={t("overview.jump.label")}
          data-testid="overview-jump"
          data-stuck={stuck ? "true" : "false"}
          className={cn(
            "absolute inset-x-0 top-0 bg-canvas px-6 py-1.5",
            stuck ? "" : "pointer-events-none invisible",
          )}
        >
          <ul className="mx-auto flex max-w-[1040px] flex-wrap gap-x-4 gap-y-1">
            {sections.map((id) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document
                      .getElementById(id)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  className="rounded-sm text-callout text-label-secondary outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {sectionTitle(id)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </>
  );
}
