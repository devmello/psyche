import type { Catalogue } from "../../index.ts";

/** Windows variants of the sandbox PC, voice keys and platform terms, and Mac wording (it); merged into `../it.ts`. */
export const windowsPlatform202611: Partial<Catalogue> = {
  "blocks.details.runsNoHostSandbox":
    "su questo computer, senza sandbox: qui non ce n’è una per i comandi",
  "blocks.execHost.noHostSandbox":
    "Su questo computer non c’è una sandbox per i comandi, quindi questo comando può essere eseguito solo senza. Digita {word} per eseguirlo questa volta.",
  "blocks.execHost.mustTypeOnly": "Digita {word} per consentirlo.",
  "settings.uninstall.stopSandboxPc":
    "Il servizio del PC sandbox viene rimosso. Windows chiede una volta l’approvazione dell’amministratore.",
  "settings.computerUse.tcc.microphone.name": "Microfono",
  "settings.computerUse.tcc.microphone.why":
    "permette a Psyche di sentirti per la dettatura e gli appunti delle riunioni",
  "settings.sandbox.restart.reopen": "Chiudi Psyche e riaprilo.",
  "settings.sandbox.pc.title": "Attiva il PC sandbox",
  "settings.sandbox.pc.body":
    "srt, la sandbox leggera di Psyche per i comandi, non funziona su Windows. Qui script, server di comandi e connettori creati da Psyche girano invece nel Privacy e sicurezza → Uso del computer → Modalità VM: un piccolo computer Linux dedicato, senza accesso ai tuoi file. Attivalo in Impostazioni → PC sandbox, poi controlla di nuovo.",
  "settings.sandbox.pc.notReady.title": "Il PC sandbox non è ancora pronto",
  "settings.sandbox.pc.notReady.body":
    "È attivato, ma non è ancora in esecuzione, oppure il Psyche al suo interno è obsoleto. Avvialo o aggiornalo in Impostazioni → Privacy e sicurezza → Uso del computer → Modalità VM, poi controlla di nuovo.",
  "settings.sandbox.pc.ready":
    "Il PC sandbox è attivo: script, server di comandi e connettori creati da Psyche girano al suo interno.",
  "settings.sandbox.pc.open": "Apri le impostazioni del PC sandbox",
  "settings.sandbox.pc.where":
    "Si trova in Impostazioni → Privacy e sicurezza → Uso del computer → Modalità VM.",
  "settings.devices.platform.windows": "PC Windows",
  "settings.devices.nodeKind.winHelper": "Helper Windows",
  "settings.devices.thisPcAdmin":
    "Questo PC è il dispositivo amministratore. Un altro dispositivo amministratore può revocarlo qui.",
  "settings.devices.presenceKey.windowsHello":
    "Chiave Windows Hello ({algorithm}), come segnalata dall’helper",
  "settings.devices.presenceKey.windowsHelloNoAlgorithm":
    "Chiave Windows Hello, come segnalata dall’helper",
  "settings.shortcut.reserved.windowsKey": "Windows (scorciatoie con il tasto Windows)",
  "settings.shortcut.reserved.windowMenu": "il menu delle finestre",
  "settings.shortcut.reserved.closeApp": "la chiusura delle app",
  "settings.shortcut.reserved.taskManager": "Gestione attività",
  "settings.shortcut.reserved.startMenu": "il menu Start",
  "settings.shortcut.reserved.securityScreen": "la schermata di sicurezza di Windows",
  "settings.shortcut.key.Super": "Tasto Windows",
  "settings.shortcut.useDefault": "Usa il predefinito",
  "settings.quickEntry.title": "Inserimento rapido",
  "settings.key.quickEntry.shortcut": "Scorciatoia",
  "settings.quickEntry.shortcutHint":
    "Apre la chat a comparsa da qualsiasi app. Se non scegli altri tasti, Psyche usa {keys}, oppure {fallback} quando un’altra app li occupa.",
  "settings.voice.key.rightCtrl": "Ctrl destro",
  "settings.voice.key.rightAlt": "Alt destro",
  "settings.voice.key.rightShift": "Maiusc destro",
  "settings.voice.key.rightWin": "Tasto Windows destro",
  "settings.voice.key.capsLock": "Blocco maiuscole",
  "settings.voice.key.scrollLock": "Scroll Lock",
  "settings.voice.key.pause": "Pausa",
  "settings.voice.key.menu": "Tasto Menu",
  "settings.voice.key.insert": "Ins",
  "settings.voice.key.numLock": "Bloc Num",
  "settings.voice.key.other": "Un altro tasto",
  "settings.voice.key.press": "Premi un tasto",
  "settings.voice.key.pressNow": "Premi il tasto da tenere premuto…",
  "settings.voice.key.cantUse":
    "Quel tasto scrive testo, quindi non può essere tenuto premuto per parlare. Prova con Ctrl destro, Blocco maiuscole, Pausa, il tasto Menu o da F13 a F24.",
  "settings.voice.key.capsLockHint":
    "Il Blocco maiuscole mantiene il suo stato attivo o disattivo: tenerlo premuto per parlare non lo cambia, mentre un tocco rapido lo commuta comunque.",
  "settings.voice.key.altGrWarning":
    "Con il layout della tastiera, Alt destro è AltGr, che scrive caratteri come @ o €. Tenerlo premuto per parlare può interferire con la loro digitazione; Ctrl destro è più sicuro.",
  "settings.voice.access.windowsWhy":
    "osserva il tasto che tieni premuto e scrive nell’app attiva. Windows non richiede alcun permesso per questo; alle app avviate come amministratore non arriva il testo dettato.",
  "settings.voice.model.title": "Modello vocale",
  "settings.voice.model.usingHelper":
    "La dettatura usa il riconoscimento vocale dell’helper. Il modello vocale trascrive meglio e funziona su questo Mac.",
  "settings.voice.model.download": "Scarica il modello vocale ({mb} MB) per una dettatura migliore",
  "settings.voice.model.downloadHint":
    "Un download unico dal progetto whisper.cpp, verificato prima dell’uso. L’audio non lascia mai questo Mac.",
  "settings.voice.model.downloading": "Download del modello vocale: {received} di {total} MB",
  "settings.voice.model.ready": "Whisper ({model}) su questo Mac",
  "settings.voice.model.readyHint":
    "Dettatura e registrazioni vengono trascritte qui; l’audio non lascia mai il Mac.",
  "settings.voice.model.readyNotFirst":
    "Installato. L’ordine dei motori mette un altro motore per primo, quindi la dettatura per ora non lo usa.",
  "settings.voice.model.failed": "Il download non è riuscito: {reason}",
  "settings.voice.model.retry": "Riprova",
  "settings.voice.model.vcredist":
    "Il modello vocale richiede Microsoft Visual C++ Redistributable. Installalo, poi detta di nuovo.",
  "settings.voice.model.crashed":
    "Il motore vocale si è fermato inaspettatamente; la dettatura usa l’helper finché non riparte.",
  "settings.sandboxPc.title": "Attiva il PC sandbox",
  "settings.sandboxPc.explain":
    "{persona} riceve un piccolo PC Linux privato che gira dentro Windows. Le attività vengono eseguite lì invece che sul tuo PC e vedono solo le cartelle che condividi.",
  "settings.sandboxPc.oneTime":
    "Configurazione una tantum: Windows chiede una volta l’approvazione dell’amministratore per aggiungere un servizio in background che fa girare il PC. Poi Psyche scarica l’immagine del PC ({download}, {disk} su disco). Nient’altro richiede un amministratore.",
  "settings.sandboxPc.oneTimeNoSize":
    "Configurazione una tantum: Windows chiede una volta l’approvazione dell’amministratore per aggiungere un servizio in background che fa girare il PC. Poi Psyche scarica l’immagine del PC. Nient’altro richiede un amministratore.",
  "settings.sandboxPc.turnOn": "Attiva il PC sandbox",
  "settings.sandboxPc.cancelDownload": "Annulla download",
  "settings.sandboxPc.waitingAdmin": "In attesa della richiesta dell’amministratore…",
  "settings.sandboxPc.restarting": "Completamento della configurazione…",
  "settings.sandboxPc.downloading": "Download dell’immagine del PC: {received} di {total}",
  "settings.sandboxPc.progressLabel": "Download dell’immagine del PC",
  "settings.sandboxPc.ready": "Configurato",
  "settings.sandboxPc.readyText": "Il PC sandbox è configurato. Versione {version}.",
  "settings.sandboxPc.unsupported": "Il PC sandbox non è disponibile qui: {reason}.",
  "settings.sandboxPc.failed": "Il PC sandbox non si è potuto attivare: {reason}",
  "settings.sandboxPc.failedDid": "Non è stato cambiato nient’altro. Puoi riprovare.",
  "settings.sandboxPc.gb": "{value, number} GB",
  "settings.sandboxPc.mb": "{value, number} MB",
  "settings.sandboxPc.loadLabel": "PC sandbox",
  "settings.sandboxPc.onboarding": "PC sandbox",
  "settings.sandboxPc.onboardingHint":
    "Facoltativo: un PC Linux privato per le attività che non devono toccare i tuoi file. Puoi configurarlo più tardi nelle impostazioni.",
  "settings.sandboxPc.update.title": "Aggiorna il servizio del PC sandbox",
  "settings.sandboxPc.update.explainCompatible":
    "Questa versione di Psyche include un servizio PC sandbox più recente di quello installato. Il PC sandbox continua a funzionare come prima.",
  "settings.sandboxPc.update.explainRequired":
    "Questa versione di Psyche non può usare il servizio PC sandbox installato. Il PC sandbox resta spento finché non lo aggiorni.",
  "settings.sandboxPc.update.available": "Aggiornamento disponibile",
  "settings.sandboxPc.update.required": "Aggiornamento necessario",
  "settings.sandboxPc.update.versions":
    "Installata: {installed}. Questa versione di Psyche: {bundled}.",
  "settings.sandboxPc.update.oneStep":
    "Windows chiede una volta l’approvazione dell’amministratore. Un PC sandbox in esecuzione viene fermato mentre il servizio viene sostituito.",
  "settings.sandboxPc.update.button": "Aggiorna il servizio del PC sandbox",
  "settings.sandboxPc.update.failed": "Il servizio del PC sandbox non è stato aggiornato: {reason}",
  "settings.sandboxPc.update.failedDid": "Non è stato cambiato nient’altro. Puoi riprovare.",
  "settings.sandboxPc.controls.title": "Il PC sandbox",
  "settings.sandboxPc.controls.hint": "Crealo una volta, poi avvialo e fermalo qui.",
  "settings.sandboxPc.controls.create": "Crea il PC sandbox",
  "settings.sandboxPc.controls.start": "Avvia",
  "settings.sandboxPc.controls.stop": "Ferma",
  "settings.sandboxPc.controls.resume": "Riprendi",
  "settings.sandboxPc.controls.working": "In corso…",
  "settings.sandboxPc.controls.helperOffline":
    "L’helper Windows non è in esecuzione o non ha ancora il PC sandbox, quindi non può essere controllato. Riavvia l’helper in Impostazioni → Dispositivi.",
  "settings.sandboxPc.controls.failed": "Non ha funzionato: {reason}",
  "settings.sandboxPc.controls.waitForImage": "Completa prima l’attivazione qui sopra.",
  "settings.sandboxPc.snapshots.title": "Snapshot",
  "settings.sandboxPc.snapshots.hint":
    "Salva il disco del PC sandbox per tornarci in seguito. Deve essere fermato per salvare o ripristinare.",
  "settings.sandboxPc.snapshots.none": "Ancora nessuno snapshot.",
  "settings.sandboxPc.snapshots.save": "Salva uno snapshot",
  "settings.sandboxPc.snapshots.saveFresh": "Salva come PC nuovo",
  "settings.sandboxPc.snapshots.reset": "Ripristina il PC nuovo",
  "settings.sandboxPc.snapshots.restore": "Ripristina",
  "settings.sandboxPc.snapshots.delete": "Elimina",
  "settings.sandboxPc.snapshots.fresh": "PC nuovo",
  "settings.sandboxPc.snapshots.item": "{label}, {when}",
  "settings.sandboxPc.snapshots.stopFirst": "Ferma prima il PC sandbox.",
  "onboarding.connectors.windowsHint":
    "Su Windows, {name} legge la posta, il calendario e i contatti tramite un account Microsoft, Google o IMAP.",
  "web.about.windowsArm": "Arm64",
  "web.about.windowsX64": "x64",
  "web.about.windowsBuild": "build {build}",
  "platform.term.os": "macOS",
  "platform.term.device": "Mac",
  "platform.term.thisDevice": "Questo Mac",
  "platform.term.thisDeviceLower": "questo Mac",
  "platform.term.presence": "Touch ID",
  "platform.term.secretStore": "Portachiavi",
  "platform.term.systemSettings": "Impostazioni di Sistema",
  "platform.term.fileManager": "Finder",
  "platform.term.trayArea": "barra dei menu",
  "platform.term.taskbar": "Dock",
  "platform.term.systemSearch": "Spotlight",
  "platform.term.helper": "helper Mac",
  "platform.term.terminal": "Terminale",
  "platform.term.alt": "Opzione",
  "platform.term.mod": "Comando",
  "platform.macOnly": "Disponibile su macOS",
  "platform.macOnlyHint": "{name} richiede un Mac. Psyche su macOS può usarlo.",
  "platform.windows.access.title": "Accesso di Windows",
  "platform.windows.access.hint": "Cosa permette Windows a Psyche e cosa ti chiede.",
  "platform.windows.access.noPermission": "Nessun permesso necessario",
  "platform.windows.access.uiAutomation.name": "Uso delle app",
  "platform.windows.access.uiAutomation.why":
    "{persona} legge e usa le finestre delle app tramite l’automazione dell’interfaccia di Windows. Windows non gli permette di controllare le app avviate come amministratore.",
  "platform.windows.access.screen.name": "Acquisizione dello schermo",
  "platform.windows.access.screen.why":
    "Windows non richiede alcun permesso per acquisire lo schermo. Le finestre di Psyche e i campi password sono nascosti nelle acquisizioni.",
  "platform.windows.access.microphone.name": "Microfono",
  "platform.windows.access.microphone.why":
    "Per la dettatura e gli appunti delle riunioni. Windows lo chiede in Impostazioni → Privacy e sicurezza → Microfono, con «Consenti alle app desktop di accedere al microfono» attivo.",
  "platform.windows.access.openSettings": "Apri Impostazioni",
  "platform.windows.access.openSettingsFor": "Apri le impostazioni di Windows per {name}",
  "platform.windows.access.state.granted": "Attivo",
  "platform.windows.access.state.denied": "Disattivo nelle impostazioni di Windows",
  "platform.windows.access.state.not_determined": "Non ancora verificato",
  "platform.helper.restart": "Riavvia l’helper",
  "platform.helper.restarting": "Riavvio in corso…",
  "platform.helper.restartFailed": "L’helper non si è avviato ({reason}).",
};
