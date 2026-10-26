import type { Catalogue } from "../../index.ts";

/** Mail and meeting settings and onboarding strings (de); merged into `../de.ts`. */
export const mailMeetings: Partial<Catalogue> = {
  "settings.nav.mail": "Mail & Meetings",
  "settings.mail.title": "Mail & Meetings",
  "settings.mail.description":
    "Was Wren mit deiner Mail und deinem Kalender macht. Wren speichert Entwürfe und schlägt Aktionen vor; ohne deine Freigabe wird nichts gesendet, geteilt, angenommen oder abgelehnt.",
  "settings.mail.quietHours": "Ruhezeiten findest du unter Benachrichtigungen.",
  "settings.mail.loadFailed": "Die Mail- und Meeting-Einstellungen konnten nicht geladen werden.",

  // Group titles
  "settings.mail.group.master": "Alles auf einmal",
  "settings.mail.group.accounts": "Accounts",
  "settings.mail.group.digest": "Posteingangs-Übersicht",
  "settings.mail.group.followups": "Nachverfolgung",
  "settings.mail.group.style": "Schreibstil",
  "settings.mail.group.scheduling": "Terminfindung",
  "settings.mail.group.prep": "Meeting-Vorbereitung",
  "settings.mail.group.notes": "Meeting-Notizen",
  "settings.mail.group.polling": "Auf neue Mail prüfen",

  // Master switches
  "settings.mail.paused.hint":
    "Hält alle Mail- und Meeting-Aufgaben an, bis du sie wieder einschaltest.",
  "settings.mail.readOnly.hint":
    "Übersichten und Vorbereitung kommen weiter. Wren schlägt keine Aktionen vor und entwirft nichts.",

  // Accounts
  "settings.mail.accounts.none": "Kein Mail-Account verbunden. Verbinde einen unter Verbindungen.",
  "settings.mail.accounts.use": "{account} in Übersicht und Nachverfolgung verwenden",
  "settings.mail.accounts.connect": "Verbindungen öffnen",

  // Inbox digest
  "settings.mail.digest.time": "Uhrzeit",
  "settings.mail.digest.days": "Tage",
  "settings.mail.digest.days.weekdays": "Wochentage",
  "settings.mail.digest.days.everyday": "Jeden Tag",
  "settings.mail.digest.onlyWhenNeeded.hint":
    "An ruhigen Tagen landet die Übersicht ohne Hinweiston im Feed.",
  "settings.mail.digest.rules": "Absenderregeln",
  "settings.mail.digest.rulesHint": "Wer immer archiviert, immer zugelassen oder geprüft wird.",
  "settings.mail.digest.openRules": "Öffnen",
  "settings.mail.digest.openRulesAsk": "Zeig mir mail/RULES.md.",

  // Follow-ups
  "settings.mail.followups.waitDays": "Wartezeit, bevor es auftaucht",
  "settings.mail.followups.days": "{n, plural, one {# Werktag} other {# Werktage}}",
  "settings.mail.followups.showTwice.hint": "Nach zwei Übersichten wird es still.",

  // Writing style
  "settings.mail.voice.learn.hint":
    "Wren liest nur, was du in gesendeter Mail selbst geschrieben hast, ohne zitierten Text oder Signaturen. Das Profil bleibt auf diesem Mac in mail/VOICE.md.",
  "settings.mail.voice.profile": "Stilprofil",
  "settings.mail.voice.view": "Ansehen",
  "settings.mail.voice.edit": "Bearbeiten",
  "settings.mail.voice.reset": "Zurücksetzen",
  "settings.mail.voice.viewAsk": "Zeig mir mail/VOICE.md.",
  "settings.mail.voice.editAsk": "Lass mich mail/VOICE.md bearbeiten.",
  "settings.mail.voice.resetAsk":
    "Setze mein Schreibstil-Profil zurück: lösche mail/VOICE.md und mail/voice-samples.jsonl.",
  "settings.mail.voice.localModel.hint": "Entwürfe in deinem Stil verlassen diesen Mac nie.",
  "settings.mail.voice.localModel.none": "Hauptmodell verwenden",
  "settings.mail.voice.localModel.empty": "Es ist kein lokales Modell eingerichtet.",

  // Scheduling
  "settings.mail.schedule.hours": "Arbeitszeiten",
  "settings.mail.schedule.hoursHint":
    "Aus USER.md. Termine werden innerhalb dieser Zeiten an Wochentagen angeboten.",
  "settings.mail.schedule.hoursFrom": "Von",
  "settings.mail.schedule.hoursTo": "Bis",
  "settings.mail.schedule.buffer.hint": "Abstand um Meetings, wenn Zeiten angeboten werden.",
  "settings.mail.schedule.minutes": "{n, plural, one {# Minute} other {# Minuten}}",
  "settings.mail.schedule.noBuffer": "Keiner",
  "settings.mail.schedule.focusTime.hint":
    "Vorschlagen, einen Block für konzentrierte Arbeit freizuhalten.",
  "settings.mail.schedule.link.hint": "Optional. Wird in Antworten angeboten, wenn du einen hast.",

  // Meeting prep
  "settings.mail.prep.scope.hint":
    "Überspringt Meetings, die nur mit deinem eigenen Team stattfinden.",
  "settings.mail.prep.leadMin": "Vor dem Meeting vorbereiten",
  "settings.mail.prep.notifyMin": "Vor dem Beginn Bescheid geben",
  "settings.mail.prep.saveToNotes.hint":
    "Legt die Vorbereitungsnotiz auch in deiner Notizen-App ab.",
  "settings.mail.prep.dailyCap": "Höchstens so viele Vorbereitungen pro Tag",
  "settings.mail.prep.calendars":
    "Die Vorbereitung umfasst die Kalender, die du unter Verbindungen verbunden hast.",

  // Meeting notes
  "settings.mail.notes.enabled.hint":
    "Tut nichts, bis du Audio hinzufügst: eine Sprachmemo, eine Datei oder eine Aufnahme, die du startest.",
  "settings.mail.notes.folder": "Aufnahmeordner",
  "settings.mail.notes.folder.hint":
    "Ein Ordner, den Wren lesen darf. Gib ihn unter Dateizugriff frei.",
  "settings.mail.notes.folder.placeholder": "~/Documents/Recordings",
  "settings.mail.notes.tasksApp": "Aufgaben hinzufügen zu",
  "settings.mail.notes.tasksApp.reminders": "Erinnerungen",
  "settings.mail.notes.tasksApp.things": "Things",
  "settings.mail.notes.recap.hint":
    "Speichert nach jedem Meeting eine Zusammenfassung als Mail-Entwurf.",
  "settings.mail.notes.consent.hint":
    "Wird vor jeder Aufnahme gezeigt, die du startest. Du sagst den Satz oder fügst ihn in den Anruf ein.",
  "settings.mail.notes.consent.default": "Ich nehme das für meine Notizen auf. Ist das in Ordnung?",
  "settings.mail.notes.cloud.hint":
    "Transkripte enthalten die Worte anderer. Aus, Zusammenfassungen nutzen ein lokales Modell, oder erst fragen.",

  // Polling
  "settings.mail.poll.active": "Solange du aktiv bist",
  "settings.mail.poll.idle": "Sonst",
  "settings.mail.poll.hint": "Wie oft Wren nach neuer Mail sieht. Häufiger kostet mehr Akku.",

  // Setting-key labels
  "settings.key.workflows.paused": "Alle Mail- und Meeting-Abläufe pausieren",
  "settings.key.workflows.readOnly": "Nur lesen (nur Übersichten und Vorbereitung)",
  "settings.key.mail.accounts": "{account} in Übersicht und Nachverfolgung verwenden",
  "settings.key.mail.digest.enabled": "Posteingangs-Übersicht",
  "settings.key.mail.digest.time": "Uhrzeit der Übersicht",
  "settings.key.mail.digest.days": "Tage der Übersicht",
  "settings.key.mail.digest.onlyWhenNeeded": "Nur benachrichtigen, wenn etwas dich braucht",
  "settings.key.mail.followups.enabled": "Antworten verfolgen, auf die du wartest",
  "settings.key.mail.followups.waitDays": "Wartezeit der Nachverfolgung",
  "settings.key.mail.followups.showTwice": "Jede Nachverfolgung höchstens zweimal zeigen",
  "settings.key.mail.voice.enabled": "Aus gesendeter Mail lernen",
  "settings.key.mail.draft.localModel": "Mit lokalem Modell entwerfen",
  "settings.key.mail.schedule.hoursStart": "Beginn der Arbeitszeit",
  "settings.key.mail.schedule.hoursEnd": "Ende der Arbeitszeit",
  "settings.key.mail.schedule.bufferMin": "Meeting-Puffer",
  "settings.key.mail.schedule.focusTime": "Fokuszeit anbieten",
  "settings.key.mail.schedulingLink": "Terminlink",
  "settings.key.mail.poll.activeMin": "Mail-Abruf bei Aktivität",
  "settings.key.mail.poll.idleMin": "Mail-Abruf sonst",
  "settings.key.meetings.prep.enabled": "Meeting-Vorbereitung",
  "settings.key.meetings.prep.scope": "Nur Meetings mit Personen außerhalb meiner Domain",
  "settings.key.meetings.prep.leadMin": "Vorlaufzeit der Vorbereitung",
  "settings.key.meetings.prep.notifyMin": "Vorlaufzeit der Vorbereitungshinweise",
  "settings.key.meetings.prep.saveToNotes": "Vorbereitung auch in Notizen sichern",
  "settings.key.meetings.prep.dailyCap": "Höchstens so viele Vorbereitungen pro Tag",
  "settings.key.meetings.notes.enabled": "Meeting-Notizen aus Aufnahmen",
  "settings.key.meetings.notes.folder": "Aufnahmeordner",
  "settings.key.meetings.notes.tasksApp": "Aufgaben hinzufügen zu",
  "settings.key.meetings.notes.recapDraft": "Zusammenfassungs-Mail entwerfen",
  "settings.key.meetings.notes.consentLine": "Einwilligungssatz für Aufnahmen",
  "settings.key.meetings.notes.cloudSummary": "Mit einem Cloud-Modell zusammenfassen",

  // Onboarding decision screen
  "onboarding.step.mail": "Mail und Meetings",
  "onboarding.mail.title": "{name} kann dich bei Mail und Meetings auf den neuesten Stand bringen",
  "onboarding.mail.lead":
    "Such aus, was du willst. Nichts läuft, bevor du fortfährst, und du kannst alles in den Einstellungen ändern.",
  "onboarding.mail.digest": "Morgendliche Posteingangs-Übersicht um 7:30",
  "onboarding.mail.digestHint":
    "Einmal am Tag eine Zusammenfassung dessen, was dich braucht. Sie sendet nie etwas.",
  "onboarding.mail.prep": "Vorbereitungsnotizen vor Meetings mit Personen außerhalb deines Teams",
  "onboarding.mail.prepHint": "Wer sie sind, was offen ist, worüber ihr zuletzt gesprochen habt.",
  "onboarding.mail.followups": "Antworten verfolgen, auf die du wartest",
  "onboarding.mail.followupsHint": "Nur in der Übersicht zu sehen. Keine eigenen Hinweise.",
  "onboarding.mail.voice": "Meinen Schreibstil aus gesendeter Mail lernen",
  "onboarding.mail.voiceHint":
    "Liest nur, was du geschrieben hast, ohne zitierten Text oder Signaturen. Es bleibt auf diesem Mac, und du kannst es ansehen, bearbeiten oder zurücksetzen.",
  "onboarding.mail.notes": "Meeting-Notizen aus Aufnahmen",
  "onboarding.mail.notesHint":
    "Tut nichts, bis du Audio hinzufügst. Audio und Transkripte werden nie hochgeladen oder fürs Training verwendet.",
  "onboarding.mail.summary":
    "{n, plural, =0 {Nichts eingeschaltet} one {# Sache eingeschaltet} other {# Dinge eingeschaltet}}",
  "onboarding.mail.done": "Mail und Meetings",
  "onboarding.mail.doneOff": "Aus. Du kannst es in den Einstellungen einschalten.",
  "onboarding.mail.doneOn": "{n, plural, one {# Ablauf an} other {# Abläufe an}}",
};
