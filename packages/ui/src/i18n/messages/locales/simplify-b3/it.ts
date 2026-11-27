import type { Catalogue } from "../../index.ts";

/** Onboarding finish, recovery key and searchable switch (it); merged into `../it.ts`. */
export const simplifyB3: Partial<Catalogue> = {
  "onboarding.done.start": "Inizia a chattare",
  "onboarding.done.psycheLabel": "Psyche",
  "onboarding.done.psycheWait":
    "Al momento non è possibile raggiungere Psyche. Questa finestra si ricollega da sola.",
  "onboarding.done.helperWait":
    "Psyche Helper non è ancora connesso. Il controllo del computer e le notifiche partono quando lo sarà.",
  "onboarding.connectors.searchable": "Rendi ricercabili",
  "onboarding.connectors.searchableHint":
    "{name} può trovare mail, eventi e note di questi account nella ricerca. Puoi disattivarne qualcuno nelle Impostazioni.",
  "home.recoveryKey.title": "Salva la tua chiave di recupero",
  "home.recoveryKey.body":
    "È l'unico modo per rientrare nel caveau dopo un ripristino o se perdi la chiave. Mostrala, conserva una copia in un posto sicuro, poi conferma.",
  "settings.credentials.vault.recoveryKey.show": "Mostra la chiave di recupero",
  "settings.credentials.vault.recoveryKey.hide": "Nascondi",
  "settings.credentials.vault.recoveryKey.gone":
    "La chiave di recupero di questo caveau è stata mostrata solo alla sua creazione, quindi non può essere mostrata di nuovo.",
  "settings.credentials.vault.recoveryKey.failed":
    "Impossibile mostrare la chiave di recupero: {reason}",
  "settings.credentials.vault.recoveryKey.title": "Chiave di recupero",
  "settings.credentials.vault.recoveryKey.body":
    "L'unico modo per rientrare nel caveau dopo un ripristino o se perdi la chiave. Conserva una copia in un posto sicuro.",
};
