/**
 * The Overview screen, "{persona} & you" (docs/design/agent-overview-2026.md §5, §5.8). Every id
 * here is translated in all shipped catalogues (`locales/overview/`), which
 * `test/overview-catalogues.test.ts` checks per locale. The shell's `shell.rail.overview` and
 * `shell.sidebar.openOverview` live in `shell.ts` and are translated alongside these.
 */
export const overview = {
  "overview.title": "{name} & you",
  "overview.screen": "Overview",

  // The period control (§5.1): short keys, they map to 7d / 30d / all.
  "overview.period.label": "Time period",
  "overview.period.week": "Week",
  "overview.period.month": "Month",
  "overview.period.all": "All time",
  "overview.range.since": "Since {date}",
  "overview.range.allTime": "All time",

  // The sticky jump bar and the section titles (anchors #now … #recent).
  "overview.jump.label": "Jump to a section",
  "overview.section.now": "Now & next",
  "overview.section.activity": "Activity",
  "overview.section.growth": "Growth",
  "overview.section.people": "People & projects",
  "overview.section.built": "Built for you",
  "overview.section.specialists": "Specialists",
  "overview.section.upcoming": "Upcoming",
  "overview.section.recent": "Recent runs",
  "overview.section.empty": "Nothing here yet.",
  "overview.built.meta": "{count, plural, one {# artifact} other {# artifacts}}",
  "overview.built.seeAll": "See all",
  "overview.built.open": "Open {title}",
  "overview.built.empty": "Nothing built in this period yet.",
  "overview.specialists.meta": "{count, plural, one {# result} other {# results}}",
  "overview.specialists.empty": "No specialist results in this period.",

  // The new-user state (§5.5).
  "overview.newUser.title": "{name} is getting to know you",
  "overview.newUser.body":
    "In a week you’ll see what {name} did for you, what it learned, and the people and projects it’s keeping track of.",
  "overview.newUser.try": "Try",
  "overview.newUser.planWeek": "Ask {name} to plan your week",
  "overview.newUser.morningBrief": "Set up a morning brief",
  "overview.newUser.connectMail": "Connect your mail",

  // /overview/run/<id>, until the Timeline moves here.
  "overview.run.title": "Run",
  "overview.run.placeholder": "The run timeline is moving here.",
  "overview.run.back": "Back to Overview",
} as const;
