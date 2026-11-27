import type { Catalogue } from "../../index.ts";

/** Native dialogs and notifications (it); merged into `../it.ts`. */
export const desktopDialog: Partial<Catalogue> = {
  "desktop.dialog.notificationsOn": "Le notifiche sono attive.",
  "desktop.dialog.anotherCopyTitle": "Un’altra copia di Psyche è già in esecuzione",
  "desktop.dialog.anotherCopyDetail":
    "Viene eseguita da {path}. Usare questa copia fa passare Psyche a questa app; l’altra copia si collegherà quindi a questa.",
  "desktop.dialog.keepOtherCopy": "Tieni l’altra copia",
  "desktop.dialog.useThisCopy": "Usa questa copia",
  "desktop.dialog.cancel": "Annulla",
  "desktop.dialog.ok": "OK",
  "desktop.dialog.shareFolderTitle": "Condividi una cartella con Psyche",
  "desktop.dialog.share": "Condividi",
  "desktop.dialog.gatewaysFileTitle": "Psyche non riesce a leggere i Gateway salvati",
  "desktop.dialog.gatewaysFileDetail":
    "{problem}. Psyche si avvia su {os, select, macos {questo Mac} windows {questo PC} other {questo computer}} e lascia il file com’è, così non si perde nessuna identità fissata. Correggi o rimuovi il file nella cartella dati di Psyche per usare il Gateway di un altro computer.",
  "desktop.dialog.stillRunningTitle": "Psyche è ancora in esecuzione",
  "desktop.dialog.stillRunningBody":
    "Attività e automazioni continuano. Apri Psyche dalla sua icona nell’area delle notifiche; fai clic destro su di essa per uscire.",
  "desktop.dialog.manualStepsTitle": "Un passo in più per completare la rimozione di Psyche",
  "desktop.dialog.uninstallTitle": "Disinstallare Psyche?",
  "desktop.dialog.uninstall": "Disinstalla",
  "desktop.dialog.uninstallAndDelete": "Elimina i dati e disinstalla",
  "desktop.dialog.uninstallItems":
    "{count, plural, one {# elemento verrà spostato} other {# elementi verranno spostati}} nel Cestino, incluso Psyche.app.",
  "desktop.dialog.uninstallDataFolder":
    "Anche la cartella dei dati {folder} verrà spostata nel Cestino.",
  "desktop.dialog.uninstallDataKept": "La cartella dei dati viene conservata.",
  "desktop.dialog.uninstallKeychain":
    "Verranno rimossi gli elementi del Portachiavi che Psyche conserva.",
  "desktop.dialog.uninstallKeychainKept":
    "Gli elementi del Portachiavi restano; se vuoi, rimuovili in Accesso Portachiavi.",
  "desktop.dialog.stopTitle":
    "Arrestare Psyche su {os, select, macos {questo Mac} windows {questo PC} other {questo computer}}?",
  "desktop.dialog.stopDetail":
    "Le sue automazioni e le attività pianificate si fermano finché non torni indietro. Lascialo in esecuzione per farle proseguire.",
  "desktop.dialog.stopButton":
    "Arresta Psyche su {os, select, macos {questo Mac} windows {questo PC} other {questo computer}}",
  "desktop.dialog.keepRunning": "Lascialo in esecuzione",
  "desktop.dialog.forgetTitle": "Dimenticare {name}?",
  "desktop.dialog.forgetDetail":
    "{origin}\n\nQuesto rimuove la chiave di questo computer per quel Gateway e tutto ciò che Psyche ha salvato qui per lui. {name} continuerà a mostrare questo computer finché qualcuno non lo rimuove lì.",
  "desktop.dialog.forgetButton": "Dimentica",
  "desktop.dialog.repairTitle": "Associare di nuovo {name}?",
  "desktop.dialog.repairDetail":
    "{origin}\n\nQuesto dimentica l’identità che Psyche aveva fissato per lui e la chiave di questo computer, quindi la prossima connessione fissa ciò che risponde a quell’indirizzo e chiede di associarsi come nuovo computer. Fallo solo se sai perché la sua identità è cambiata.",
  "desktop.dialog.repairButton": "Associa di nuovo",
  "desktop.dialog.claimTitle": "Configurare il server Psyche su {origin}?",
  "desktop.dialog.claimDetail":
    "Psyche verifica che il server conosca il codice di configurazione che hai digitato prima di fidarsi, e il server verifica che questo computer lo conosca prima di renderlo amministratore del server. Continua solo se hai appena installato tu quel server.",
  "desktop.dialog.setUp": "Configura",
  "desktop.dialog.addLanTitle": "{origin} è un Psyche di questa rete?",
  "desktop.dialog.addLanDetail":
    "Nome: {name}\n\nUn Psyche di questa rete usa un proprio certificato, che Psyche fissa invece di fidarsi di quello del sistema: controlla il certificato e la chiave del Gateway al primo collegamento e rifiuta qualsiasi altro in seguito. Scegli «Https semplice» solo per un server con un certificato normale (per esempio un reverse proxy con la tua CA). Non si condivide nulla finché il suo proprietario non approva questo computer lì.",
  "desktop.dialog.psycheOnNetwork": "Psyche su questa rete",
  "desktop.dialog.plainHttps": "Https semplice",
  "desktop.dialog.addLinkTitleLan": "Collegare Psyche a {origin} su questa rete?",
  "desktop.dialog.addLinkTitle": "Collegare Psyche a {origin}?",
  "desktop.dialog.addLinkDetail":
    "{external, select, yes {Questo link è stato aperto da un’altra app o da un sito web, non l’hai incollato tu. Continua solo se l’hai creato tu stesso su {os, select, macos {il Mac} windows {il PC} other {il computer}} che esegue Psyche.\n\n} other {}}Psyche si collegherà solo se quel Gateway dimostra questa identità:\n{fingerprint}\n\n{lan, select, yes {Usa un proprio certificato, non uno di cui il sistema si fida. Psyche lo mantiene fisso a quello che indica questo link ({pin}…) prima di inviare qualsiasi cosa, e rifiuta gli altri. Continua solo se il link arriva dal tuo {os, select, macos {Mac} windows {PC} other {computer}} su questa rete.\n\n} other {}}Il codice monouso del link permette poi a quel Gateway di approvare questo computer senza chiedere di nuovo, con l’accesso scelto dal suo proprietario al momento della creazione.",
  "desktop.dialog.addDetailKey":
    "Nome: {name}\nChiave annunciata: {key}…\n\nQuesto computer chiederà a quel Gateway di associarsi. Non si condivide nulla finché il suo proprietario non approva questo computer lì, e Psyche fissa l’identità del Gateway al primo collegamento.",
  "desktop.dialog.addDetailPlain":
    "Nome: {name}\n\nQuesto computer chiederà a quel Gateway di associarsi. Non si condivide nulla finché il suo proprietario non approva questo computer lì, e Psyche fissa l’identità del Gateway al primo collegamento.",
  "desktop.dialog.addGatewayButton": "Aggiungi Gateway",
};
