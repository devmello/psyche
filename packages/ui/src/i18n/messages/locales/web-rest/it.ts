import type { Catalogue } from "../../index.ts";

/** `web.*` strings (it); merged into `../it.ts`. */
export const webRest: Partial<Catalogue> = {
  "web.remotePresence.title": "Touch ID per le approvazioni",
  "web.remotePresence.description":
    "Acquisti, inserimento di credenziali, comandi sull’host e modifiche di sicurezza richiedono Touch ID. Configuralo su questo computer per rispondere da qui; fino ad allora quelle schede dicono di rispondere su {host}. Le approvazioni normali non ne hanno mai bisogno.",
  "web.remotePresence.on": "Touch ID è attivo per le approvazioni da questo computer.",
  "web.remotePresence.off": "Touch ID non è configurato su questo computer.",
  "web.remotePresence.enable": "Usa Touch ID per le approvazioni su questo computer",
  "web.remotePresence.disable": "Disattiva",
  "web.remotePresence.waiting": "In attesa di Touch ID…",
  "web.remotePresence.passkeyName": "Touch ID su questo computer",
  "web.remotePresence.enabled": "Touch ID è attivo per le approvazioni da questo computer.",
  "web.remotePresence.disabled": "Touch ID per le approvazioni è disattivato su questo computer.",
  "web.remotePresence.approveOnHost":
    "Approva “Aggiungi una passkey” su {host}, con Touch ID o una passkey, poi premi di nuovo il pulsante.",
  "web.remotePresence.unavailable":
    "Touch ID richiede il Gateway di {host} a un indirizzo https:// (gateway.publicOrigin). Fino ad allora, rispondi a quelle schede su {host}.",
  "web.touchId.helperDidNotStart":
    "Psyche Helper non si è collegato. Apri Impostazioni → Dispositivi per capire perché, poi riprova.",
  "web.panes.title.sidechat": "Chat secondaria",
  "web.sideChat.about": "Chat secondaria su {parent}",
  "web.sideChat.aside": "Chat secondaria",
  "web.sideChat.expand": "Espandi",
  "web.sideChat.expandTitle": "Apri questa chat a schermo intero",
  "web.terminal.ended": "sessione terminata",
  "web.terminal.waitingApproval": "In attesa della tua approvazione…",
  "web.terminal.approvalDenied": "Il terminale non è stato approvato.",
  "web.terminal.approvalTimedOut":
    "L’approvazione non è arrivata in tempo. Apri di nuovo il terminale.",
  "web.terminal.openOnHost": "Apri il terminale su {host}.",
  "web.terminal.limit":
    "Ci sono troppi terminali aperti su {host}. Chiudine uno per aprirne un altro.",
  "web.approval.folderNone": "Nessuna cartella scelta",
  "web.approval.folderChoose": "Scegli cartella…",
  "web.approval.messageText": "Testo del messaggio, modificabile prima dell’invio",
  "web.approval.messageWeak": "SMS/RCS: identità debole, controllala",
  "web.approval.messageUntrusted":
    "Questo destinatario è stato suggerito da un contenuto letto da Psyche, non da te. Controllalo prima di inviare.",
  "web.approval.folderPath": "Percorso della cartella",
  "web.approval.folderPickTitle": "Condividi una cartella",
  "web.browser.stay.question": "Restare connesso a {site}?",
  "web.browser.stay.detail":
    "Psyche conserva questo accesso nel proprio profilo del browser così le attività possono usarlo. Tutti gli altri siti restano disconnessi.",
  "web.browser.stay.yes": "Resta connesso",
  "web.browser.prompt.notNow": "Non ora",
  "web.browser.vault.question": "Salvare l’accesso nel vault di Psyche?",
  "web.browser.vault.account": "{username} su {origin}",
  "web.browser.vault.passwordLabel": "Password",
  "web.browser.vault.save": "Salva accesso",
  "web.browser.vault.never": "Mai per questo sito",
  "web.browser.vault.error": "Impossibile salvare l’accesso ({code}). Sblocca il vault e riprova.",
  "web.chat.autoUnavailable":
    "Auto non è disponibile: {model} non è nell’elenco dei modelli consentiti per la modalità auto. Scegli un altro modello per usarla.",
  "web.toast.threadUpdateFailed":
    "Psyche non è riuscito a cambiare questa impostazione della chat.",
  "web.splash.remote.finding": "Ricerca di {host}…",
  "web.splash.remote.checking": "Verifica che sia davvero {host}…",
  "web.splash.remote.waiting": "In attesa dell’approvazione su {host}…",
  "web.splash.remote.pairCode": "Codice di abbinamento {code}",
  "web.splash.remote.pairKey": "Chiave del Gateway {fingerprint}",
  "web.splash.remote.pairHint":
    "Confronta entrambi con la richiesta in Impostazioni → Dispositivi di {host}, poi approvala lì.",
  "web.splash.remote.pairHintLan":
    "Confronta l’intera chiave con quella in Impostazioni → Dispositivi di {host}, sotto la richiesta di questo computer. In una rete, la chiave è l’unica prova di chi ha risposto. Approva solo se coincidono.",
  "web.splash.remote.unreachable": "{host} non risponde.",
  "web.splash.remote.unreachableReason":
    "Potrebbe essere in stop o spento, Psyche potrebbe non essere in esecuzione lì, oppure Tailscale potrebbe essere spento su questo computer. Psyche continua a riprovare.",
  "web.splash.remote.identity": "Questo non è l’{host} con cui hai fatto l’abbinamento.",
  "web.splash.remote.identityChanged":
    "La sua chiave di identità non è quella fissata da questo computer. Potrebbe rispondere un’altra macchina al suo posto, oppure è stato configurato di nuovo.",
  "web.splash.remote.identityMissing":
    "Non ha presentato una chiave di identità, quindi Psyche non si collegherà.",
  "web.splash.remote.identityInvalid":
    "La sua prova di identità non ha superato la verifica, quindi Psyche non si collegherà.",
  "web.splash.remote.identityOrigin":
    "Ha risposto per un indirizzo diverso da quello chiamato da questo computer. Su {host}, imposta l’indirizzo pubblico in Impostazioni → Dispositivi → Server e accesso remoto.",
  "web.splash.remote.certChanged":
    "Il suo certificato di rete non è quello fissato da questo computer. Potrebbe rispondere un’altra macchina di questa rete al suo posto, oppure il certificato è stato sostituito.",
  "web.splash.remote.certMissing":
    "Non ha garantito per il certificato usato, quindi Psyche non si collegherà.",
  "web.splash.remote.certInvalid":
    "La sua prova per il certificato usato non ha superato la verifica, quindi Psyche non si collegherà.",
  "web.splash.remote.olderHost": "{host} usa una versione più vecchia di Psyche.",
  "web.splash.remote.olderHostReason": "Aggiorna Psyche su {host}, poi riprova.",
  "web.splash.remote.olderApp": "Questa app è più vecchia di {host}.",
  "web.splash.remote.olderAppReason": "Aggiorna Psyche su questo computer, poi riprova.",
  "web.splash.remote.revoked": "Questo computer è stato rimosso da {host}.",
  "web.splash.remote.revokedReason": "Abbina di nuovo per usarlo da qui, oppure dimenticalo.",
  "web.splash.remote.tokenRefused": "{host} ha rifiutato questo link di abbinamento.",
  "web.splash.remote.tokenRefusedReason":
    "È già stato usato, è scaduto o è stato revocato. Creane uno nuovo su {host} e aggiungilo di nuovo.",
  "web.splash.remote.switch": "Cambia Gateway",
  "web.splash.remote.useThisMac": "Usa questo Mac",
  "web.splash.remote.pairAgain": "Dimentica e abbina di nuovo",
  "web.splash.remote.forget": "Dimentica {host}",
  "web.splash.remote.close": "Nascondi",
  "web.remote.connectedTo": "Connesso a {host}",
  "web.remote.switch": "Cambia…",
  "web.remote.thisMac": "Questo Mac",
  "web.remote.menuLabel": "Gateway",
  "web.remote.switcherLabel": "Connesso a {host}. Cambia Gateway.",
  "web.remote.manage": "Gateway…",
  "web.panes.title.terminalOn": "Terminale su {host}",
  "web.panes.terminalRemote":
    "Il terminale è in esecuzione su {host}. Questa finestra non ha ancora una shell.",
  "web.splash.remote.pinsUnreadable": "Psyche non riesce a leggere i Gateway salvati.",
  "web.splash.remote.pinsUnreadableReason":
    "Il file che ricorda l’identità di ogni Gateway non è leggibile, quindi Psyche non si collega senza. Non è stato modificato nulla.",
  "web.browser.remote": "Il browser è in esecuzione su {host}.",
  "web.browser.remoteHint":
    "Le attività del browser continuano in Psyche su {host}, che deve restare aperto lì.",
  "web.teach.record": "Registra",
  "web.teach.recordHint": "Mostra a Psyche come fare qualcosa in questa scheda",
  "web.teach.agentTab": "L’agente sta usando questa scheda. Apri una scheda tua per registrare.",
  "web.teach.startFailed": "Psyche non è riuscito ad avviare la registrazione di questa scheda.",
  "web.teach.bar.title": "Registrazione",
  "web.teach.bar.body":
    "Psyche annota i tuoi clic e ciò che digiti solo in questa scheda. Password, numeri di carta e codici non vengono mai registrati, e nulla lascia questo Mac finché non salvi.",
  "web.teach.bar.steps": "{count, plural, one {# passaggio} other {# passaggi}} finora",
  "web.teach.bar.stop": "Interrompi registrazione",
  "web.teach.bar.cancel": "Scarta",
  "web.teach.bar.endedLimit":
    "La registrazione si è fermata al limite di 200 passaggi. Controlla cosa ha catturato.",
  "web.teach.bar.endedInterrupted":
    "La registrazione è terminata in anticipo perché la scheda è cambiata o è stata chiusa. Controlla cosa ha catturato.",
  "web.teach.bar.review": "Controlla",
  "web.teach.stopFailed": "Psyche non è riuscito a terminare la registrazione.",
  "web.teach.nothingRecorded": "Non è stato registrato nulla.",
  "web.teach.review.keepUnavailable":
    "Non disponibile: il portachiavi di questo Mac non è disponibile per cifrare una registrazione conservata.",
  "web.teach.kept.title": "Registrazioni conservate",
  "web.teach.kept.open": "Apri",
  "web.teach.kept.delete": "Elimina",
  "web.teach.kept.deleted": "Registrazione eliminata.",
  "web.teach.kept.failed": "Psyche non è riuscito ad aprire quella registrazione.",
  "web.teach.review.title": "Controlla ciò che hai mostrato",
  "web.teach.review.intro":
    "Questi sono i passaggi che Psyche ha catturato, in parole semplici. Correggili, riordinali o rimuovili. Nulla viene salvato finché non premi Salva.",
  "web.teach.review.name": "Come dovrebbe chiamarsi?",
  "web.teach.review.namePlaceholder": "Esporta il report di fatturazione settimanale",
  "web.teach.review.skipped":
    "{count, plural, one {La pagina si è modificata da sola # volta durante la registrazione. È stato omesso.} other {La pagina si è modificata da sola # volte durante la registrazione. Sono stati omessi.}}",
  "web.teach.review.steps": "Passaggi",
  "web.teach.review.stepNumber": "Passaggio {n}",
  "web.teach.review.moveUp": "Sposta su il passaggio {n}",
  "web.teach.review.moveDown": "Sposta giù il passaggio {n}",
  "web.teach.review.remove": "Rimuovi il passaggio {n}",
  "web.teach.review.empty":
    "Tutti i passaggi sono stati rimossi. Annulla, oppure registra di nuovo.",
  "web.teach.review.sensitive":
    "Non registrato. Psyche ti passerà la scheda perché tu faccia questa parte da solo.",
  "web.teach.review.value": "Cosa digitare",
  "web.teach.review.value.ask": "Chiedimelo ogni volta",
  "web.teach.review.value.keep": "Conserva questo valore",
  "web.teach.review.value.input": "Rendilo un input",
  "web.teach.review.valueHidden": "L’esempio che hai digitato è nascosto e non verrà salvato.",
  "web.teach.review.valueKept": "Salvato con la skill: {value}",
  "web.teach.review.inputName": "Nome dell’input",
  "web.teach.review.inputDescription": "Di cosa si tratta",
  "web.teach.review.inputDescriptionPlaceholder": "Il primo giorno della settimana",
  "web.teach.review.keepRecording":
    "Conserva questa registrazione su questo Mac così posso creare un’altra versione",
  "web.teach.review.keepRecordingHint":
    "Vengono conservati solo i passaggi qui sopra, con i valori che hai scelto di conservare. Altrimenti la registrazione viene eliminata quando salvi.",
  "web.teach.review.save": "Salva come skill",
  "web.teach.review.saving": "Salvataggio",
  "web.teach.review.discard": "Scarta registrazione",
  "web.teach.review.privacy":
    "Il testo della pagina in questi passaggi è trattato come dato, mai come istruzione. Salvando, ti viene chiesto di approvare la skill prima che possa essere eseguita.",
  "web.teach.review.issues": "Correggi prima questo: {problems}",
  "web.teach.review.needName": "Dagli prima un nome.",
  "web.teach.review.saveFailed": "Psyche non è riuscito a salvarla come skill: {reason}",
  "web.teach.done.title": "Salvata",
  "web.teach.done.body":
    "“{title}” è in attesa della tua approvazione. Leggi la scheda, poi approvala per installare la skill.",
  "web.teach.done.installed": "“{title}” è installata.",
  "web.teach.done.run": "Eseguila una volta adesso",
  "web.teach.done.runHint":
    "Inserisce la skill nella casella del messaggio. Premi Invia, poi guarda il browser: ogni clic e inserimento chiede approvazione come al solito, e si ferma e chiede se la pagina è cambiata.",
  "web.teach.done.close": "Chiudi",
  "web.teach.step.navigate": "Apri {address}",
  "web.teach.step.click": "Fai clic su ‘{name}’",
  "web.teach.step.clickRole": "Fai clic su {role}",
  "web.teach.step.type": "Digita in ‘{name}’",
  "web.teach.step.typeKept": "Digita {value} in ‘{name}’",
  "web.teach.step.typeInput": "Digita {input} in ‘{name}’",
  "web.teach.step.typeAsk": "Digita in ‘{name}’ ciò che gli dici",
  "web.teach.step.typeSensitive": "Digiti tu stesso in ‘{name}’",
  "web.teach.step.typeUnnamed": "un campo",
  "web.teach.step.select": "Scegli un’opzione in ‘{name}’",
  "web.teach.step.selectKept": "Scegli {value} in ‘{name}’",
  "web.teach.step.selectInput": "Scegli {input} in ‘{name}’",
  "web.teach.step.selectAsk": "Scegli in ‘{name}’ ciò che gli dici",
  "web.teach.step.selectSensitive": "Scegli tu stesso in ‘{name}’",
  "web.teach.step.press": "Premi {key}",
  "web.teach.step.pressIn": "Premi {key} in ‘{name}’",
};
