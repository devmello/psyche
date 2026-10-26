/**
 * The Overview's Growth and People & projects sections (docs/design/agent-overview-2026.md §5.4).
 * Every id is translated in all shipped catalogues (`locales/overview-growth/`), which
 * `test/overview-catalogues.test.ts` checks per locale (the `overview.` prefix).
 */
export const overviewGrowth = {
  // The period in a section header's meta.
  "overview.meta.7d": "Last 7 days",
  "overview.meta.30d": "Last 30 days",
  "overview.meta.all": "All time",

  // Growth
  "overview.growth.loading": "Loading growth",
  "overview.growth.loadFailed": "Couldn’t load Growth",
  "overview.growth.empty": "Nothing learned in this period yet.",
  "overview.growth.counts": "Lessons in this period",
  "overview.growth.learned": "{n, plural, one {# lesson learned} other {# lessons learned}}",
  "overview.growth.refined": "{n, plural, one {# refined} other {# refined}}",
  "overview.growth.confirmed": "{n, plural, one {# confirmed} other {# confirmed}}",
  "overview.growth.forgotten": "{n, plural, one {# forgotten} other {# forgotten}}",
  "overview.growth.milestones": "Milestones",
  "overview.growth.seeAll": "See all lessons",
  "overview.growth.sheetTitle": "What {agent} learned",
  "overview.growth.evidenceTitle": "Events behind “{metric}”",
  "overview.growth.card.thisWeek": "This week’s lessons ({n})",
  "overview.growth.card.week": "Lessons for the week of {date} ({n})",
  "overview.growth.card.review": "Review",
  "overview.growth.card.sheetTitle": "What {agent} learned this week",
  "overview.growth.card.sheetDescription": "Keep, edit or forget what {agent} picked up.",

  // People & projects
  "overview.people.loading": "Loading people and projects",
  "overview.people.loadFailed": "Couldn’t load People & projects",
  "overview.people.paused":
    "The people and projects graph is paused, so nothing is being tracked. Turn it on in Settings to see it here.",
  "overview.people.empty":
    "Nobody yet in this period. People and projects show up here once {agent} works with them for you.",
  "overview.people.map": "People and projects map",
  "overview.people.mapHint":
    "Arrow keys move between people and projects, most interactions first. Enter opens one.",
  "overview.people.caption":
    "Closer to you means more recent. Bigger means more interactions. Circles are people; squares are projects and organisations.",
  "overview.people.you": "You",
  "overview.people.ring.0": "This week",
  "overview.people.ring.1": "This month",
  "overview.people.ring.2": "Earlier",
  "overview.people.kind.person": "Person",
  "overview.people.kind.org": "Organisation",
  "overview.people.kind.project": "Project",
  "overview.people.kind.place": "Place",
  "overview.people.interactions": "{n, plural, one {# interaction} other {# interactions}}",
  "overview.people.openLoops": "{n, plural, one {# open loop} other {# open loops}}",
  "overview.people.last": "Last interaction {when}",
  "overview.people.node": "{name}, {kind}. {interactions}. Last interaction {when}. {loops}.",
  "overview.people.detailHint": "Hover or focus a person or project to see its details.",
  "overview.people.counts":
    "{people, plural, one {# person} other {# people}} · {projects, plural, one {# project} other {# projects}} · {loops, plural, one {# open loop} other {# open loops}}",
  "overview.people.ranked": "{name} {n}",
  "overview.people.showList": "Show as list",
  "overview.people.showMap": "Show map",
  "overview.people.seeAll": "See all",
  "overview.people.list": "People and projects, most interactions first",
  "overview.people.table.name": "Name",
  "overview.people.table.kind": "Kind",
  "overview.people.table.interactions": "Interactions",
  "overview.people.table.last": "Last interaction",
  "overview.people.table.loops": "Open loops",
} as const;
