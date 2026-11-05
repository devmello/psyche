import type { Catalogue } from "../../index.ts";

/** Linux access in Settings → Computer use (it); merged into `../it.ts`. */
export const linuxAccess: Partial<Catalogue> = {
  "settings.computerUse.linux.screen.name": "Accesso a schermo e input",
  "settings.computerUse.linux.screen.allowed": "Consentito finché non lo revochi",
  "settings.computerUse.linux.screen.asks": "Chiede la prima volta che lo usi",
  "settings.computerUse.linux.screen.notNeeded": "Non necessario su X11",
  "settings.computerUse.linux.screen.unavailable": "Non disponibile",
  "settings.computerUse.linux.screen.why":
    "{persona} vede il tuo schermo e usa mouse e tastiera tramite la finestra di autorizzazione del tuo desktop. La approvi una sola volta.",
  "settings.computerUse.linux.revoke": "Revoca",
  "settings.computerUse.linux.revokeLabel": "Revoca l'accesso a schermo e input",
  "settings.computerUse.linux.warning.x11":
    "Su X11 qualsiasi app può leggere il tuo schermo e i tasti che premi, compresa la password quando approvi qualcosa.",
  "settings.computerUse.linux.warning.wlroots":
    "Su questo desktop qualsiasi app può leggere il tuo schermo e scrivere al posto tuo senza chiedere. Psyche non può aggiungere un passaggio di consenso.",
  "settings.computerUse.linux.accessibility":
    "Le app aperte da ora in poi espongono la loro struttura a Psyche. Quelle già aperte potrebbero richiedere un riavvio.",
  "settings.computerUse.linux.headless":
    "Serve una sessione grafica su questo computer. Accedi al desktop e riprova.",
};
