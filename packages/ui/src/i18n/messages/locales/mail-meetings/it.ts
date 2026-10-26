import type { Catalogue } from "../../index.ts";

/** Mail and meeting settings and onboarding strings (it); merged into `../it.ts`. */
export const mailMeetings: Partial<Catalogue> = {
  "settings.nav.mail": "Posta e riunioni",
  "settings.mail.title": "Posta e riunioni",
  "settings.mail.description":
    "Cosa fa Wren con la tua posta e il tuo calendario. Salva bozze e propone azioni; nulla viene inviato, condiviso, accettato o rifiutato senza la tua approvazione.",
  "settings.mail.quietHours": "Le ore di silenzio sono in Notifiche.",
  "settings.mail.loadFailed": "Impossibile caricare le impostazioni di posta e riunioni.",

  // Group titles
  "settings.mail.group.master": "Tutto insieme",
  "settings.mail.group.accounts": "Account",
  "settings.mail.group.digest": "Riepilogo della posta",
  "settings.mail.group.followups": "Solleciti",
  "settings.mail.group.style": "Stile di scrittura",
  "settings.mail.group.scheduling": "Pianificazione",
  "settings.mail.group.prep": "Preparazione riunione",
  "settings.mail.group.notes": "Note della riunione",
  "settings.mail.group.polling": "Controllo della nuova posta",

  // Master switches
  "settings.mail.paused.hint": "Ferma ogni attività di posta e riunioni finché non la riattivi.",
  "settings.mail.readOnly.hint":
    "Riepiloghi e preparazione continuano ad arrivare. Wren non propone azioni e non scrive bozze.",

  // Accounts
  "settings.mail.accounts.none": "Nessun account di posta collegato. Collegane uno in Connettori.",
  "settings.mail.accounts.use": "Usa {account} nel riepilogo e nei solleciti",
  "settings.mail.accounts.connect": "Apri Connettori",

  // Inbox digest
  "settings.mail.digest.time": "Ora",
  "settings.mail.digest.days": "Giorni",
  "settings.mail.digest.days.weekdays": "Giorni feriali",
  "settings.mail.digest.days.everyday": "Ogni giorno",
  "settings.mail.digest.onlyWhenNeeded.hint":
    "Nei giorni tranquilli il riepilogo va nel Feed senza avviso.",
  "settings.mail.digest.rules": "Regole sui mittenti",
  "settings.mail.digest.rulesHint": "Chi viene sempre archiviato, sempre consentito o controllato.",
  "settings.mail.digest.openRules": "Apri",
  "settings.mail.digest.openRulesAsk": "Mostrami mail/RULES.md.",

  // Follow-ups
  "settings.mail.followups.waitDays": "Attesa prima che compaia",
  "settings.mail.followups.days":
    "{n, plural, one {# giorno lavorativo} other {# giorni lavorativi}}",
  "settings.mail.followups.showTwice.hint": "Dopo due riepiloghi non compare più.",

  // Writing style
  "settings.mail.voice.learn.hint":
    "Wren legge solo ciò che hai scritto nella posta inviata, senza testo citato né firme. Il profilo resta su questo Mac in mail/VOICE.md.",
  "settings.mail.voice.profile": "Profilo di stile",
  "settings.mail.voice.view": "Mostra",
  "settings.mail.voice.edit": "Modifica",
  "settings.mail.voice.reset": "Ripristina",
  "settings.mail.voice.viewAsk": "Mostrami mail/VOICE.md.",
  "settings.mail.voice.editAsk": "Fammi modificare mail/VOICE.md.",
  "settings.mail.voice.resetAsk":
    "Ripristina il mio profilo di stile di scrittura: elimina mail/VOICE.md e mail/voice-samples.jsonl.",
  "settings.mail.voice.localModel.hint": "Le bozze nel tuo stile non lasciano mai questo Mac.",
  "settings.mail.voice.localModel.none": "Usa il modello principale",
  "settings.mail.voice.localModel.empty": "Nessun modello locale configurato.",

  // Scheduling
  "settings.mail.schedule.hours": "Orario di lavoro",
  "settings.mail.schedule.hoursHint":
    "Da USER.md. Gli slot vengono proposti entro questi orari, nei giorni feriali.",
  "settings.mail.schedule.hoursFrom": "Dalle",
  "settings.mail.schedule.hoursTo": "Alle",
  "settings.mail.schedule.buffer.hint":
    "Margine lasciato attorno alle riunioni quando si propongono orari.",
  "settings.mail.schedule.minutes": "{n, plural, one {# minuto} other {# minuti}}",
  "settings.mail.schedule.noBuffer": "Nessuno",
  "settings.mail.schedule.focusTime.hint":
    "Suggerisci di riservare un blocco per il lavoro concentrato.",
  "settings.mail.schedule.link.hint": "Facoltativo. Proposto nelle risposte quando ne hai uno.",

  // Meeting prep
  "settings.mail.prep.scope.hint": "Salta le riunioni che coinvolgono solo il tuo team.",
  "settings.mail.prep.leadMin": "Prepara prima della riunione",
  "settings.mail.prep.notifyMin": "Avvisami prima che inizi",
  "settings.mail.prep.saveToNotes.hint":
    "Conserva la nota di preparazione anche nella tua app di note.",
  "settings.mail.prep.dailyCap": "Massimo di preparazioni al giorno",
  "settings.mail.prep.calendars":
    "La preparazione copre i calendari che hai collegato in Connettori.",

  // Meeting notes
  "settings.mail.notes.enabled.hint":
    "Non fa nulla finché non aggiungi dell’audio: un memo vocale, un file o una registrazione che avvii.",
  "settings.mail.notes.folder": "Cartella delle registrazioni",
  "settings.mail.notes.folder.hint":
    "Una cartella che Wren può leggere. Concedila in Accesso ai file.",
  "settings.mail.notes.folder.placeholder": "~/Documents/Recordings",
  "settings.mail.notes.tasksApp": "Aggiungi le azioni a",
  "settings.mail.notes.tasksApp.reminders": "Promemoria",
  "settings.mail.notes.tasksApp.things": "Things",
  "settings.mail.notes.recap.hint": "Salva come bozza un’email di riepilogo dopo ogni riunione.",
  "settings.mail.notes.consent.hint":
    "Mostrata prima di ogni registrazione che avvii. La dici tu oppure la incolli nella chiamata.",
  "settings.mail.notes.consent.default": "Sto registrando per i miei appunti. Ti va bene?",
  "settings.mail.notes.cloud.hint":
    "Le trascrizioni contengono le parole di altre persone. Disattivato, i riepiloghi usano un modello locale, oppure chiedi prima.",

  // Polling
  "settings.mail.poll.active": "Quando sei attivo",
  "settings.mail.poll.idle": "Altrimenti",
  "settings.mail.poll.hint": "Ogni quanto Wren cerca nuova posta. Più spesso consuma più batteria.",

  // Setting-key labels
  "settings.key.workflows.paused": "Metti in pausa tutti i flussi di posta e riunioni",
  "settings.key.workflows.readOnly": "Sola lettura (solo riepiloghi e preparazione)",
  "settings.key.mail.accounts": "Usa {account} nel riepilogo e nei solleciti",
  "settings.key.mail.digest.enabled": "Riepilogo della posta",
  "settings.key.mail.digest.time": "Ora del riepilogo",
  "settings.key.mail.digest.days": "Giorni del riepilogo",
  "settings.key.mail.digest.onlyWhenNeeded": "Avvisa solo quando serve la tua attenzione",
  "settings.key.mail.followups.enabled": "Tieni traccia delle risposte che aspetti",
  "settings.key.mail.followups.waitDays": "Attesa del sollecito",
  "settings.key.mail.followups.showTwice": "Mostra ogni sollecito al massimo due volte",
  "settings.key.mail.voice.enabled": "Impara dalla posta inviata",
  "settings.key.mail.draft.localModel": "Scrivi le bozze con un modello locale",
  "settings.key.mail.schedule.hoursStart": "Inizio dell’orario di lavoro",
  "settings.key.mail.schedule.hoursEnd": "Fine dell’orario di lavoro",
  "settings.key.mail.schedule.bufferMin": "Margine tra riunioni",
  "settings.key.mail.schedule.focusTime": "Proponi tempo di concentrazione",
  "settings.key.mail.schedulingLink": "Link di pianificazione",
  "settings.key.mail.poll.activeMin": "Controllo posta quando sei attivo",
  "settings.key.mail.poll.idleMin": "Controllo posta altrimenti",
  "settings.key.meetings.prep.enabled": "Preparazione riunione",
  "settings.key.meetings.prep.scope": "Solo riunioni con persone esterne al mio dominio",
  "settings.key.meetings.prep.leadMin": "Anticipo della preparazione",
  "settings.key.meetings.prep.notifyMin": "Anticipo dell’avviso di preparazione",
  "settings.key.meetings.prep.saveToNotes": "Salva la preparazione anche in Note",
  "settings.key.meetings.prep.dailyCap": "Massimo di preparazioni al giorno",
  "settings.key.meetings.notes.enabled": "Note delle riunioni dalle registrazioni",
  "settings.key.meetings.notes.folder": "Cartella delle registrazioni",
  "settings.key.meetings.notes.tasksApp": "Aggiungi le azioni a",
  "settings.key.meetings.notes.recapDraft": "Scrivi una bozza di email di riepilogo",
  "settings.key.meetings.notes.consentLine": "Frase di consenso alla registrazione",
  "settings.key.meetings.notes.cloudSummary": "Riassumi con un modello cloud",

  // Onboarding decision screen
  "onboarding.step.mail": "Posta e riunioni",
  "onboarding.mail.title": "{name} può tenerti aggiornato su posta e riunioni",
  "onboarding.mail.lead":
    "Scegli cosa vuoi. Nulla parte finché non continui, e puoi cambiare tutto in Impostazioni.",
  "onboarding.mail.digest": "Riepilogo mattutino della posta alle 7:30",
  "onboarding.mail.digestHint":
    "Un riepilogo al giorno di ciò che richiede la tua attenzione. Non invia mai nulla.",
  "onboarding.mail.prep":
    "Note di preparazione prima delle riunioni con persone esterne al tuo team",
  "onboarding.mail.prepHint": "Chi sono, cosa è in sospeso, di cosa avete parlato l’ultima volta.",
  "onboarding.mail.followups": "Tieni traccia delle risposte che aspetti",
  "onboarding.mail.followupsHint": "Mostrato solo nel riepilogo. Nessuna notifica a parte.",
  "onboarding.mail.voice": "Impara il mio stile di scrittura dalla posta inviata",
  "onboarding.mail.voiceHint":
    "Legge solo ciò che hai scritto, senza testo citato né firme. Resta su questo Mac e puoi mostrarlo, modificarlo o ripristinarlo.",
  "onboarding.mail.notes": "Note delle riunioni dalle registrazioni",
  "onboarding.mail.notesHint":
    "Non fa nulla finché non aggiungi dell’audio. Audio e trascrizioni non vengono mai caricati né usati per l’addestramento.",
  "onboarding.mail.summary":
    "{n, plural, =0 {Niente attivato} one {# cosa attivata} other {# cose attivate}}",
  "onboarding.mail.done": "Posta e riunioni",
  "onboarding.mail.doneOff": "Disattivato. Puoi attivarlo in Impostazioni.",
  "onboarding.mail.doneOn": "{n, plural, one {# flusso attivo} other {# flussi attivi}}",
};
