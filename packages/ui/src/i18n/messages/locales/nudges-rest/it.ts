import type { Catalogue } from "../../index.ts";

/** `nudges.*` strings (it); merged into `../it.ts`. */
export const nudgesRest: Partial<Catalogue> = {
  "nudges.kind": "Resta in contatto",
  "nudges.draftReply": "Prepara una risposta",
  "nudges.draftMessage": "Prepara un messaggio",
  "nudges.snooze": "Posticipa",
  "nudges.snoozeWeek": "Per una settimana",
  "nudges.snoozeMonth": "Per un mese",
  "nudges.mutePerson": "Non questa persona",
  "nudges.done": "Fatto",
  "nudges.overdue": "Scaduto",
  "nudges.moreActions": "Altri modi per metterlo da parte: {name}",
  "nudges.result.done": "Segnato come fatto.",
  "nudges.result.snooze_week": "Posticipato di una settimana.",
  "nudges.result.snooze_month": "Posticipato di un mese.",
  "nudges.result.mute_person":
    "Niente più promemoria per {name}. Puoi riattivarli dalla sua pagina.",
  "nudges.gone": "Qui non resta più nulla da fare.",
  "nudges.failed": "Non è stato salvato: {reason}",
  "nudges.draft.unanswered":
    "Aiutami a rispondere a {name}. L’ultimo suo {channel, select, mail {messaggio email} other {messaggio}} per me risale a {days} giorni fa e non ho risposto. Guarda la conversazione, poi prepara una risposta breve che possa leggere. Non inviare nulla.",
  "nudges.draft.drift":
    "Non parlo con {name} da un po’. Prepara un messaggio breve e cordiale che potrei inviare per rimetterci in pari. Non inviare nulla.",
  "nudges.draft.birthday":
    "Manca poco al giorno speciale di {name} ({date}). Prepara un messaggio breve e cordiale che potrei inviare. Non inviare nulla.",
  "nudges.draft.promise":
    "{text} Aiutami a dare seguito: prepara un breve messaggio per {name} a riguardo. Non inviare nulla.",
  "nudges.starters.title": "Spunti di conversazione",
  "nudges.draft.starters":
    "Spunti che potrei tirare fuori, in base a ciò che Psyche ha in archivio (usa solo questi e non inventare altro):",
  "nudges.settings.phrasing": "Riformula i suggerimenti con il mio modello",
  "nudges.settings.phrasingHint":
    "Usa il modello scelto per la memoria di tutto per esprimerli con parole più amichevoli. Disattivato per impostazione predefinita.",
  "nudges.person.title": "Resta in contatto",
  "nudges.person.none": "Niente da seguire.",
  "nudges.person.muted": "I promemoria per {name} sono disattivati.",
  "nudges.person.unmute": "Riattiva i promemoria",
  "nudges.settings.title": "Restare in contatto",
  "nudges.settings.description":
    "Promemoria discreti su persone con cui hai perso i contatti, compleanni e promesse che hai fatto.",
  "nudges.settings.enabled": "Ricordami di restare in contatto",
  "nudges.settings.enabledHint":
    "Fino a tre nel riepilogo del mattino, più schede discrete nel Feed. Non viene mai inviato nulla al tuo posto.",
  "nudges.settings.sensitivity": "Con che frequenza",
  "nudges.settings.sensitivityHint": "Quanto aspetta un messaggio prima che Psyche dica qualcosa.",
  "nudges.settings.low": "Con calma",
  "nudges.settings.normal": "Normale",
  "nudges.settings.high": "Premuroso",
  "nudges.settings.quietHours":
    "Le schede aspettano che finiscano le ore di silenzio in Impostazioni → Generali → Notifiche.",
  "nudges.consent.title": "Attivare i promemoria sulle relazioni?",
  "nudges.consent.body":
    "Psyche guarderà quando hai scritto o ricevuto notizie per l’ultima volta dalle persone con cui scambi messaggi (solo le date, non il contenuto), i compleanni che hai confermato e le promesse che hai fatto con parole tue.",
  "nudges.consent.rules":
    "Le persone che hai escluso non compaiono mai, i fatti sensibili non vengono mai usati e un promemoria è una frase semplice con un nome e un numero di giorni. Puoi silenziare chiunque con “Non questa persona” e disattivare tutto quando vuoi.",
  "nudges.consent.confirm": "Attiva",
  "nudges.consent.cancel": "Non ora",
};
