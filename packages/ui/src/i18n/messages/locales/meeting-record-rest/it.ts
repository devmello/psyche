import type { Catalogue } from "../../index.ts";

/** `meetingRecord.*` strings (it); merged into `../it.ts`. */
export const meetingRecordRest: Partial<Catalogue> = {
  "meetingRecord.palette": "Registra riunione…",
  "meetingRecord.title": "Registrare questa riunione?",
  "meetingRecord.intro":
    "Avvisa tutti prima di iniziare. Dillo a voce o incollalo nella chat. Psyche non entra mai in una chiamata e registra solo dopo la tua conferma.",
  "meetingRecord.copy": "Copia",
  "meetingRecord.copied": "Copiato",
  "meetingRecord.confirm": "Ho avvisato tutti",
  "meetingRecord.cancel": "Annulla",
  "meetingRecord.privacy":
    "L’audio resta nel tuo Psyche, viene trasformato in note lì, e non viene mai caricato altrove né usato per l’addestramento.",
  "meetingRecord.unavailable":
    "Per registrare serve un modo per trasformare l’audio in note (l’helper del Mac), e non è collegato.",
  "meetingRecord.micDenied":
    "Psyche non può usare il microfono. Consentilo in Impostazioni di Sistema.",
  "meetingRecord.failed": "Psyche non è riuscito a registrare questa riunione.",
  "meetingRecord.pill": "Registrazione riunione · {time}",
  "meetingRecord.stop": "Interrompi",
  "meetingRecord.stopping": "Salvataggio…",
  "meetingRecord.notes.processing": "Scrittura delle note…",
  "meetingRecord.notes.done": "Le note sono pronte in Home.",
  "meetingRecord.notes.needs_permission": "Le note aspettano il tuo OK per usare un modello cloud.",
  "meetingRecord.notes.failed": "Psyche non è riuscito a scrivere le note da questa registrazione.",
};
