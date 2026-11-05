import type { Catalogue } from "../../index.ts";

/** The Linux helper check in Settings → Devices (it); merged into `../it.ts`. */
export const helperCheck: Partial<Catalogue> = {
  "settings.devices.helperCheck.title": "Controllo dell'assistente Linux",
  "settings.devices.helperCheck.description":
    "Quando l'assistente Linux si connette, Psyche controlla quale programma è davvero.",
  "settings.devices.helperCheck.state.verified": "Verificato: assistente installato nel sistema",
  "settings.devices.helperCheck.state.userOwned":
    "Non verificato: assistente dalla tua cartella personale",
  "settings.devices.helperCheck.state.unverified":
    "Non verificato: Psyche non è riuscito a controllare l'assistente",
  "settings.devices.helperCheck.detail.verified":
    "È l'assistente installato con Psyche. Solo il sistema può modificarlo.",
  "settings.devices.helperCheck.detail.userOwned":
    "Viene eseguito da file tuoi, come un AppImage o una build nella tua cartella personale. Psyche lo accetta, ma non può escludere che un altro tuo programma l'abbia sostituito.",
  "settings.devices.helperCheck.detail.unverified":
    "Per ora Psyche lo accetta, ma non è riuscito a capire di quale programma si tratti.",
  "settings.devices.helperCheck.refused": "Rifiutato: {reason}",
  "settings.devices.helperCheck.reason.unclear": "Psyche non è riuscito a verificare l'assistente",
  "settings.devices.helperCheck.reason.notHelper": "questo programma non è l'assistente di Psyche",
  "settings.devices.helperCheck.reason.userCopy":
    "è una copia fuori dall'installazione di sistema e serve l'assistente installato",
  "settings.devices.helperCheck.reason.loaderEnv":
    "è stato avviato con un percorso di librerie o una libreria precaricata",
  "settings.devices.helperCheck.reason.foreignCode": "ha codice caricato dall'esterno del sistema",
  "settings.devices.helperCheck.reason.severalPrograms":
    "più di un programma condivide la sua connessione",
  "settings.devices.helperCheck.reason.handedOver":
    "la sua connessione gli è stata passata da un altro programma",
  "settings.devices.helperCheck.reason.stillStarting": "era ancora in fase di avvio",
  "settings.devices.helperCheck.reason.debugged": "è fermo o in fase di debug",
  "settings.devices.helperCheck.reason.restartNeeded":
    "è stato sostituito o una libreria di sistema è stata aggiornata dall'avvio; riavvia l'assistente",
  "settings.devices.helperCheck.reason.filesNotLocked":
    "i suoi file potrebbero essere modificati da qualcuno che non è il sistema",
  "settings.devices.helperCheck.reason.otherNamespace":
    "viene eseguito in una sandbox separata di questo computer",
  "settings.devices.helperCheck.reason.busy":
    "Psyche era impegnato a controllare altre connessioni; l'assistente riproverà",
  "settings.devices.nodeKind.hostHelper": "Assistente di questo computer",
  "settings.devices.nodeKind.guest": "Desktop separato",
};
