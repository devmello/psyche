/**
 * Settings → Memory → Work and Where memory shows (docs/design/memory-everything-2026.md §4, §5.4,
 * §9 W1–W7). To-do is the owner's word for an assignment (W7); examples are a general mix.
 */
export const memorySettings = {
  "settings.nav.work": "Work",
  "settings.nav.surfaces": "Where memory shows",

  // Labels for the keys Search finds (`settings.key.*`).
  "settings.key.memory.work": "Work in memory",
  "settings.key.memory.surfaces": "Where memory shows",
  "settings.key.memory.work.enabled": "Track my work",
  "settings.key.memory.work.trackedLists": "Reminders lists tracked as work",
  "settings.key.memory.work.anchorsFromFolders": "Which folders count as work",
  "settings.key.memory.work.remind.enabled": "Remind me what is due tomorrow",
  "settings.key.memory.work.remind.dueSoonHours": "How far ahead to look for due things",
  "settings.key.memory.work.remind.dayOf": "Also tell me in the morning what is due today",
  "settings.key.memory.surfaces.tiers.work.home": "Work on Home",
  "settings.key.memory.surfaces.tiers.work.brief": "Work in the daily brief",
  "settings.key.memory.surfaces.tiers.work.notification": "Work in notifications",
  "settings.key.memory.surfaces.tiers.work.channel": "Work in the brief sent to a channel",
  "settings.key.memory.surfaces.tiers.workMail.home": "Mail about work on Home",
  "settings.key.memory.surfaces.tiers.workMail.brief": "Mail about work in the daily brief",
  "settings.key.memory.surfaces.tiers.workMail.notification": "Mail about work in notifications",
  "settings.key.memory.surfaces.tiers.workMail.channel":
    "Mail about work in the brief sent to a channel",
  "settings.key.memory.surfaces.tiers.people.home": "People on Home",
  "settings.key.memory.surfaces.tiers.people.brief": "People in the daily brief",
  "settings.key.memory.surfaces.tiers.people.notification": "People in notifications",
  "settings.key.memory.surfaces.tiers.people.channel": "People in the brief sent to a channel",
  "settings.key.memory.surfaces.birthdays": "Birthdays and anniversaries in the brief and on Home",
  "settings.key.memory.surfaces.hideSources": "Keep a source out of Home, briefs and notifications",
  "settings.key.memory.surfaces.kinds.project": "Show projects outside Memory",
  "settings.key.memory.surfaces.kinds.course": "Show courses outside Memory",
  "settings.key.memory.surfaces.kinds.assignment": "Show to-dos outside Memory",
  "settings.key.memory.surfaces.kinds.event": "Show events outside Memory",

  // --- Work ---
  "memoryWork.title": "Work",
  "memoryWork.description":
    "What {persona} keeps track of for you: projects, to-dos with a deadline, and where you stopped.",
  "memoryWork.loadLabel": "work memory",
  "memoryWork.enabled.title": "Work in memory",
  "memoryWork.enabled.label": "Track my work",
  "memoryWork.enabled.hint":
    "Keeps a to-do for anything with a deadline, how it is going, and where you stopped. Off until you say yes.",
  "memoryWork.enabled.off":
    "Turn on to choose Reminders lists and folders and to set up reminders.",

  "memoryWork.consent.title": "Track your work in memory",
  "memoryWork.consent.body":
    "{persona} will keep a to-do for anything with a deadline (rent, a lab report, a board deck) and note how it is going and where you stopped.",
  "memoryWork.consent.reads": "What it reads",
  "memoryWork.consent.r1": "Reminders lists you pick, and your own calendars",
  "memoryWork.consent.r2": "Files in folders you link to a project",
  "memoryWork.consent.r3":
    "Your sent mail and mail on threads you link, and your chats with {persona}",
  "memoryWork.consent.keeps": "What stays true",
  "memoryWork.consent.k1": "Nothing leaves this Mac. Dates and status are worked out by code.",
  "memoryWork.consent.k2": "Text from other people never changes a deadline or a status.",
  "memoryWork.consent.k3":
    "Work shows on Home and in your daily brief. Change that under Where memory shows.",
  "memoryWork.consent.cancel": "Not now",
  "memoryWork.consent.confirm": "Turn on",

  "memoryWork.lists.title": "Reminders lists",
  "memoryWork.lists.description":
    "A reminder with a due date in a tracked list becomes a to-do under the project you pick. Other lists are left alone. Only lists you mark as yours in Connectors can mark things done.",
  "memoryWork.lists.none": "Not tracked",
  "memoryWork.lists.pick": "Project for {list}",
  "memoryWork.lists.missing": "A list that is no longer in Reminders",
  "memoryWork.lists.shared": "Shared list",
  "memoryWork.lists.empty": "No Reminders lists yet.",
  "memoryWork.lists.noProjects": "Add a project on the Memory page, then pick it here.",
  "memoryWork.lists.openMemory": "Open Memory",
  "memoryWork.lists.loading": "Reading your Reminders lists…",

  "memoryWork.folders.title": "Folders",
  "memoryWork.folders.anchored": "Only folders linked to a project",
  "memoryWork.folders.anchoredHint":
    "Link a folder from a project’s page. When a folder’s name matches a project, {persona} suggests it.",
  "memoryWork.folders.all": "Any folder {persona} can read, matched by name",
  "memoryWork.folders.allHint":
    "A folder whose name matches a project is linked without asking. Only names and dates are read.",

  "memoryWork.remind.title": "Reminders to finish things",
  "memoryWork.remind.description":
    "Notifications are off until you turn them on. They never come during quiet hours.",
  "memoryWork.remind.enabled": "Remind me what is due tomorrow",
  "memoryWork.remind.enabledHint":
    "One notification a day at wrap-up time, for things due in the next {hours, plural, one {# hour} other {# hours}}.",
  "memoryWork.remind.hours": "How far ahead to look",
  "memoryWork.remind.hoursOption": "{hours, plural, one {# hour} other {# hours}}",
  "memoryWork.remind.at": "When",
  "memoryWork.remind.atWrapup": "At your wrap-up time, {time}",
  "memoryWork.remind.atHint": "Set in Daily. Titles show only for things you added yourself.",
  "memoryWork.remind.openDaily": "Open Daily",
  "memoryWork.remind.dayOf": "Also tell me in the morning what is due today",
  "memoryWork.remind.dayOfHint": "A second notification after the morning brief: “Due today: …”.",
  "memoryWork.remind.needsWrapup":
    "The evening wrap-up is off, so nothing will be sent. Turn it on to get this.",
  "memoryWork.remind.needsBrief":
    "The morning brief is off, so nothing will be sent. Turn it on to get this.",
  "memoryWork.remind.turnOnWrapup": "Turn on wrap-up",
  "memoryWork.remind.turnOnBrief": "Turn on brief",

  // --- Where memory shows ---
  "memorySurfaces.title": "Where memory shows",
  "memorySurfaces.description":
    "What {persona} may put on Home, in the daily brief, in notifications and in a brief sent to Telegram or another channel. The Memory page always shows everything you have not excluded.",
  "memorySurfaces.loadLabel": "where memory shows",
  "memorySurfaces.surface.home": "Home",
  "memorySurfaces.surface.brief": "Daily brief",
  "memorySurfaces.surface.notification": "Notifications",
  "memorySurfaces.surface.channel": "Brief sent to a channel",

  "memorySurfaces.tier.work.title": "Work and to-dos",
  "memorySurfaces.tier.work.description":
    "Projects, courses, to-dos, how they are going, due dates, and events from your own calendars.",
  "memorySurfaces.tier.work.notificationHint":
    "Titles show only for things you added yourself. Otherwise it is a count, like “1 to-do due tomorrow”.",
  "memorySurfaces.tier.workMail.title": "Mail about work",
  "memorySurfaces.tier.workMail.description":
    "Subjects and senders of mail on a thread you linked to a project or to-do.",
  "memorySurfaces.tier.people.title": "Facts about people",
  "memorySurfaces.tier.people.description":
    "Facts about other people, how you know them, what you talked about, and Keep in touch.",
  "memorySurfaces.people.warning":
    "Briefs can be seen by anyone who sees your screen or your Telegram.",

  "memorySurfaces.birthdays.title": "Birthdays and anniversaries",
  "memorySurfaces.birthdays.label": "Show birthdays and anniversaries",
  "memorySurfaces.birthdays.hint":
    "Dates only, under Coming up in the brief and on Home. Never in a notification.",
  "memorySurfaces.sensitive":
    "Anything marked sensitive, such as health or money, never shows outside Memory.",

  "memorySurfaces.kinds.title": "What kinds show",
  "memorySurfaces.kinds.description":
    "Turn a kind off and it stays on the Memory page only. To hide a single item, use Keep private on its page.",
  "memorySurfaces.kind.project": "Projects",
  "memorySurfaces.kind.course": "Courses",
  "memorySurfaces.kind.assignment": "To-dos",
  "memorySurfaces.kind.event": "Events",

  "memorySurfaces.sources.title": "Keep a source out",
  "memorySurfaces.sources.description":
    "What is learned from a source you switch on stays on the Memory page. This works on top of the switches above.",
  "memorySurfaces.sources.label": "Don’t show anything learned from {source}",
  "memorySurfaces.source.mail": "Mail",
  "memorySurfaces.source.messages": "Messages",
  "memorySurfaces.source.notes": "Notes",
  "memorySurfaces.source.calendar": "Calendar",
  "memorySurfaces.source.reminders": "Reminders",
  "memorySurfaces.source.chats": "Chats with Psyche",
  "memorySurfaces.source.files": "Files",
  "memorySurfaces.source.transcripts": "Transcripts",
  "memorySurfaces.source.contacts": "Contacts",
} as const;
