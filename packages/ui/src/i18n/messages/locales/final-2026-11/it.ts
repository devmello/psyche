import type { Catalogue } from "../../index.ts";

/** Signed connector bundles and teach-by-showing in Mac apps (it); merged into `../it.ts`. */
export const final202611: Partial<Catalogue> = {
  "settings.connectorBundle.title": "Connettore condiviso {name}",
  "settings.connectorBundle.intro":
    "Qualcuno ha condiviso questo connettore come file. Non è ancora stato installato nulla. Controlla chi l’ha creato e cosa richiede, poi decidi.",
  "settings.connectorBundle.update": "Questo è un aggiornamento del connettore che hai.",
  "settings.connectorBundle.signer.title": "Chi l’ha creato",
  "settings.connectorBundle.signer.unsigned":
    "Questo file non è firmato, quindi non c’è modo di sapere chi l’ha creato.",
  "settings.connectorBundle.signer.dropped": "La versione installata era firmata. Questa no.",
  "settings.connectorBundle.signer.new":
    "Firmato da {name}. Non hai mai visto prima questa chiave.",
  "settings.connectorBundle.signer.seen":
    "Firmato da {name}, con una chiave che hai già visto ma di cui non ti fidi.",
  "settings.connectorBundle.signer.trusted": "Firmato da {name}, un autore di cui ti fidi.",
  "settings.connectorBundle.signer.own": "Firmato da te.",
  "settings.connectorBundle.signer.changed":
    "Firmato da {name}, ma non con la chiave vista prima. Verifica che sia la stessa persona.",
  "settings.connectorBundle.signer.impersonates":
    "Firmato con un nome che somiglia al tuo, ma con una chiave che non è tua.",
  "settings.connectorBundle.signer.nameChanged":
    "Una chiave di cui ti fidi firma con un nome che non aveva mai usato: {name}.",
  "settings.connectorBundle.signer.revoked": "Firmato da una chiave che hai revocato.",
  "settings.connectorBundle.signer.rotated":
    "Firmato da {name}: stesso autore, chiave nuova (firmata dalla chiave precedente). La nuova chiave non è attendibile finché non decidi di fidartene.",
  "settings.connectorBundle.signer.claim":
    "Il nome è un’affermazione dell’autore stesso. Solo la chiave lo identifica.",
  "settings.connectorBundle.signer.key": "Chiave dell’autore",
  "settings.connectorBundle.signer.trust": "Considera {name} un autore attendibile",
  "settings.connectorBundle.signer.trustHint":
    "Questo cambia solo l’etichetta e gli avvisi dei file successivi. Non salta mai questa scheda.",
  "settings.connectorBundle.command": "Comando che esegue",
  "settings.connectorBundle.commandHint":
    "Prima il programma, poi ogni argomento su una riga a sé. Non viene eseguito tramite una shell.",
  "settings.connectorBundle.network": "Rete che richiede",
  "settings.connectorBundle.noNetwork": "Nessuna rete",
  "settings.connectorBundle.networkHint":
    "Solo la sandbox può farlo rispettare. L’elenco è ciò che dichiara l’autore.",
  "settings.connectorBundle.env": "Variabili che legge",
  "settings.connectorBundle.noEnv": "Nessuna",
  "settings.connectorBundle.envHint": "Solo i nomi. Darai loro i valori dopo l’installazione.",
  "settings.connectorBundle.secrets": "Segreti di cui ha bisogno",
  "settings.connectorBundle.noSecrets": "Nessuno",
  "settings.connectorBundle.secretsHint":
    "Solo i nomi. Il file non contiene alcun segreto. Dopo l’installazione darai un valore a ciascuno, e verrà conservato nella tua cassaforte.",
  "settings.connectorBundle.tools": "Strumenti che l’autore dichiara di elencare",
  "settings.connectorBundle.toolsCount": "{n, plural, one {# strumento} other {# strumenti}}",
  "settings.connectorBundle.toolsHint":
    "Psyche lo avvia nella sandbox ed elenca ciò che offre davvero. Contano quegli strumenti.",
  "settings.connectorBundle.toolsUndeclared":
    "Il server ha elencato strumenti che il file non aveva dichiarato: {names}",
  "settings.connectorBundle.toolsMissing":
    "Il file ha dichiarato strumenti che il server non ha elencato: {names}",
  "settings.connectorBundle.files": "Script inclusi ({n})",
  "settings.connectorBundle.file": "{path} · {bytes} B",
  "settings.connectorBundle.fileBinary": "Non è testo, quindi non può essere mostrato qui.",
  "settings.connectorBundle.findings": "Cosa hanno trovato i controlli",
  "settings.connectorBundle.finding.high": "Blocca l’installazione: {message}",
  "settings.connectorBundle.finding.warn": "Da controllare: {message}",
  "settings.connectorBundle.finding.info": "{message}",
  "settings.connectorBundle.sandbox.srt":
    "La prima esecuzione avviene nella sandbox. Psyche lo avvia lì per elencare i suoi strumenti, e continua a funzionare lì.",
  "settings.connectorBundle.sandbox.container":
    "La prima esecuzione avviene in un container sandbox. Psyche lo avvia lì per elencare i suoi strumenti, e continua a funzionare lì.",
  "settings.connectorBundle.sandbox.none":
    "Questo Mac non ha una sandbox per i connettori a comando, e Psyche non ne esegue mai uno al di fuori. Questo connettore non può essere installato qui. Non è stato avviato né salvato nulla.",
  "settings.connectorBundle.blocker.scan":
    "I controlli hanno trovato qualcosa che ne blocca l’installazione. Non è stato avviato né salvato nulla.",
  "settings.connectorBundle.blocker.probe_failed":
    "La prima esecuzione, senza rete e senza segreti, non è riuscita ad avviarlo. Non è stato salvato nulla.",
  "settings.connectorBundle.signer.ownRetired":
    "Firmato con una tua chiave che hai sostituito. Non viene più considerata tua.",
  "settings.connectorBundle.signer.retired":
    "Firmato da {name}, con una chiave sostituita da una rotazione che hai visto. Un nuovo file con questa firma è sospetto.",
  "settings.connectorBundle.carry.kept": "Valori che hai dato e che restano: {names}",
  "settings.connectorBundle.carry.cleared":
    "Valori che hai dato e che non vengono riportati, perché il firmatario o il comando è cambiato. Inseriscili di nuovo: {names}",
  "settings.connectorBundle.carry.vault":
    "I segreti che hai salvato in precedenza restano nella tua cassaforte, ma non vengono consegnati a questa versione.",
  "settings.connectorBundle.reset.title": "Se il registro dei connettori condivisi è danneggiato",
  "settings.connectorBundle.reset.hint":
    "I connettori provenienti da un file restano disattivati finché il loro registro non può essere letto. Questo mette da parte il registro danneggiato (ripristinando l’ultima copia buona, se c’è); quei connettori restano disattivati finché non li rimuovi o non li importi di nuovo.",
  "settings.connectorBundle.reset.go": "Reimposta il registro…",
  "settings.connectorBundle.reset.confirm": "Sì, reimposta",
  "settings.connectorBundle.reset.done":
    "Il registro è stato reimpostato. {restored, select, true {È stata ripristinata l’ultima copia buona.} other {Riparte vuoto.}}",
  "settings.connectorBundle.reset.failed": "Impossibile reimpostare il registro: {reason}",
  "settings.connectorBundle.hash": "ID del bundle",
  "settings.connectorBundle.close": "Chiudi",
  "settings.connectorBundle.widened.title": "Richiede più della versione che hai",
  "settings.connectorBundle.widened.hint":
    "Approvando questa scheda gli dai tutto questo. Una scheda per la versione più limitata non l’avrebbe coperto.",
  "settings.connectorBundle.widened.command": "Un comando diverso",
  "settings.connectorBundle.widened.commandValue": "Ora {now}. Prima: {before}",
  "settings.connectorBundle.widened.env": "Più variabili",
  "settings.connectorBundle.widened.secrets": "Più segreti",
  "settings.connectorBundle.widened.network": "Più rete",
  "settings.connectorBundle.widened.tools": "Più strumenti, o strumenti che possono fare di più",
  "settings.connectorBundle.widened.payload": "Script diversi",
  "settings.connectorBundle.widened.payloadValue": "I file inclusi sono cambiati",
  "settings.connectorBundle.diff": "Cosa è cambiato",
  "settings.connectorBundle.noChanges": "Nient’altro è cambiato.",
  "settings.connectorBundle.import.title": "Connettori condivisi",
  "settings.connectorBundle.import.hint":
    "Importa un connettore che qualcuno ti ha inviato come file o link. Vedi tutto ciò che richiede prima che venga installato qualsiasi cosa.",
  "settings.connectorBundle.import.file": "Importa un file di connettore",
  "settings.connectorBundle.import.linkLabel": "Oppure incolla un link a uno",
  "settings.connectorBundle.import.linkPlaceholder": "https://example.com/notes.psyche-connector",
  "settings.connectorBundle.import.review": "Esamina",
  "settings.connectorBundle.import.checking": "Controllo in corso…",
  "settings.connectorBundle.import.failed": "Impossibile importare il connettore: {reason}",
  "settings.connectorBundle.import.tooBig": "Quel file è troppo grande per essere un connettore.",
  "settings.connectorBundle.import.denied": "{name} non è stato installato.",
  "settings.connectorBundle.import.lapsed":
    "{expired, select, true {La scheda di {name} è scaduta.} other {La scheda di {name} non è più valida.}} Importalo di nuovo per esaminarlo.",
  "settings.connectorBundle.import.added":
    "{name} è stato aggiunto. Dagli qui sotto i segreti di cui ha bisogno, e potrà usarli.",
  "settings.connectorBundle.import.addedNoSecrets": "{name} è stato aggiunto.",
  "settings.connectorBundle.import.addFailed": "Impossibile aggiungere {name}: {reason}",
  "settings.connectorBundle.import.secretsTitle": "Segreti per {name}",
  "settings.connectorBundle.share.title": "Condividi questo connettore",
  "settings.connectorBundle.share.hint":
    "Crea un file firmato con il comando, i nomi delle sue variabili e dei suoi segreti, la rete che raggiunge e i suoi strumenti. Non viene mai incluso alcun valore. Prima confermi cosa ci va dentro.",
  "settings.connectorBundle.share.go": "Condividi…",
  "settings.connectorBundle.share.nameLabel": "Il tuo nome sui connettori condivisi",
  "settings.connectorBundle.share.nameHint":
    "Chiunque importi un tuo file vede questo nome. Viene chiesto una sola volta; la tua chiave di firma viene creata adesso.",
  "settings.connectorBundle.share.make": "Crea il file",
  "settings.connectorBundle.share.label": "Condividi {name}",
  "settings.connectorBundle.share.done":
    "Salvato {file}, firmato come {author}. Contiene solo nomi: nessun valore di variabile o di segreto.",
  "settings.connectorBundle.share.failed": "Impossibile condividere il connettore: {reason}",
  "settings.connectorBundle.share.unavailable":
    "Solo Psyche sul Mac che lo esegue può firmare un connettore.",
  "settings.skills.signer.ownRetired":
    "Firmato con una tua chiave che hai sostituito. Non viene più considerata tua.",
  "settings.skills.signer.retired":
    "Firmato da {name}, con una chiave sostituita da una rotazione che hai visto. Un nuovo file con questa firma è sospetto.",
  "settings.skills.signer.rotated":
    "Firmato da {name}: stesso autore, chiave nuova (firmata dalla chiave precedente). La nuova chiave non è attendibile finché non decidi di fidartene.",
  "settings.skills.author.state.seen": "Vista, non attendibile",
  "settings.skills.author.state.trusted": "Attendibile",
  "settings.skills.author.state.revoked": "Revocata",
  "settings.skills.keys.title": "La tua chiave d’autore e gli avvisi",
  "settings.skills.keys.hint":
    "La chiave che firma le skill e i connettori che condividi. Puoi sostituirla e pubblicare un avviso quando una chiave o un file non deve più essere considerato attendibile.",
  "settings.skills.keys.none":
    "Non hai ancora firmato nulla. La tua chiave viene creata la prima volta che condividi una skill o un connettore.",
  "settings.skills.keys.own": "Firma come {name}",
  "settings.skills.keys.fingerprint": "Chiave",
  "settings.skills.keys.rotate": "Sostituisci la mia chiave…",
  "settings.skills.keys.rotateHint":
    "Crea una nuova chiave con lo stesso nome. La vecchia chiave firma una dichiarazione che indica la nuova, così chi si fidava di te vede lo stesso autore con una chiave nuova. Devono comunque fidarsene da sé. Prima confermi.",
  "settings.skills.keys.rotateLabel": "Sostituisci la tua chiave d’autore",
  "settings.skills.keys.rotated": "La tua chiave è stata sostituita. La nuova chiave è {key}.",
  "settings.skills.keys.rotateFailed": "Impossibile sostituire la chiave: {reason}",
  "settings.skills.keys.notice.title": "Pubblica un avviso",
  "settings.skills.keys.notice.hint":
    "Un avviso è un piccolo file firmato. Invialo o ospitalo, e chiunque abbia già incontrato la tua chiave può importarlo per bloccare una chiave o un file.",
  "settings.skills.keys.notice.kindKey": "La mia chiave (quella attuale)",
  "settings.skills.keys.notice.kindBundle":
    "Un file che ho condiviso, tramite il suo ID del bundle",
  "settings.skills.keys.notice.kind": "Cosa non va",
  "settings.skills.keys.notice.hash": "ID del bundle (sha256:…)",
  "settings.skills.keys.notice.reason": "Perché (lo vede chiunque lo importi)",
  "settings.skills.keys.notice.make": "Crea l’avviso",
  "settings.skills.keys.notice.label": "Firma un avviso di revoca",
  "settings.skills.keys.notice.done": "Salvato {file}. Pubblicalo come preferisci.",
  "settings.skills.keys.notice.failed": "Impossibile creare l’avviso: {reason}",
  "settings.skills.keys.import.title": "Importa un avviso di revoca",
  "settings.skills.keys.import.hint":
    "Viene applicato solo se è firmato da un autore che hai già incontrato. Può solo bloccare: non rende mai attendibile nulla.",
  "settings.skills.keys.import.file": "Importa un file di avviso",
  "settings.skills.keys.import.linkLabel": "Oppure incolla un link",
  "settings.skills.keys.import.linkPlaceholder": "https://example.com/revoke.psyche-notice",
  "settings.skills.keys.import.go": "Importa",
  "settings.skills.keys.import.key": "Chiave {key} bloccata. Motivo indicato: {reason}",
  "settings.skills.keys.import.bundle": "File {hash} bloccato. Motivo indicato: {reason}",
  "settings.skills.keys.import.previewKey":
    "Questo revocherà la chiave {key}{names, select, none {} other { (nota come {names})}}. Motivo indicato dal firmatario: {reason}",
  "settings.skills.keys.import.previewBundle":
    "Questo bloccherà il file {hash}. Motivo indicato dal firmatario: {reason}",
  "settings.skills.keys.import.already": "È già in vigore.",
  "settings.skills.keys.import.apply": "Applicalo",
  "settings.skills.keys.import.signedBy": "Firmato da {name}.",
  "settings.skills.keys.import.failed": "Impossibile usare l’avviso: {reason}",
  "web.teach.app.record": "Registra in un’app",
  "web.teach.app.recordHint":
    "Mostra a Psyche come fare qualcosa in un’app del Mac che hai già consentito",
  "web.teach.app.pickTitle": "In quale app registrare?",
  "web.teach.app.pickLabel": "App",
  "web.teach.app.pickHint":
    "Sono elencate solo le app che hai consentito per l’uso del computer. Apri prima l’app. Password, numeri di carta e codici non vengono mai registrati, e neppure le finestre di Psyche stessa o le richieste di accesso e sicurezza.",
  "web.teach.app.none":
    "Nessuna app è pronta per la registrazione. Attiva l’uso del computer nelle Impostazioni e dai prima a un’app il livello Clic o Interazione.",
  "web.teach.app.start": "Avvia registrazione",
  "web.teach.app.cancelPick": "Non ora",
  "web.teach.app.startFailed":
    "Psyche non è riuscita ad avviare la registrazione di quell’app. Aprila prima e verifica che Psyche abbia l’accesso a Accessibilità.",
  "web.teach.app.bar.title": "Registrazione di {app}",
  "web.teach.app.bar.body":
    "Psyche annota i tuoi clic, le scelte dai menu e ciò che digiti solo in {app}. I campi protetti non vengono mai registrati, non vengono fatti screenshot e nulla lascia questo Mac finché non salvi. Anche la barra dei menu ha un pulsante Interrompi.",
  "web.teach.app.bar.endedLimit":
    "La registrazione si è fermata al limite di 200 passaggi. Controlla cosa ha rilevato.",
  "web.teach.app.bar.endedTimeout":
    "La registrazione si è fermata al raggiungimento del limite di tempo. Controlla cosa ha rilevato.",
  "web.teach.app.bar.endedInterrupted":
    "La registrazione è terminata in anticipo perché l’app è stata chiusa. Controlla cosa ha rilevato.",
  "web.teach.app.stopFailed": "Psyche non è riuscita a concludere la registrazione.",
  "web.teach.app.skipped":
    "{count, plural, one {# elemento è stato escluso: un campo protetto, o un controllo senza nome con cui trovarlo.} other {# elementi sono stati esclusi: campi protetti, o controlli senza nome con cui trovarli.}}",
  "web.teach.app.privacy":
    "Il testo di questi passaggi proviene dalle finestre e dai menu dell’app. Viene trattato come dato, mai come istruzione. Al salvataggio ti viene chiesto di approvare la skill prima che possa essere eseguita.",
  "web.teach.app.sensitive": "Non registrato. Psyche ti chiederà di fare questa parte da solo.",
  "web.teach.app.runHint":
    "Riempie la casella del messaggio con la skill. Premi Invia e osserva l’app: ogni clic e ogni inserimento chiede approvazione come al solito, e si ferma e chiede se qualcosa non è dove era.",
  "web.teach.step.app.click": "In {app}, fai clic su «{name}»",
  "web.teach.step.app.clickRole": "In {app}, fai clic su {role}",
  "web.teach.step.app.menu": "In {app}, scegli {path}",
  "web.teach.step.app.type": "In {app}, digita in «{name}»",
  "web.teach.step.app.typeKept": "In {app}, digita {value} in «{name}»",
  "web.teach.step.app.typeInput": "In {app}, digita {input} in «{name}»",
  "web.teach.step.app.typeAsk": "In {app}, digita in «{name}» ciò che indichi",
  "web.teach.step.app.typeSensitive": "In {app}, digiti tu stesso in «{name}»",
};
