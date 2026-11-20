import type { Catalogue } from "../../index.ts";

/** Computers Psyche can use (it); merged into `../it.ts`. */
export const machines: Partial<Catalogue> = {
  "machines.title": "Computer che Psyche può usare",
  "machines.description":
    "Computer Linux che hai abbinato perché Psyche vi usi app, comandi e file mentre tu continui a usare questo.",
  "machines.empty":
    "Dai a Psyche un computer Linux su cui lavorare, così può usarvi app, comandi e file mentre tu continui a usare questo.",
  "machines.add": "Aggiungi un computer Linux",
  "machines.add.description":
    "Psyche lavora su quel computer mentre tu continui a usare questo. Le azioni lì seguono le tue impostazioni di approvazione.",
  "machines.add.account": "Quale account deve usare Psyche lì?",
  "machines.add.account.own": "Il tuo account (consigliato)",
  "machines.add.account.ownHint":
    "Psyche può usare lì i tuoi file, le tue app e i tuoi accessi, come te. Non ottiene mai root.",
  "machines.add.account.dedicated": "Un account psyche separato",
  "machines.add.account.dedicatedHint":
    "Psyche vede solo i file e le app di quell'account. Non ha sudo né password.",
  "machines.add.needsNetwork":
    "Gli altri computer non riescono ancora a raggiungere questo. Attiva prima l'accesso remoto o l'accesso dalla rete locale in Impostazioni → Server e accesso remoto.",
  "machines.add.make": "Mostra i comandi",
  "machines.add.again": "Crea nuovi comandi",
  "machines.add.commands": "Comandi per il computer Linux",
  "machines.add.installStep": "1. Sul computer Linux, installa l'assistente",
  "machines.add.pairStep": "2. Avvia lì l'abbinamento",
  "machines.add.expires": "Il link funziona una volta sola e scade {when}.",
  "machines.add.waiting": "In attesa che il computer si abbini…",
  "machines.add.paired": "{name} è abbinato. Psyche può usarlo ora.",
  "machines.add.pairedToast": "{name} è stato aggiunto",
  "machines.add.done": "Fatto",
  "machines.copy": "Copia",
  "machines.status.online": "Online",
  "machines.status.offline": "Offline",
  "machines.status.degraded": "Richiede attenzione",
  "machines.display.headless": "Schermo privato",
  "machines.display.desktopSession": "Un desktop tutto suo",
  "machines.display.container": "Contenitore",
  "machines.thisComputer": "Questo computer",
  "machines.watch": "Guarda",
  "machines.watchNamed": "Guarda {name}",
  "machines.apps": "Accesso alle app",
  "machines.appsNamed": "Accesso alle app su {name}",
  "machines.folders": "Cartelle",
  "machines.foldersNamed": "Cartelle su {name}",
  "machines.rename.action": "Rinomina",
  "machines.rename.named": "Rinomina {name}",
  "machines.rename.label": "Nuovo nome per {name}",
  "machines.rename.save": "Salva",
  "machines.rename.cancel": "Annulla",
  "machines.remove": "Rimuovi",
  "machines.removeTitle": "Rimuovere {name}?",
  "machines.removeDescription":
    "Psyche smette subito di usare {name} e l'abbinamento viene revocato. Per usarlo di nuovo, abbinalo di nuovo.",
  "machines.err.nameTaken":
    "Un altro computer ha già questo nome, oppure è riservato. Scegline un altro.",
  "machines.err.nameInvalid":
    "Questo nome non è utilizzabile. Usa lettere, numeri e punteggiatura normali, fino a 64 caratteri, e non mescolare lettere simili.",
  "machines.err.forbidden":
    "Rinominare richiede un dispositivo amministratore. Riprova da uno di essi.",
  "machines.err.failed": "Non ha funzionato ({reason}). Non è cambiato nulla.",
  "machines.account.own":
    "Gira con il tuo account su {name}. Psyche può usare lì i tuoi file, le tue app e i tuoi accessi, come te. Se il tuo Psyche venisse mai compromesso, potrebbe esserlo anche per un malintenzionato, tranne che per root, che Psyche non ottiene mai.",
  "machines.account.dedicated":
    "Gira con un account separato su {name}. Psyche vede solo i file e le app di quell'account.",
  "machines.account.useSeparate": "Usa invece un account separato…",
  "machines.account.useSeparateHint":
    "Su {name}, esegui di nuovo il programma di installazione con l'opzione per l'account separato, poi abbinalo di nuovo:",
  "machines.shell.contained": "I comandi girano in una shell isolata",
  "machines.shell.full": "I comandi girano nella shell completa dell'account",
  "machines.shell.off": "I comandi sono disattivati",
  "machines.limits.folders":
    "{count, plural, =0 {Nessuna cartella concessa} one {# cartella concessa} other {# cartelle concesse}}",
  "machines.helperVersion": "Assistente {version}",
  "machines.helperVersionUnknown": "Versione dell'assistente sconosciuta",
  "machines.update": "È disponibile un assistente più recente. Aggiorna l'assistente su {name}:",
  "machines.warnings": "Avvisi per {name}",
  "machines.warn.fullShell":
    "Shell completa dell'account. I comandi non sono isolati, quindi raggiungono tutto ciò che raggiunge questo account.",
  "machines.warn.userLimits":
    "I limiti appartengono all'utente. Qualsiasi programma eseguito con questo account può cambiare ciò che Psyche può fare su {name}.",
  "machines.warn.sudo":
    "Questo account ha sudo senza password. Psyche non può usare sudo qui, ma altri programmi che esegui con questo account sì.",
  "machines.paired": "Abbinato {when}",
  "machines.line": "Su «{name}» · Linux · {place}",
  "machines.place.screen": "schermo privato",
  "machines.place.desktop": "il suo desktop",
  "machines.place.command": "comando",
  "machines.place.files": "file",
  "machines.step.on": "{label} su {name}",
  "machines.picker.title": "Computer",
  "machines.picker.description":
    "Scegli per quale computer valgono queste impostazioni e dove lavora Psyche quando non ne guardi uno in particolare.",
  "machines.picker.show": "Mostra l'accesso alle app di",
  "machines.picker.default": "Computer predefinito per il lavoro in background",
  "machines.picker.defaultHint":
    "Attività e automazioni girano lì, a meno che non indichino un computer. Scegli un computer Linux perché Psyche lavori laggiù mentre tu lavori qui.",
  "machines.picker.appsOn": "App su {name}",
  "machines.picker.appsHint":
    "Psyche le sincronizza con {name} e non va mai oltre i limiti propri di quel computer.",
  "machines.picker.noApps":
    "Psyche non ha ancora visto app su {name}. Compariranno qui appena ne vedrà.",
  "machines.picker.offline": "{name} è offline. Le modifiche lo raggiungono quando si riconnette.",
  "computerWatch.titleMachine": "{name} · schermo privato",
  "computerWatch.machineOffline": "Impossibile raggiungere {name}. Riprovo…",
  "computerWatch.empty.bodyMachine":
    "Quando l'agente avrà bisogno di uno schermo su {name}, potrai guardarlo qui.",
  "notice.machine.working.title": "Psyche sta lavorando su {name}",
  "notice.machine.working.body":
    "Sta usando lo schermo, le app o i file di quel computer. Guardalo da Impostazioni → Dispositivi.",
  "notice.machine.offline.title": "{name} è andato offline",
  "notice.machine.offline.body":
    "Psyche non può usarlo finché non si riconnette. Le attività che ne hanno bisogno aspettano te.",
  "machines.add.linkStep": "3. Quando chiede il link, incolla questo",
  "machines.add.installSource":
    "Scarica il pacchetto dell'assistente da {url}, decomprimilo ed esegui questo sul computer Linux.",
  "machines.reports": "{name} segnala:",
  "computerWatch.machineLoading": "Caricamento del computer…",
  "computerWatch.machineMissing": "Quel computer non è disponibile.",
  "settings.key.computerUse.defaultMachine": "Computer predefinito per il lavoro in background",
  "settings.key.computerUse.machineApps": "Accesso alle app su un computer Linux",
};
