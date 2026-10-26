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
  "overview.loading": "Loading",
  "overview.error.load": "Couldn’t load",

  // Summary (§5.4): the sentence is chosen from these templates over the computed totals. A clause
  // is dropped when its number is 0. `period` is week | month | all.
  "overview.summary.label": "Summary",
  "overview.summary.sentence.both":
    "{period, select, week {This week} month {This month} other {Overall}}, {name} finished {tasks, plural, one {# task or chat} other {# tasks and chats}} and ran {automations, plural, one {# automation} other {# automations}} for you.",
  "overview.summary.sentence.tasks":
    "{period, select, week {This week} month {This month} other {Overall}}, {name} finished {tasks, plural, one {# task or chat} other {# tasks and chats}} for you.",
  "overview.summary.sentence.automations":
    "{period, select, week {This week} month {This month} other {Overall}}, {name} ran {automations, plural, one {# automation} other {# automations}} for you.",
  "overview.summary.sentence.none":
    "{period, select, week {Nothing ran this week.} month {Nothing ran this month.} other {Nothing has run yet.}}",
  "overview.summary.sentence.lessons":
    "{name} learned {n, plural, one {# lesson} other {# lessons}} from you.",
  "overview.summary.quiet":
    "{period, select, week {Nothing this week.} month {Nothing this month.} other {Nothing yet.}}",
  "overview.summary.tile.tasks": "Tasks done",
  "overview.summary.tile.automations": "Automations run",
  "overview.summary.tile.approvals": "Approvals decided",
  "overview.summary.tile.lessons": "Lessons learned",
  "overview.summary.vs.week": "last week",
  "overview.summary.vs.month": "last month",
  "overview.summary.runsOk": "{pct} of runs ok",
  "overview.summary.failed": "{n} failed",
  "overview.summary.approved": "{n} approved",
  "overview.summary.denied": "{n} denied",
  "overview.summary.expired": "{n} expired",
  "overview.summary.confirmed": "{n} confirmed",

  // Activity (§5.4).
  "overview.activity.meta":
    "{period, select, week {Last 7 days} month {Last 30 days} other {All time}}",
  "overview.activity.label": "Runs per day",
  "overview.activity.series.tasks": "Tasks",
  "overview.activity.series.automations": "Automations",
  "overview.activity.series.chat": "Chat",
  "overview.activity.n.tasks": "{n, plural, one {# task} other {# tasks}}",
  "overview.activity.n.automations": "{n, plural, one {# automation} other {# automations}}",
  "overview.activity.n.chat": "{n, plural, one {# chat} other {# chats}}",
  "overview.activity.dayTime": "{duration} of run time",
  "overview.activity.busiest": "Busiest day: {date} · {n, plural, one {# run} other {# runs}}",
  "overview.activity.worked": "{name} worked {duration} (measured run time)",
  "overview.activity.topAutomation": "Most-run automation: {title} · {n}×",
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

  // /overview/run/<id>: the Timeline page. Its back link reads `overview.title`.
  "overview.run.title": "Run",

  // Now & next (§5.4); "Next up", the empty lines and the run rows reuse `agent.activity.*`.
  "overview.now.needsYou": "{n, plural, one {# thing needs you} other {# things need you}}",
  "overview.now.review": "Review",
  "overview.now.running": "Running now",

  // Upcoming groups and the paused disclosure.
  "overview.upcoming.today": "Today",
  "overview.upcoming.tomorrow": "Tomorrow",
  "overview.upcoming.week": "This week",
  "overview.upcoming.later": "Later",
  "overview.upcoming.paused": "Paused ({n, number})",

  // Recent runs paging.
  "overview.recent.filterTasks": "Tasks",
  "overview.recent.clearDay": "Clear the {date} filter",
  "overview.recent.more": "Show more",
} as const;
