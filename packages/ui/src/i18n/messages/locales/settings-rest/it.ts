import type { Catalogue } from "../../index.ts";

/** `settings.*` strings (it); merged into `../it.ts`. */
export const settingsRest: Partial<Catalogue> = {
  "settings.appearance.accent.ink": "Inchiostro",
  "settings.appearance.gray.paper": "Carta",
  "settings.nav.daily": "Giornaliero",
  "settings.daily.title": "Giornaliero",
  "settings.daily.description":
    "Un breve riepilogo al mattino e un resoconto alla sera, in Home. Psyche si limita a leggere; non viene inviato nulla senza la tua approvazione.",
  "settings.daily.loadFailed": "Impossibile caricare le impostazioni giornaliere.",
  "settings.daily.group.brief": "Riepilogo del mattino",
  "settings.daily.group.wrapup": "Riepilogo della sera",
  "settings.daily.group.delivery": "Dove compare",
  "settings.daily.group.followups": "Impostazioni dei follow-up",
  "settings.daily.group.automations": "Automazioni",
  "settings.key.daily.brief.enabled": "Riepilogo del mattino",
  "settings.key.daily.wrapup.enabled": "Riepilogo della sera",
  "settings.key.daily.notify": "Avvisami",
  "settings.key.daily.messages": "Invia anche tramite Messaggi",
  "settings.key.daily.followups.enabled": "Monitora i follow-up",
  "settings.key.daily.brief.time": "Ora del riepilogo del mattino",
  "settings.key.daily.wrapup.time": "Ora del riepilogo della sera",
  "settings.key.daily.followups.sensitivity": "Quanto monitorare",
  "settings.daily.time": "Ora",
  "settings.daily.notify.hint":
    "Una notifica con la scheda. Le ore di silenzio la trattengono fino alla fine.",
  "settings.daily.messages.hint": "Richiede il canale Messaggi. Inviato solo a te.",
  "settings.daily.sensitivity": "Quanto monitorare",
  "settings.daily.sensitivity.low": "Solo promesse chiare con una data",
  "settings.daily.sensitivity.normal": "Promesse e richieste (consigliato)",
  "settings.daily.sensitivity.high": "Tutto ciò che dico che farò",
  "settings.daily.runNow": "Anteprima adesso",
  "settings.daily.runFailed": "Impossibile creare la scheda.",
  "settings.key.nudges.enabled": "Promemoria sulle relazioni",
  "settings.key.nudges.consentedAt": "Consenso ai promemoria sulle relazioni",
  "settings.key.nudges.sensitivity": "Con che frequenza ricordare",
  "settings.key.nudges.phrasing": "Riformula i suggerimenti dei promemoria",
  "settings.shared.advanced": "Avanzate",
  "settings.nav.inPage": "In {page}",
  "settings.nav.essentials": "Essenziali",
  "settings.nav.learning": "Nozioni di base",
  "settings.search.count": "{count, plural, one {# risultato} other {# risultati}}",
  "settings.search.result.page": "Pagina",
  "settings.page.essentials": "Essenziali",
  "settings.page.essentials.description":
    "Le poche scelte che fa la maggior parte delle persone. Ognuna ha un’impostazione predefinita sicura, e le pagine qui sotto contengono il resto.",
  "settings.page.general.description":
    "Come appare {persona}, chi è, quando può interromperti e come ci parli.",
  "settings.page.model.description":
    "I modelli con cui ragiona {persona}, le chiavi che usano e quanto costano.",
  "settings.page.connectors.description":
    "Le app e gli account che {persona} può raggiungere, e quali di essi cerca.",
  "settings.page.memory.description": "Cosa ricorda {persona}, da dove impara e come lo controlli.",
  "settings.page.daily.description":
    "Il tuo riepilogo del mattino e della sera, le automazioni, le skill e gli specialisti che {persona} può chiamare.",
  "settings.page.permissions.description":
    "Cosa {persona} può fare su questo Mac senza chiedere, e dove si ferma sempre a chiederti.",
  "settings.page.data.description":
    "Cosa resta su questo Mac, per quanto tempo viene conservato, esportazioni, backup e ripartire da zero.",
  "settings.page.devices.description":
    "I tuoi altri dispositivi, il server Gateway e come raggiungere {persona} quando sei fuori.",
  "settings.page.about.description": "Versioni, controlli di integrità e log.",
  "settings.essentials.title": "Essenziali",
  "settings.essentials.description":
    "Le poche scelte che fa la maggior parte delle persone, ciascuna con un’impostazione predefinita sicura. {persona} chiede quando gli serve altro.",
  "settings.essentials.more": "Altro",
  "settings.essentials.moreIn": "Altro in {place}",
  "settings.essentials.model.title": "Modello",
  "settings.essentials.model.thinksWith": "{persona} ragiona con",
  "settings.essentials.model.ready": "Pronto",
  "settings.essentials.model.noKey": "Serve una chiave",
  "settings.essentials.model.none": "Ancora nessun modello",
  "settings.essentials.model.noneHint":
    "{persona} ha bisogno di un modello per poter rispondere. Aggiungi una chiave, oppure usa un modello su questo Mac.",
  "settings.essentials.model.setUp": "Configura un modello",
  "settings.essentials.read.title": "Cosa può leggere {persona}",
  "settings.essentials.read.hint":
    "Disattivato finché non ne attivi uno. Ciò che legge viene indicizzato su questo Mac per trovare le cose al posto tuo, e anche la memoria impara da esso, a meno che tu non lo escluda in Memoria → Fonti.",
  "settings.essentials.asks.title": "Quanto spesso {persona} chiede prima",
  "settings.essentials.interrupt.title": "Quando {persona} può interromperti",
  "settings.essentials.interrupt.quietHint":
    "Dalle {from} alle {until}, le notifiche aspettano nella posta in arrivo.",
  "settings.essentials.interrupt.briefHint": "Un breve riepilogo nel Feed alle {time}.",
  "settings.essentials.memory.title": "Memoria",
  "settings.essentials.memory.remember": "Lascia che {persona} ricordi le nostre chat",
  "settings.essentials.memory.rememberHint":
    "Disattivato mette in pausa la memoria: nulla di nuovo viene ricordato o indicizzato dalle chat finché non la riattivi.",
  "settings.essentials.rest":
    "Tutto il resto, e un controllo più fine su ciascuna di queste voci, è nelle pagine qui sotto. “Cerca nelle impostazioni” trova qualsiasi cosa.",
  "settings.searchModel.title": "Modello per la ricerca",
  "settings.searchModel.description":
    "Quale modello legge le domande, scrive le schede di contesto e riordina i risultati.",
  "settings.searchModel.utility": "Il tuo modello di servizio",
  "settings.searchModel.utilityHint":
    "Il piccolo modello impostato in Modelli. Se è un modello cloud, il testo che legge va a quel fornitore.",
  "settings.searchModel.apple":
    "Usa il modello Apple sul dispositivo per le operazioni di ricerca private",
  "settings.searchModel.appleName": "Modello Apple sul dispositivo",
  "settings.searchModel.appleHint":
    "Il testo resta su questo Mac: niente da scaricare, nessuna chiave, nulla inviato al cloud. Legge circa {k}k token alla volta, quindi i testi lunghi vengono saltati. Se non riesce a rispondere, quell’operazione viene saltata. Non ripiega mai su un modello cloud.",
  "settings.searchModel.apple.why.off":
    "Apple Intelligence è disattivata. Attivala in Impostazioni di Sistema, in Apple Intelligence e Siri.",
  "settings.searchModel.apple.why.os": "Questo Mac richiede macOS 26 o successivo.",
  "settings.searchModel.apple.why.device":
    "Questo Mac o questa regione non supporta Apple Intelligence.",
  "settings.searchModel.apple.why.notReady":
    "Apple sta ancora preparando il modello. Riprova tra un po’.",
  "settings.searchModel.apple.why.unknown": "Il modello non è disponibile al momento.",
  "settings.searchModel.apple.whySkipped": "Fino ad allora, quelle operazioni vengono saltate.",
  "settings.searchModel.apple.host":
    "Questa è un’impostazione di {host}. Il modello gira su {host}, non su questo computer, e la modifica vale per ogni finestra.",
  "settings.searchModel.apple.ready": "Pronto su questo Mac",
  "settings.searchModel.apple.needsAi": "Richiede Apple Intelligence",
  "settings.searchModel.apple.notReady": "In preparazione",
  "settings.searchModel.apple.notOnThisMac": "Non disponibile su questo Mac",
  "settings.searchModel.apple.unavailable": "Non disponibile al momento",
  "settings.search.advancedHint": "Quale modello legge le tue domande",
  "settings.search.description":
    "Cosa indicizza Psyche per trovare le cose al posto tuo, e quale motore usa sul web.",
  "settings.nav.specialists": "Specialisti",
  "settings.nav.notifications": "Notifiche",
  "settings.nav.people": "Persone e privacy",
  "settings.key.appearance.showInDock": "Mostra nel Dock quando non ci sono finestre aperte",
  "settings.key.appearance.openAtLogin": "Apri Psyche all’accesso",
  "settings.key.browser.useSignedInSessions": "Usa le mie sessioni con accesso effettuato",
  "settings.key.exec.srtPath": "Posizione di srt",
  "settings.key.search.model.engine": "Modello per la ricerca",
  "settings.key.search.semantic.enabled": "Ricerca semantica (sul dispositivo)",
  "settings.key.search.cards.enabled": "Schede di contesto per la ricerca",
  "settings.semanticSearch.cardsHint":
    "Un piccolo modello cloud scrive un breve riassunto di ogni elemento salvato. Limitato a circa 200.000 token al giorno.",
  "settings.key.search.encrypt": "Cifra l’indice di ricerca",
  "settings.semanticSearch.encryptHint":
    "Rende l’indice di ricerca illeggibile senza una chiave conservata separatamente. Si applica al prossimo avvio e ricostruisce l’indice una volta.",
  "settings.semanticSearch.encrypt.on": "Indice cifrato",
  "settings.semanticSearch.encrypt.pending": "In attesa che l’helper del Mac apra l’indice cifrato",
  "settings.semanticSearch.encrypt.unavailable": "Non cifrato: {why}",
  "settings.key.search.rerank.enabled":
    "Riordina i risultati migliori con un piccolo modello cloud",
  "settings.semanticSearch.rerankHint":
    "Un piccolo modello cloud mette i risultati migliori in cima. I primi 20 frammenti lasciano questo Mac. Disattivato per impostazione predefinita.",
  "settings.key.search.runOnBattery": "Indicizza a batteria",
  "settings.key.search.queryModel.enabled": "Leggi le domande con un piccolo modello",
  "settings.semanticSearch.queryModelHint":
    "Un piccolo modello cloud ricava i filtri di tempo, persona e fonte. Viene inviata solo la domanda, mai i tuoi elementi.",
  "settings.key.search.semantic.engine": "Motore di embedding",
  "settings.key.search.semantic.allowCloud": "Consenti un servizio di embedding cloud",
  "settings.key.memory.recall.mode": "Come viene richiamata la memoria",
  "settings.key.widgets.remoteImages": "Immagini remote nei widget",
  "settings.key.ui.map.tiles": "Tessere della mappa",
  "settings.key.ui.map.styleUrl": "URL dello stile della mappa",
  "settings.key.ui.map.styleUrlDark": "URL dello stile della mappa (scuro)",
  "settings.key.teaching.enabled": "Impara dai tuoi riscontri",
  "settings.key.teaching.implicit": "Nota modifiche, annullamenti e scarti",
  "settings.key.teaching.paused": "Metti in pausa l’apprendimento",
  "settings.key.teaching.weeklyCard": "Scheda settimanale “Cosa ho imparato”",
  "settings.key.memory.graph": "Persone e progetti",
  "settings.key.memory.everything": "Memoria in background",
  "settings.key.agent.showReasoning": "Mostra il ragionamento mentre lavora",
  "settings.key.data.reasoningRetentionDays": "Conserva il ragionamento per",
  "settings.key.notifications.quietHours.enabled": "Ore di silenzio",
  "settings.key.notifications.quietHours.start": "Silenzio dalle",
  "settings.key.notifications.quietHours.end": "Silenzio fino alle",
  "settings.notifications.title": "Notifiche",
  "settings.notifications.description": "Quando Psyche può interromperti.",
  "settings.notifications.group.quietHours": "Ore di silenzio",
  "settings.notifications.quietHours.hint":
    "Trattiene le notifiche fino alla fine della fascia. Le approvazioni urgenti arrivano comunque.",
  "settings.key.ui.onboarding.progress": "Avanzamento della configurazione iniziale",
  "settings.key.permissions.liftedFloors": "Azioni consentite senza chiedere per {id}",
  "settings.key.specialists.maxConcurrent": "Specialisti contemporaneamente",
  "settings.key.specialists.monthlyCapUsd": "Spesa mensile degli specialisti",
  "settings.key.specialists.showInFeed": "Mostra i risultati degli specialisti nel Feed",
  "settings.key.specialists.enabled": "{role} attivo",
  "settings.key.specialists.model": "Modello di {role}",
  "settings.key.specialists.budget": "Budget di {role}",
  "settings.key.specialists.maxMode": "Modalità permessi di {role}",
  "settings.credentials.payments.description":
    "Una carta monouso, dopo che approvi ogni acquisto. I numeri di carta non arrivano mai a Psyche.",
  "settings.approval.presenceUnavailable":
    "Questa finestra non può confermare che sei tu. Approva la modifica nell’app Psyche sul tuo Mac (Touch ID), oppure da un dispositivo con una passkey. Fino ad allora non cambia nulla.",
  "settings.doctor.gateway": "Gateway",
  "settings.doctor.gatewayOk": "Risponde.",
  "settings.doctor.model": "Modello",
  "settings.doctor.noModel":
    "Non è ancora stato scelto nessun modello. Aggiungine uno in Impostazioni → Modelli.",
  "settings.doctor.sandbox": "Sandbox",
  "settings.doctor.noSandbox": "Nessuna sandbox disponibile, quindi i comandi restano bloccati.",
  "settings.doctor.memory": "Memoria",
  "settings.doctor.memoryPaused": "La memoria è in pausa: non viene ricordato nulla di nuovo.",
  "settings.doctor.memoryOk": "{files, plural, one {# file} other {# file}} in memoria.",
  "settings.appearance.description": "Si applica a ogni dispositivo che hai abbinato.",
  "settings.appearance.colors": "Colori",
  "settings.appearance.colorsHint": "Chiaro o scuro, e il tuo colore di evidenziazione.",
  "settings.appearance.comfort": "Comfort",
  "settings.appearance.comfortHint": "Più riposante per gli occhi e per il movimento.",
  "settings.appearance.backgroundHint":
    "Se Psyche continua a funzionare quando chiudi la finestra.",
  "settings.appearance.advancedHint":
    "Tonalità di grigio, colore personalizzato, direzione del testo, verifica del contrasto",
  "settings.appearance.fineTune": "Regola i colori nel dettaglio",
  "settings.appearance.fineTuneHint": "Per chi vuole un aspetto preciso.",
  "settings.appearance.contrastCheck": "Verifica del contrasto",
  "settings.appearance.contrastCheckHint": "Quanto è leggibile ogni tema, passo dopo passo.",
  "settings.appearance.background": "Sfondo",
  "settings.appearance.showInDockHint":
    "Se disattivato, Psyche continua a funzionare dalla barra dei menu quando si chiude l’ultima finestra.",
  "settings.appearance.openAtLoginHint":
    "Avvia Psyche nella barra dei menu quando accedi, così le automazioni pianificate possono sempre essere eseguite.",
  "settings.appearance.glass.hint":
    "Lascia trasparire i contenuti attraverso menu, popover e il campo di scrittura.",
  "settings.browser.description":
    "{persona} naviga in una finestra propria. La modalità Chrome reale usa un profilo separato a cui accedi una sola volta.",
  "settings.browser.signedIn.title": "Siti con accesso effettuato",
  "settings.browser.signedIn.description":
    "Siti a cui hai effettuato l’accesso nel browser di Psyche. Le attività riutilizzano questi accessi.",
  "settings.browser.signedIn.auto": "trovato automaticamente",
  "settings.browser.useSignedIn.title": "Sessioni con accesso effettuato",
  "settings.browser.useSignedIn.description":
    "{persona} continua a usare il tuo accesso sullo stesso sito. Scritture, acquisti e invii chiedono comunque prima a te.",
  "settings.browser.useSignedIn.label":
    "Lascia che Psyche usi le mie sessioni con accesso effettuato",
  "settings.browser.useSignedIn.hint":
    "Attivo per impostazione predefinita. Se disattivato, ogni sito si apre senza accesso, tranne quelli per cui hai scelto di restare connesso.",
  "settings.browser.signedIn.none": "Ancora nessun sito con accesso effettuato.",
  "settings.browser.signedIn.viaHosts": "Accesso effettuato anche tramite {hosts}",
  "settings.browser.signedIn.forget": "Disconnetti / dimentica",
  "settings.browser.signedIn.loadFailed":
    "Psyche non è riuscito a elencare i siti con accesso effettuato ({reason}).",
  "settings.browser.signedIn.forgetFailed":
    "Psyche non è riuscito a disconnettersi da {site} ({reason}).",
  "settings.computerUse.appsHint": "Fin dove può spingersi Psyche in ogni app.",
  "settings.connectors.catalog.appleShortcuts": "Comandi rapidi",
  "settings.connectors.catalog.obsidian": "Obsidian",
  "settings.connectors.trust.verified": "verificato",
  "settings.connectors.filter.label": "Mostra",
  "settings.connectors.filter.all": "Tutti",
  "settings.connectors.filter.apps": "App",
  "settings.connectors.filter.mcp": "Server MCP",
  "settings.connectors.configureFailed":
    "Psyche non è riuscito a salvare le impostazioni di {name}: {reason}",
  "settings.shortcuts.title": "I tuoi comandi rapidi",
  "settings.shortcuts.loading": "Lettura dei comandi rapidi da questo Mac…",
  "settings.shortcuts.none": "Ancora nessun comando rapido nell’app Comandi rapidi.",
  "settings.shortcuts.noHelper":
    "Apri Psyche sul tuo Mac per elencare i comandi rapidi: li legge l’helper.",
  "settings.shortcuts.failed": "Psyche non è riuscito a leggere i tuoi comandi rapidi.",
  "settings.shortcuts.hint":
    "No: non vengono mai eseguiti. Chiedi: una scheda ogni volta. Consenti: vengono eseguiti senza chiedere, solo per i comandi rapidi che si limitano a leggere.",
  "settings.shortcuts.rule.off": "No",
  "settings.shortcuts.rule.ask": "Chiedi",
  "settings.shortcuts.rule.allow": "Consenti",
  "settings.shortcuts.actions": "Azioni di Psyche",
  "settings.shortcuts.install": "Installa",
  "settings.shortcuts.installNamed": "Installa {name}",
  "settings.shortcuts.installed": "Installato",
  "settings.trusted.title.reminders": "I tuoi elenchi di Promemoria",
  "settings.trusted.title.notes": "Le tue cartelle di Note",
  "settings.trusted.title.calendar": "I tuoi calendari",
  "settings.trusted.none.reminders": "Ancora nessun elenco di Promemoria.",
  "settings.trusted.none.notes": "Ancora nessuna cartella in Note.",
  "settings.trusted.none.calendar": "Ancora nessun calendario.",
  "settings.trusted.loading": "Lettura da questo Mac…",
  "settings.trusted.noHelper": "Apri Psyche sul tuo Mac per elencarli: li legge l’helper.",
  "settings.trusted.failed": "Psyche non è riuscito a leggerli da questo Mac.",
  "settings.trusted.toggle": "Mio: considera attendibile",
  "settings.trusted.shared": "Condiviso",
  "settings.trusted.hint":
    "Leggerlo non farà chiedere di nuovo alla chat. Attivalo solo per elenchi che nessun altro può modificare.",
  "settings.obsidian.vault": "Cartella del vault",
  "settings.obsidian.newVault": "Nuova cartella del vault",
  "settings.obsidian.noVault": "Nessun vault scelto",
  "settings.obsidian.vaultHint":
    "Psyche legge il vault tramite una cartella condivisa (Impostazioni → Permessi → Accesso): condividila, poi usala.",
  "settings.obsidian.share": "Condividi questa cartella",
  "settings.obsidian.shared": "Condivisa",
  "settings.obsidian.useVault": "Usa questo vault",
  "settings.obsidian.change": "Cambia vault…",
  "settings.obsidian.daily": "Cartella delle note giornaliere",
  "settings.obsidian.dailyPlaceholder": "Dalle impostazioni delle note giornaliere di Obsidian",
  "settings.connectors.can.title": "Cosa può fare {persona}",
  "settings.connectors.can.label": "Cosa può fare {persona} con {name}",
  "settings.connectors.can.alwaysAsks": "Chiede sempre prima",
  "settings.connectors.can.asksByDefault": "Chiede prima, a meno che tu non lo consenta",
  "settings.connectors.can.lifted": "Viene eseguito senza chiedere",
  "settings.connectors.can.liftWhat": "{action} in {name}",
  "settings.connectors.can.readOnly": "Disattivato finché {name} è collegato in sola lettura",
  "settings.connectors.can.mail.read.title": "Leggere la posta",
  "settings.connectors.can.mail.read.lines":
    "Leggere e cercare nella posta, compresa quella non letta · Vedere il numero di non letti per casella · Usare l’email che hai selezionato",
  "settings.connectors.can.mail.draft.title": "Preparare bozze di posta",
  "settings.connectors.can.mail.draft.lines":
    "Preparare bozze di nuove email, risposte e inoltri (salvate, non inviate)",
  "settings.connectors.can.mail.organize.title": "Organizzare la posta",
  "settings.connectors.can.mail.organize.lines":
    "Segnare come letta, contrassegnare, archiviare e spostare · Salvare gli allegati",
  "settings.connectors.can.mail.send.title": "Inviare posta",
  "settings.connectors.can.mail.send.lines": "Inviare email e bozze salvate",
  "settings.connectors.can.notes.read.title": "Leggere le note",
  "settings.connectors.can.notes.read.lines": "Trovare, elencare e leggere note e cartelle",
  "settings.connectors.can.notes.create.title": "Scrivere note",
  "settings.connectors.can.notes.create.lines": "Creare note e aggiungervi contenuti",
  "settings.connectors.can.reminders.read.title": "Leggere i promemoria",
  "settings.connectors.can.reminders.read.lines":
    "Vedere cosa è in scadenza, in ritardo e contrassegnato",
  "settings.connectors.can.reminders.write.title": "Modificare i promemoria",
  "settings.connectors.can.reminders.write.lines":
    "Aggiungere, completare e contrassegnare i promemoria",
  "settings.connectors.can.calendar.read.title": "Leggere il calendario",
  "settings.connectors.can.calendar.read.lines":
    "Vedere eventi, partecipanti e link delle riunioni · Trovare tempo libero",
  "settings.connectors.can.calendar.write.title": "Modificare il calendario",
  "settings.connectors.can.calendar.write.lines": "Aggiungere, spostare e modificare eventi",
  "settings.connectors.grant.allowed":
    "Consentito in Impostazioni di Sistema → Privacy e sicurezza → {grant}",
  "settings.connectors.grant.automation": "Automazione → {app}",
  "settings.connectors.grant.calendars": "Calendari",
  "settings.connectors.grant.reminders": "Promemoria",
  "settings.connectors.grant.contacts": "Contatti",
  "settings.connectors.grant.photos": "Foto",
  "settings.connectors.app.mail": "Mail",
  "settings.connectors.app.notes": "Note",
  "settings.connectors.app.music": "Musica",
  "settings.connectors.app.safari": "Safari",
  "settings.connectors.app.chrome": "Google Chrome",
  "settings.connectors.app.things": "Things",
  "settings.connectors.app.shortcuts": "Comandi rapidi",
  "settings.connectors.try.title": "Provalo",
  "settings.connectors.try.mail.unread": "Cosa non ho letto di oggi?",
  "settings.connectors.try.mail.reminder": "Crea un promemoria dall’email che ho selezionato",
  "settings.connectors.try.mail.reply": "Prepara una risposta all’ultima email di Dana",
  "settings.connectors.try.notes.find": "Trova la mia nota sull’offsite",
  "settings.connectors.try.notes.append":
    "Aggiungi le decisioni di oggi alla mia nota sull’offsite",
  "settings.connectors.try.reminders.due": "Cosa scade oggi?",
  "settings.connectors.try.reminders.add": "Ricordami di chiamare il dentista domani alle 9",
  "settings.connectors.try.calendar.today": "Cosa c’è nel mio calendario oggi?",
  "settings.connectors.try.calendar.focus": "Blocca due ore per concentrarmi domani mattina",
  "settings.connectors.actionFailed":
    "Psyche non è riuscito a modificare {name} ({reason}). Non è cambiato nulla.",
  "settings.mcp.badge": "MCP",
  "settings.mcp.showDetails": "Mostra dettagli",
  "settings.mcp.hideDetails": "Nascondi dettagli",
  "settings.sandbox.setUp": "Configura sandbox",
  "settings.mcp.sandboxHelp": "I server di comandi richiedono una sandbox su questo Mac.",
  "settings.sandbox.title": "Configura la sandbox",
  "settings.sandbox.why":
    "I comandi vengono eseguiti sul tuo Mac con i tuoi file, ma non possono leggere il tuo vault, le chiavi né i dati privati di Psyche.",
  "settings.sandbox.whyHow":
    "Usa srt, il runtime sandbox di Anthropic, sopra la sandbox di macOS. Non serve alcuna macchina virtuale.",
  "settings.sandbox.privacy":
    "Psyche non installa nulla da solo. Esegui tu ogni passaggio qui sotto, oppure apri tu il download.",
  "settings.sandbox.checking": "Controllo di questo Mac…",
  "settings.sandbox.checkAgain": "Ricontrolla",
  "settings.sandbox.done": "Fatto",
  "settings.sandbox.copy": "Copia",
  "settings.sandbox.copied": "Copiato",
  "settings.sandbox.ready": "Pronta",
  "settings.sandbox.srt.ready":
    "srt è configurato in {path}. Si possono aggiungere server di comandi.",
  "settings.sandbox.srt.missing.title": "Installa srt",
  "settings.sandbox.srt.missing.body":
    "srt arriva da npm. Se il comando chiede il permesso di scrittura, eseguilo con i diritti del tuo account; Psyche non lo esegue mai al posto tuo.",
  "settings.sandbox.srt.install": "Installalo con npm",
  "settings.sandbox.srt.link": "Leggi di srt su GitHub",
  "settings.sandbox.srt.thenCheck": "Poi ricontrolla",
  "settings.sandbox.srt.thenCheckBody":
    "Psyche trova srt nel tuo PATH, nelle cartelle di Homebrew e npm, senza riavvio.",
  "settings.sandbox.srt.broken":
    "Impossibile usare srt in {path}: {problem, select, not_absolute {il percorso deve iniziare con /} not_executable {lì non c’è alcun programma eseguibile} other {non è stato trovato}}.",
  "settings.sandbox.srt.fromEnv":
    "PSYCHE_SRT_PATH imposta questa posizione, quindi non si può cambiare qui.",
  "settings.sandbox.srt.installButton": "Installa con Psyche",
  "settings.sandbox.srt.reinstallButton": "Reinstalla",
  "settings.sandbox.srt.updateButton": "Aggiorna srt",
  "settings.sandbox.srt.installOr": "Oppure lascia che Psyche lo installi per te",
  "settings.sandbox.srt.installConfirm.title": "Installare srt {version}?",
  "settings.sandbox.srt.installConfirm.body":
    "Psyche scaricherà {package} {version} e le sue dipendenze dal registro npm (registry.npmjs.org), verificherà ogni file con un checksum incorporato in questa versione di Psyche e li estrarrà con il proprio Node. Non viene installato nulla a livello di sistema, non vengono eseguiti script di installazione e non serve alcuna password.",
  "settings.sandbox.srt.installConfirm.where": "Verrà messo in {dir}",
  "settings.sandbox.srt.installConfirm.go": "Installa",
  "settings.sandbox.srt.installConfirm.cancel": "Annulla",
  "settings.sandbox.srt.installing": "Installazione di srt…",
  "settings.sandbox.srt.installed": "Installato da Psyche: srt {version}.",
  "settings.sandbox.srt.installFailed": "Impossibile installare srt: {reason}",
  "settings.sandbox.srt.updateAvailable":
    "Questa versione di Psyche include un srt più recente ({version}); è installato {installed}.",
  "settings.sandbox.srt.choose": "srt si trova altrove",
  "settings.sandbox.srt.path": "Percorso completo di srt",
  "settings.sandbox.srt.use": "Usa questo srt",
  "settings.sandbox.srt.useHint":
    "Salvarlo ti chiede di confermare su questo dispositivo, perché decide cosa esegue i tuoi comandi.",
  "settings.sandbox.containers.title": "Isolamento più forte (facoltativo)",
  "settings.sandbox.containers.body":
    "Un runtime di container esegue il codice in una propria macchina Linux senza accesso ai file del tuo Mac: per il codice eseguito dall’agente e per alcune conversioni di file. I server di comandi continuano a usare srt a meno che il Gateway non sia impostato per usare i container.",
  "settings.sandbox.containers.ready": "{runtime} è in esecuzione.",
  "settings.sandbox.runtime.appleContainer": "Apple container",
  "settings.sandbox.runtime.docker": "Docker",
  "settings.sandbox.runtime.podman": "Podman",
  "settings.sandbox.missing.title": "Installa {runtime}",
  "settings.sandbox.missing.appleContainer":
    "Il runtime container di Apple dà a ogni sandbox una propria VM leggera. Richiede macOS 26 su Apple silicon e un programma di installazione che approvi con la password del Mac.",
  "settings.sandbox.missing.docker":
    "Docker tramite Colima è gratuito e leggero; Docker Desktop è la scelta più semplice con un clic.",
  "settings.sandbox.step.download": "Scarica e apri il programma di installazione",
  "settings.sandbox.step.downloadLink": "Apri le versioni di Apple container",
  "settings.sandbox.step.start": "Avvialo",
  "settings.sandbox.step.install": "Installalo con Homebrew",
  "settings.sandbox.step.orDesktop": "Oppure scarica Docker Desktop e aprilo una volta",
  "settings.sandbox.step.desktopLink": "Apri il download di Docker Desktop",
  "settings.sandbox.stopped.title": "{runtime} è installato ma non in esecuzione",
  "settings.sandbox.stopped.appleContainer": "Avvia il suo servizio di sistema, poi ricontrolla.",
  "settings.sandbox.stopped.docker":
    "Avvia il demone Docker (apri Docker Desktop, oppure esegui il comando qui sotto), poi ricontrolla.",
  "settings.sandbox.stopped.podman": "Avvia la macchina Podman, poi ricontrolla.",
  "settings.sandbox.restart.title": "{runtime} è in esecuzione. Riavvia il Gateway per usarlo",
  "settings.sandbox.restart.body":
    "Il Gateway ha cercato un runtime di container all’avvio e non ne ha trovato nessuno. Riavvialo e riconoscerà {runtime}.",
  "settings.sandbox.restart.step": "Riavvia il Gateway",
  "settings.sandbox.without":
    "Senza srt, Psyche può comunque usare i server URL e i tuoi connettori, ma non può eseguire server di comandi MCP locali.",
  "settings.mcp.off": "No",
  "settings.mcp.turnedOn": "{name} è attivo.",
  "settings.mcp.turnedOff": "{name} è disattivato.",
  "settings.mcp.tools.title": "Strumenti",
  "settings.mcp.tools.hint":
    "{off, plural, =0 {Psyche può usare ogni strumento.} one {# strumento è escluso per Psyche.} other {# strumenti sono esclusi per Psyche.}} Disattivarne uno non riavvia il server.",
  "settings.mcp.tools.loadFailed": "Impossibile caricare gli strumenti: {reason}",
  "settings.mcp.tools.off": "Questo server è disattivato. Attivalo per vederne gli strumenti.",
  "settings.mcp.tools.notConnected": "Questo server non è collegato, quindi non elenca strumenti.",
  "settings.mcp.tools.none": "Questo server non ha strumenti.",
  "settings.mcp.secrets.title": "Segreti",
  "settings.mcp.secrets.intro":
    "Chiavi con cui parte questo server. Restano nel tuo vault; Psyche mostra solo se ciascuna è impostata.",
  "settings.mcp.secrets.loadFailed": "Impossibile caricare i segreti: {reason}",
  "settings.mcp.secrets.set": "Impostato",
  "settings.mcp.secrets.unset": "Non impostato",
  "settings.mcp.secrets.replace": "Sostituisci",
  "settings.mcp.secrets.setIt": "Imposta un valore",
  "settings.mcp.secrets.replaceFor": "Sostituisci {name}",
  "settings.mcp.secrets.plain":
    "Conservato nelle impostazioni del server, non nel vault. Sostituendolo viene spostato nel vault.",
  "settings.mcp.secrets.newValue": "Nuovo valore per {name}",
  "settings.mcp.secrets.hint": "Salvato nel tuo vault, poi il server si riavvia con esso.",
  "settings.mcp.secrets.replaced":
    "{name} è stato sostituito. Il server si riavvia con il nuovo valore.",
  "settings.mcp.danger.title": "Zona pericolosa",
  "settings.mcp.danger.disable": "Disattiva questo server",
  "settings.mcp.danger.disableHint":
    "Ne mantiene le impostazioni ma lo ferma. I suoi strumenti scompaiono e i permessi che hai dato loro terminano.",
  "settings.mcp.danger.disableAction": "Disattiva",
  "settings.mcp.danger.enable": "Attiva questo server",
  "settings.mcp.danger.enableHint": "Lo riavvia. I suoi segreti chiedono la tua approvazione.",
  "settings.mcp.danger.enableAction": "Attiva",
  "settings.mcp.danger.remove": "Rimuovi questo server",
  "settings.mcp.danger.removeHint":
    "Ne elimina le impostazioni. I segreti nel tuo vault restano lì.",
  "settings.mcp.json.toggle": "Incolla JSON",
  "settings.mcp.json.label": "JSON del server",
  "settings.mcp.json.hint":
    "Il consueto formato mcpServers. Chiavi e token vanno nel tuo vault, non nelle impostazioni.",
  "settings.mcp.json.fill": "Compila il modulo",
  "settings.mcp.json.choose": "Quale server?",
  "settings.mcp.json.empty": "Incolla prima il JSON di un server.",
  "settings.mcp.json.invalid": "Non è un JSON valido.",
  "settings.mcp.json.shape": "Era previsto un oggetto JSON con una voce mcpServers.",
  "settings.mcp.json.noServers": "Nessun server con un comando o un URL in quel JSON.",
  "settings.mcp.json.secrets":
    "{n, plural, one {# segreto} other {# segreti}} del JSON andranno nel tuo vault: {names}.",
  "settings.mcp.json.ignored": "Non riportati: {names}.",
  "settings.searchSources.title": "Fonti di ricerca",
  "settings.searchSources.description":
    "Cosa Psyche legge nel tuo indice di ricerca. Tutto disattivato finché non lo attivi; l’indice resta su questo Mac. Attivare una fonte permette anche alla memoria di imparare da essa, a meno che tu non la escluda in Memoria → Fonti (Memoria e Contatti sono eccezioni: da nessuna delle due si impara).",
  "settings.searchSources.hint.mail":
    "Oggetto, mittente, destinatari, data e testo della tua posta in Mail di Apple. Le risposte citate vengono saltate.",
  "settings.searchSources.hint.messages":
    "Le tue conversazioni iMessage, per chat e giorno. I messaggi degli altri non vengono mai trattati come istruzioni.",
  "settings.searchSources.hint.notes": "Titolo e testo delle tue Note di Apple.",
  "settings.searchSources.hint.calendar":
    "Eventi degli ultimi tre anni e dei prossimi dodici mesi: titolo, ora, luogo, partecipanti e note.",
  "settings.searchSources.hint.reminders": "Promemoria e relativi elenchi, scadenze e note.",
  "settings.searchSources.hint.contacts":
    "I tuoi Contatti di Apple: nome, soprannome, azienda, qualifica, email, numeri di telefono, città e paese di ogni indirizzo, e compleanno. Indirizzi stradali, note e gruppi non vengono mai letti. L’agente non può cercare finché non lo consenti, e quell’interruttore riguarda solo questo indice: ciò che Memoria ha imparato sulle persone, e le loro pagine con email o numeri, seguono l’accesso dell’agente a Memoria.",
  "settings.searchSources.hint.files":
    "File di testo, codice, PDF, Word ed Excel nelle cartelle che hai condiviso. Le immagini sono indicizzate per nome.",
  "settings.searchSources.hint.browser":
    "Pagine che il browser di Psyche legge per te, conservate 90 giorni. Le pagine private, di accesso e di pagamento non vengono mai conservate.",
  "settings.searchSources.hint.transcripts":
    "Memo vocali e riunioni, divisi per interlocutore. Le parole degli altri non vengono mai trattate come istruzioni.",
  "settings.searchSources.hint.memory":
    "Ciò che Psyche ricorda: le tue persone, i progetti, il lavoro in scadenza e gli eventi, e i fatti che Psyche ha accettato. Resta escluso tutto ciò che è sensibile, ancora in attesa di revisione, imparato da una fonte in cui l’agente non può cercare, o tenuto privato. La memoria non impara da questo indice e richiede che Memoria sia attiva.",
  "settings.searchSources.runOnBatteryHint":
    "Permette a indicizzazione, ricostruzione e lettura del testo nelle immagini di proseguire mentre il Mac è a batteria, a ritmo più lento. Consuma più batteria. Il Risparmio energetico mette comunque in pausa l’indicizzazione.",
  "settings.searchSources.cannotEnable": "Non si può ancora attivare: {why}",
  "settings.searchSources.cannotAgent": "L’agente non può ancora cercare qui: {why}",
  "settings.searchSources.state.off": "No: non viene letto",
  "settings.searchSources.state.unavailable": "Attivo, ma non disponibile: {why}",
  "settings.searchSources.state.error": "Problema: {why}",
  "settings.searchSources.state.indexing":
    "Indicizzazione: finora {n, plural, one {# elemento} other {# elementi}}",
  "settings.searchSources.state.idle":
    "Aggiornato: {n, plural, one {# elemento} other {# elementi}}",
  "settings.searchSources.neverIndexed": "Non ancora indicizzato",
  "settings.searchSources.lastIndexed": "Ultima indicizzazione {when}",
  "settings.searchSources.rebuild": "Ricostruisci",
  "settings.searchSources.rebuildLabel": "Ricostruisci {source}",
  "settings.searchSources.rebuilding": "Ricostruzione…",
  "settings.searchSources.rebuild.turnOnFirst": "Prima attiva {source}",
  "settings.searchSources.rebuild.starting": "Ricostruzione di {source}…",
  "settings.searchSources.rebuild.progress":
    "Ricostruzione di {source}: finora {n, plural, one {# elemento letto} other {# elementi letti}}. Prosegue in background.",
  "settings.searchSources.rebuild.done":
    "{source} ricostruito: {n, plural, one {# elemento} other {# elementi}}.",
  "settings.searchSources.rebuild.failed": "Impossibile ricostruire {source}: {why}",
  "settings.searchSources.agent": "Lascia che l’agente di Psyche cerchi qui",
  "settings.searchSources.agentLabel": "Ricerca dell’agente per {source}",
  "settings.searchSources.ocr": "Leggi il testo nelle immagini (OCR)",
  "settings.searchSources.ocrHint":
    "Legge screenshot e PDF scansionati con Apple Vision, una pagina alla volta, con alimentazione collegata (o a batteria se “Indicizza a batteria” è attivo). Nulla lascia il tuo Mac.",
  "settings.searchSources.ocrLabel": "Leggi il testo nelle immagini per {source}",
  "settings.searchSources.processing": "Elaborazione",
  "settings.searchSources.processingLabel": "Elaborazione per {source}",
  "settings.searchSources.processing.cloud": "Modello cloud (attuale)",
  "settings.searchSources.processing.local": "Modello locale",
  "settings.searchSources.processing.none": "Nessuno: niente riassunti",
  "settings.searchSources.excludeContacts": "Non indicizzare mai questi contatti",
  "settings.searchSources.excludeContactsHint":
    "Indirizzi email, numeri di telefono o nomi, separati da virgole",
  "settings.searchSources.excludeFolders": "Non indicizzare mai queste cartelle",
  "settings.searchSources.excludeFoldersPlaceholder": "~/Documenti/Privato",
  "settings.searchSources.indexSize": "Dimensione dell’indice di ricerca: {size}",
  "settings.semanticSearch.title": "Ricerca per significato",
  "settings.semanticSearch.description":
    "Trova le cose per significato oltre che per parole, tutto su questo Mac.",
  "settings.semanticSearch.enabledHint":
    "La prima volta scarica un modello da 118 MB. Disattivarla elimina l’indice dei significati.",
  "settings.semanticSearch.engine.builtin": "Modello integrato",
  "settings.semanticSearch.engine.builtinHint":
    "Multilingual E5 small, circa 100 lingue, gira sul processore di questo Mac.",
  "settings.semanticSearch.engine.router": "Il mio server di modelli locale",
  "settings.semanticSearch.engine.routerHint":
    "Usa il modello di embedding impostato in Ruoli, ad esempio Ollama o LM Studio su questo Mac.",
  "settings.semanticSearch.state.off": "No: la ricerca trova le parole",
  "settings.semanticSearch.state.starting": "Avvio…",
  "settings.semanticSearch.state.downloading": "Download del modello: {received} di {total} MB",
  "settings.semanticSearch.state.indexing": "Indicizzazione dei significati: {done} di {total}",
  "settings.semanticSearch.state.ready":
    "Attiva: {n, plural, one {# brano indicizzato} other {# brani indicizzati}}",
  "settings.semanticSearch.state.readyCloud":
    "Attiva, con un servizio cloud: {n, plural, one {# brano indicizzato} other {# brani indicizzati}}",
  "settings.semanticSearch.allowCloudHint":
    "Solo se il modello di embedding è un servizio cloud. Le tue chat, attività e il testo della Libreria gli vengono inviati. Se disattivato, tutto resta su questo Mac.",
  "settings.semanticSearch.state.noModel":
    "Nessun modello di embedding impostato in Ruoli. Sceglierne uno, oppure usa il modello integrato.",
  "settings.semanticSearch.state.cloudBlocked":
    "Il modello di embedding in Ruoli è un servizio cloud. La ricerca semantica usa solo modelli su questo Mac.",
  "settings.semanticSearch.state.error": "Interrotta: {reason}",
  "settings.webSearch.description":
    "Come l’agente cerca le cose sul web. Le pagine web non vengono mai trattate come tue istruzioni.",
  "settings.data.description":
    "Tutto ciò che {persona} conserva si trova su questa macchina. Nulla viene inviato per l’addestramento.",
  "settings.data.advancedHint": "Mappe e immagini nei widget",
  "settings.data.keep": "Per quanto tempo si conservano le cose",
  "settings.data.keepHint":
    "Il ragionamento e le riproduzioni delle attività più vecchi vengono eliminati automaticamente.",
  "settings.data.danger": "Elimina e ricomincia",
  "settings.memoryControls.title": "Nozioni di base",
  "settings.memoryControls.description":
    "Scegli cosa ricorda {persona} e da dove impara. Ognuno può essere disattivato in qualsiasi momento.",
  "settings.learning.title": "Apprendimento dai riscontri",
  "settings.learning.implicit": "Nota modifiche, annullamenti e scarti",
  "settings.learning.implicitHint":
    "Inviare una bozza modificata o annullare un’azione conta come riscontro.",
  "settings.learning.signals": "Segnali",
  "settings.learning.signal.draftEdits": "Modifiche alle bozze",
  "settings.learning.signal.undo": "Annulla",
  "settings.learning.signal.approvalEdits": "Modifiche alle approvazioni",
  "settings.learning.signal.dismissals": "Scarti",
  "settings.learning.paused": "Metti in pausa l’apprendimento",
  "settings.learning.pausedHint":
    "Mentre è attivo non viene letto né scritto nulla, e dopo non viene recuperato nulla.",
  "settings.learning.weeklyCard": "Scheda settimanale “Cosa ho imparato”",
  "settings.learning.weeklyCardHint":
    "Un post nel Feed la domenica, solo quando c’è qualcosa da rivedere.",
  "settings.learning.open": "Cosa ha imparato {persona}",
  "settings.learning.openButton": "Apri Crescita",
  "settings.learning.forgetAll": "Dimentica tutto ciò che {persona} ha imparato",
  "settings.learning.forgetAllTitle": "Dimenticare tutto ciò che {persona} ha imparato da te?",
  "settings.learning.forgetAllBody":
    "Note, Anima e skill tornano a ciò che hai scritto tu. Digita “{phrase}” per confermare.",
  "settings.learning.forgetPhrase": "dimentica",
  "settings.learning.forgetAllGo": "Dimentica tutto",
  "settings.learning.forgotAll":
    "{lessons, plural, one {Dimenticata # lezione} other {Dimenticate # lezioni}} e {events, plural, one {# evento di riscontro} other {# eventi di riscontro}}.",
  "settings.data.reasoningRetentionHint":
    "Per quanto tempo si conserva il ragionamento completo di ogni passaggio. Se disattivato, resta un riassunto di una riga.",
  "settings.data.recallModeHint":
    "I tuoi file di memoria Markdown restano la fonte di verità. Gli embedding permettono a ogni turno di trovare i ricordi per significato.",
  "settings.data.recallMode.markdown": "Solo Markdown",
  "settings.data.recallMode.markdownHint":
    "Legge i file e abbina le parole. Nulla di aggiuntivo da eseguire.",
  "settings.data.recallMode.embeddings": "Markdown più embedding",
  "settings.data.recallMode.embeddingsHint":
    "Usa la stessa scelta di embedding di Cerca. Il modello si carica quando serve e viene liberato quando è inattivo.",
  "settings.data.recallState.off": "Solo Markdown.",
  "settings.data.encryptMemory": "Cifra la memoria su disco",
  "settings.data.encryptMemoryHint":
    "Conserva ciò che {persona} sa sulle persone in un file cifrato, con la chiave nel tuo vault. Disattivandola, prima copia tutto indietro.",
  "settings.data.encryptMemory.restart": "Si attiva al prossimo avvio di Psyche.",
  "settings.data.encryptMemory.on": "Cifrata.",
  "settings.data.encryptMemory.pending": "In attesa della chiave dall’helper del Mac.",
  "settings.data.encryptMemory.unavailable": "Non disponibile: {why}",
  "settings.data.encryptMemory.offDone":
    "La memoria è tornata nel database principale; il file cifrato è stato eliminato.",
  "settings.data.recallState.semantic":
    "Richiamo per significato e parole: {vectors} di {chunks} brani di memoria indicizzati.",
  "settings.data.recallState.modelMissing":
    "Il modello di embedding non è ancora scaricato, quindi il richiamo abbina solo le parole. Attiva la ricerca semantica in Impostazioni → Connettori e fonti → Cerca per scaricarlo.",
  "settings.data.recallState.cloudBlocked":
    "Il servizio di embedding non può ricevere la tua memoria, quindi il richiamo abbina solo le parole.",
  "settings.data.recallState.textOnly":
    "Nessun modello di embedding disponibile, quindi il richiamo abbina solo le parole.",
  "settings.data.replayRetentionHint":
    "Le schermate che {persona} ha guardato mentre lavorava, per la Timeline. Se disattivato, non ne conserva nessuna.",
  "settings.devices.presenceKey.unknown": "Chiave Touch ID (tipo non indicato dall’helper)",
  "settings.devices.presenceKey.deviceIdentity":
    "I pagamenti usano Touch ID o la password del tuo Mac. Non c’è nulla da configurare.",
  "settings.devices.touchId.none":
    "Ancora nessuna chiave Touch ID. Le schede che richiedono Touch ID non possono essere approvate finché non ne registri una.",
  "settings.devices.touchId.bundled": "Il Psyche Helper in questa app mostra la chiave",
  "settings.devices.touchId.notBundled":
    "Questo helper non è quello incluso in questa app, quindi la sua chiave non può essere registrata qui.",
  "settings.devices.touchId.keyMismatch":
    "L’helper di Psyche in questa app ora mostra la chiave {shown}, non quella registrata {registered}. Se non hai reimpostato tu la chiave, consideralo sospetto e non registrarla.",
  "settings.devices.touchId.confirmReplace":
    "Questo sostituisce la chiave Touch ID {previous} registrata per questo Mac. Sostituiscila solo se hai reimpostato tu la chiave.",
  "settings.devices.touchId.confirmReplaceButton": "Sostituisci la chiave",
  "settings.devices.touchId.noBundledKey":
    "Il Psyche Helper in questa app non ha una chiave Touch ID ({reason}).",
  "settings.devices.touchId.register": "Registra questa chiave",
  "settings.devices.touchId.remove": "Rimuovi chiave",
  "settings.devices.touchId.manualLabel": "ID della chiave",
  "settings.devices.touchId.manualHint":
    "Esegui psyche-helper --print-identity sul computer e incolla il presenceKeyId che stampa.",
  "settings.files.execHost": "Esegui comandi su questo Mac",
  "settings.files.execHostHint":
    "Permette a {persona} di eseguire comandi nelle tue cartelle condivise, nella sandbox. I comandi che potrebbero modificare i file chiedono prima a te.",
  "settings.files.execHostSwitch": "Consenti comandi su questo Mac",
  "settings.files.readOnlyQuiet": "Esegui comandi di sola lettura senza chiedere",
  "settings.files.readOnlyQuietHint":
    "I comandi di base su file e informazioni che si limitano a leggere, come ls, cat o wc, vengono eseguiti nella sandbox senza scheda. Tutto il resto chiede, git compreso, e così ogni comando dopo che {persona} ha letto qualcosa dall’esterno.",
  "settings.files.revoke": "Revoca",
  "settings.files.description":
    "{persona} raggiunge solo ciò che consenti, e chiede in chat quando gli serve altro.",
  "settings.files.foldersHint":
    "Sola lettura permette a {persona} di aprire e cercare in una cartella; lettura e scrittura gli permette di salvare modifiche. La revoca ha effetto subito.",
  "settings.files.addYourself": "Aggiungi tu una cartella",
  "settings.files.addYourselfHint":
    "Di solito non serve: {persona} chiede quando un’attività richiede una cartella. Le cartelle aggiunte partono in sola lettura.",
  "settings.access.title": "Cosa può raggiungere {persona}",
  "settings.access.listLabel": "Cosa può raggiungere {persona}",
  "settings.access.empty":
    "Ancora nulla. Quando {persona} ha bisogno di una cartella o di un’app, te lo chiede in chat, e ciò che consenti compare qui.",
  "settings.access.scope.always": "Sempre",
  "settings.access.scope.conversation": "Questa chat",
  "settings.access.scope.limited": "Per ora",
  "settings.access.used": "usato {when}",
  "settings.access.revokeNamed": "Revoca {name}",
  "settings.access.loadLabel": "cosa può raggiungere Psyche",
  "settings.access.loadFailed":
    "Psyche non è riuscito a caricare ciò che può raggiungere ({reason}).",
  "settings.access.unchanged": "L’accesso è invariato.",
  "settings.model.advancedHint": "Limiti di contesto, modelli locali",
  "settings.permissions.subject.prepNotes": "Note intitolate “Prep:” (preparazione riunioni)",
  "settings.permissions.specificConnectors":
    "I permessi per un connettore specifico si impostano nella sua pagina in Connettori.",
  "settings.permissions.openConnectors": "Apri Connettori",
  "settings.persona.description": "Come appare {name} e come si presenta.",
  "settings.persona.whileWorking": "Durante il lavoro",
  "settings.persona.showReasoningHint":
    "Mostra il ragionamento di {persona} mentre lavora. Non viene mai salvato.",
  "settings.connectors.page.onHost": "Su {host}",
  "settings.connectors.page.row.onHost": "Su {host}",
  "settings.computerUse.remote":
    "L’uso del computer funziona su {host}. Chiedi da lì, oppure usa il browser.",
  "settings.gateways.title": "Gateway su questo computer",
  "settings.gateways.description":
    "Usa Psyche da questo computer con il Gateway di un altro, ad esempio il tuo Mac a casa. Un solo Gateway è attivo alla volta, e cambiarlo riavvia Psyche.",
  "settings.gateways.loadLabel": "Gateway salvati",
  "settings.gateways.thisMac": "Questo Mac",
  "settings.gateways.active": "Connesso",
  "settings.gateways.pinned": "Identità fissata",
  "settings.gateways.notPinned": "Fissa la sua identità alla prima connessione",
  "settings.gateways.switch": "Cambia",
  "settings.gateways.switchTo": "Passa a {name}",
  "settings.gateways.switchTitle": "Passare a {name}?",
  "settings.gateways.switchKeep":
    "Psyche si riavvia su {name}. Psyche su questo Mac continua a funzionare, quindi le sue automazioni proseguono.",
  "settings.gateways.switchOnly": "Cambia",
  "settings.gateways.switchAndStop": "Cambia e ferma Psyche su questo Mac",
  "settings.gateways.pairAgain": "Abbina di nuovo",
  "settings.gateways.pairAgainNamed": "Abbina di nuovo con {name}",
  "settings.gateways.forget": "Dimentica",
  "settings.gateways.forgetNamed": "Dimentica {name}",
  "settings.gateways.add": "Aggiungi un Gateway",
  "settings.gateways.addressLabel": "Link di abbinamento o indirizzo",
  "settings.gateways.addressPlaceholder": "studio-mac.your-tailnet.ts.net",
  "settings.gateways.nameLabel": "Nome (facoltativo)",
  "settings.gateways.addHint":
    "Incolla il link di abbinamento dal Mac che esegue Psyche (Impostazioni, Server e accesso remoto, Abbina un altro computer). Senza link, digita il suo indirizzo Tailscale, https://<host>.<tailnet>.ts.net; questo computer chiede di abbinarsi e il proprietario lo approva lì.",
  "settings.gateways.newLink": "È arrivato un nuovo link di abbinamento. Vuoi usarlo?",
  "settings.gateways.useNewLink": "Usalo",
  "settings.gateways.ignoreNewLink": "Ignora",
  "settings.gateways.fromLink":
    "Aperto da un link di abbinamento. Controllalo, poi premi Aggiungi Gateway. Psyche ti chiede di confermare l’indirizzo prima di collegarsi.",
  "settings.gateways.adding": "Aggiungi Gateway",
  "settings.gateways.problem.empty": "Digita l’indirizzo del Gateway.",
  "settings.gateways.problem.invalid": "Questo non è un indirizzo che Psyche può usare.",
  "settings.gateways.problem.needs_full_name":
    "Usa il nome completo, come studio-mac.your-tailnet.ts.net. Un nome breve non si può verificare.",
  "settings.gateways.problem.needs_https":
    "Usa un indirizzo https://. Il semplice http funziona solo tramite un tunnel SSH su questo computer.",
  "settings.gateways.problem.has_path": "Usa solo l’indirizzo, senza percorso.",
  "settings.gateways.problem.has_credentials": "Ometti nome utente e password.",
  "settings.gateways.problem.link_not_a_pairing_link": "Questo non è un link di abbinamento.",
  "settings.gateways.problem.link_unsupported_version":
    "Quel link di abbinamento proviene da una versione più recente di Psyche. Aggiorna Psyche su questo computer e riprova.",
  "settings.gateways.problem.link_malformed":
    "Quel link di abbinamento è danneggiato. Copialo di nuovo dal Mac che lo ha creato.",
  "settings.gateways.problem.link_extra_fields":
    "Quel link di abbinamento contiene qualcosa che Psyche non capisce, quindi non viene usato.",
  "settings.gateways.problem.link_bad_field":
    "Quel link di abbinamento è danneggiato. Copialo di nuovo dal Mac che lo ha creato.",
  "settings.gateways.problem.link_lan":
    "Questo link di abbinamento è per un computer della tua rete locale ma non include il suo certificato, quindi non viene usato. Su quel Mac, creane uno nuovo: Abbina un altro computer, Da questa rete.",
  "settings.gateways.problem.link_not_lan":
    "Quel link di abbinamento indica un indirizzo che non è in una rete locale, quindi non viene usato.",
  "settings.gateways.problem.link_pin_mismatch":
    "Questo Gateway è già salvato con un’identità diversa. Prima usa “Abbina di nuovo” su di esso, poi aggiungi il link.",
  "settings.gateways.problem.failed": "Impossibile aggiungere il Gateway. Non è cambiato nulla.",
  "settings.gateways.problem.declined": "L’aggiunta del Gateway è stata annullata.",
  "settings.gateways.problem.actionFailed": "Non ha funzionato. Non è cambiato nulla.",
  "settings.remote.title": "Consenti altri computer",
  "settings.remote.description":
    "Lascia che Psyche su un altro computer usi il Gateway di questo Mac tramite Tailscale. Il Gateway resta su questo Mac e ascolta solo Tailscale Serve, che è l’unico accesso.",
  "settings.remote.step1":
    "Installa Tailscale su questo Mac e sull’altro computer, e accedi a entrambi con la stessa tailnet.",
  "settings.remote.step2":
    "In Terminale su questo Mac, pubblica il Gateway sulla tua tailnet. Questo è Serve, non Funnel.",
  "settings.remote.copyCommand": "Copia comando",
  "settings.remote.copied": "Copiato",
  "settings.remote.step3":
    "Indica al Gateway il suo indirizzo. In config.json nella cartella dati di Psyche, imposta:",
  "settings.remote.step4":
    "Riavvia Psyche. Poi, sull’altro computer, aggiungi questo Mac come Gateway. Mostra un codice di abbinamento e l’impronta di una chiave: confrontali con la richiesta in “In attesa di abbinamento” qui, poi approvala.",
  "settings.remote.funnel":
    "Non attivare mai Tailscale Funnel per questo. Metterebbe il Gateway su internet pubblico.",
  "settings.remote.configWarnings":
    "config.json contiene impostazioni che questa versione di Psyche non conosce e quindi ignora: {keys}. Se intendevi una di queste, controlla l’ortografia.",
  "settings.uninstall.group": "Disinstalla Psyche",
  "settings.uninstall.groupHint":
    "Ferma il Gateway e l’assistente e sposta l’app nel Cestino. I tuoi dati restano, a meno che tu non scelga altrimenti.",
  "settings.uninstall.open": "Disinstalla Psyche…",
  "settings.uninstall.title": "Disinstalla Psyche",
  "settings.uninstall.description":
    "Tutto ciò che segue va nel Cestino, quindi puoi ancora recuperarlo. Niente viene eliminato definitivamente.",
  "settings.uninstall.dataChoice": "I tuoi dati",
  "settings.uninstall.keep": "Conserva i miei dati",
  "settings.uninstall.keepHint":
    "Chat, memoria, cassaforte e backup restano nella cartella dei dati.",
  "settings.uninstall.delete": "Elimina i miei dati",
  "settings.uninstall.deleteHint":
    "Sposta nel Cestino anche la cartella dei dati: chat, memoria, cassaforte e backup.",
  "settings.uninstall.willDo": "Cosa succede",
  "settings.uninstall.stopAgent": "Il LaunchAgent del Gateway viene fermato e rimosso.",
  "settings.uninstall.stopHelper":
    "Psyche Helper viene fermato e «Apri al login» viene disattivato.",
  "settings.uninstall.trash": "Spostato nel Cestino",
  "settings.uninstall.kind.agent": "LaunchAgent del Gateway",
  "settings.uninstall.kind.support": "Application Support",
  "settings.uninstall.kind.cache": "Cache, log, preferenze e stato salvato",
  "settings.uninstall.kind.data": "I tuoi dati",
  "settings.uninstall.kind.app": "L’app",
  "settings.uninstall.agentOther":
    "L’agente del Gateway appartiene a un’altra copia di Psyche o allo strumento da riga di comando, quindi viene lasciato dov’è.",
  "settings.uninstall.blocked": "{path} non può essere spostato nel Cestino da qui: {reason}",
  "settings.uninstall.keychainStays":
    "Gli elementi del portachiavi restano (la chiave della cassaforte e quelli dell’assistente). Rimuovili in Accesso Portachiavi se vuoi.",
  "settings.uninstall.keychainGoes":
    "Vengono rimossi anche gli elementi del portachiavi per la cassaforte e l’assistente.",
  "settings.uninstall.removeKeychain":
    "Rimuovi anche i miei elementi del portachiavi (com.psyche.vault e quelli dell’assistente). Senza i tuoi dati sono inutili.",
  "settings.uninstall.kind.state": "Stato salvato delle finestre",
  "settings.uninstall.dataStays": "La cartella dei tuoi dati non viene toccata.",
  "settings.uninstall.typeWord": "Digita {word} per confermare",
  "settings.uninstall.presence":
    "Ti verrà poi chiesto di confermare con Touch ID o su questo dispositivo, perché così i tuoi dati vengono rimossi.",
  "settings.uninstall.approvalLabel": "Disinstalla Psyche ed elimina i dati",
  "settings.uninstall.failed":
    "Psyche non è riuscito a disinstallarsi ({reason}). Nient’altro è stato modificato.",
  "settings.uninstall.cancel": "Annulla",
  "settings.uninstall.go": "Disinstalla ed esci",
  "settings.uninstall.goDelete": "Elimina i dati e disinstalla",
  "settings.remote.admin":
    "Un computer che si abbina ottiene lettura, scrittura e approvazioni. L’amministrazione resta disattivata a meno che tu non la selezioni durante l’approvazione, e ogni modifica di amministrazione richiede comunque il tuo Touch ID qui.",
  "settings.remote.address": "Indirizzo pubblico",
  "settings.remote.addressUnset": "Non impostato",
  "settings.remote.proxy": "Proxy attendibile",
  "settings.remote.on": "Sì",
  "settings.remote.off": "No",
  "settings.remote.fingerprint": "Chiave di questo Gateway",
  "settings.remote.fingerprintHint":
    "Confrontala con l’impronta che l’altro computer mostra alla prima connessione.",
  "settings.remote.loadLabel": "Identità del Gateway",
  "settings.remote.clientNote":
    "Questo computer è un client di {host}. L’accesso remoto si configura su {host}.",
  "settings.pair.title": "Abbina un altro computer",
  "settings.pair.description":
    "Crea un link di abbinamento, o un codice QR, per Psyche su un altro computer. Funziona una sola volta, per dieci minuti, e il computer che lo usa viene abbinato con l’accesso che selezioni qui, senza una seconda approvazione.",
  "settings.pair.needsAddress":
    "Imposta prima l’indirizzo pubblico di questo Mac (passaggio 3 qui sopra), poi crea un link di abbinamento.",
  "settings.pair.scopes": "Cosa può fare l’altro computer",
  "settings.pair.adminHint":
    "L’amministrazione gli permette di modificare impostazioni di sicurezza, dispositivi e vault, e resta disattivata a meno che tu non la selezioni. Ogni modifica di amministrazione richiede comunque il tuo Touch ID qui.",
  "settings.pair.make": "Crea un link di abbinamento",
  "settings.pair.resultRegion": "Link di abbinamento e codice QR",
  "settings.pair.qrLabel": "Codice QR del link di abbinamento per {host}",
  "settings.pair.scan":
    "Sull’altro computer, scegli Aggiungi un Gateway e incolla questo link per {host}.",
  "settings.pair.expires": "Scade {when}.",
  "settings.pair.linkLabel": "Link di abbinamento",
  "settings.pair.copy": "Copia link",
  "settings.pair.gives": "Una volta usato, quel computer ottiene: {scopes}.",
  "settings.pair.compare":
    "Controlla la chiave di questo Mac prima di usare il link: {fingerprint}. Puoi confrontarla.",
  "settings.pair.secret":
    "Chiunque abbia questo link nei prossimi dieci minuti può abbinare un computer. Non pubblicarlo né inviarlo a chi non fiderebbe con questo Mac.",
  "settings.pair.live": "Link di abbinamento non usati",
  "settings.pair.unused": "Non ancora usato",
  "settings.pair.revoke": "Revoca",
  "settings.pair.revokeNamed": "Revoca il link di abbinamento creato {when}",
  "settings.pair.madeToast":
    "Link di abbinamento creato. Funziona una sola volta, per dieci minuti.",
  "settings.pair.usedToast": "Un computer si è abbinato con il tuo link.",
  "settings.pair.gone": "Il link di abbinamento non è più valido, quindi non viene più mostrato.",
  "settings.pair.err.noAddress":
    "Questo Mac non ha ancora un indirizzo pubblico, quindi non c’è nulla da mettere in un link.",
  "settings.pair.err.tooMany":
    "Ci sono già tre link di abbinamento non usati. Revocane uno, oppure aspetta che scada.",
  "settings.pair.err.forbidden":
    "Solo Psyche sull’Host stesso, abbinato come amministratore, può creare un link di abbinamento.",
  "settings.pair.err.failed": "Impossibile creare un link di abbinamento ({reason}).",
  "settings.pair.via": "Da dove si collegherà l’altro computer?",
  "settings.pair.viaAddress": "Tramite Tailscale, all’indirizzo di questo Mac",
  "settings.pair.viaLan": "Da questa rete",
  "settings.pair.viaLanHint":
    "Un link per questa rete contiene la chiave e il certificato di questo Mac, quindi funziona solo per i computer sullo stesso Wi-Fi o Ethernet.",
  "settings.pair.lanNote":
    "Questo link è per i computer sulla stessa rete di questo Mac. Indica la chiave e il certificato che Psyche pretenderà.",
  "settings.pair.err.noLan":
    "Attiva “Consenti computer su questa rete” e aspetta che sia in ascolto, per creare un link per questa rete.",
  "settings.key.gateway.lan": "Consenti computer su questa rete",
  "settings.key.gateway.lan.rotateCert": "Il certificato di rete",
  "settings.lan.title": "Consenti computer su questa rete",
  "settings.lan.description":
    "Permetti a Psyche su un altro computer sullo stesso Wi-Fi o Ethernet di raggiungere il Gateway di questo Mac, senza Tailscale. È disattivato finché non lo attivi.",
  "settings.lan.loadLabel": "Accesso di rete",
  "settings.lan.unsupported": "Questo Gateway è troppo vecchio per restare in ascolto sulla rete.",
  "settings.lan.toggle": "Consenti computer su questa rete",
  "settings.lan.toggleHint":
    "Psyche resta in ascolto su una rete, tramite una connessione cifrata con un proprio certificato. Un computer che si collega deve comunque essere approvato qui con Touch ID.",
  "settings.lan.ipv6": "Usa anche gli indirizzi IPv6 di questa rete",
  "settings.lan.ipv6Hint":
    "Aggiunge gli indirizzi IPv6 privati (iniziano con fd o fc) della rete scelta. Gli indirizzi IPv6 pubblici e quelli fe80 non vengono mai usati.",
  "settings.lan.problem.ipv6Off":
    "{address} è un indirizzo IPv6 e IPv6 è disattivato, quindi Psyche non resta in ascolto su di esso. Attiva IPv6 qui sopra, oppure rimuovilo.",
  "settings.lan.problem.ipv6NeedsIpv4":
    "Psyche non resta in ascolto su {address}. IPv6 si usa solo insieme all’indirizzo IPv4 di questa rete, che devi prima consentire qui.",
  "settings.lan.interface": "Rete",
  "settings.lan.interfaceDefault": "Rete principale",
  "settings.lan.interfaceOption": "{name} ({address})",
  "settings.lan.noInterface":
    "Su questo Mac non è stata trovata alcuna connessione Wi-Fi o Ethernet.",
  "settings.lan.trustedOnly":
    "Attivalo solo su una rete di cui ti fidi. Su un Wi-Fi condiviso o per gli ospiti, chiunque sia connesso può raggiungere la schermata di abbinamento.",
  "settings.lan.status": "Stato",
  "settings.lan.listening": "In ascolto su {addresses}",
  "settings.lan.notListening": "Non in ascolto",
  "settings.lan.address": "Indirizzo",
  "settings.lan.discovery": "Rilevamento",
  "settings.lan.advertised": "Mostrato a Psyche su questa rete",
  "settings.lan.notAdvertised": "Non mostrato. Aggiungi questo Mac tramite il suo indirizzo.",
  "settings.lan.certificate": "Certificato",
  "settings.lan.certificateHint":
    "I computer che si abbinano lo ricordano. Se sostituisci il certificato, tutti dovranno abbinarsi di nuovo.",
  "settings.lan.rotate": "Sostituisci certificato",
  "settings.lan.rotateTitle": "Sostituire il certificato di rete?",
  "settings.lan.rotateBody":
    "I computer già abbinati tramite la rete smetteranno di collegarsi finché non si abbinano di nuovo. Usalo se pensi che il certificato sia stato copiato.",
  "settings.lan.rotateConfirm": "Sostituisci e disconnetti",
  "settings.lan.rotateFailed":
    "Impossibile sostituire il certificato ({reason}). Non è cambiato nulla.",
  "settings.lan.problem.unknownInterface": "{name} non è una rete di questo Mac.",
  "settings.lan.problem.noInterface":
    "Non c’è alcuna rete su cui restare in ascolto, quindi nulla è in ascolto.",
  "settings.lan.problem.bindFailed":
    "Impossibile restare in ascolto su {address}. Un altro programma potrebbe usare la porta.",
  "settings.lan.problem.paused":
    "L’accesso LAN è in pausa su questa rete. L’hai attivato per un’altra.",
  "settings.lan.allowHere": "Consenti su questa rete",
  "settings.lan.problem.cert":
    "Psyche non è riuscito a creare o leggere il proprio certificato di rete, quindi non resta in ascolto.",
  "settings.lan.problem.cloudflare":
    "Questo Gateway è configurato per essere raggiunto solo tramite Cloudflare Access, quindi non resta in ascolto anche sulla rete.",
  "settings.gateways.discoverConflict":
    "Più di un computer ha annunciato questo nome con chiavi diverse, quindi Psyche non lo aggiunge. Aggiungi quello giusto tramite il suo indirizzo.",
  "settings.lan.problem.container":
    "Un Gateway in un container non resta in ascolto sulla rete in questo modo.",
  "settings.lan.problem.advertise":
    "Psyche non è riuscito ad annunciarsi sulla rete. I computer possono comunque aggiungere questo Mac tramite il suo indirizzo.",
  "settings.gateways.discover": "Cerca su questa rete",
  "settings.gateways.discovering": "Ricerca…",
  "settings.gateways.discoverTitle": "Su questa rete",
  "settings.gateways.discoverNone":
    "Nessun Psyche trovato. Su quel computer, attiva “Consenti computer su questa rete”.",
  "settings.gateways.discoverFailed":
    "Impossibile cercare sulla rete. Aggiungilo invece tramite il suo indirizzo.",
  "settings.gateways.discoverKey": "Chiave {fingerprint}",
  "settings.gateways.discoverHint":
    "Ciò che un computer annuncia sulla rete è solo un’affermazione. La schermata di abbinamento mostra la sua chiave: confrontala con quella dell’Host prima di approvare.",
  "settings.gateways.discoverAdd": "Aggiungi {name}",
  "settings.gateways.discoverSaved": "Salvato",
  "settings.devices.gatewayKey": "Chiave di questo Gateway {fingerprint}",
  "settings.devices.fromAddress": "Da {address}",
  "settings.devices.fromLan": "Da {address}, sulla tua rete. Controlla l’intera chiave qui sotto.",
  "settings.devices.adminOptIn":
    "L’amministrazione permette a questo computer di modificare impostazioni di sicurezza, dispositivi e vault. Lasciala disattivata a meno che non ti serva.",
  "settings.skills.signer.title": "Chi l’ha creata",
  "settings.skills.signer.unsigned":
    "Non firmata. Nulla indica chi l’ha creata né che non sia stata modificata lungo la strada, quindi si installa come autore sconosciuto.",
  "settings.skills.signer.new": "Firmata da {name}. Non hai mai visto prima questa chiave.",
  "settings.skills.signer.seen":
    "Firmata da {name}, con una chiave che hai già visto ma di cui non ti fidi.",
  "settings.skills.signer.trusted": "Firmata da {name}, un autore di cui ti fidi.",
  "settings.skills.signer.own": "Firmata da te.",
  "settings.skills.signer.changed":
    "Firmata da {name}, ma non con la chiave vista prima. Verifica che sia la stessa persona prima di installarla.",
  "settings.skills.signer.changedUpdate":
    "Firmata da {name}, con una chiave diversa dalla versione che hai installato. Verifica che sia la stessa persona prima di aggiornare.",
  "settings.skills.signer.dropped":
    "La versione installata era firmata da {name}. Questa non è firmata affatto.",
  "settings.skills.signer.impersonates":
    "Firmata da {name}, che somiglia al nome con cui firmi le tue skill, ma la chiave non è tua. Non installarla a meno che tu non sappia da dove viene.",
  "settings.skills.signer.nameChanged":
    "Firmata da una chiave di cui ti fidi, ma con un nome che non aveva mai usato: {name}. Verifica che sia ancora la stessa persona.",
  "settings.skills.signer.originAgent":
    "Scritta da un assistente sul Mac del mittente. Leggila come testo non rivisto, chiunque l’abbia firmata.",
  "settings.skills.widened.specialist": "Ruolo in background",
  "settings.skills.bundleOriginAgent": "Scritta da un assistente altrove",
  "settings.skills.export.label": "Firma di “{name}”",
  "settings.skills.author.label": "Fiducia nell’autore",
  "settings.skills.signer.claim":
    "Il nome è un’affermazione dell’autore stesso. La chiave è ciò che lega insieme le versioni.",
  "settings.skills.signer.key": "Chiave dell’autore",
  "settings.skills.signer.trust": "Considera {name} un autore attendibile",
  "settings.skills.signer.trustHint":
    "Le versioni successive firmate con questa chiave vengono contrassegnate come di un autore di cui ti fidi. Ogni installazione chiede comunque prima a te.",
  "settings.skills.widened.title": "Chiede più della versione installata",
  "settings.skills.widened.hint":
    "Approvarla non le dà alcun permesso di per sé, ma ora porterà anche a queste domande.",
  "settings.skills.widened.permissions": "Nuovi permessi",
  "settings.skills.widened.tools": "Nuovi strumenti",
  "settings.skills.widened.prompts": "Nuovi file di prompt",
  "settings.skills.import.file": "Importa un file…",
  "settings.skills.import.hint":
    "Un file .psyche-skill di qualcun altro, o un link https a uno. Viene controllato e mostrato prima di installare qualsiasi cosa.",
  "settings.skills.import.failed": "Psyche non è riuscito a leggere quel file ({reason}).",
  "settings.skills.import.tooBig": "quel file supera gli 8 MB",
  "settings.skills.signedBy": "Firmata da {name}",
  "settings.skills.signedState":
    "{state, select, own {tu} trusted {attendibile} revoked {revocata} other {non attendibile}}",
  "settings.skills.export": "Esporta…",
  "settings.skills.export.title": "Esporta “{name}”",
  "settings.skills.export.hint":
    "Il file è firmato con la tua chiave d’autore, così chi lo riceve può capire che è tuo e che non è stato modificato. La chiave resta su questo Mac.",
  "settings.skills.export.nameLabel": "Nome con cui firmare",
  "settings.skills.export.nameHint":
    "Si crea una sola volta. Lo vedono tutti quelli che importano le tue skill.",
  "settings.skills.export.go": "Esporta e firma",
  "settings.skills.exported":
    "“{name}” esportata come {file}, firmata come {author}.{created, select, true { La tua chiave d’autore è stata creata: {key}.} other {}}",
  "settings.skills.author.trust": "Considera attendibile questo autore",
  "settings.skills.author.untrust": "Non considerare più attendibile questo autore",
  "settings.skills.author.revoke": "Revoca questo autore",
  "settings.skills.author.revokeTitle": "Revocare la chiave di {name}?",
  "settings.skills.author.revokeDescription":
    "Le skill firmate con essa smettono di caricarsi, e i nuovi file firmati con essa vengono rifiutati. Potrai fidarti di nuovo in seguito.",
  "settings.skills.author.revokeConfirm": "Revoca",
  "settings.usage.unavailable": "L’utilizzo non è ancora disponibile da questo Gateway.",
  "settings.usage.thisMonth": "Questo mese",
  "settings.usage.monthLine":
    "{cost} e {tokens} token in {turns, plural, one {# turno} other {# turni}}. Oggi finora: {today}.",
  "settings.usage.noBudget": "Nessun budget mensile impostato.",
  "settings.usage.byModel": "Ultimi 7 giorni per modello",
  "settings.usage.model": "Modello",
  "settings.usage.turns": "{n, plural, one {# turno} other {# turni}}",
  "settings.usage.planWindow": "{model}: {pct}% della finestra del piano usato, si azzera {when}.",
  "settings.vm.enabledHint":
    "Le attività che lo richiedono vengono eseguite nel guest, solo con le cartelle che condividi.",
  "settings.vm.credentialsHint":
    "Con il vault dell’host, i valori restano sul tuo Mac. Un vault del guest tiene una copia propria.",
  "settings.voice.anyAppHint":
    "ovunque tu stia scrivendo. Il testo va al cursore, mai all’agente né a un campo password.",
  "settings.voice.talkHint":
    "Un pulsante Voce nel campo di scrittura avvia una conversazione parlata. La voce non approva mai nulla.",
  "settings.people.title": "Persone e progetti",
  "settings.people.description":
    "Le schede che {persona} tiene per le persone e i progetti della tua vita. Restano su questo Mac, e ogni fatto mostra da dove proviene.",
  "settings.people.loadLabel": "Caricamento delle impostazioni su persone e progetti",
  "settings.people.off":
    "Disattivato. {persona} non tiene schede per le persone e i progetti della tua vita.",
  "settings.people.turnOn": "Attiva",
  "settings.people.graph": "Impara le persone da",
  "settings.people.entityRecall": "Usa i nomi nelle risposte",
  "settings.people.entityRecallHint":
    "Quando nomini qualcuno in una chat privata, {persona} aggiunge una riga su di lui/lei. Mai nei gruppi o nei canali.",
  "settings.people.sources": "Impara le persone da",
  "settings.people.sourcesHint":
    "Ogni fonte è disattivata finché non la attivi. Disattivandone una, smette di leggerla.",
  "settings.people.source.contacts": "Contatti",
  "settings.people.source.mail": "Mail",
  "settings.people.source.calendar": "Calendario",
  "settings.people.source.messages": "Messaggi",
  "settings.people.source.messagesHint": "Usa a chi scrivi e quando, mai il testo dei messaggi.",
  "settings.people.source.notes": "Note",
  "settings.people.source.chats": "Le tue chat",
  "settings.people.sourceOff": "No",
  "settings.people.sourceCounts":
    "{entities, plural, one {# persona o progetto} other {# persone e progetti}} · {interactions, plural, one {# interazione} other {# interazioni}} · {read, select, none {non ancora letto} other {letto il {read}}}",
  "settings.people.retention": "Per quanto tempo restano le interazioni",
  "settings.people.retentionLabel": "Conserva le interazioni per",
  "settings.people.retentionHint":
    "Le intestazioni e i link più vecchi vengono eliminati ogni notte. Schede, fatti e questioni aperte restano finché non li dimentichi.",
  "settings.people.months": "{n, plural, one {# mese} other {# mesi}}",
  "settings.people.learning": "Come si tengono le schede",
  "settings.people.learningHint":
    "Riassunti, ruoli e questioni aperte provengono dal modello di servizio, locale per impostazione predefinita.",
  "settings.people.budget":
    "Stanotte: {tokens, number} di {maxTokens, number} token, {entities, number} di {maxEntities, number} persone e progetti. Riassunti, ruoli e questioni provengono dal modello di servizio, locale per impostazione predefinita.",
  "settings.people.nightly": "Ogni notte",
  "settings.people.nightlyHint": "Aggiorna i riassunti e trova le questioni aperte mentre dormi.",
  "settings.people.afterRun": "Dopo ogni attività",
  "settings.people.afterRunHint":
    "Aggiorna le poche persone e progetti che un’attività ha toccato.",
  "settings.people.precision": "Questioni suggerite che hai tenuto: {list}.",
  "settings.people.precisionItem": "{source} {confirmed, number} su {total, number}",
  "settings.people.aboutYou": "Su di te",
  "settings.people.aboutYouHint":
    "La tua scheda personale: ogni fatto che {persona} ha imparato su di te, con la sua fonte.",
  "settings.people.openOwnCard": "Apri la tua scheda",
  "settings.people.ownCardHint":
    "Fatti su di te dal tuo profilo, dalle chat e dalle app collegate.",
  "settings.people.editUserMd": "Modifica USER.md",
  "settings.people.blocked": "Bloccati da Persone",
  "settings.people.blockedHint":
    "Non si impara più nulla su di loro. Un dominio bloccato copre ogni indirizzo al suo interno.",
  "settings.people.noneBlocked": "Nessuno è bloccato.",
  "settings.people.blockedOn": "{kind} · bloccato il {date}",
  "settings.people.unblock": "Sblocca",
  "settings.people.unblockLabel": "Sblocca {hint}",
  "settings.people.block": "Blocca",
  "settings.people.blockKindLabel": "Cosa bloccare",
  "settings.people.blockValue": "Indirizzo, telefono o dominio",
  "settings.people.blockKind.email": "Indirizzo email",
  "settings.people.blockKind.phone": "Numero di telefono",
  "settings.people.blockKind.domain": "Dominio",
  "settings.people.blockKind.contact": "Contatto",
  "settings.people.blockKind.channel": "Canale",
  "settings.people.blockKind.calendar": "Calendario",
  "settings.people.blockKind.url": "Indirizzo web",
  "settings.people.blockPlaceholder.email": "nome@esempio.com",
  "settings.people.blockPlaceholder.phone": "+39 333 0100000",
  "settings.people.blockPlaceholder.domain": "esempio.com",
  "settings.people.nothingStored": "Ancora nulla è memorizzato da nessuna fonte.",
  "settings.people.sourceStored":
    "{entities, plural, one {# persona o progetto} other {# persone e progetti}} · {interactions, plural, one {# interazione} other {# interazioni}}",
  "settings.people.deleteSource": "Elimina…",
  "settings.people.deleteSourceLabel": "Elimina ciò che ha portato {source}",
  "settings.people.deleteSourceTitle": "Eliminare ciò che ha portato {source}?",
  "settings.people.deleteSourceAfter":
    "{source} viene disattivato così la prossima sincronizzazione non lo riporta. I fatti che hai aggiunto tu restano.",
  "settings.people.deleteSourceConfirm": "Elimina",
  "settings.people.deletedSource": "Eliminato ciò che ha portato {source}.",
  "settings.people.forgetAll": "Tutto su persone e progetti",
  "settings.people.forgetAllHint":
    "Elimina ogni persona, progetto, scheda e questione aperta, e disattiva Persone e progetti. I tuoi file di memoria restano.",
  "settings.people.forgetAllButton": "Dimentica…",
  "settings.people.forgetAllTitle": "Dimenticare tutto su persone e progetti?",
  "settings.people.forgetAllAfter":
    "L’operazione non si può annullare. Persone e progetti si disattiva; riattivalo per ricominciare da zero.",
  "settings.people.typeToConfirm": "Digita “{phrase}” per confermare",
  "settings.people.forgetAllConfirm": "Dimentica tutto",
  "settings.people.forgotAll": "Dimenticato tutto su persone e progetti.",
  "settings.people.counting": "Verifica di cosa verrebbe eliminato…",
  "settings.people.previewFailed":
    "Psyche non è riuscito a contare cosa verrebbe eliminato ({reason}).",
  "settings.people.removeCounts":
    "Psyche elimina {entities, plural, one {# persona o progetto} other {# persone e progetti}}, {facts, plural, one {# fatto} other {# fatti}}, {interactions, plural, one {# interazione} other {# interazioni}}, {loops, plural, one {# questione aperta} other {# questioni aperte}} e {identifiers, plural, one {# indirizzo} other {# indirizzi}}.",
  "settings.specialists.title": "Specialisti",
  "settings.specialists.description":
    "Attività in background con un ruolo definito, ciascuna entro il proprio budget, che consegnano un risultato alla tua Posta in arrivo.",
  "settings.specialists.all": "Tutti gli specialisti",
  "settings.specialists.concurrent": "Specialisti contemporaneamente",
  "settings.specialists.concurrentHint": "Più ne girano affiancati; gli altri aspettano in coda.",
  "settings.specialists.monthlyCap": "Spesa mensile",
  "settings.specialists.monthlyCapHint":
    "Raggiunto il limite, i nuovi lavori aspettano il budget. Se vuoto, usa metà del tuo budget mensile{budget, select, none {} other { ({budget})}}.",
  "settings.specialists.monthlyCapNone": "Nessun limite",
  "settings.specialists.showInFeed": "Mostra i risultati nel Feed",
  "settings.specialists.showInFeedHint": "La tua Posta in arrivo riceve comunque ogni risultato.",
  "settings.specialists.roles": "Ruoli",
  "settings.specialists.rolesHint":
    "Un ruolo deriva da una skill. Uno che hai installato resta disattivato finché non lo attivi.",
  "settings.specialists.turnOn": "{role} attivo",
  "settings.specialists.summary": "{model} · {budget} · {mode}",
  "settings.specialists.budgetLine": "{tokens} token · {cost} · {minutes} min",
  "settings.specialists.edit": "Modifica",
  "settings.specialists.done": "Fine",
  "settings.specialists.editLabel": "Modifica {role}",
  "settings.specialists.model": "Modello",
  "settings.specialists.modelDefault": "Predefinito: {class}",
  "settings.specialists.class.utility": "modello di servizio",
  "settings.specialists.class.primary": "modello principale",
  "settings.specialists.class.harness": "ambiente di coding",
  "settings.specialists.class.vision": "modello principale con visione",
  "settings.specialists.budget": "Budget per lavoro",
  "settings.specialists.budgetTokens": "Token",
  "settings.specialists.budgetCost": "Costo (USD)",
  "settings.specialists.budgetMinutes": "Minuti",
  "settings.specialists.budgetCaps":
    "Fino a {tokens} token · {cost} · {minutes} min. Un lavoro può chiederne di più, mai oltre questo limite.",
  "settings.specialists.maxMode": "Il massimo che può fare senza chiedere",
  "settings.specialists.mode.plan": "Piano",
  "settings.specialists.mode.manual": "Manuale",
  "settings.specialists.mode.balanced": "Bilanciata",
  "settings.specialists.mode.auto": "Auto",
  "settings.specialists.installed": "Da {skill}",
  "settings.specialists.empty": "Nessuna skill definisce ancora uno specialista.",
  "settings.language.description": "Lingua del testo e modo in cui si scrivono date e numeri.",
  "settings.language.languageHint": "Tutto ciò che non è ancora tradotto compare in inglese.",
  "settings.persona.identityHint": "Nome e slogan.",
  "settings.persona.avatarHint": "Scegli una creatura, oppure descrivi una modifica.",
  "settings.persona.whileWorkingHint": "Cosa vedi mentre un’attività è in corso.",
  "settings.daily.group.briefHint": "Un breve riassunto per iniziare la giornata.",
  "settings.daily.group.wrapupHint": "Uno sguardo indietro a ciò che è stato fatto.",
  "settings.daily.group.deliveryHint": "Come ti raggiungono.",
  "settings.daily.group.automationsHint": "Attività ricorrenti che Psyche esegue per te.",
  "settings.voice.dictationHint": "Parla invece di scrivere.",
  "settings.usage.byThreadHint": "Dove sono andati token e costi.",
  "settings.skills.installedHint": "Le skill che Psyche può usare ora.",
  "settings.about.versionsHint": "Cosa è in esecuzione su questo Mac.",
  "settings.specialists.allHint": "Attiva o disattiva i ruoli e imposta i loro budget.",
  "settings.vm.sandboxMacHint": "Dove vengono eseguiti i comandi.",
  "settings.computerUse.macPermissionsHint": "Cosa ha consentito macOS.",
  "settings.voice.advancedHint": "Motore vocale",
  "settings.files.advancedHint": "Lascia che Psyche esegua comandi nelle cartelle condivise",
  "settings.browser.advancedHint": "Firma le richieste web di Psyche",
  "settings.skills.advancedHint": "Skill incluse in Psyche",
  "settings.skills.madeByAgent": "Creata da {persona}",
  "settings.skills.history":
    "{n, plural, one {# versione precedente} other {# versioni precedenti}}",
  "settings.skills.historyItem":
    "v{version} · approvata {approved} · {retiredBy, select, delete {eliminata} other {sostituita}} {retired}",
  "settings.skills.historyHint":
    "Conservate come riferimento. Queste versioni non vengono mai caricate.",
  "settings.mcp.madeBy": "Creato da Psyche",
  "settings.mcp.madeByHint":
    "Psyche ha scritto il codice di questo connettore. Gira solo nella sandbox, solo il codice che hai approvato, e i suoi strumenti chiedono prima di cambiare qualsiasi cosa.",
  "settings.mcp.code.title": "Codice",
  "settings.mcp.code.view": "Mostra codice",
  "settings.mcp.code.hide": "Nascondi codice",
  "settings.mcp.code.loading": "Caricamento del codice…",
  "settings.mcp.code.version": "Versione {version} · {runtime} · avvia {entry}",
  "settings.mcp.code.modified":
    "Il codice su disco non è la versione che hai approvato, quindi questo connettore è fermo finché non approvi la modifica.",
  "settings.mcp.code.file": "{path} · {bytes} B",
  "settings.mcp.code.edit": "Modifica {file}",
  "settings.mcp.code.editing": "Modifica di {file}",
  "settings.mcp.code.save": "Salva per la revisione",
  "settings.mcp.code.saving": "Salvataggio…",
  "settings.mcp.code.cancel": "Annulla modifica",
  "settings.mcp.code.provided": "Fornito da Psyche, uguale per ogni connettore",
  "settings.mcp.code.approved": "{name} aggiornato.",
  "settings.mcp.code.denied":
    "Modifica a {name} non approvata. Resta fermo finché non ne approvi una.",
  "settings.deviceAccess.files.title": "File su questo Mac",
  "settings.deviceAccess.files.hint":
    "Le cartelle che {persona} può leggere, e modificare dove lo consenti. Le condividi in Permessi → Accesso.",
  "settings.deviceAccess.files.more": "{count, plural, one {e 1 altra} other {e altre #}}",
  "settings.deviceAccess.open": "Apri Accesso",
  "settings.deviceAccess.terminal.title": "Terminale",
  "settings.deviceAccess.terminal.hint":
    "{persona} può eseguire comandi di terminale su questo Mac quando “Esegui comandi su questo Mac” è attivo in Permessi → Accesso.",
  "settings.deviceAccess.terminal.where":
    "I comandi vengono eseguiti sul tuo Mac, nelle cartelle che hai condiviso, e possono scrivere solo in una cartella condivisa in lettura e scrittura.",
  "settings.deviceAccess.terminal.asks":
    "I comandi che potrebbero modificare i file chiedono prima, a meno che tu non scelga di consentire sempre quel comando esatto. I comandi di base di sola lettura come ls, cat o wc vengono eseguiti senza chiedere, a meno che tu non lo disattivi.",
  "settings.deviceAccess.terminal.sandbox":
    "I comandi vengono eseguiti nella sandbox. Un’esecuzione approvata va senza sandbox solo se digiti UNSANDBOXED sulla sua scheda.",
  "settings.deviceAccess.terminal.on": "L’esecuzione di comandi è attiva",
  "settings.deviceAccess.terminal.off": "L’esecuzione di comandi è disattivata",
  "settings.deviceAccess.terminal.folders":
    "{count, plural, =0 {Nessuna cartella condivisa: i comandi non hanno dove essere eseguiti.} one {1 cartella condivisa.} other {# cartelle condivise.}}",
  "settings.mcp.needs.title": "Cosa serve sul tuo Mac",
  "settings.mcp.needs.srt": "Sandbox (srt)",
  "settings.mcp.needs.srt.fix": "Tiene il server lontano dai dati privati di Psyche.",
  "settings.mcp.needs.node": "Strumenti Node.js (npm)",
  "settings.mcp.needs.node.fix":
    "Gira sul Node di Psyche; serve npm su questo Mac. Installa Node.js da nodejs.org, oppure esegui brew install node.",
  "settings.mcp.needs.uv": "uv (uvx)",
  "settings.mcp.needs.uv.fix":
    "Un server Python. Installa uv con brew install uv o da docs.astral.sh/uv.",
  "settings.mcp.needs.network": "Rete",
  "settings.mcp.needs.network.fix": "Raggiunge l’indirizzo del server stesso.",
  "settings.mcp.needs.networkHosts": "Raggiunge solo {hosts} per scaricare ed eseguire il server.",
  "settings.mcp.needs.missing": "Mancante",
  "settings.mcp.needs.ready": "Pronto",
  "settings.mcp.needs.checked": "Verificato con “Controlla server”",
  "settings.mcp.fail.no_srt":
    "La sandbox non è installata. Configurala qui sotto, poi controlla di nuovo il server.",
  "settings.mcp.fail.node_missing":
    "Installa Node.js (nodejs.org, oppure brew install node) in modo che npm sia presente su questo Mac, poi ricontrolla.",
  "settings.mcp.fail.uv_missing":
    "Installa uv (brew install uv, oppure docs.astral.sh/uv), poi controlla di nuovo il server.",
  "settings.mcp.fail.command_not_found":
    "Il comando del server non è installato qui. Controlla il comando, oppure installa lo strumento che indica.",
  "settings.mcp.fail.network_blocked":
    "Il server non è riuscito a scaricare o raggiungere ciò che gli serve. Controlla la connessione e che i suoi host siano consentiti.",
  "settings.mcp.fail.timeout":
    "Ha impiegato troppo tempo. La prima esecuzione scarica il pacchetto; controlla la connessione e riprova.",
  "settings.mcp.fail.exited":
    "Il server si è fermato subito dopo l’avvio. Il suo ultimo output è qui sotto.",
  "settings.mcp.fail.failed": "Controlla l’output del server qui sotto, poi riprova.",
  "settings.mcp.fail.exitCode": "Codice di uscita {code}.",
  "settings.mcp.fail.output": "Output del server",
  "settings.connectors.page.description":
    "Le app e gli strumenti che {persona} può usare. Ognuno chiede prima di agire, a meno che tu non dica diversamente.",
  "settings.connectors.page.needsYou": "Serve te",
  "settings.connectors.page.connected": "Collegati",
  "settings.connectors.page.onThisMac": "Su questo Mac",
  "settings.connectors.page.addMore": "Aggiungine altri",
  "settings.connectors.page.addMore.hint":
    "Mail, calendario, note e strumenti già pronti. Ognuno chiede prima di agire.",
  "settings.connectors.page.addMore.browse": "Sfoglia tutti",
  "settings.connectors.page.status.paused": "In pausa",
  "settings.connectors.page.status.notWorking": "Non funziona",
  "settings.connectors.page.status.signInExpired": "Accesso scaduto",
  "settings.connectors.page.status.on": "Sì",
  "settings.connectors.page.status.off": "No",
  "settings.connectors.page.paused": "In pausa",
  "settings.connectors.page.open": "Apri {name}",
  "settings.connectors.page.manage": "Gestisci",
  "settings.connectors.page.fix.seeWhy": "Scopri perché",
  "settings.connectors.page.row.never": "Non ancora usato",
  "settings.connectors.page.row.lastUsed": "Usato {when}",
  "settings.connectors.page.row.unverified": "Non verificato",
  "settings.connectors.page.row.local": "Gira su questo Mac",
  "settings.connectors.page.row.remote": "Si collega tramite il web",
  "settings.connectors.page.row.files":
    "{count, plural, =0 {Nessuna cartella condivisa} one {1 cartella condivisa} other {# cartelle condivise}}",
  "settings.connectors.page.row.terminal.on": "Può eseguire comandi",
  "settings.connectors.page.row.terminal.off": "I comandi sono disattivati",
  "settings.connectors.page.detail.label": "Dettagli di {name}",
  "settings.connectors.page.detail.about": "Informazioni",
  "settings.connectors.page.detail.access": "Accesso",
  "settings.connectors.page.detail.source": "Fonte",
  "settings.connectors.page.detail.technical": "Dettagli tecnici",
  "settings.connectors.page.detail.manage": "Metti in pausa o rimuovi",
  "settings.connectors.page.detail.type": "Tipo",
  "settings.connectors.page.detail.removeHint":
    "Scollega lo mette in pausa e ne mantiene le impostazioni. Rimuovi lo elimina.",
  "settings.connectors.page.source.builtIn": "Integrato in Psyche",
  "settings.connectors.page.source.verified": "Editore verificato",
  "settings.connectors.page.source.unverified": "Non ancora controllato da nessuno",
  "settings.connectors.page.attention.signIn":
    "Il tuo accesso a {name} è scaduto. Accedi di nuovo perché possa continuare a funzionare.",
  "settings.connectors.page.attention.error":
    "{name} non funziona al momento. Prova ad accedere di nuovo; se continua a non funzionare, rimuovilo e aggiungilo di nuovo.",
  "settings.connectors.page.attention.errorReason": "Cosa ha detto: {reason}",
  "settings.connectors.page.attention.server":
    "{name} non si è avviato, quindi i suoi strumenti non sono disponibili.",
  "settings.connectors.page.attention.serverHint":
    "Controlla il suo comando o indirizzo e gli eventuali segreti qui sotto, poi disattivalo e riattivalo.",
  "settings.connectors.page.server.local": "Uno strumento che gira in una sandbox su questo Mac",
  "settings.connectors.page.server.remote": "Uno strumento che raggiungi tramite un indirizzo web",
  "settings.connectors.page.server.network": "Raggiunge la rete",
  "settings.connectors.page.server.noNetwork": "Nessuna rete",
  "settings.connectors.page.advanced": "Avanzate",
  "settings.connectors.page.advanced.hint":
    "I tuoi server di strumenti e una ricerca nel registro pubblico.",
  "settings.connectors.page.advanced.custom": "Il tuo server di strumenti",
  "settings.connectors.page.advanced.customHint":
    "Esegui qualsiasi server MCP nella sandbox, oppure collegati a uno tramite indirizzo web.",
  "settings.connectors.page.advanced.customAction": "Aggiungi server",
  "settings.connectors.page.advanced.find": "Trova server online",
  "settings.connectors.page.gallery.title": "Aggiungi un connettore",
  "settings.connectors.page.gallery.intro":
    "Scegli qualcosa da provare. Ognuno chiede prima di fare qualsiasi cosa e puoi rimuoverlo quando vuoi.",
  "settings.connectors.page.gallery.noMatch": "Nessun risultato. Prova un’altra parola.",
  "settings.connectors.page.gallery.back": "Torna alla galleria",
  "settings.connectors.page.gallery.community": "Community",
  "settings.nav.memory": "Revisione",
  "settings.nav.everything": "Fonti",
  "settings.learnMore": "Scopri di più",
  "settings.learnLess": "Mostra meno",
  "settings.nav.work": "Lavoro",
  "settings.nav.surfaces": "Dove compare la memoria",
  "settings.key.memory.work": "Lavoro in memoria",
  "settings.key.memory.surfaces": "Dove compare la memoria",
  "settings.key.memory.work.enabled": "Tieni traccia del mio lavoro",
  "settings.key.memory.work.trackedLists": "Elenchi di Promemoria monitorati come lavoro",
  "settings.key.memory.work.anchorsFromFolders": "Quali cartelle contano come lavoro",
  "settings.key.memory.work.remind.enabled": "Ricordami cosa scade domani",
  "settings.key.memory.work.remind.dueSoonHours": "Quanto in anticipo cercare le scadenze",
  "settings.key.memory.work.remind.dayOf": "Dimmi anche al mattino cosa scade oggi",
  "settings.key.memory.surfaces.tiers.work.home": "Lavoro in Home",
  "settings.key.memory.surfaces.tiers.work.brief": "Lavoro nel riepilogo quotidiano",
  "settings.key.memory.surfaces.tiers.work.notification": "Lavoro nelle notifiche",
  "settings.key.memory.surfaces.tiers.work.channel": "Lavoro nel riepilogo inviato a un canale",
  "settings.key.memory.surfaces.tiers.workMail.home": "Posta di lavoro in Home",
  "settings.key.memory.surfaces.tiers.workMail.brief": "Posta di lavoro nel riepilogo quotidiano",
  "settings.key.memory.surfaces.tiers.workMail.notification": "Posta di lavoro nelle notifiche",
  "settings.key.memory.surfaces.tiers.workMail.channel":
    "Posta di lavoro nel riepilogo inviato a un canale",
  "settings.key.memory.surfaces.tiers.people.home": "Persone in Home",
  "settings.key.memory.surfaces.tiers.people.brief": "Persone nel riepilogo quotidiano",
  "settings.key.memory.surfaces.tiers.people.notification": "Persone nelle notifiche",
  "settings.key.memory.surfaces.tiers.people.channel": "Persone nel riepilogo inviato a un canale",
  "settings.key.memory.surfaces.birthdays": "Compleanni e anniversari nel riepilogo e in Home",
  "settings.key.memory.surfaces.hideSources":
    "Tieni una fonte fuori da Home, riepiloghi e notifiche",
  "settings.key.memory.surfaces.kinds.project": "Mostra i progetti fuori da Memoria",
  "settings.key.memory.surfaces.kinds.course": "Mostra i corsi fuori da Memoria",
  "settings.key.memory.surfaces.kinds.assignment": "Mostra le cose da fare fuori da Memoria",
  "settings.key.memory.surfaces.kinds.event": "Mostra gli eventi fuori da Memoria",
  "settings.recording.madeBy": "Da una registrazione",
  "settings.recording.open": "Eseguila ogni settimana",
  "settings.recording.title": "Eseguila a orari stabiliti",
  "settings.recording.checking": "Controllo dei passaggi.",
  "settings.recording.cannot": "Questa non può essere eseguita quando non ci sei:",
  "settings.recording.reason.sensitive": "Il passaggio {step} è un campo che compili tu.",
  "settings.recording.reason.input": "Il passaggio {step} ti chiede un valore ogni volta.",
  "settings.recording.reason.unreadable":
    "I suoi passaggi non si possono leggere. Registrala di nuovo per pianificarla.",
  "settings.recording.reason.browserOnly":
    "Per ora le esecuzioni pianificate sono solo per le registrazioni del browser.",
  "settings.recording.reason.off": "È disattivata o è cambiata dopo la tua approvazione.",
  "settings.recording.reason.notRecording": "Non è una skill creata da una registrazione.",
  "settings.recording.cannotWhy":
    "Un’esecuzione pianificata non ha nessuno a cui chiedere, quindi non compila mai una password né chiede un valore. Puoi comunque eseguirla tu dalla chat.",
  "settings.recording.rules":
    "Scegli tu quando. Ogni esecuzione usa le tue solite approvazioni. Se la pagina è cambiata, o un passaggio richiede la tua approvazione, si ferma a quel passaggio, va in pausa e te lo dice. Non tira mai a indovinare.",
  "settings.recording.every": "Ogni",
  "settings.recording.daily": "giorno",
  "settings.recording.weekly": "settimana il",
  "settings.recording.monthly": "mese il giorno",
  "settings.recording.dayOfWeek": "Giorno della settimana",
  "settings.recording.dayOfMonth": "Giorno del mese",
  "settings.recording.at": "alle",
  "settings.recording.confirm": "Pianificala",
  "settings.recording.close": "Annulla",
  "settings.recording.runs": "Esecuzioni",
  "settings.recording.seeScheduled":
    "mettila in pausa, rimuovila o vedi la sua cronologia in Pianificate",
  "settings.teach.storage.title": "Registrazioni che conservi",
  "settings.teach.storage.description":
    "Quando chiedi a Psyche di conservare una registrazione per poter creare un’altra versione, i passaggi vengono salvati su questo Mac.",
  "settings.teach.storage.encrypted":
    "Cifrata. Il file è protetto da una chiave conservata nel portachiavi di questo Mac, quindi non si può leggere fuori da Psyche. Scade dopo 90 giorni.",
  "settings.teach.storage.unavailable":
    "Le registrazioni non vengono conservate. Il portachiavi di questo Mac non è disponibile e Psyche non salva una registrazione in chiaro. Puoi comunque salvare una registrazione come skill.",
  "settings.key.capabilities.onlineSearch": "Cerca nel registro MCP online",
  "settings.key.tools.loading": "Quando vengono caricati gli strumenti",
  "settings.widgets.title": "Widget nella chat",
  "settings.widgets.privacy":
    "Psyche può disegnare piccoli pannelli nella chat: avanzamento, elenchi, tabelle, grafici e immagini. Un pannello può rimandare a un’immagine sul web. Consentirlo fa sì che il tuo Gateway scarichi l’immagine dal web per te (senza cookie, senza referrer, mai direttamente dal tuo dispositivo), e solo i tipi di immagine comuni fino a 512 KB. In un pannello creato da contenuti non attendibili, l’immagine aspetta comunque il tuo clic.",
  "settings.widgets.remoteImages": "Mostra le immagini dal web nei widget",
  "settings.widgets.remoteImagesHint":
    "Disattivato per impostazione predefinita: quelle immagini mostrano una breve nota e non viene scaricato nulla. Modificarlo richiede la tua conferma.",
};
