/** Relationship nudges (docs/design/relationship-nudges-2026.md): Feed card, person row, Settings. */
export const nudges = {
  "settings.key.nudges.enabled": "Relationship nudges",
  "settings.key.nudges.consentedAt": "Relationship nudges consent",
  "settings.key.nudges.sensitivity": "How often to nudge",
  "settings.key.nudges.phrasing": "Reword nudge suggestions",
  "nudges.kind": "Keep in touch",
  "nudges.draftReply": "Draft a reply",
  "nudges.draftMessage": "Draft a message",
  "nudges.snooze": "Snooze",
  "nudges.snoozeWeek": "For a week",
  "nudges.snoozeMonth": "For a month",
  "nudges.mutePerson": "Not this person",
  "nudges.done": "Done",
  "nudges.overdue": "Past due",
  "nudges.moreActions": "More ways to put away: {name}",
  "nudges.result.done": "Marked done.",
  "nudges.result.snooze_week": "Snoozed for a week.",
  "nudges.result.snooze_month": "Snoozed for a month.",
  "nudges.result.mute_person":
    "No more nudges for {name}. You can turn them back on from their page.",
  "nudges.gone": "Nothing left to do here.",
  "nudges.failed": "That did not save: {reason}",
  "nudges.draft.unanswered":
    "Help me reply to {name}. Their last {channel, select, mail {email} other {message}} to me came {days} days ago and I have not answered. Look at the conversation, then draft a short reply for me to read. Do not send anything.",
  "nudges.draft.drift":
    "I have not talked to {name} in a while. Draft a short, warm message I could send to catch up. Do not send anything.",
  "nudges.draft.birthday":
    "It is nearly {name}'s special day ({date}). Draft a short, warm message I could send. Do not send anything.",
  "nudges.draft.promise":
    "{text} Help me follow up: draft a short message to {name} about it. Do not send anything.",
  "nudges.starters.title": "Things to bring up",
  "nudges.draft.starters":
    "Things I could bring up, from what Psyche has on file (use only these and do not invent anything else):",
  "nudges.settings.phrasing": "Reword suggestions with my model",
  "nudges.settings.phrasingHint":
    "Uses the model chosen in Settings → Everything memory to say the “things to bring up” in friendlier words. It sees only those short lines, adds nothing, and the plain wording stays if it fails. Off by default.",
  "nudges.person.title": "Keep in touch",
  "nudges.person.none": "Nothing to follow up.",
  "nudges.person.muted": "Nudges for {name} are off.",
  "nudges.person.unmute": "Turn nudges back on",
  "nudges.settings.title": "Relationship nudges",
  "nudges.settings.description":
    "Psyche tells you when a message from someone has gone unanswered, when you are drifting from someone you usually talk to, when a birthday is near, and when you owe someone something you promised.",
  "nudges.settings.enabled": "Remind me to keep in touch",
  "nudges.settings.enabledHint":
    "Shown in your morning brief (up to three) and as quiet Feed cards. Nothing is ever sent for you.",
  "nudges.settings.sensitivity": "How often",
  "nudges.settings.sensitivityHint":
    "How long a message waits, and how far from your usual rhythm, before Psyche says something.",
  "nudges.settings.low": "Gentle",
  "nudges.settings.normal": "Normal",
  "nudges.settings.high": "Eager",
  "nudges.settings.quietHours":
    "Cards wait out the quiet hours set in Settings → General → Notifications.",
  "nudges.consent.title": "Turn on relationship nudges?",
  "nudges.consent.body":
    "Psyche will look at when you last wrote to or heard from people you correspond with (dates only, not what was said), birthdays you confirmed, and promises you made in your own words.",
  "nudges.consent.rules":
    "People you excluded never show up, sensitive facts are never used, and a nudge is one plain sentence with a name and a number of days. You can mute anyone with Not this person, and turn this off any time.",
  "nudges.consent.confirm": "Turn on",
  "nudges.consent.cancel": "Not now",
} as const;
