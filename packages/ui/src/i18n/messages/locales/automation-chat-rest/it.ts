import type { Catalogue } from "../../index.ts";

/** `automationChat.*` strings (it); merged into `../it.ts`. */
export const automationChatRest: Partial<Catalogue> = {
  "automationChat.label": "Esecuzioni di {title}",
  "automationChat.runs": "{n, plural, one {# esecuzione} other {# esecuzioni}}",
  "automationChat.runs.aria":
    "{title}, {n, plural, one {# esecuzione} other {# esecuzioni}}, ultima esecuzione {status}",
  "automationChat.schedule": "Pianificate",
  "automationChat.runNow": "Esegui ora",
  "automationChat.empty":
    "Ancora nessuna esecuzione. Ogni volta che questa automazione viene eseguita, compare qui.",
  "automationChat.loading": "Caricamento delle esecuzioni",
  "automationChat.failed": "Psyche non è riuscito a caricare le esecuzioni",
  "automationChat.more": "Mostra le esecuzioni meno recenti",
  "automationChat.status.needsYou": "Serve te",
  "automationChat.status.running": "In corso",
  "automationChat.trigger.manual": "Esegui ora",
  "automationChat.trigger.event": "Su un evento",
  "automationChat.coalesced": "{n} esecuzioni perse in una",
  "automationChat.noResult": "Nessun risultato scritto",
  "automationChat.noSteps": "Per questa esecuzione non è stato registrato alcun passaggio.",
  "automationChat.stepsLoading": "Caricamento dei passaggi",
  "automationChat.timeline": "Apri nella Timeline",
  "automationChat.approvals": "Apri approvazioni",
  "automationChat.waiting": "Questa esecuzione è in attesa di te.",
  "automationChat.result": "Risultato",
  "automationChat.openScheduled": "Apri in Pianificate",
  "automationChat.row.runs": "{n, plural, one {# esecuzione} other {# esecuzioni}}",
  "automationChat.row.last": "Ultima esecuzione: {status}",
};
