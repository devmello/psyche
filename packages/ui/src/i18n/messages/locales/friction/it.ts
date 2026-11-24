import type { Catalogue } from "../../index.ts";

/** Approval-friction and person-interaction strings (it); merged into `../it.ts`. */
export const friction: Partial<Catalogue> = {
  "friction.title": "Attrito delle approvazioni",
  "friction.hint":
    "Quante volte Psyche si ferma a chiedere prima di agire e come rispondi. Solo conteggi, dal registro di controllo.",
  "friction.window": "Periodo",
  "friction.window.days": "Ultimi {days} giorni",
  "friction.loading": "Conteggio delle approvazioni…",
  "friction.error": "Impossibile caricare l’attrito delle approvazioni: {reason}",
  "friction.retry": "Riprova",
  "friction.empty":
    "Psyche non ha controllato azioni in questo periodo, quindi non c’è nulla da mostrare.",
  "friction.since": "Dal {date}",
  "friction.asked":
    "Chiesto per {asks, plural, one {# azione} other {# azioni}} su {decisions, plural, one {# azione controllata} other {# azioni controllate}} ({rate}%).",
  "friction.perRun":
    "Le esecuzioni che hanno chiesto almeno una volta hanno avuto in media {n} richieste ciascuna.",
  "friction.answered":
    "Delle richieste concluse, il {rate}% ha ricevuto risposta prima di scadere.",
  "friction.approved": "Delle richieste concluse, il {rate}% è stato approvato.",
  "friction.noTimes":
    "In questo periodo nessuna richiesta ha ricevuto risposta, quindi non c’è un tempo di risposta.",
  "friction.times":
    "La risposta ha richiesto in mediana {p50}. Il decimo più lento ha richiesto {p90} o più.",
  "friction.expired":
    "{n, plural, =0 {Nessuna richiesta è scaduta senza risposta.} one {# richiesta è scaduta senza risposta.} other {# richieste sono scadute senza risposta.}}",
  "friction.rejected":
    "{n, plural, =0 {Nessuna risposta è stata rifiutata.} one {# risposta è stata rifiutata perché non valida.} other {# risposte sono state rifiutate perché non valide.}}",
  "friction.saved":
    "{n, plural, =0 {Nessuna azione è passata con un permesso permanente senza conferma.} one {# azione è passata con un permesso permanente senza conferma.} other {# azioni sono passate con un permesso permanente senza conferma.}}",
  "friction.grantsCreated":
    "{n, plural, =0 {Non è stato creato alcun permesso permanente.} one {È stato creato # permesso permanente.} other {Sono stati creati # permessi permanenti.}}",
  "friction.kinds": "Da dove venivano le richieste",
  "friction.kind.row":
    "{kind}: chiesto {asks}, approvato {approved}, rifiutato {declined}, scaduto {expired}",
  "friction.rules": "Motivi più comuni per chiedere",
  "friction.rule.row": "{label}: {count}",
  "friction.rule.mode": "La tua impostazione di modalità",
  "friction.rule.taint": "Contenuto esterno",
  "friction.rule.policy": "La tua politica",
  "friction.rule.designated": "Un luogo protetto",
  "friction.rule.site": "Una regola del sito",
  "friction.rule.other": "Un’altra regola",
  "friction.modes": "Per modalità",
  "friction.mode.row": "{mode}: chiesto {asks} su {decisions}",

  "people.interactions.title": "Interazioni recenti",
  "people.interactions.empty": "Nessuna interazione con {name} per ora.",
  "people.interactions.error": "Impossibile caricare le interazioni: {reason}",
  "people.interactions.more": "Mostra altro",
  "people.interactions.loadingMore": "Caricamento…",
};
