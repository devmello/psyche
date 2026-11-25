import type { Catalogue } from "../../index.ts";

/** `home.*` strings (it); merged into `../it.ts`. */
export const homeRest: Partial<Catalogue> = {
  "home.title": "Home",
  "home.needsYou": "Serve te",
  "home.today": "Oggi",
  "home.today.options": "Opzioni di Oggi",
  "home.suggestions": "Suggerimenti",
  "home.comingUp": "In arrivo",
  "home.comingUp.line": "{schedule} · {next}",
  "home.comingUp.open": "Apri {title} in Pianificate",
  "home.comingUp.more": "{n, plural, one {# altro in Pianificate} other {# altri in Pianificate}}",
  "home.goals": "Obiettivi",
  "home.keepInTouch": "Resta in contatto",
  "home.keepInTouch.people": "Persone",
  "home.ask.label": "Chiedi qualsiasi cosa a {name}",
  "home.ask.send": "Invia",
  "home.ask.failed": "Non è stato inviato: {reason}",
  "home.start.try": "Prova",
  "home.start.planWeek": "Pianifica la mia settimana",
  "home.start.planWeek.prompt":
    "Aiutami a pianificare questa settimana. Guarda cosa sta per arrivare e chiedimi cosa conta di più.",
  "home.start.brief": "Imposta un riepilogo del mattino",
  "home.start.brief.prompt":
    "Imposta per me un breve riepilogo del mattino nei giorni feriali. Chiedimi cosa dovrebbe includere.",
  "home.start.remember": "Parla di te a {name}",
  "home.start.remember.prompt":
    "Impara a conoscermi: fammi qualche domanda sul mio lavoro e su cosa vorrei che mi aiutassi a fare, e ricorda le risposte.",
  "home.showMore": "{n, plural, one {Mostra altro #} other {Mostra altri #}}",
  "home.showLess": "Mostra meno",
  "home.catchUp": "Recupera",
  "home.catchUp.hint": "Cosa scade e cosa si è mosso dall’ultima volta che hai guardato",
  "home.catchUp.open": "Apri {title}",
  "home.catchUp.source": "Da {source}",
  "home.catchUp.all": "Tutto il lavoro in scadenza",
  "home.catchUp.pending":
    "{n, plural, one {# nuovo elemento da confermare} other {# nuovi elementi da confermare}}",
  "home.ask.list": "Domande scadute",
  "home.ask.handedInLabel": "Segna “{title}” come consegnato",
  "home.ask.stillWorking": "Ci sto ancora lavorando",
  "home.ask.stillWorkingLabel": "Sto ancora lavorando a “{title}”",
  "home.more": "Altro",
  "home.more.pages": "Pagine",
  "home.more.brief": "Impostazioni del riepilogo",
  "home.more.memoryReview": "Revisione della memoria",
  "home.loadFailed": "Impossibile caricare {what}.",
};
