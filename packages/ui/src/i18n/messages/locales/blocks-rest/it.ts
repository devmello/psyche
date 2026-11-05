import type { Catalogue } from "../../index.ts";

/** `blocks.*` strings (it); merged into `../it.ts`. */
export const blocksRest: Partial<Catalogue> = {
  "blocks.lifeAnswer.label": "Risposta dalla tua posta, dai messaggi e dai file",
  "blocks.message.receipt":
    "{status, select, approved {Consentito{scope, select, task { per questa attività} site { per questo sito} session { per questa sessione} always { sempre} other { una volta}}} denied {Negato} expired {Scaduto} invalidated {Annullato} other {{status}}}: {summary}",
  "blocks.message.showDetails": "Dettagli",
  "blocks.message.hideDetails": "Nascondi dettagli",
  "blocks.message.showDetailsOf": "Mostra i dettagli di {summary}",
  "blocks.message.hideDetailsOf": "Nascondi i dettagli di {summary}",
  "blocks.details.requestedFolder": "Richiesto",
  "blocks.details.folderReason": "Motivo",
  "blocks.details.folderAccess": "Accesso",
  "blocks.details.folderAccess.ro": "Sola lettura",
  "blocks.details.folderAccess.rw": "Lettura e scrittura",
  "blocks.folder.title": "Cartella da condividere",
  "blocks.folder.choose": "Scegli cartella…",
  "blocks.folder.change": "Scegli un’altra cartella…",
  "blocks.folder.blocked":
    "{path} non può essere condivisa: contiene dati privati o è una cartella di sistema. Scegli un’altra cartella.",
  "blocks.folder.notFound":
    "Psyche non ha trovato nessuna cartella in {path}. Scegli la cartella da condividere.",
  "blocks.folder.pickTitle": "Condividi una cartella con {persona}",
  "blocks.folder.pickError": "Impossibile aprire il selettore di cartelle: {error}",
  "blocks.folder.pathLabel": "Percorso della cartella",
  "blocks.folder.mustPick": "Scegli la cartella da condividere prima di consentire.",
  "blocks.folder.scope":
    "“Solo questa chat” dura fino alla fine della conversazione. “Sempre” mantiene la cartella finché non la rimuovi in Impostazioni → Permessi → Accesso.",
  "blocks.folder.scope.once": "Solo questa chat",
  "blocks.folder.scope.always": "Sempre, questa cartella e quelle al suo interno",
  "blocks.folder.explain.ro": "{persona} vuole leggere i file di una cartella.",
  "blocks.folder.explain.rw": "{persona} vuole leggere e modificare i file di una cartella.",
  "blocks.folder.readOnly": "Consenti solo la lettura, senza modificare nulla",
  "blocks.message.to": "Invio a",
  "blocks.message.pick": "Scegli a chi inviare",
  "blocks.message.group": "Chat di gruppo · {count, plural, one {# persona} other {# persone}}",
  "blocks.message.weak":
    "SMS o RCS: a garantire per questo numero è l’operatore, non Apple. Controllalo.",
  "blocks.message.service.imessage": "iMessage",
  "blocks.message.service.sms": "SMS",
  "blocks.message.service.rcs": "RCS",
  "blocks.message.service.unknown": "Servizio sconosciuto",
  "blocks.message.text": "Messaggio",
  "blocks.message.textLabel": "Testo del messaggio, puoi modificarlo prima di inviarlo",
  "blocks.message.exact":
    "Viene inviato esattamente questo testo, esattamente a questo destinatario.",
  "blocks.message.empty": "Scrivi qualcosa da inviare.",
  "blocks.message.untrusted":
    "Questo destinatario è stato suggerito da un contenuto letto da Psyche, non da te. Controlla chi è prima di inviare.",
  "blocks.folder.exact": "Viene condivisa solo questa cartella e ciò che contiene.",
  "blocks.details.executable": "Programma",
  "blocks.details.network": "Rete",
  "blocks.details.networkNone": "nessuna",
  "blocks.details.runsSandboxed":
    "sul tuo Mac, nella sandbox: non può leggere il vault di Psyche, le tue chiavi SSH, i portachiavi né i profili del browser",
  "blocks.details.runsNoSandbox": "sul tuo Mac, e la sandbox non è configurata ({reason})",
  "blocks.details.needed": "Necessario",
  "blocks.details.neededWhy": "Motivo",
  "blocks.execHost.sandboxed":
    "Viene eseguito nella sandbox. Per eseguire questo solo comando senza sandbox, digita {word} qui sotto.",
  "blocks.execHost.noSandbox":
    "La sandbox non è configurata, quindi questo comando può essere eseguito solo senza. Configurala, oppure digita {word} per eseguirlo senza sandbox solo questa volta.",
  "blocks.execHost.setUp": "Configura sandbox",
  "blocks.execHost.typeLabel": "Digita {word} per eseguire senza sandbox",
  "blocks.execHost.unsandboxedOnce": "Senza sandbox è disponibile solo “Consenti una volta”.",
  "blocks.execHost.mustType": "Digita {word} per consentire, oppure configura prima la sandbox.",
  "blocks.permission.need.capability": "Attiva “Esegui comandi su questo Mac”",
  "blocks.permission.need.connector_action":
    "Fai in modo che {connector} ti chieda prima di {group} (ora è su Nega)",
  "blocks.permission.need.connector": "Collega {connector}",
  "blocks.permission.need.macos_access":
    "Dai accesso a {connector} nelle Impostazioni di Sistema di macOS",
  "blocks.permission.need.sandbox": "Configura la sandbox per i comandi",
  "blocks.permission.need.folder": "Una cartella: {path}",
  "blocks.permission.enableHint":
    "Attivare modifica le tue impostazioni finché non lo disattivi in Impostazioni. Ogni azione ti chiede comunque conferma.",
  "blocks.permission.checkHint":
    "Sistemalo, poi scegli Ricontrolla: Psyche verifica e lo comunica alla chat.",
  "blocks.permission.enable": "Attiva",
  "blocks.permission.checkAgain": "Ricontrolla",
  "blocks.permission.openConnectors": "Apri Connettori",
  "blocks.permission.openSystemSettings": "Apri Impostazioni di Sistema",
  "blocks.permission.setUpSandbox": "Configura sandbox",
  "blocks.approval.scope.prepNotes": "Sempre per le note di preparazione",
  "blocks.liftFloor.title": "Consentire senza chiedere?",
  "blocks.liftFloor.what": "{persona} può {what} senza chiedere.",
  "blocks.liftFloor.consequence.destructive":
    "Gli elementi eliminati potrebbero non essere recuperabili.",
  "blocks.liftFloor.consequence.send":
    "Messaggi ed email partono a tuo nome e non si possono annullare.",
  "blocks.liftFloor.consequence.financial":
    "Il denaro speso e i pagamenti effettuati potrebbero non essere rimborsabili.",
  "blocks.liftFloor.still":
    "{persona} chiede comunque dopo aver letto contenuti non attendibili, e ogni volta in modalità Manuale. Puoi cambiarlo in Impostazioni.",
  "blocks.liftFloor.confirm": "Consenti senza chiedere",
  "blocks.liftFloor.cardWhat": "rifare questo ({summary})",
  "blocks.approval.taintSentence":
    "In precedenza, in questa chat, {persona} {what}{onlyOnce, select, true {, quindi è disponibile solo “Consenti una volta”} other {}}.",
  "blocks.approval.taintRead": "ha letto {list}",
  "blocks.approval.taintUsed": "ha usato {list}",
  "blocks.approval.taintOther":
    "{first, select, true {ha letto contenuti non attendibili} other {altri contenuti non attendibili}}",
  "blocks.approval.taintTranscript": "una trascrizione",
  "blocks.approval.taintAnd": "{head} e {last}",
  "blocks.approval.taintDetails": "Fonti non attendibili",
  "blocks.approval.allowScope": "Consenti per",
  "blocks.approval.sideEffect.none": "si limita a guardare",
  "blocks.approval.sideEffect.read": "legge informazioni",
  "blocks.approval.sideEffect.write": "modifica qualcosa",
  "blocks.approval.sideEffect.destructive":
    "modifica impostazioni o dati che potrebbero essere difficili da ripristinare",
  "blocks.approval.sideEffect.financial": "riguarda denaro",
  "blocks.approval.whyMode": "La modalità {mode} chiede prima di quando {effect}.",
  "blocks.details.params": "Dettagli",
  "blocks.details.reason": "Motivo",
  "blocks.approval.answerOnHost":
    "Rispondi su {host}, oppure configura Touch ID per le approvazioni su questo computer in Impostazioni → Dispositivi.",
  "blocks.approval.rateLimited": "Troppe approvazioni in un minuto. Riprova tra {seconds} s.",
  "blocks.approval.touchIdFailed": "Touch ID non riuscito: {reason}. Riprova.",
  "blocks.approval.touchIdFailedNoReason": "Touch ID non riuscito. Riprova.",
  "blocks.approval.touchIdInvalid": "Psyche non ha potuto verificare che fossi tu",
  "blocks.approval.touchId.helperOffline":
    "Psyche Helper non è in esecuzione, quindi Touch ID non può confermare da qui.",
  "blocks.approval.touchId.helperOutdated":
    "Questo Psyche Helper è troppo vecchio per confermare le approvazioni da questa finestra. Aggiorna Psyche e riprova.",
  "blocks.approval.touchId.noKey":
    "Touch ID non è ancora configurato per le approvazioni su questo Mac. Configuralo in Impostazioni → Dispositivi, dove puoi prima verificare la chiave.",
  "blocks.approval.touchId.invalidated":
    "Touch ID è cambiato dopo la configurazione della chiave di questo Mac, quindi non può confermare le approvazioni. Configuralo di nuovo in Impostazioni → Dispositivi.",
  "blocks.approval.touchId.noUnsandboxed":
    "Eseguire un comando senza sandbox non può essere approvato con Touch ID da questa finestra. Configura invece la sandbox",
  "blocks.approval.touchId.openDevices": "Apri Impostazioni → Dispositivi",
  "blocks.approval.touchId.code": "Codice {code}",
  "blocks.approval.touchId.onceOnly":
    "Le approvazioni con Touch ID da questa finestra valgono una sola volta.",
  "blocks.approval.status.allowedOnceTouchId":
    "Consentito una volta (le approvazioni con Touch ID da questa finestra valgono una sola volta)",
  "blocks.approval.touchId.keyUntrusted":
    "La chiave Touch ID dell’helper di Psyche nel portachiavi non si può dimostrare sua, quindi non è stata usata. Apri Impostazioni → Dispositivi per vedere cosa fare.",
  "blocks.approval.touchId.keyAccessDenied":
    "macOS non ha permesso all’helper di Psyche di usare la sua chiave Touch ID. Riprova e scegli Consenti sempre solo se la finestra nomina psyche-helper.",
  "blocks.approval.touchId.keyChanged":
    "La chiave Touch ID è cambiata mentre l’helper di Psyche era in esecuzione. Esci dall’helper di Psyche e riavvialo.",
  "blocks.approval.touchId.keyWrongLocation":
    "Psyche è in esecuzione da un posto in cui la sua chiave Touch ID non può essere conservata (immagine disco, Download o un’altra cartella). Sposta Psyche in Applicazioni e aprilo da lì.",
  "blocks.approval.touchId.keyLocked":
    "Il portachiavi non può chiedere il permesso in questo momento. Sblocca il Mac e riprova.",
  "blocks.approval.touchId.keyAclUnavailable":
    "Il portachiavi non ha conservato l’elenco di accesso della chiave Touch ID su questo Mac. Riavvia l’helper di Psyche per riprovare.",
  "blocks.approval.touchId.keyUnavailable":
    "Questa build di Psyche Helper non può conservare una chiave Touch ID (non ha un gruppo di accesso al portachiavi), quindi le schede che richiedono Touch ID non possono essere approvate su questo Mac.",
  "blocks.approval.touchId.cancelled":
    "Touch ID è stato annullato, quindi non è stato approvato nulla",
  "blocks.approval.touchId.startHelper": "Avvia Psyche Helper",
  "blocks.question.answerLine": "↳ {answer}",
  "blocks.sources.label": "Fonti",
  "blocks.sources.open": "Apri {title}",
  "blocks.sources.untitled": "Senza titolo",
  "blocks.sources.show": "Mostra la fonte",
  "blocks.sources.hide": "Nascondi la fonte",
  "blocks.sources.untrusted": "Da qualcun altro. Trattato come dato, non come istruzione.",
  "blocks.sources.kind.mail": "Mail",
  "blocks.sources.kind.messages": "Messaggi",
  "blocks.sources.kind.notes": "Note",
  "blocks.sources.kind.calendar": "Calendario",
  "blocks.sources.kind.library": "Libreria",
  "blocks.sources.kind.other": "{source}",
  "blocks.appLink.open": "Apri {where}",
  "blocks.appLink.settings": "Impostazioni: {section}",
  "blocks.markdown.taskDone": "Fatto",
  "blocks.markdown.taskOpen": "Da fare",
  "blocks.workflow.label": "Pianifica questo flusso di lavoro",
  "blocks.workflow.title": "Pianificare “{title}”?",
  "blocks.workflow.runs":
    "{count, plural, one {# esecuzione pianificata} other {# esecuzioni pianificate}}",
  "blocks.workflow.runOf": "{name} · {when} ({timezone})",
  "blocks.workflow.does": "Cosa fa",
  "blocks.workflow.approvals": "Ti chiederà di approvare",
  "blocks.workflow.noApprovals": "Nessuna approvazione necessaria.",
  "blocks.workflow.notify":
    "{how, select, messages {Ti avvisa in Messaggi} both {Ti avvisa con una notifica e in Messaggi} other {Ti avvisa con una notifica}} quando ha bisogno di te.",
  "blocks.workflow.obstacles": "Da sapere",
  "blocks.workflow.tainted":
    "È stato pianificato dopo aver letto contenuti dal web o da un connettore. Controlla i passaggi prima di pianificare.",
  "blocks.workflow.skillOffer": "Dopo posso anche salvare questi passaggi come skill.",
  "blocks.workflow.confirm": "Pianifica",
  "blocks.workflow.decline": "Non ora",
  "blocks.workflow.scheduling": "Pianificazione…",
  "blocks.workflow.done":
    "{count, plural, one {Pianificata # esecuzione} other {Pianificate # esecuzioni}}. Le trovi in Attività.",
  "blocks.workflow.declined": "Non pianificato.",
  "blocks.workflow.failed": "Impossibile pianificare. Controlla gli orari e riprova.",
  "blocks.details.skillAction": "Azione",
  "blocks.details.skillActionValue":
    "{action, select, update {Modificare una skill creata da {persona}} delete {Eliminare una skill creata da {persona}} other {Aggiungere una nuova skill scritta da {persona}}}",
  "blocks.details.name": "Nome",
  "blocks.details.skillText": "Istruzioni",
  "blocks.details.skillTextView": "Mostra il testo completo",
  "blocks.details.connector.runtime": "Esecuzione",
  "blocks.details.connector.runtimeValue":
    "{persona} ha scritto questo connettore (versione {version})",
  "blocks.details.connector.command": "Comando",
  "blocks.details.connector.network": "Chiede di raggiungere",
  "blocks.details.connector.networkNone": "Nessuna rete",
  "blocks.details.connector.tools": "Strumenti",
  "blocks.details.connector.files": "Codice ({n} file)",
  "blocks.details.connector.file": "{path} ({bytes} byte)",
  "blocks.details.connector.provided": "fornito da Psyche",
  "blocks.details.connector.diff": "Modifiche dalla versione {version}",
  "blocks.details.connector.suggested": "{persona} suggerisce questo connettore dal registro",
};
