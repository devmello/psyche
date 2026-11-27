import type { Catalogue } from "../../index.ts";

/** Privacy, Browser and About simplified copy (it); merged into `../it.ts`. */
export const simplifyB7: Partial<Catalogue> = {
  "simplify.b7.about.doctorDescription":
    "Controlla che Psyche, la sandbox, i permessi e il caveau funzionino.",
  "simplify.b7.doctor.psyche": "Psyche",
  "simplify.b7.browser.fromSetup":
    "Impostato dalla tua configurazione, quindi non modificabile qui.",
  "simplify.b7.browser.advancedHint":
    "Profilo Chrome, accessi da altri browser, registrazioni e porte di anteprima",
  "simplify.b7.permissions.advancedHint": "Revisione dei comandi in modalità Auto",
  "simplify.b7.updates.off":
    "Gli aggiornamenti sono disattivati per questa build. Per aggiornare, ricompila Psyche ed esegui pnpm app:install.",
};
