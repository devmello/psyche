/**
 * Settings → Mail & meetings and the onboarding decision screen (docs/workflows/mail-and-
 * meetings-2026.md §7.3, §7.5). Translated in every shipped catalogue
 * (`locales/mail-meetings/`); `test/mail-meetings-catalogues.test.ts` checks them per locale.
 */
export const mailMeetings = {
  "settings.nav.mail": "Mail & meetings",
  "settings.mail.title": "Mail & meetings",
  "settings.mail.description":
    "What Wren does with your mail and calendar. It saves drafts and proposes actions; nothing is sent, shared, accepted or declined without your approval.",
  "settings.mail.quietHours": "Quiet hours are in Notifications.",
  "settings.mail.loadFailed": "Couldn't load the mail and meeting settings.",

  // Group titles
  "settings.mail.group.master": "Everything at once",
  "settings.mail.group.accounts": "Accounts",
  "settings.mail.group.digest": "Inbox digest",
  "settings.mail.group.followups": "Follow-ups",
  "settings.mail.group.style": "Writing style",
  "settings.mail.group.scheduling": "Scheduling",
  "settings.mail.group.prep": "Meeting prep",
  "settings.mail.group.notes": "Meeting notes",
  "settings.mail.group.polling": "Checking for new mail",

  // Master switches
  "settings.mail.paused.hint": "Stops every mail and meeting job until you turn it back on.",
  "settings.mail.readOnly.hint":
    "Digests and prep keep coming. Wren proposes no actions and drafts nothing.",

  // Accounts
  "settings.mail.accounts.none": "No mail account is connected. Connect one in Connectors.",
  "settings.mail.accounts.use": "Use {account} in digest and follow-ups",
  "settings.mail.accounts.connect": "Open Connectors",

  // Inbox digest
  "settings.mail.digest.time": "Time",
  "settings.mail.digest.days": "Days",
  "settings.mail.digest.days.weekdays": "Weekdays",
  "settings.mail.digest.days.everyday": "Every day",
  "settings.mail.digest.onlyWhenNeeded.hint":
    "Quiet days put the digest in the Feed without a ping.",
  "settings.mail.digest.rules": "Sender rules",
  "settings.mail.digest.rulesHint": "Who is always archived, always allowed or screened.",
  "settings.mail.digest.openRules": "Open",
  "settings.mail.digest.openRulesAsk": "Show me mail/RULES.md.",

  // Follow-ups
  "settings.mail.followups.waitDays": "Wait before it shows up",
  "settings.mail.followups.days": "{n, plural, one {# business day} other {# business days}}",
  "settings.mail.followups.showTwice.hint": "After two digests it goes quiet.",

  // Writing style
  "settings.mail.voice.learn.hint":
    "Wren reads only what you wrote in sent mail, without quoted text or signatures. The profile stays on this Mac in mail/VOICE.md.",
  "settings.mail.voice.profile": "Voice profile",
  "settings.mail.voice.view": "View",
  "settings.mail.voice.edit": "Edit",
  "settings.mail.voice.reset": "Reset",
  "settings.mail.voice.viewAsk": "Show me mail/VOICE.md.",
  "settings.mail.voice.editAsk": "Let me edit mail/VOICE.md.",
  "settings.mail.voice.resetAsk":
    "Reset my writing style profile: delete mail/VOICE.md and mail/voice-samples.jsonl.",
  "settings.mail.voice.localModel.hint": "Drafts in your voice never leave this Mac.",
  "settings.mail.voice.localModel.none": "Use the primary model",
  "settings.mail.voice.localModel.empty": "No local model is set up.",

  // Scheduling
  "settings.mail.schedule.hours": "Working hours",
  "settings.mail.schedule.hoursHint":
    "From USER.md. Slots are offered inside these hours, on weekdays.",
  "settings.mail.schedule.hoursFrom": "From",
  "settings.mail.schedule.hoursTo": "To",
  "settings.mail.schedule.buffer.hint": "Space kept around meetings when offering times.",
  "settings.mail.schedule.minutes": "{n, plural, one {# minute} other {# minutes}}",
  "settings.mail.schedule.noBuffer": "None",
  "settings.mail.schedule.focusTime.hint": "Suggest holding a block for deep work.",
  "settings.mail.schedule.link.hint": "Optional. Offered in replies when you have one.",
  "settings.mail.schedule.link.placeholder": "https://",

  // Meeting prep
  "settings.mail.prep.scope.hint": "Skips meetings that are only with your own team.",
  "settings.mail.prep.leadMin": "Prepare ahead of the meeting",
  "settings.mail.prep.notifyMin": "Tell me before it starts",
  "settings.mail.prep.saveToNotes.hint": "Also keeps the prep note in your notes app.",
  "settings.mail.prep.dailyCap": "Most preps a day",
  "settings.mail.prep.calendars": "Prep covers the calendars you connected under Connectors.",

  // Meeting notes
  "settings.mail.notes.enabled.hint":
    "Does nothing until you add audio: a Voice Memo, a file or a recording you start.",
  "settings.mail.notes.folder": "Recordings folder",
  "settings.mail.notes.folder.hint": "A folder Wren may read. Grant it under File access.",
  "settings.mail.notes.folder.placeholder": "~/Documents/Recordings",
  "settings.mail.notes.tasksApp": "Add action items to",
  "settings.mail.notes.tasksApp.reminders": "Reminders",
  "settings.mail.notes.tasksApp.things": "Things",
  "settings.mail.notes.recap.hint": "Saves a recap email as a draft after each meeting.",
  "settings.mail.notes.consent.hint":
    "Shown before every recording you start. You say it or paste it into the call.",
  "settings.mail.notes.consent.default": "I’m recording this for my notes. Is that OK?",
  "settings.mail.notes.cloud.hint":
    "Transcripts contain other people’s words. Off, summaries use a local model, or ask first.",

  // Polling
  "settings.mail.poll.active": "While you’re active",
  "settings.mail.poll.idle": "Otherwise",
  "settings.mail.poll.hint": "How often Wren looks for new mail. Quicker costs more battery.",

  // Setting-key labels (docs/ui-audit.md: a raw key never shows at level 1)
  "settings.key.workflows.paused": "Pause all mail and meeting workflows",
  "settings.key.workflows.readOnly": "Read-only (digests and prep only)",
  "settings.key.mail.accounts": "Use {account} in digest and follow-ups",
  "settings.key.mail.digest.enabled": "Inbox digest",
  "settings.key.mail.digest.time": "Digest time",
  "settings.key.mail.digest.days": "Digest days",
  "settings.key.mail.digest.onlyWhenNeeded": "Notify only when something needs you",
  "settings.key.mail.followups.enabled": "Track replies you’re waiting on",
  "settings.key.mail.followups.waitDays": "Follow-up wait",
  "settings.key.mail.followups.showTwice": "Show each follow-up at most twice",
  "settings.key.mail.voice.enabled": "Learn from sent mail",
  "settings.key.mail.draft.localModel": "Draft with a local model",
  "settings.key.mail.schedule.hoursStart": "Working hours start",
  "settings.key.mail.schedule.hoursEnd": "Working hours end",
  "settings.key.mail.schedule.bufferMin": "Meeting buffer",
  "settings.key.mail.schedule.focusTime": "Offer focus time",
  "settings.key.mail.schedulingLink": "Scheduling link",
  "settings.key.mail.poll.activeMin": "Mail check while active",
  "settings.key.mail.poll.idleMin": "Mail check otherwise",
  "settings.key.meetings.prep.enabled": "Meeting prep",
  "settings.key.meetings.prep.scope": "Only meetings with people outside my domain",
  "settings.key.meetings.prep.leadMin": "Prep lead time",
  "settings.key.meetings.prep.notifyMin": "Prep notice lead time",
  "settings.key.meetings.prep.saveToNotes": "Also save prep to Notes",
  "settings.key.meetings.prep.dailyCap": "Most preps a day",
  "settings.key.meetings.notes.enabled": "Meeting notes from recordings",
  "settings.key.meetings.notes.folder": "Recordings folder",
  "settings.key.meetings.notes.tasksApp": "Add action items to",
  "settings.key.meetings.notes.recapDraft": "Draft a recap email",
  "settings.key.meetings.notes.consentLine": "Recording consent line",
  "settings.key.meetings.notes.cloudSummary": "Summarize with a cloud model",

  // Onboarding decision screen (§7.5)
  "onboarding.step.mail": "Mail and meetings",
  "onboarding.mail.title": "{name} can catch you up on mail and meetings",
  "onboarding.mail.lead":
    "Pick what you want. Nothing runs until you continue, and you can change any of it in Settings.",
  "onboarding.mail.digest": "Morning inbox digest at 7:30",
  "onboarding.mail.digestHint": "One summary a day of what needs you. It never sends anything.",
  "onboarding.mail.prep": "Prep notes before meetings with people outside your team",
  "onboarding.mail.prepHint": "Who they are, what’s open, what you discussed last time.",
  "onboarding.mail.followups": "Track replies you’re waiting on",
  "onboarding.mail.followupsHint": "Shown in the digest only. No separate pings.",
  "onboarding.mail.voice": "Learn my writing style from sent mail",
  "onboarding.mail.voiceHint":
    "Reads only what you wrote, without quoted text or signatures. It stays on this Mac and you can view, edit or reset it.",
  "onboarding.mail.notes": "Meeting notes from recordings",
  "onboarding.mail.notesHint":
    "Does nothing until you add audio. Audio and transcripts are never uploaded or used for training.",
  "onboarding.mail.summary":
    "{n, plural, =0 {Nothing turned on} one {# thing turned on} other {# things turned on}}",
  "onboarding.mail.done": "Mail and meetings",
  "onboarding.mail.doneOff": "Off. You can turn it on in Settings.",
  "onboarding.mail.doneOn": "{n, plural, one {# workflow on} other {# workflows on}}",
} as const;
