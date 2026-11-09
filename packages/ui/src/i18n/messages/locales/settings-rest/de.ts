import type { Catalogue } from "../../index.ts";

/** Completed settings strings (de); merged into `../de.ts`. */
export const settingsRest: Partial<Catalogue> = {
  "settings.appearance.accent.ink": "Tinte",
  "settings.appearance.gray.paper": "Papier",
  "settings.nav.daily": "Täglich",
  "settings.daily.title": "Täglich",
  "settings.daily.description":
    "Eine kurze Übersicht am Morgen und ein Rückblick am Abend, auf dem Home-Bildschirm. Psyche liest nur; ohne deine Genehmigung wird nichts gesendet.",
  "settings.daily.loadFailed": "Die Einstellungen für „Täglich“ konnten nicht geladen werden.",
  "settings.daily.group.brief": "Morgenübersicht",
  "settings.daily.group.wrapup": "Abendrückblick",
  "settings.daily.group.delivery": "Wo es erscheint",
  "settings.daily.group.followups": "Nachfass-Einstellungen",
  "settings.daily.group.automations": "Automatisierungen",
  "settings.key.daily.brief.enabled": "Morgenübersicht",
  "settings.key.daily.wrapup.enabled": "Abendrückblick",
  "settings.key.daily.notify": "Mich benachrichtigen",
  "settings.key.daily.messages": "Auch über Nachrichten senden",
  "settings.key.daily.followups.enabled": "Nachfassen verfolgen",
  "settings.key.daily.brief.time": "Uhrzeit der Morgenübersicht",
  "settings.key.daily.wrapup.time": "Uhrzeit des Abendrückblicks",
  "settings.key.daily.followups.sensitivity": "Wie viel verfolgt wird",
  "settings.daily.time": "Uhrzeit",
  "settings.daily.notify.hint":
    "Eine Mitteilung mit der Karte. In den Ruhezeiten wird sie bis zu deren Ende zurückgehalten.",
  "settings.daily.messages.hint": "Braucht den Nachrichtenkanal. Wird nur an dich gesendet.",
  "settings.daily.sensitivity": "Wie viel verfolgt wird",
  "settings.daily.sensitivity.low": "Nur klare Zusagen mit Datum",
  "settings.daily.sensitivity.normal": "Zusagen und Bitten (empfohlen)",
  "settings.daily.sensitivity.high": "Alles, was ich zu tun verspreche",
  "settings.daily.runNow": "Jetzt Vorschau",
  "settings.daily.runFailed": "Die Karte konnte nicht erstellt werden.",
  "settings.key.nudges.enabled": "Beziehungs-Erinnerungen",
  "settings.key.nudges.consentedAt": "Einwilligung für Beziehungs-Erinnerungen",
  "settings.key.nudges.sensitivity": "Wie oft erinnert wird",
  "settings.key.nudges.phrasing": "Erinnerungsvorschläge umformulieren",
  "settings.shared.advanced": "Erweitert",
  "settings.nav.inPage": "In {page}",
  "settings.nav.essentials": "Das Wichtigste",
  "settings.nav.learning": "Grundlagen",
  "settings.search.count": "{count, plural, one {# Ergebnis} other {# Ergebnisse}}",
  "settings.search.result.page": "Seite",
  "settings.page.essentials": "Das Wichtigste",
  "settings.page.essentials.description":
    "Die wenigen Entscheidungen, die die meisten treffen. Jede hat eine sichere Voreinstellung, den Rest findest du auf den Seiten darunter.",
  "settings.page.general.description":
    "Wie {persona} aussieht, wer es ist, wann es dich unterbrechen darf und wie du mit ihm sprichst.",
  "settings.page.model.description":
    "Die Modelle, mit denen {persona} denkt, die Schlüssel dafür und was sie kosten.",
  "settings.page.connectors.description":
    "Die Apps und Konten, die {persona} erreichen kann, und welche davon durchsucht werden.",
  "settings.page.memory.description":
    "Was {persona} sich merkt, woraus es lernt und wie du es steuerst.",
  "settings.page.daily.description":
    "Deine Morgenübersicht und dein Abendrückblick, Automatisierungen, Skills und die Spezialisten, die {persona} hinzuziehen kann.",
  "settings.page.permissions.description":
    "Was {persona} auf diesem Mac ohne Nachfragen tun darf und wo es immer bei dir nachfragt.",
  "settings.page.data.description":
    "Was auf diesem Mac bleibt, wie lange es aufbewahrt wird, Exporte, Backups und Neuanfang.",
  "settings.page.devices.description":
    "Deine anderen Geräte, der Gateway-Server und wie du {persona} unterwegs erreichst.",
  "settings.page.about.description": "Versionen, Systemprüfungen und Protokolle.",
  "settings.essentials.title": "Das Wichtigste",
  "settings.essentials.description":
    "Die wenigen Entscheidungen, die die meisten treffen, jeweils mit sicherer Voreinstellung. {persona} fragt, wenn es mehr braucht.",
  "settings.essentials.more": "Mehr",
  "settings.essentials.moreIn": "Mehr unter {place}",
  "settings.essentials.model.title": "Modell",
  "settings.essentials.model.thinksWith": "{persona} denkt mit",
  "settings.essentials.model.ready": "Bereit",
  "settings.essentials.model.noKey": "Braucht einen Schlüssel",
  "settings.essentials.model.none": "Noch kein Modell",
  "settings.essentials.model.noneHint":
    "{persona} braucht ein Modell, bevor es antworten kann. Füge einen Schlüssel hinzu oder nutze ein Modell auf diesem Mac.",
  "settings.essentials.model.setUp": "Modell einrichten",
  "settings.essentials.read.title": "Was {persona} lesen darf",
  "settings.essentials.read.hint":
    "Aus, bis du eines einschaltest. Was gelesen wird, wird auf diesem Mac indexiert, damit es Dinge für dich finden kann, und das Gedächtnis lernt ebenfalls daraus, außer du widersprichst unter Gedächtnis → Quellen.",
  "settings.essentials.asks.title": "Wie oft {persona} vorher nachfragt",
  "settings.essentials.interrupt.title": "Wann {persona} dich unterbrechen darf",
  "settings.essentials.interrupt.quietHint":
    "Von {from} bis {until} warten Mitteilungen im Eingang.",
  "settings.essentials.interrupt.briefHint": "Eine kurze Übersicht im Feed um {time}.",
  "settings.essentials.memory.title": "Gedächtnis",
  "settings.essentials.memory.remember": "{persona} soll sich unsere Chats merken",
  "settings.essentials.memory.rememberHint":
    "Aus pausiert das Gedächtnis: Aus Chats wird nichts Neues gemerkt oder indexiert, bis du es wieder einschaltest.",
  "settings.essentials.rest":
    "Alles andere und feinere Kontrolle über jeden dieser Punkte findest du auf den Seiten darunter. Mit der Einstellungssuche findest du alles.",
  "settings.searchModel.title": "Modell für die Suche",
  "settings.searchModel.description":
    "Welches Modell Fragen liest, Kontextkarten schreibt und Ergebnisse neu ordnet.",
  "settings.searchModel.utility": "Dein Hilfsmodell",
  "settings.searchModel.utilityHint":
    "Das kleine Modell, das unter „Modelle“ festgelegt ist. Ist es ein Cloud-Modell, geht der Text, den es liest, an diesen Anbieter.",
  "settings.searchModel.apple":
    "Das Modell von Apple auf dem Gerät für private Suchaufgaben nutzen",
  "settings.searchModel.appleName": "Apple-Modell auf dem Gerät",
  "settings.searchModel.appleHint":
    "Der Text bleibt auf diesem Mac: nichts herunterzuladen, kein Schlüssel, nichts geht an die Cloud. Es liest etwa {k}k Tokens auf einmal, daher werden lange Texte übersprungen. Kann es nicht antworten, wird die Aufgabe übersprungen. Es weicht nie auf ein Cloud-Modell aus.",
  "settings.searchModel.apple.why.off":
    "Apple Intelligence ist ausgeschaltet. Schalte es in den Systemeinstellungen unter „Apple Intelligence & Siri“ ein.",
  "settings.searchModel.apple.why.os": "Dieser Mac braucht macOS 26 oder neuer.",
  "settings.searchModel.apple.why.device":
    "Dieser Mac oder diese Region unterstützt Apple Intelligence nicht.",
  "settings.searchModel.apple.why.notReady":
    "Apple bereitet das Modell noch vor. Versuche es in Kürze erneut.",
  "settings.searchModel.apple.why.unknown": "Das Modell ist gerade nicht verfügbar.",
  "settings.searchModel.apple.whySkipped": "Bis dahin werden diese Aufgaben übersprungen.",
  "settings.searchModel.apple.host":
    "Das ist die Einstellung von {host}. Das Modell läuft auf {host}, nicht auf diesem Computer, und die Änderung gilt für jedes Fenster.",
  "settings.searchModel.apple.ready": "Auf diesem Mac bereit",
  "settings.searchModel.apple.needsAi": "Braucht Apple Intelligence",
  "settings.searchModel.apple.notReady": "Wird vorbereitet",
  "settings.searchModel.apple.notOnThisMac": "Auf diesem Mac nicht verfügbar",
  "settings.searchModel.apple.unavailable": "Gerade nicht verfügbar",
  "settings.search.advancedHint": "Welches Modell deine Fragen liest",
  "settings.search.description":
    "Was Psyche indexiert, um Dinge für dich zu finden, und welche Suchmaschine es im Web nutzt.",
  "settings.nav.specialists": "Spezialisten",
  "settings.nav.notifications": "Mitteilungen",
  "settings.nav.people": "Personen & Datenschutz",
  "settings.key.appearance.showInDock": "Im Dock zeigen, wenn keine Fenster offen sind",
  "settings.key.appearance.openAtLogin": "Psyche bei der Anmeldung öffnen",
  "settings.key.browser.useSignedInSessions": "Meine angemeldeten Sitzungen verwenden",
  "settings.key.exec.srtPath": "Speicherort von srt",
  "settings.key.search.model.engine": "Modell für die Suche",
  "settings.key.search.semantic.enabled": "Semantische Suche (auf dem Gerät)",
  "settings.key.search.cards.enabled": "Kontextkarten für die Suche",
  "settings.semanticSearch.cardsHint":
    "Ein kleines Cloud-Modell schreibt eine kurze Zusammenfassung zu jedem gesicherten Element. Begrenzt auf etwa 200.000 Tokens pro Tag.",
  "settings.key.search.encrypt": "Suchindex verschlüsseln",
  "settings.semanticSearch.encryptHint":
    "Macht den Suchindex ohne separat gespeicherten Schlüssel unlesbar. Gilt ab dem nächsten Start und baut den Index einmal neu auf.",
  "settings.semanticSearch.encrypt.on": "Index verschlüsselt",
  "settings.semanticSearch.encrypt.pending":
    "Wartet darauf, dass der Mac-Helper den verschlüsselten Index öffnet",
  "settings.semanticSearch.encrypt.unavailable": "Nicht verschlüsselt: {why}",
  "settings.key.search.rerank.enabled":
    "Die besten Ergebnisse mit einem kleinen Cloud-Modell neu ordnen",
  "settings.semanticSearch.rerankHint":
    "Ein kleines Cloud-Modell setzt die besten Ergebnisse nach vorn. Die obersten 20 Ausschnitte verlassen diesen Mac. Standardmäßig aus.",
  "settings.key.search.runOnBattery": "Im Akkubetrieb indexieren",
  "settings.key.search.queryModel.enabled": "Fragen mit einem kleinen Modell lesen",
  "settings.semanticSearch.queryModelHint":
    "Ein kleines Cloud-Modell ermittelt Filter für Zeit, Person und Quelle. Es wird nur die Frage gesendet, nie deine Elemente.",
  "settings.key.search.semantic.engine": "Embedding-Engine",
  "settings.key.search.semantic.allowCloud": "Cloud-Embedding-Dienst erlauben",
  "settings.key.memory.recall.mode": "Wie das Gedächtnis abgerufen wird",
  "settings.key.widgets.remoteImages": "Externe Bilder in Widgets",
  "settings.key.ui.map.tiles": "Kartenkacheln",
  "settings.key.ui.map.styleUrl": "URL des Kartenstils",
  "settings.key.ui.map.styleUrlDark": "URL des Kartenstils (dunkel)",
  "settings.key.teaching.enabled": "Aus deinem Feedback lernen",
  "settings.key.teaching.implicit": "Bearbeitungen, Rückgängig-Aktionen und Verwerfungen bemerken",
  "settings.key.teaching.paused": "Lernen pausieren",
  "settings.key.teaching.weeklyCard": "Wöchentliche Karte „Was ich gelernt habe“",
  "settings.key.memory.graph": "Personen & Projekte",
  "settings.key.memory.everything": "Gedächtnis im Hintergrund",
  "settings.key.agent.showReasoning": "Denkprozess während der Arbeit zeigen",
  "settings.key.data.reasoningRetentionDays": "Denkprozess aufbewahren für",
  "settings.key.notifications.quietHours.enabled": "Ruhezeiten",
  "settings.key.notifications.quietHours.start": "Ruhig ab",
  "settings.key.notifications.quietHours.end": "Ruhig bis",
  "settings.notifications.title": "Mitteilungen",
  "settings.notifications.description": "Wann Psyche dich unterbrechen darf.",
  "settings.notifications.group.quietHours": "Ruhezeiten",
  "settings.notifications.quietHours.hint":
    "Hält Mitteilungen bis zum Ende des Zeitfensters zurück. Zeitkritische Genehmigungen kommen trotzdem durch.",
  "settings.key.ui.onboarding.progress": "Fortschritt der Einführung",
  "settings.key.permissions.liftedFloors": "Ohne Nachfragen erlaubte Aktionen für {id}",
  "settings.key.specialists.maxConcurrent": "Spezialisten gleichzeitig",
  "settings.key.specialists.monthlyCapUsd": "Monatliche Ausgaben für Spezialisten",
  "settings.key.specialists.showInFeed": "Ergebnisse von Spezialisten im Feed zeigen",
  "settings.key.specialists.enabled": "{role} an",
  "settings.key.specialists.model": "Modell für {role}",
  "settings.key.specialists.budget": "Budget für {role}",
  "settings.key.specialists.maxMode": "Berechtigungsmodus für {role}",
  "settings.credentials.payments.description":
    "Eine einmalige Karte, nachdem du jeden Kauf genehmigt hast. Kartennummern erreichen Psyche nie.",
  "settings.approval.presenceUnavailable":
    "Dieses Fenster kann nicht bestätigen, dass du es bist. Genehmige die Änderung in der Psyche-App auf deinem Mac (Touch ID) oder auf einem Gerät mit Passkey. Bis dahin ändert sich nichts.",
  "settings.doctor.gateway": "Gateway",
  "settings.doctor.gatewayOk": "Antwortet.",
  "settings.doctor.model": "Modell",
  "settings.doctor.noModel":
    "Es ist noch kein Modell gewählt. Füge unter Einstellungen → Modelle eines hinzu.",
  "settings.doctor.sandbox": "Sandbox",
  "settings.doctor.noSandbox": "Es ist keine Sandbox verfügbar, daher bleiben Befehle blockiert.",
  "settings.doctor.memory": "Gedächtnis",
  "settings.doctor.memoryPaused": "Das Gedächtnis ist pausiert: Es wird nichts Neues gemerkt.",
  "settings.doctor.memoryOk": "{files, plural, one {# Datei} other {# Dateien}} im Gedächtnis.",
  "settings.appearance.description": "Gilt für jedes gekoppelte Gerät.",
  "settings.appearance.colors": "Farben",
  "settings.appearance.colorsHint": "Hell oder dunkel und deine Akzentfarbe.",
  "settings.appearance.comfort": "Komfort",
  "settings.appearance.comfortHint": "Schonender für Augen und Bewegung.",
  "settings.appearance.backgroundHint": "Ob Psyche weiterläuft, wenn du das Fenster schließt.",
  "settings.appearance.advancedHint": "Grauton, eigene Farbe, Textrichtung, Kontrastprüfung",
  "settings.appearance.fineTune": "Farben feinabstimmen",
  "settings.appearance.fineTuneHint": "Für alle, die ein genaues Aussehen wollen.",
  "settings.appearance.contrastCheck": "Kontrastprüfung",
  "settings.appearance.contrastCheckHint": "Wie gut lesbar jedes Design ist, Schritt für Schritt.",
  "settings.appearance.background": "Hintergrund",
  "settings.appearance.showInDockHint":
    "Aus läuft Psyche weiter in der Menüleiste, wenn das letzte Fenster geschlossen wird.",
  "settings.appearance.openAtLoginHint":
    "Startet Psyche beim Anmelden in der Menüleiste, damit geplante Automatisierungen immer laufen können.",
  "settings.appearance.glass.hint":
    "Lässt Inhalte durch Menüs, Popovers und das Eingabefeld durchscheinen.",
  "settings.browser.description":
    "{persona} browst in einem eigenen Fenster. Der Echt-Chrome-Modus nutzt ein separates Profil, in dem du dich einmal anmeldest.",
  "settings.browser.signedIn.title": "Angemeldete Websites",
  "settings.browser.signedIn.description":
    "Websites, bei denen du im Browser von Psyche angemeldet bist. Aufgaben nutzen diese Anmeldungen weiter.",
  "settings.browser.signedIn.auto": "automatisch gefunden",
  "settings.browser.useSignedIn.title": "Angemeldete Sitzungen",
  "settings.browser.useSignedIn.description":
    "{persona} nutzt deine Anmeldung auf derselben Website weiter. Schreiben, Käufe und Senden fragen weiterhin zuerst nach.",
  "settings.browser.useSignedIn.label": "Psyche meine angemeldeten Sitzungen nutzen lassen",
  "settings.browser.useSignedIn.hint":
    "Standardmäßig an. Aus öffnet jede Website abgemeldet, außer denen, bei denen du angemeldet bleiben willst.",
  "settings.browser.signedIn.none": "Noch keine angemeldeten Websites.",
  "settings.browser.signedIn.viaHosts": "Auch angemeldet über {hosts}",
  "settings.browser.signedIn.forget": "Abmelden / vergessen",
  "settings.browser.signedIn.loadFailed":
    "Psyche konnte die angemeldeten Websites nicht auflisten ({reason}).",
  "settings.browser.signedIn.forgetFailed": "Psyche konnte {site} nicht abmelden ({reason}).",
  "settings.computerUse.appsHint": "Wie weit Psyche in jeder App gehen darf.",
  "settings.connectors.catalog.appleShortcuts": "Kurzbefehle",
  "settings.connectors.catalog.obsidian": "Obsidian",
  "settings.connectors.trust.verified": "verifiziert",
  "settings.connectors.filter.label": "Anzeigen",
  "settings.connectors.filter.all": "Alle",
  "settings.connectors.filter.apps": "Apps",
  "settings.connectors.filter.mcp": "MCP-Server",
  "settings.connectors.configureFailed":
    "Psyche konnte die Einstellungen von {name} nicht sichern: {reason}",
  "settings.shortcuts.title": "Deine Kurzbefehle",
  "settings.shortcuts.loading": "Deine Kurzbefehle werden von diesem Mac gelesen …",
  "settings.shortcuts.none": "Noch keine Kurzbefehle in der Kurzbefehle-App.",
  "settings.shortcuts.noHelper":
    "Öffne Psyche auf deinem Mac, um deine Kurzbefehle aufzulisten: Der Helper liest sie.",
  "settings.shortcuts.failed": "Psyche konnte deine Kurzbefehle nicht lesen.",
  "settings.shortcuts.hint":
    "Aus: nie ausführen. Fragen: jedes Mal eine Karte. Erlauben: läuft ohne Nachfrage, nur bei Kurzbefehlen, die nur lesen.",
  "settings.shortcuts.rule.off": "Aus",
  "settings.shortcuts.rule.ask": "Fragen",
  "settings.shortcuts.rule.allow": "Erlauben",
  "settings.shortcuts.actions": "Psyche-Aktionen",
  "settings.shortcuts.install": "Installieren",
  "settings.shortcuts.installNamed": "{name} installieren",
  "settings.shortcuts.installed": "Installiert",
  "settings.trusted.title.reminders": "Deine Erinnerungslisten",
  "settings.trusted.title.notes": "Deine Notizordner",
  "settings.trusted.title.calendar": "Deine Kalender",
  "settings.trusted.none.reminders": "Noch keine Erinnerungslisten.",
  "settings.trusted.none.notes": "Noch keine Ordner in Notizen.",
  "settings.trusted.none.calendar": "Noch keine Kalender.",
  "settings.trusted.loading": "Werden von diesem Mac gelesen …",
  "settings.trusted.noHelper":
    "Öffne Psyche auf deinem Mac, um sie aufzulisten: Der Helper liest sie.",
  "settings.trusted.failed": "Psyche konnte sie nicht von diesem Mac lesen.",
  "settings.trusted.toggle": "Meine – als vertrauenswürdig behandeln",
  "settings.trusted.shared": "Geteilt",
  "settings.trusted.hint":
    "Das Lesen daraus führt nicht dazu, dass der Chat erneut nachfragt. Schalte das nur für Listen ein, die niemand sonst bearbeiten kann.",
  "settings.obsidian.vault": "Vault-Ordner",
  "settings.obsidian.newVault": "Neuer Vault-Ordner",
  "settings.obsidian.noVault": "Kein Vault gewählt",
  "settings.obsidian.vaultHint":
    "Psyche liest den Vault über einen geteilten Ordner (Einstellungen → Berechtigungen → Zugriff): Teile ihn und nutze ihn dann.",
  "settings.obsidian.share": "Diesen Ordner teilen",
  "settings.obsidian.shared": "Geteilt",
  "settings.obsidian.useVault": "Diesen Vault nutzen",
  "settings.obsidian.change": "Vault ändern …",
  "settings.obsidian.daily": "Ordner für Tagesnotizen",
  "settings.obsidian.dailyPlaceholder": "Aus den Tagesnotiz-Einstellungen von Obsidian",
  "settings.connectors.can.title": "Was {persona} tun kann",
  "settings.connectors.can.label": "Was {persona} mit {name} tun kann",
  "settings.connectors.can.alwaysAsks": "Fragt immer zuerst",
  "settings.connectors.can.asksByDefault": "Fragt zuerst, außer du erlaubst es",
  "settings.connectors.can.lifted": "Läuft ohne Nachfrage",
  "settings.connectors.can.liftWhat": "{action} in {name}",
  "settings.connectors.can.readOnly": "Aus, solange {name} nur lesend verbunden ist",
  "settings.connectors.can.mail.read.title": "Mails lesen",
  "settings.connectors.can.mail.read.lines":
    "Mails lesen und durchsuchen, auch ungelesene · Ungelesene pro Postfach sehen · Die ausgewählte Mail verwenden",
  "settings.connectors.can.mail.draft.title": "Mails entwerfen",
  "settings.connectors.can.mail.draft.lines":
    "Neue Mails, Antworten und Weiterleitungen entwerfen (gesichert, nicht gesendet)",
  "settings.connectors.can.mail.organize.title": "Mails organisieren",
  "settings.connectors.can.mail.organize.lines":
    "Als gelesen markieren, markieren, ablegen und archivieren · Anhänge sichern",
  "settings.connectors.can.mail.send.title": "Mails senden",
  "settings.connectors.can.mail.send.lines": "Mails und gesicherte Entwürfe senden",
  "settings.connectors.can.notes.read.title": "Notizen lesen",
  "settings.connectors.can.notes.read.lines": "Notizen und Ordner finden, auflisten und lesen",
  "settings.connectors.can.notes.create.title": "Notizen schreiben",
  "settings.connectors.can.notes.create.lines": "Notizen anlegen und ergänzen",
  "settings.connectors.can.reminders.read.title": "Erinnerungen lesen",
  "settings.connectors.can.reminders.read.lines": "Sehen, was fällig, überfällig und markiert ist",
  "settings.connectors.can.reminders.write.title": "Erinnerungen ändern",
  "settings.connectors.can.reminders.write.lines":
    "Erinnerungen hinzufügen, abschließen und markieren",
  "settings.connectors.can.calendar.read.title": "Deinen Kalender lesen",
  "settings.connectors.can.calendar.read.lines":
    "Termine, Teilnehmende und Meeting-Links sehen · Freie Zeit finden",
  "settings.connectors.can.calendar.write.title": "Deinen Kalender ändern",
  "settings.connectors.can.calendar.write.lines": "Termine hinzufügen, verschieben und ändern",
  "settings.connectors.grant.allowed":
    "In den Systemeinstellungen unter Datenschutz & Sicherheit → {grant} erlaubt",
  "settings.connectors.grant.automation": "Automation → {app}",
  "settings.connectors.grant.calendars": "Kalender",
  "settings.connectors.grant.reminders": "Erinnerungen",
  "settings.connectors.grant.contacts": "Kontakte",
  "settings.connectors.grant.photos": "Fotos",
  "settings.connectors.app.mail": "Mail",
  "settings.connectors.app.notes": "Notizen",
  "settings.connectors.app.music": "Musik",
  "settings.connectors.app.safari": "Safari",
  "settings.connectors.app.chrome": "Google Chrome",
  "settings.connectors.app.things": "Things",
  "settings.connectors.app.shortcuts": "Kurzbefehle",
  "settings.connectors.try.title": "Ausprobieren",
  "settings.connectors.try.mail.unread": "Was ist von heute ungelesen?",
  "settings.connectors.try.mail.reminder": "Aus der ausgewählten Mail eine Erinnerung machen",
  "settings.connectors.try.mail.reply": "Eine Antwort auf die letzte Mail von Dana entwerfen",
  "settings.connectors.try.notes.find": "Meine Notiz zum Offsite finden",
  "settings.connectors.try.notes.append":
    "Die heutigen Entscheidungen zu meiner Offsite-Notiz hinzufügen",
  "settings.connectors.try.reminders.due": "Was ist heute fällig?",
  "settings.connectors.try.reminders.add": "Erinnere mich, morgen um 9 den Zahnarzt anzurufen",
  "settings.connectors.try.calendar.today": "Was steht heute in meinem Kalender?",
  "settings.connectors.try.calendar.focus": "Morgen früh zwei Stunden für Fokuszeit blockieren",
  "settings.connectors.actionFailed":
    "Psyche konnte {name} nicht ändern ({reason}). Es wurde nichts geändert.",
  "settings.mcp.badge": "MCP",
  "settings.mcp.showDetails": "Details anzeigen",
  "settings.mcp.hideDetails": "Details ausblenden",
  "settings.sandbox.setUp": "Sandbox einrichten",
  "settings.mcp.sandboxHelp": "Befehlsserver brauchen eine Sandbox auf diesem Mac.",
  "settings.sandbox.title": "Die Sandbox einrichten",
  "settings.sandbox.why":
    "Befehle laufen auf deinem Mac mit deinen Dateien, können aber weder deinen Tresor, deine Schlüssel noch die privaten Daten von Psyche lesen.",
  "settings.sandbox.whyHow":
    "Nutzt srt, die Sandbox-Runtime von Anthropic, unter der eigenen Sandbox von macOS. Keine virtuelle Maschine nötig.",
  "settings.sandbox.privacy":
    "Psyche installiert von sich aus nichts. Du führst jeden Schritt unten selbst aus oder öffnest den Download selbst.",
  "settings.sandbox.checking": "Dieser Mac wird geprüft …",
  "settings.sandbox.checkAgain": "Erneut prüfen",
  "settings.sandbox.done": "Fertig",
  "settings.sandbox.copy": "Kopieren",
  "settings.sandbox.copied": "Kopiert",
  "settings.sandbox.ready": "Bereit",
  "settings.sandbox.srt.ready":
    "srt ist unter {path} eingerichtet. Befehlsserver können hinzugefügt werden.",
  "settings.sandbox.srt.missing.title": "srt installieren",
  "settings.sandbox.srt.missing.body":
    "srt kommt von npm. Fragt der Befehl nach Schreibrechten, führe ihn mit den Rechten deines eigenen Kontos aus; Psyche führt ihn nie für dich aus.",
  "settings.sandbox.srt.install": "Mit npm installieren",
  "settings.sandbox.srt.link": "Mehr zu srt auf GitHub lesen",
  "settings.sandbox.srt.thenCheck": "Danach erneut prüfen",
  "settings.sandbox.srt.thenCheckBody":
    "Psyche findet srt in deinem PATH sowie in den Ordnern von Homebrew und npm, ohne Neustart.",
  "settings.sandbox.srt.broken":
    "Das srt unter {path} lässt sich nicht verwenden: {problem, select, not_absolute {der Pfad muss mit / beginnen} not_executable {dort gibt es kein ausführbares Programm} other {es wurde nicht gefunden}}.",
  "settings.sandbox.srt.fromEnv":
    "PSYCHE_SRT_PATH legt diesen Speicherort fest, daher lässt er sich hier nicht ändern.",
  "settings.sandbox.srt.installButton": "Mit Psyche installieren",
  "settings.sandbox.srt.reinstallButton": "Neu installieren",
  "settings.sandbox.srt.updateButton": "srt aktualisieren",
  "settings.sandbox.srt.installOr": "Oder Psyche es für dich installieren lassen",
  "settings.sandbox.srt.installConfirm.title": "srt {version} installieren?",
  "settings.sandbox.srt.installConfirm.body":
    "Psyche lädt {package} {version} und dessen Abhängigkeiten aus der npm-Registry (registry.npmjs.org) herunter, prüft jede Datei gegen eine in diese Psyche-Version eingebaute Prüfsumme und entpackt sie mit dem eigenen Node. Es wird nichts systemweit installiert, es laufen keine Installationsskripte und es ist kein Passwort nötig.",
  "settings.sandbox.srt.installConfirm.where": "Es wird abgelegt in {dir}",
  "settings.sandbox.srt.installConfirm.go": "Installieren",
  "settings.sandbox.srt.installConfirm.cancel": "Abbrechen",
  "settings.sandbox.srt.installing": "srt wird installiert …",
  "settings.sandbox.srt.installed": "Von Psyche installiert: srt {version}.",
  "settings.sandbox.srt.installFailed": "srt konnte nicht installiert werden: {reason}",
  "settings.sandbox.srt.updateAvailable":
    "Mit dieser Psyche-Version kommt ein neueres srt ({version}); installiert ist {installed}.",
  "settings.sandbox.srt.choose": "srt liegt woanders",
  "settings.sandbox.srt.path": "Vollständiger Pfad zu srt",
  "settings.sandbox.srt.use": "Dieses srt verwenden",
  "settings.sandbox.srt.useHint":
    "Beim Sichern musst du auf diesem Gerät bestätigen, weil es bestimmt, was deine Befehle ausführt.",
  "settings.sandbox.containers.title": "Stärkere Isolierung (optional)",
  "settings.sandbox.containers.body":
    "Eine Container-Runtime führt Code in einer eigenen Linux-Maschine ohne Zugriff auf die Dateien deines Macs aus: für Code, den der Agent ausführt, und einige Dateikonvertierungen. Befehlsserver nutzen weiter srt, außer das Gateway ist auf Container eingestellt.",
  "settings.sandbox.containers.ready": "{runtime} läuft.",
  "settings.sandbox.runtime.appleContainer": "Apple container",
  "settings.sandbox.runtime.docker": "Docker",
  "settings.sandbox.runtime.podman": "Podman",
  "settings.sandbox.missing.title": "{runtime} installieren",
  "settings.sandbox.missing.appleContainer":
    "Die Container-Runtime von Apple gibt jeder Sandbox eine eigene leichtgewichtige VM. Sie braucht macOS 26 auf Apple Silicon und ein Installationsprogramm, das du mit deinem Mac-Passwort freigibst.",
  "settings.sandbox.missing.docker":
    "Docker über Colima ist kostenlos und leichtgewichtig; Docker Desktop ist die Lösung für Klick-und-fertig.",
  "settings.sandbox.step.download": "Das Installationsprogramm laden und öffnen",
  "settings.sandbox.step.downloadLink": "Die Releases von Apple container öffnen",
  "settings.sandbox.step.start": "Starten",
  "settings.sandbox.step.install": "Mit Homebrew installieren",
  "settings.sandbox.step.orDesktop": "Oder Docker Desktop laden und einmal öffnen",
  "settings.sandbox.step.desktopLink": "Den Download von Docker Desktop öffnen",
  "settings.sandbox.stopped.title": "{runtime} ist installiert, läuft aber nicht",
  "settings.sandbox.stopped.appleContainer": "Starte den Systemdienst und prüfe dann erneut.",
  "settings.sandbox.stopped.docker":
    "Starte den Docker-Daemon (öffne Docker Desktop oder führe den Befehl unten aus) und prüfe dann erneut.",
  "settings.sandbox.stopped.podman": "Starte die Podman-Maschine und prüfe dann erneut.",
  "settings.sandbox.restart.title": "{runtime} läuft. Starte das Gateway neu, um es zu nutzen",
  "settings.sandbox.restart.body":
    "Das Gateway hat beim Start nach einer Container-Runtime gesucht und keine gefunden. Starte es neu, dann erkennt es {runtime}.",
  "settings.sandbox.restart.step": "Gateway neu starten",
  "settings.sandbox.without":
    "Ohne srt kann Psyche weiterhin URL-Server und deine Verbindungen nutzen, aber keine lokalen MCP-Befehlsserver ausführen.",
  "settings.mcp.off": "Aus",
  "settings.mcp.turnedOn": "{name} ist an.",
  "settings.mcp.turnedOff": "{name} ist aus.",
  "settings.mcp.tools.title": "Tools",
  "settings.mcp.tools.hint":
    "{off, plural, =0 {Psyche kann jedes Tool nutzen.} one {# Tool wird Psyche vorenthalten.} other {# Tools werden Psyche vorenthalten.}} Das Ausschalten eines Tools startet den Server nicht neu.",
  "settings.mcp.tools.loadFailed": "Die Tools konnten nicht geladen werden: {reason}",
  "settings.mcp.tools.off": "Dieser Server ist aus. Schalte ihn ein, um seine Tools zu sehen.",
  "settings.mcp.tools.notConnected":
    "Dieser Server ist nicht verbunden und listet daher keine Tools auf.",
  "settings.mcp.tools.none": "Dieser Server hat keine Tools.",
  "settings.mcp.secrets.title": "Geheimnisse",
  "settings.mcp.secrets.intro":
    "Schlüssel, mit denen dieser Server startet. Sie bleiben in deinem Tresor; Psyche zeigt nur, ob jeder gesetzt ist.",
  "settings.mcp.secrets.loadFailed": "Die Geheimnisse konnten nicht geladen werden: {reason}",
  "settings.mcp.secrets.set": "Gesetzt",
  "settings.mcp.secrets.unset": "Nicht gesetzt",
  "settings.mcp.secrets.replace": "Ersetzen",
  "settings.mcp.secrets.setIt": "Wert festlegen",
  "settings.mcp.secrets.replaceFor": "{name} ersetzen",
  "settings.mcp.secrets.plain":
    "In den Servereinstellungen gespeichert, nicht im Tresor. Beim Ersetzen wandert es in den Tresor.",
  "settings.mcp.secrets.newValue": "Neuer Wert für {name}",
  "settings.mcp.secrets.hint":
    "Wird in deinem Tresor gesichert, dann startet der Server damit neu.",
  "settings.mcp.secrets.replaced":
    "{name} wurde ersetzt. Der Server startet mit dem neuen Wert neu.",
  "settings.mcp.danger.title": "Gefahrenbereich",
  "settings.mcp.danger.disable": "Diesen Server ausschalten",
  "settings.mcp.danger.disableHint":
    "Behält die Einstellungen, hält ihn aber an. Seine Tools verschwinden, und ihnen erteilte Berechtigungen enden.",
  "settings.mcp.danger.disableAction": "Ausschalten",
  "settings.mcp.danger.enable": "Diesen Server einschalten",
  "settings.mcp.danger.enableHint":
    "Startet ihn wieder. Seine Geheimnisse brauchen deine Genehmigung.",
  "settings.mcp.danger.enableAction": "Einschalten",
  "settings.mcp.danger.remove": "Diesen Server entfernen",
  "settings.mcp.danger.removeHint":
    "Löscht seine Einstellungen. Geheimnisse in deinem Tresor bleiben dort.",
  "settings.mcp.json.toggle": "JSON einfügen",
  "settings.mcp.json.label": "Server-JSON",
  "settings.mcp.json.hint":
    "Das übliche mcpServers-Format. Schlüssel und Tokens gehen in deinen Tresor, nicht in die Einstellungen.",
  "settings.mcp.json.fill": "Formular ausfüllen",
  "settings.mcp.json.choose": "Welcher Server?",
  "settings.mcp.json.empty": "Füge zuerst das JSON eines Servers ein.",
  "settings.mcp.json.invalid": "Das ist kein gültiges JSON.",
  "settings.mcp.json.shape": "Erwartet wurde ein JSON-Objekt mit einem mcpServers-Eintrag.",
  "settings.mcp.json.noServers": "Kein Server mit Befehl oder URL in diesem JSON.",
  "settings.mcp.json.secrets":
    "{n, plural, one {# Geheimnis} other {# Geheimnisse}} aus dem JSON {n, plural, one {geht} other {gehen}} in deinen Tresor: {names}.",
  "settings.mcp.json.ignored": "Nicht übernommen: {names}.",
  "settings.searchSources.title": "Suchquellen",
  "settings.searchSources.description":
    "Was Psyche in deinen Suchindex einliest. Alles ist aus, bis du es einschaltest; der Index bleibt auf diesem Mac. Wer eine Quelle einschaltet, lässt auch das Gedächtnis daraus lernen, außer du widersprichst unter Gedächtnis → Quellen (Ausnahmen sind Gedächtnis und Kontakte: aus beiden wird nicht gelernt).",
  "settings.searchSources.hint.mail":
    "Betreff, Absender, Empfänger, Datum und der Text deiner Mails in Apple Mail. Zitierte Antworten werden übersprungen.",
  "settings.searchSources.hint.messages":
    "Deine iMessage-Unterhaltungen, nach Chat und Tag. Nachrichten anderer Personen werden nie als Anweisungen behandelt.",
  "settings.searchSources.hint.notes": "Titel und Text deiner Apple Notizen.",
  "settings.searchSources.hint.calendar":
    "Termine der letzten drei Jahre und der nächsten zwölf Monate: Titel, Zeit, Ort, Teilnehmende und Notizen.",
  "settings.searchSources.hint.reminders":
    "Erinnerungen samt Listen, Fälligkeitsdaten und Notizen.",
  "settings.searchSources.hint.contacts":
    "Deine Apple Kontakte: Name, Spitzname, Firma, Berufsbezeichnung, E-Mail-Adressen, Telefonnummern, Stadt und Land jeder Adresse sowie Geburtstag. Straßenadressen, Notizen und Gruppen werden nie gelesen. Der Agent kann sie erst durchsuchen, wenn du es erlaubst, und dieser Schalter gilt nur für diesen Index: Was das Gedächtnis über Personen gelernt hat und ihre Seiten mit E-Mails oder Nummern folgen dem eigenen Agentenzugriff des Gedächtnisses.",
  "settings.searchSources.hint.files":
    "Text-, Code-, PDF-, Word- und Excel-Dateien in Ordnern, die du geteilt hast. Bilder werden nach Namen indexiert.",
  "settings.searchSources.hint.browser":
    "Seiten, die der Browser von Psyche für dich liest, 90 Tage lang aufbewahrt. Private Seiten, Anmelde- und Zahlungsseiten werden nie aufbewahrt.",
  "settings.searchSources.hint.transcripts":
    "Sprachmemos und Meetings, nach Sprechern getrennt. Die Worte anderer Personen werden nie als Anweisungen behandelt.",
  "settings.searchSources.hint.memory":
    "Was Psyche sich merkt: deine Personen, Projekte, fällige Aufgaben und Termine sowie die Fakten, die Psyche akzeptiert hat. Alles Sensible, noch zu Prüfende, aus einer für den Agenten nicht durchsuchbaren Quelle Gelernte oder privat Gehaltene bleibt außen vor. Das Gedächtnis lernt nicht aus diesem Index und muss eingeschaltet sein.",
  "settings.searchSources.runOnBatteryHint":
    "Lässt Indexieren, „Neu aufbauen“ und das Lesen von Text in Bildern im Akkubetrieb weiterlaufen, in gemächlicherem Tempo. Das verbraucht mehr Akku. Der Energiesparmodus pausiert das Indexieren weiterhin.",
  "settings.searchSources.cannotEnable": "Lässt sich noch nicht einschalten: {why}",
  "settings.searchSources.cannotAgent": "Der Agent kann das noch nicht durchsuchen: {why}",
  "settings.searchSources.state.off": "Aus: wird nicht gelesen",
  "settings.searchSources.state.unavailable": "An, aber nicht verfügbar: {why}",
  "settings.searchSources.state.error": "Problem: {why}",
  "settings.searchSources.state.indexing":
    "Wird indexiert: bisher {n, plural, one {# Element} other {# Elemente}}",
  "settings.searchSources.state.idle": "Aktuell: {n, plural, one {# Element} other {# Elemente}}",
  "settings.searchSources.neverIndexed": "Noch nicht indexiert",
  "settings.searchSources.lastIndexed": "Zuletzt indexiert {when}",
  "settings.searchSources.rebuild": "Neu aufbauen",
  "settings.searchSources.rebuildLabel": "{source} neu aufbauen",
  "settings.searchSources.rebuilding": "Wird neu aufgebaut …",
  "settings.searchSources.rebuild.turnOnFirst": "Schalte zuerst {source} ein",
  "settings.searchSources.rebuild.starting": "{source} wird neu aufgebaut …",
  "settings.searchSources.rebuild.progress":
    "{source} wird neu aufgebaut: bisher {n, plural, one {# Element} other {# Elemente}} gelesen. Es läuft im Hintergrund weiter.",
  "settings.searchSources.rebuild.done":
    "{source} neu aufgebaut: {n, plural, one {# Element} other {# Elemente}}.",
  "settings.searchSources.rebuild.failed": "{source} konnte nicht neu aufgebaut werden: {why}",
  "settings.searchSources.agent": "Den Agenten von Psyche dies durchsuchen lassen",
  "settings.searchSources.agentLabel": "Agentensuche für {source}",
  "settings.searchSources.ocr": "Text in Bildern lesen (OCR)",
  "settings.searchSources.ocrHint":
    "Liest Screenshots und gescannte PDFs mit Apple Vision, Seite für Seite, am Netzbetrieb (oder im Akkubetrieb, wenn „Im Akkubetrieb indexieren“ an ist). Nichts verlässt deinen Mac.",
  "settings.searchSources.ocrLabel": "Text in Bildern für {source} lesen",
  "settings.searchSources.processing": "Verarbeitung",
  "settings.searchSources.processingLabel": "Verarbeitung für {source}",
  "settings.searchSources.processing.cloud": "Cloud-Modell (aktuell)",
  "settings.searchSources.processing.local": "Lokales Modell",
  "settings.searchSources.processing.none": "Keine: keine Zusammenfassungen",
  "settings.searchSources.excludeContacts": "Diese Kontakte nie indexieren",
  "settings.searchSources.excludeContactsHint":
    "E-Mail-Adressen, Telefonnummern oder Namen, durch Kommas getrennt",
  "settings.searchSources.excludeFolders": "Diese Ordner nie indexieren",
  "settings.searchSources.excludeFoldersPlaceholder": "~/Documents/Private",
  "settings.searchSources.indexSize": "Größe des Suchindex: {size}",
  "settings.semanticSearch.title": "Suche nach Bedeutung",
  "settings.semanticSearch.description":
    "Finde Dinge nach Bedeutung und nach ihren Wörtern, alles auf diesem Mac.",
  "settings.semanticSearch.enabledHint":
    "Lädt beim ersten Mal ein Modell mit 118 MB herunter. Beim Ausschalten wird der Bedeutungsindex gelöscht.",
  "settings.semanticSearch.engine.builtin": "Integriertes Modell",
  "settings.semanticSearch.engine.builtinHint":
    "Multilingual E5 small, etwa 100 Sprachen, läuft auf dem Prozessor dieses Macs.",
  "settings.semanticSearch.engine.router": "Mein lokaler Modellserver",
  "settings.semanticSearch.engine.routerHint":
    "Nutzt das unter „Rollen“ festgelegte Embedding-Modell, zum Beispiel Ollama oder LM Studio auf diesem Mac.",
  "settings.semanticSearch.state.off": "Aus: Die Suche gleicht Wörter ab",
  "settings.semanticSearch.state.starting": "Wird gestartet …",
  "settings.semanticSearch.state.downloading":
    "Modell wird heruntergeladen: {received} von {total} MB",
  "settings.semanticSearch.state.indexing": "Bedeutungen werden indexiert: {done} von {total}",
  "settings.semanticSearch.state.ready":
    "An: {n, plural, one {# Textabschnitt} other {# Textabschnitte}} indexiert",
  "settings.semanticSearch.state.readyCloud":
    "An, mit einem Cloud-Dienst: {n, plural, one {# Textabschnitt} other {# Textabschnitte}} indexiert",
  "settings.semanticSearch.allowCloudHint":
    "Nur wenn das Embedding-Modell ein Cloud-Dienst ist. Deine Chats, Aufgaben und der Text der Mediathek werden dorthin gesendet. Aus hält alles auf diesem Mac.",
  "settings.semanticSearch.state.noModel":
    "Unter „Rollen“ ist kein Embedding-Modell festgelegt. Wähle eines oder nutze das integrierte Modell.",
  "settings.semanticSearch.state.cloudBlocked":
    "Das Embedding-Modell unter „Rollen“ ist ein Cloud-Dienst. Die semantische Suche nutzt nur Modelle auf diesem Mac.",
  "settings.semanticSearch.state.error": "Angehalten: {reason}",
  "settings.webSearch.description":
    "Wie der Agent im Web nachschlägt. Webseiten werden nie als deine Anweisungen behandelt.",
  "settings.data.description":
    "Alles, was {persona} aufbewahrt, liegt auf diesem Gerät. Nichts wird zum Training gesendet.",
  "settings.data.advancedHint": "Karten und Bilder in Widgets",
  "settings.data.keep": "Wie lange Dinge aufbewahrt werden",
  "settings.data.keepHint":
    "Ältere Denkprozesse und Aufgabenwiedergaben werden automatisch gelöscht.",
  "settings.data.danger": "Löschen und von vorn beginnen",
  "settings.memoryControls.title": "Grundlagen",
  "settings.memoryControls.description":
    "Lege fest, woran sich {persona} erinnert und woraus es lernt. Jedes lässt sich jederzeit ausschalten.",
  "settings.learning.title": "Aus Feedback lernen",
  "settings.learning.implicit": "Bearbeitungen, Rückgängig-Aktionen und Verwerfungen bemerken",
  "settings.learning.implicitHint":
    "Das Senden eines bearbeiteten Entwurfs oder das Rückgängigmachen einer Aktion zählt als Feedback.",
  "settings.learning.signals": "Signale",
  "settings.learning.signal.draftEdits": "Entwurfsbearbeitungen",
  "settings.learning.signal.undo": "Rückgängig",
  "settings.learning.signal.approvalEdits": "Genehmigungsbearbeitungen",
  "settings.learning.signal.dismissals": "Verwerfungen",
  "settings.learning.paused": "Lernen pausieren",
  "settings.learning.pausedHint":
    "Solange es an ist, wird nichts gelesen oder geschrieben, und danach wird nichts nachgeholt.",
  "settings.learning.weeklyCard": "Wöchentliche Karte „Was ich gelernt habe“",
  "settings.learning.weeklyCardHint":
    "Ein Feed-Beitrag sonntags, nur wenn es etwas zu prüfen gibt.",
  "settings.learning.open": "Was {persona} gelernt hat",
  "settings.learning.openButton": "Wachstum öffnen",
  "settings.learning.forgetAll": "Alles vergessen, was {persona} gelernt hat",
  "settings.learning.forgetAllTitle": "Alles vergessen, was {persona} von dir gelernt hat?",
  "settings.learning.forgetAllBody":
    "Seine Notizen, Seele und Skills kehren zu dem zurück, was du geschrieben hast. Gib zur Bestätigung „{phrase}“ ein.",
  "settings.learning.forgetPhrase": "vergessen",
  "settings.learning.forgetAllGo": "Alles vergessen",
  "settings.learning.forgotAll":
    "{lessons, plural, one {# Lektion} other {# Lektionen}} und {events, plural, one {# Feedback-Ereignis} other {# Feedback-Ereignisse}} vergessen.",
  "settings.data.reasoningRetentionHint":
    "Wie lange der vollständige Denkprozess jedes Schritts aufbewahrt wird. Aus behält eine einzeilige Zusammenfassung.",
  "settings.data.recallModeHint":
    "Deine Markdown-Gedächtnisdateien bleiben die maßgebliche Quelle. Embeddings lassen jeden Zug Erinnerungen nach Bedeutung finden.",
  "settings.data.recallMode.markdown": "Nur Markdown",
  "settings.data.recallMode.markdownHint":
    "Liest die Dateien und gleicht Wörter ab. Nichts Zusätzliches läuft.",
  "settings.data.recallMode.embeddings": "Markdown plus Embeddings",
  "settings.data.recallMode.embeddingsHint":
    "Nutzt dieselbe Embedding-Wahl wie die Suche. Das Modell wird bei Bedarf geladen und im Leerlauf freigegeben.",
  "settings.data.recallState.off": "Nur Markdown.",
  "settings.data.encryptMemory": "Gedächtnis auf dem Datenträger verschlüsseln",
  "settings.data.encryptMemoryHint":
    "Bewahrt das, was {persona} über Personen weiß, in einer verschlüsselten Datei auf, mit dem Schlüssel in deinem Tresor. Beim Ausschalten wird zuerst alles zurückkopiert.",
  "settings.data.encryptMemory.restart": "Wird beim nächsten Start von Psyche eingeschaltet.",
  "settings.data.encryptMemory.on": "Verschlüsselt.",
  "settings.data.encryptMemory.pending": "Wartet auf den Schlüssel vom Mac-Helper.",
  "settings.data.encryptMemory.unavailable": "Nicht verfügbar: {why}",
  "settings.data.encryptMemory.offDone":
    "Das Gedächtnis liegt wieder in der Hauptdatenbank; die verschlüsselte Datei wurde gelöscht.",
  "settings.data.recallState.semantic":
    "Abruf nach Bedeutung und Wörtern: {vectors} von {chunks} Gedächtnisabschnitten indexiert.",
  "settings.data.recallState.modelMissing":
    "Das Embedding-Modell ist noch nicht heruntergeladen, daher gleicht der Abruf nur Wörter ab. Schalte unter Einstellungen → Verbindungen & Quellen → Suche die semantische Suche ein, um es herunterzuladen.",
  "settings.data.recallState.cloudBlocked":
    "Der Embedding-Dienst darf dein Gedächtnis nicht erhalten, daher gleicht der Abruf nur Wörter ab.",
  "settings.data.recallState.textOnly":
    "Es ist kein Embedding-Modell verfügbar, daher gleicht der Abruf nur Wörter ab.",
  "settings.data.replayRetentionHint":
    "Die Bildschirme, die {persona} bei der Arbeit angesehen hat, für den Verlauf. Aus behält keine.",
  "settings.devices.presenceKey.unknown": "Touch-ID-Schlüssel (Art vom Helper nicht gemeldet)",
  "settings.devices.presenceKey.deviceIdentity":
    "Freigaben verwenden Touch ID oder das Passwort deines Macs. Es muss nichts eingerichtet werden.",
  "settings.devices.touchId.none":
    "Noch kein Touch-ID-Schlüssel. Karten, die Touch ID brauchen, lassen sich erst genehmigen, wenn einer registriert ist.",
  "settings.devices.touchId.bundled": "Der Psyche Helper in dieser App zeigt den Schlüssel",
  "settings.devices.touchId.notBundled":
    "Dieser Helper ist nicht der, der mit dieser App geliefert wurde, daher lässt sich sein Schlüssel hier nicht registrieren.",
  "settings.devices.touchId.keyMismatch":
    "Der Psyche Helper in dieser App zeigt jetzt den Schlüssel {shown}, nicht den registrierten {registered}. Wenn du den Schlüssel nicht selbst zurückgesetzt hast, halte das für verdächtig und registriere ihn nicht.",
  "settings.devices.touchId.confirmReplace":
    "Dies ersetzt den für diesen Mac registrierten Touch-ID-Schlüssel {previous}. Ersetze ihn nur, wenn du den Schlüssel selbst zurückgesetzt hast.",
  "settings.devices.touchId.confirmReplaceButton": "Schlüssel ersetzen",
  "settings.devices.touchId.noBundledKey":
    "Der Psyche Helper in dieser App hat keinen Touch-ID-Schlüssel ({reason}).",
  "settings.devices.touchId.register": "Diesen Schlüssel registrieren",
  "settings.devices.touchId.remove": "Schlüssel entfernen",
  "settings.devices.touchId.manualLabel": "Schlüssel-ID",
  "settings.devices.touchId.manualHint":
    "Führe psyche-helper --print-identity auf dem Mac aus und füge die ausgegebene presenceKeyId ein.",
  "settings.files.execHost": "Befehle auf diesem Mac ausführen",
  "settings.files.execHostHint":
    "Lässt {persona} Befehle in deinen geteilten Ordnern in der Sandbox ausführen. Befehle, die Dateien ändern könnten, fragen vorher nach.",
  "settings.files.execHostSwitch": "Befehle auf diesem Mac erlauben",
  "settings.files.readOnlyQuiet": "Nur lesende Befehle ohne Nachfrage ausführen",
  "settings.files.readOnlyQuietHint":
    "Einfache Datei- und Info-Befehle, die nur lesen, wie ls, cat oder wc, laufen in der Sandbox ohne Karte. Alles andere fragt nach, auch git, ebenso jeder Befehl, nachdem {persona} etwas von außen gelesen hat.",
  "settings.files.revoke": "Widerrufen",
  "settings.files.description":
    "{persona} erreicht nur, was du erlaubst, und fragt im Chat nach, wenn es mehr braucht.",
  "settings.files.foldersHint":
    "„Nur lesen“ lässt {persona} einen Ordner öffnen und durchsuchen; „Lesen und schreiben“ lässt es Änderungen sichern. Ein Widerruf gilt sofort.",
  "settings.files.addYourself": "Einen Ordner selbst hinzufügen",
  "settings.files.addYourselfHint":
    "Meist nicht nötig: {persona} fragt, wenn eine Aufgabe einen Ordner braucht. Hinzugefügte Ordner beginnen mit „Nur lesen“.",
  "settings.access.title": "Worauf {persona} zugreifen kann",
  "settings.access.listLabel": "Worauf {persona} zugreifen kann",
  "settings.access.empty":
    "Noch nichts. Braucht {persona} einen Ordner oder eine App, fragt es dich im Chat, und was du erlaubst, erscheint hier.",
  "settings.access.scope.always": "Immer",
  "settings.access.scope.conversation": "Dieser Chat",
  "settings.access.scope.limited": "Vorerst",
  "settings.access.used": "verwendet {when}",
  "settings.access.revokeNamed": "{name} widerrufen",
  "settings.access.loadLabel": "worauf Psyche zugreifen kann",
  "settings.access.loadFailed": "Psyche konnte nicht laden, worauf es zugreifen kann ({reason}).",
  "settings.access.unchanged": "Der Zugriff ist unverändert.",
  "settings.model.advancedHint": "Kontextgrenzen, lokale Modelle",
  "settings.permissions.subject.prepNotes": "Notizen mit dem Titel „Prep:“ (Meeting-Vorbereitung)",
  "settings.permissions.specificConnectors":
    "Berechtigungen für einen bestimmten Connector legst du auf dessen Seite unter „Verbindungen“ fest.",
  "settings.permissions.openConnectors": "Verbindungen öffnen",
  "settings.persona.description": "Wie {name} aussieht und sich vorstellt.",
  "settings.persona.whileWorking": "Bei der Arbeit",
  "settings.persona.showReasoningHint":
    "Zeigt die Überlegungen von {persona} während der Arbeit. Wird nie gesichert.",
  "settings.connectors.page.onHost": "Auf {host}",
  "settings.connectors.page.row.onHost": "Auf {host}",
  "settings.computerUse.remote":
    "Die Computer-Nutzung funktioniert bei {host}. Frag von dort aus oder nutze den Browser.",
  "settings.gateways.title": "Gateways auf diesem Computer",
  "settings.gateways.description":
    "Nutze Psyche von diesem Computer aus mit dem Gateway auf einem anderen, etwa deinem Mac zu Hause. Es ist immer ein Gateway aktiv, und das Wechseln startet Psyche neu.",
  "settings.gateways.loadLabel": "gespeicherte Gateways",
  "settings.gateways.thisMac": "Dieser Mac",
  "settings.gateways.active": "Verbunden",
  "settings.gateways.pinned": "Identität festgelegt",
  "settings.gateways.notPinned": "Legt seine Identität bei der ersten Verbindung fest",
  "settings.gateways.switch": "Wechseln",
  "settings.gateways.switchTo": "Zu {name} wechseln",
  "settings.gateways.switchTitle": "Zu {name} wechseln?",
  "settings.gateways.switchKeep":
    "Psyche startet auf {name} neu. Psyche auf diesem Mac läuft weiter, daher laufen seine Automatisierungen weiter.",
  "settings.gateways.switchOnly": "Wechseln",
  "settings.gateways.switchAndStop": "Wechseln und Psyche auf diesem Mac beenden",
  "settings.gateways.pairAgain": "Erneut koppeln",
  "settings.gateways.pairAgainNamed": "Erneut mit {name} koppeln",
  "settings.gateways.forget": "Vergessen",
  "settings.gateways.forgetNamed": "{name} vergessen",
  "settings.gateways.add": "Gateway hinzufügen",
  "settings.gateways.addressLabel": "Kopplungslink oder Adresse",
  "settings.gateways.addressPlaceholder": "studio-mac.your-tailnet.ts.net",
  "settings.gateways.nameLabel": "Name (optional)",
  "settings.gateways.addHint":
    "Füge den Kopplungslink von dem Mac ein, auf dem Psyche läuft (Einstellungen, Server & Fernzugriff, Anderen Computer koppeln). Ohne Link gib seine Tailscale-Adresse ein, https://<host>.<tailnet>.ts.net; dieser Computer bittet dann um Kopplung, und der Besitzer genehmigt sie dort.",
  "settings.gateways.newLink": "Ein neuer Kopplungslink ist eingetroffen. Verwenden?",
  "settings.gateways.useNewLink": "Verwenden",
  "settings.gateways.ignoreNewLink": "Ignorieren",
  "settings.gateways.fromLink":
    "Aus einem Kopplungslink geöffnet. Prüfe ihn und drücke dann „Gateway hinzufügen“. Psyche bittet dich, die Adresse zu bestätigen, bevor es sich verbindet.",
  "settings.gateways.adding": "Gateway hinzufügen",
  "settings.gateways.problem.empty": "Gib die Adresse des Gateways ein.",
  "settings.gateways.problem.invalid": "Das ist keine Adresse, die Psyche nutzen kann.",
  "settings.gateways.problem.needs_full_name":
    "Verwende den vollständigen Namen, etwa studio-mac.your-tailnet.ts.net. Ein Kurzname lässt sich nicht prüfen.",
  "settings.gateways.problem.needs_https":
    "Verwende eine https://-Adresse. Reines http funktioniert nur über einen SSH-Tunnel auf diesem Computer.",
  "settings.gateways.problem.has_path": "Gib nur die Adresse an, ohne Pfad.",
  "settings.gateways.problem.has_credentials": "Lass Benutzername und Passwort weg.",
  "settings.gateways.problem.link_not_a_pairing_link": "Das ist kein Kopplungslink.",
  "settings.gateways.problem.link_unsupported_version":
    "Dieser Kopplungslink stammt von einem neueren Psyche. Aktualisiere Psyche auf diesem Computer und versuche es erneut.",
  "settings.gateways.problem.link_malformed":
    "Dieser Kopplungslink ist beschädigt. Kopiere ihn erneut von dem Mac, der ihn erstellt hat.",
  "settings.gateways.problem.link_extra_fields":
    "Dieser Kopplungslink enthält etwas, das Psyche nicht versteht, daher wird er nicht verwendet.",
  "settings.gateways.problem.link_bad_field":
    "Dieser Kopplungslink ist beschädigt. Kopiere ihn erneut von dem Mac, der ihn erstellt hat.",
  "settings.gateways.problem.link_lan":
    "Dieser Kopplungslink gilt für einen Computer in deinem lokalen Netzwerk, enthält aber dessen Zertifikat nicht, daher wird er nicht verwendet. Erstelle auf diesem Mac einen neuen: Anderen Computer koppeln, Aus diesem Netzwerk.",
  "settings.gateways.problem.link_not_lan":
    "Dieser Kopplungslink nennt eine Adresse, die nicht in einem lokalen Netzwerk liegt, daher wird er nicht verwendet.",
  "settings.gateways.problem.link_pin_mismatch":
    "Dieses Gateway ist bereits mit einer anderen Identität gespeichert. Nutze zuerst „Erneut koppeln“ und füge dann den Link hinzu.",
  "settings.gateways.problem.failed":
    "Das Gateway konnte nicht hinzugefügt werden. Es wurde nichts geändert.",
  "settings.gateways.problem.declined": "Das Hinzufügen des Gateways wurde abgebrochen.",
  "settings.gateways.problem.actionFailed": "Das hat nicht geklappt. Es wurde nichts geändert.",
  "settings.remote.title": "Andere Computer zulassen",
  "settings.remote.description":
    "Lass Psyche auf einem anderen Computer das Gateway dieses Macs über Tailscale nutzen. Das Gateway bleibt auf diesem Mac und lauscht nur darauf; Tailscale Serve ist der einzige Zugang.",
  "settings.remote.step1":
    "Installiere Tailscale auf diesem Mac und auf dem anderen Computer und melde beide im selben Tailnet an.",
  "settings.remote.step2":
    "Veröffentliche das Gateway im Terminal auf diesem Mac in deinem Tailnet. Das ist Serve, nicht Funnel.",
  "settings.remote.copyCommand": "Befehl kopieren",
  "settings.remote.copied": "Kopiert",
  "settings.remote.step3":
    "Teile dem Gateway seine Adresse mit. Setze in der config.json im Datenordner von Psyche:",
  "settings.remote.step4":
    "Starte Psyche neu. Füge dann auf dem anderen Computer diesen Mac als Gateway hinzu. Er zeigt einen Kopplungscode und einen Schlüssel-Fingerabdruck: Vergleiche sie mit der Anfrage unter „Wartet auf Kopplung“ hier und genehmige sie dann.",
  "settings.remote.funnel":
    "Schalte dafür nie Tailscale Funnel ein. Es würde das Gateway im öffentlichen Internet erreichbar machen.",
  "settings.remote.configWarnings":
    "config.json enthält Einstellungen, die diese Version von Psyche nicht kennt und deshalb ignoriert: {keys}. Falls du eine davon meintest, prüfe die Schreibweise.",
  "settings.uninstall.group": "Psyche deinstallieren",
  "settings.uninstall.groupHint":
    "Beendet das Gateway und den Helfer und legt die App in den Papierkorb. Deine Daten bleiben erhalten, außer du entscheidest dich anders.",
  "settings.uninstall.open": "Psyche deinstallieren…",
  "settings.uninstall.title": "Psyche deinstallieren",
  "settings.uninstall.description":
    "Alles unten kommt in den Papierkorb, du kannst es also wieder herausholen. Nichts wird endgültig gelöscht.",
  "settings.uninstall.dataChoice": "Deine Daten",
  "settings.uninstall.keep": "Meine Daten behalten",
  "settings.uninstall.keepHint": "Chats, Gedächtnis, Tresor und Backups bleiben im Datenordner.",
  "settings.uninstall.delete": "Meine Daten löschen",
  "settings.uninstall.deleteHint":
    "Legt auch den Datenordner in den Papierkorb: Chats, Gedächtnis, Tresor und Backups.",
  "settings.uninstall.willDo": "Was passiert",
  "settings.uninstall.stopAgent": "Der Gateway-LaunchAgent wird beendet und entfernt.",
  "settings.uninstall.stopHelper":
    "Psyche Helper wird beendet und „Beim Anmelden öffnen“ wird ausgeschaltet.",
  "settings.uninstall.trash": "In den Papierkorb gelegt",
  "settings.uninstall.kind.agent": "Gateway-LaunchAgent",
  "settings.uninstall.kind.support": "Application Support",
  "settings.uninstall.kind.cache": "Caches, Protokolle, Einstellungen und gesicherter Zustand",
  "settings.uninstall.kind.data": "Deine Daten",
  "settings.uninstall.kind.app": "Die App",
  "settings.uninstall.agentOther":
    "Der Gateway-Agent gehört zu einer anderen Kopie von Psyche oder zum Kommandozeilen-Tool und bleibt deshalb unberührt.",
  "settings.uninstall.blocked":
    "{path} kann von hier aus nicht in den Papierkorb gelegt werden: {reason}",
  "settings.uninstall.keychainStays":
    "Schlüsselbund-Einträge bleiben erhalten (der Tresorschlüssel und die Einträge des Helfers). Entferne sie bei Bedarf in der Schlüsselbundverwaltung.",
  "settings.uninstall.keychainGoes":
    "Die Schlüsselbund-Einträge für den Tresor und den Helfer werden ebenfalls entfernt.",
  "settings.uninstall.removeKeychain":
    "Auch meine Schlüsselbund-Einträge entfernen (com.psyche.vault und die des Helfers). Ohne deine Daten sind sie nutzlos.",
  "settings.uninstall.kind.state": "Gesicherter Fensterzustand",
  "settings.uninstall.dataStays": "Dein Datenordner wird nicht angetastet.",
  "settings.uninstall.typeWord": "Gib {word} zur Bestätigung ein",
  "settings.uninstall.presence":
    "Danach wirst du gebeten, mit Touch ID oder auf diesem Gerät zu bestätigen, weil dabei deine Daten entfernt werden.",
  "settings.uninstall.approvalLabel": "Psyche deinstallieren und Daten löschen",
  "settings.uninstall.failed":
    "Psyche konnte nicht deinstalliert werden ({reason}). Es wurde nichts weiter geändert.",
  "settings.uninstall.cancel": "Abbrechen",
  "settings.uninstall.go": "Deinstallieren und beenden",
  "settings.uninstall.goDelete": "Daten löschen und deinstallieren",
  "settings.remote.admin":
    "Ein gekoppelter Computer erhält Lesen, Schreiben und Genehmigungen. Admin bleibt aus, außer du hakst es bei der Genehmigung an, und jede Admin-Änderung braucht hier weiterhin deine Touch ID.",
  "settings.remote.address": "Öffentliche Adresse",
  "settings.remote.addressUnset": "Nicht festgelegt",
  "settings.remote.proxy": "Vertrauenswürdiger Proxy",
  "settings.remote.on": "An",
  "settings.remote.off": "Aus",
  "settings.remote.fingerprint": "Schlüssel dieses Gateways",
  "settings.remote.fingerprintHint":
    "Vergleiche ihn mit dem Fingerabdruck, den der andere Computer bei der ersten Verbindung zeigt.",
  "settings.remote.loadLabel": "Identität des Gateways",
  "settings.remote.clientNote":
    "Dieser Computer ist ein Client von {host}. Der Fernzugriff wird auf {host} eingerichtet.",
  "settings.pair.title": "Anderen Computer koppeln",
  "settings.pair.description":
    "Erstelle einen Kopplungslink oder QR-Code für Psyche auf einem anderen Computer. Er gilt einmal, zehn Minuten lang, und der Computer, der ihn nutzt, wird mit dem hier angehakten Zugriff gekoppelt, ohne zweite Genehmigung.",
  "settings.pair.needsAddress":
    "Lege zuerst die öffentliche Adresse dieses Macs fest (Schritt 3 oben) und erstelle dann einen Kopplungslink.",
  "settings.pair.scopes": "Was der andere Computer darf",
  "settings.pair.adminHint":
    "Admin erlaubt ihm, Sicherheitseinstellungen, Geräte und den Tresor zu ändern, und bleibt aus, außer du hakst es an. Jede Admin-Änderung braucht hier weiterhin deine Touch ID.",
  "settings.pair.make": "Kopplungslink erstellen",
  "settings.pair.resultRegion": "Kopplungslink und QR-Code",
  "settings.pair.qrLabel": "QR-Code des Kopplungslinks für {host}",
  "settings.pair.scan":
    "Wähle auf dem anderen Computer „Gateway hinzufügen“ und füge diesen Link für {host} ein.",
  "settings.pair.expires": "Läuft {when} ab.",
  "settings.pair.linkLabel": "Kopplungslink",
  "settings.pair.copy": "Link kopieren",
  "settings.pair.gives": "Nach der Nutzung erhält dieser Computer: {scopes}.",
  "settings.pair.compare":
    "Er prüft den Schlüssel dieses Macs, bevor er den Link nutzt: {fingerprint}. Du kannst vergleichen.",
  "settings.pair.secret":
    "Wer diesen Link in den nächsten zehn Minuten hat, kann einen Computer koppeln. Poste ihn nicht und sende ihn nicht an jemanden, dem du diesen Mac nicht anvertrauen würdest.",
  "settings.pair.live": "Unbenutzte Kopplungslinks",
  "settings.pair.unused": "Noch nicht verwendet",
  "settings.pair.revoke": "Widerrufen",
  "settings.pair.revokeNamed": "Den {when} erstellten Kopplungslink widerrufen",
  "settings.pair.madeToast": "Kopplungslink erstellt. Er gilt einmal, zehn Minuten lang.",
  "settings.pair.usedToast": "Ein Computer hat sich mit deinem Link gekoppelt.",
  "settings.pair.gone":
    "Der Kopplungslink ist nicht mehr gültig und wird deshalb nicht mehr angezeigt.",
  "settings.pair.err.noAddress":
    "Dieser Mac hat noch keine öffentliche Adresse, daher gibt es nichts, was in einen Link gehört.",
  "settings.pair.err.tooMany":
    "Es gibt bereits drei unbenutzte Kopplungslinks. Widerrufe einen oder warte, bis einer abläuft.",
  "settings.pair.err.forbidden":
    "Nur Psyche auf dem Host selbst, als Admin gekoppelt, kann einen Kopplungslink erstellen.",
  "settings.pair.err.failed": "Der Kopplungslink konnte nicht erstellt werden ({reason}).",
  "settings.pair.via": "Von wo verbindet sich der andere Computer?",
  "settings.pair.viaAddress": "Über Tailscale, unter der Adresse dieses Macs",
  "settings.pair.viaLan": "Aus diesem Netzwerk",
  "settings.pair.viaLanHint":
    "Ein Link für dieses Netzwerk enthält den Schlüssel und das Zertifikat dieses Macs und funktioniert daher nur für Computer im selben WLAN oder Ethernet.",
  "settings.pair.lanNote":
    "Dieser Link gilt für Computer im selben Netzwerk wie dieser Mac. Er nennt den Schlüssel und das Zertifikat, auf die Psyche besteht.",
  "settings.pair.err.noLan":
    "Schalte „Computer in diesem Netzwerk zulassen“ ein und warte, bis das Gateway lauscht, um einen Link für dieses Netzwerk zu erstellen.",
  "settings.key.gateway.lan": "Computer in diesem Netzwerk zulassen",
  "settings.key.gateway.lan.rotateCert": "Das Netzwerkzertifikat",
  "settings.lan.title": "Computer in diesem Netzwerk zulassen",
  "settings.lan.description":
    "Lass Psyche auf einem anderen Computer im selben WLAN oder Ethernet das Gateway dieses Macs ohne Tailscale erreichen. Es ist aus, bis du es einschaltest.",
  "settings.lan.loadLabel": "Netzwerkzugriff",
  "settings.lan.unsupported": "Dieses Gateway ist zu alt, um im Netzwerk zu lauschen.",
  "settings.lan.toggle": "Computer in diesem Netzwerk zulassen",
  "settings.lan.toggleHint":
    "Psyche lauscht in einem Netzwerk, über eine verschlüsselte Verbindung mit eigenem Zertifikat. Ein Computer, der sich verbindet, muss hier trotzdem per Touch ID genehmigt werden.",
  "settings.lan.ipv6": "Auch die IPv6-Adressen dieses Netzwerks nutzen",
  "settings.lan.ipv6Hint":
    "Fügt die privaten IPv6-Adressen (sie beginnen mit fd oder fc) des gewählten Netzwerks hinzu. Öffentliche IPv6-Adressen und fe80-Adressen werden nie verwendet.",
  "settings.lan.problem.ipv6Off":
    "{address} ist eine IPv6-Adresse, und IPv6 ist aus, daher lauscht Psyche dort nicht. Schalte oben IPv6 ein oder entferne sie.",
  "settings.lan.problem.ipv6NeedsIpv4":
    "Psyche lauscht nicht auf {address}. IPv6 wird nur zusammen mit der IPv4-Adresse dieses Netzwerks genutzt, die du hier zuerst zulassen musst.",
  "settings.lan.interface": "Netzwerk",
  "settings.lan.interfaceDefault": "Primäres Netzwerk",
  "settings.lan.interfaceOption": "{name} ({address})",
  "settings.lan.noInterface": "Auf diesem Mac wurde keine WLAN- oder Ethernet-Verbindung gefunden.",
  "settings.lan.trustedOnly":
    "Schalte das nur in einem Netzwerk ein, dem du vertraust. In geteilten oder Gast-WLANs kann jeder Verbundene den Kopplungsbildschirm erreichen.",
  "settings.lan.status": "Status",
  "settings.lan.listening": "Lauscht auf {addresses}",
  "settings.lan.notListening": "Lauscht nicht",
  "settings.lan.address": "Adresse",
  "settings.lan.discovery": "Erkennung",
  "settings.lan.advertised": "Psyche in diesem Netzwerk angezeigt",
  "settings.lan.notAdvertised": "Nicht angezeigt. Füge diesen Mac über seine Adresse hinzu.",
  "settings.lan.certificate": "Zertifikat",
  "settings.lan.certificateHint":
    "Computer, die koppeln, merken sich das. Ersetzt du das Zertifikat, müssen alle erneut koppeln.",
  "settings.lan.rotate": "Zertifikat ersetzen",
  "settings.lan.rotateTitle": "Das Netzwerkzertifikat ersetzen?",
  "settings.lan.rotateBody":
    "Computer, die bereits über das Netzwerk gekoppelt sind, verbinden sich nicht mehr, bis sie erneut koppeln. Nutze das, wenn du glaubst, dass das Zertifikat kopiert wurde.",
  "settings.lan.rotateConfirm": "Ersetzen und trennen",
  "settings.lan.rotateFailed":
    "Das Zertifikat konnte nicht ersetzt werden ({reason}). Es wurde nichts geändert.",
  "settings.lan.problem.unknownInterface": "{name} ist kein Netzwerk auf diesem Mac.",
  "settings.lan.problem.noInterface": "Es gibt kein Netzwerk zum Lauschen, daher lauscht nichts.",
  "settings.lan.problem.bindFailed":
    "Auf {address} konnte nicht gelauscht werden. Möglicherweise nutzt ein anderes Programm den Port.",
  "settings.lan.problem.paused":
    "Der LAN-Zugriff ist in diesem Netzwerk pausiert. Du hast ihn für ein anderes eingeschaltet.",
  "settings.lan.allowHere": "In diesem Netzwerk zulassen",
  "settings.lan.problem.cert":
    "Psyche konnte sein Netzwerkzertifikat weder erstellen noch lesen und lauscht daher nicht.",
  "settings.lan.problem.cloudflare":
    "Dieses Gateway ist nur über Cloudflare Access erreichbar eingerichtet und lauscht daher nicht zusätzlich im Netzwerk.",
  "settings.gateways.discoverConflict":
    "Mehrere Computer haben diesen Namen mit unterschiedlichen Schlüsseln angekündigt, daher fügt Psyche ihn nicht hinzu. Füge den richtigen über seine Adresse hinzu.",
  "settings.lan.problem.container":
    "Ein Gateway in einem Container lauscht auf diese Weise nicht im Netzwerk.",
  "settings.lan.problem.advertise":
    "Psyche konnte sich im Netzwerk nicht ankündigen. Computer können diesen Mac weiterhin über seine Adresse hinzufügen.",
  "settings.gateways.discover": "In diesem Netzwerk suchen",
  "settings.gateways.discovering": "Suche läuft …",
  "settings.gateways.discoverTitle": "In diesem Netzwerk",
  "settings.gateways.discoverNone":
    "Kein Psyche gefunden. Schalte auf jenem Computer „Computer in diesem Netzwerk zulassen“ ein.",
  "settings.gateways.discoverFailed":
    "Das Netzwerk konnte nicht durchsucht werden. Füge ihn stattdessen über seine Adresse hinzu.",
  "settings.gateways.discoverKey": "Schlüssel {fingerprint}",
  "settings.gateways.discoverHint":
    "Was ein Computer im Netzwerk ankündigt, ist nur eine Behauptung. Der Kopplungsbildschirm zeigt seinen Schlüssel: Vergleiche ihn mit dem des Hosts, bevor du genehmigst.",
  "settings.gateways.discoverAdd": "{name} hinzufügen",
  "settings.gateways.discoverSaved": "Gespeichert",
  "settings.devices.gatewayKey": "Schlüssel dieses Gateways {fingerprint}",
  "settings.devices.fromAddress": "Von {address}",
  "settings.devices.fromLan":
    "Von {address}, in deinem Netzwerk. Prüfe unten den ganzen Schlüssel.",
  "settings.devices.adminOptIn":
    "Admin erlaubt diesem Computer, Sicherheitseinstellungen, Geräte und den Tresor zu ändern. Lass es aus, außer du brauchst es.",
  "settings.skills.signer.title": "Wer es erstellt hat",
  "settings.skills.signer.unsigned":
    "Nicht signiert. Nichts zeigt, wer es erstellt hat oder dass es unterwegs nicht verändert wurde, daher wird es als unbekannter Herausgeber installiert.",
  "settings.skills.signer.new": "Signiert von {name}. Du hast diesen Schlüssel noch nie gesehen.",
  "settings.skills.signer.seen":
    "Signiert von {name}, mit einem Schlüssel, den du schon gesehen, dem du aber nicht vertraut hast.",
  "settings.skills.signer.trusted":
    "Signiert von {name}, einer Autorin oder einem Autor, der du vertraust.",
  "settings.skills.signer.own": "Von dir signiert.",
  "settings.skills.signer.changed":
    "Signiert von {name}, aber nicht mit dem zuvor gesehenen Schlüssel. Prüfe, ob es dieselbe Person ist, bevor du es installierst.",
  "settings.skills.signer.changedUpdate":
    "Signiert von {name}, mit einem anderen Schlüssel als die installierte Version. Prüfe, ob es dieselbe Person ist, bevor du aktualisierst.",
  "settings.skills.signer.dropped":
    "Die installierte Version wurde von {name} signiert. Diese hier ist gar nicht signiert.",
  "settings.skills.signer.impersonates":
    "Signiert von {name}, was dem Namen ähnelt, mit dem du deine eigenen Skills signierst, aber der Schlüssel gehört nicht dir. Installiere es nur, wenn du weißt, woher es stammt.",
  "settings.skills.signer.nameChanged":
    "Mit einem Schlüssel signiert, dem du vertraust, aber unter einem Namen, den er zuvor nicht verwendet hat: {name}. Prüfe, ob es noch dieselbe Person ist.",
  "settings.skills.signer.originAgent":
    "Von einem Assistenten auf dem Mac des Absenders geschrieben. Lies es als ungeprüften Text, egal wer signiert hat.",
  "settings.skills.widened.specialist": "Hintergrundrolle",
  "settings.skills.bundleOriginAgent": "Von einem Assistenten anderswo geschrieben",
  "settings.skills.export.label": "„{name}“ wird signiert",
  "settings.skills.author.label": "Vertrauen in Autoren",
  "settings.skills.signer.claim":
    "Der Name ist die eigene Angabe des Autors. Der Schlüssel verbindet die Versionen miteinander.",
  "settings.skills.signer.key": "Autorenschlüssel",
  "settings.skills.signer.trust": "{name} als Autor vertrauen",
  "settings.skills.signer.trustHint":
    "Spätere Versionen, die mit diesem Schlüssel signiert sind, werden als von einem Autor markiert, dem du vertraust. Jede Installation fragt weiterhin zuerst nach.",
  "settings.skills.widened.title": "Verlangt mehr als die installierte Version",
  "settings.skills.widened.hint":
    "Das Genehmigen erteilt von sich aus keine Berechtigung, führt aber nun auch zu diesen Fragen.",
  "settings.skills.widened.permissions": "Neue Berechtigungen",
  "settings.skills.widened.tools": "Neue Tools",
  "settings.skills.widened.prompts": "Neue Prompt-Dateien",
  "settings.skills.import.file": "Datei importieren …",
  "settings.skills.import.hint":
    "Eine .psyche-skill-Datei von jemand anderem oder ein https-Link dazu. Sie wird geprüft und dir gezeigt, bevor etwas installiert wird.",
  "settings.skills.import.failed": "Psyche konnte diese Datei nicht lesen ({reason}).",
  "settings.skills.import.tooBig": "diese Datei ist größer als 8 MB",
  "settings.skills.signedBy": "Signiert von {name}",
  "settings.skills.signedState":
    "{state, select, own {du} trusted {vertrauenswürdig} revoked {widerrufen} other {nicht vertrauenswürdig}}",
  "settings.skills.export": "Exportieren …",
  "settings.skills.export.title": "„{name}“ exportieren",
  "settings.skills.export.hint":
    "Die Datei wird mit deinem Autorenschlüssel signiert, sodass Empfänger erkennen, dass sie von dir stammt und nicht verändert wurde. Der Schlüssel bleibt auf diesem Mac.",
  "settings.skills.export.nameLabel": "Name zum Signieren",
  "settings.skills.export.nameHint":
    "Wird einmal festgelegt. Alle, die deine Skills importieren, sehen ihn.",
  "settings.skills.export.go": "Exportieren und signieren",
  "settings.skills.exported":
    "„{name}“ als {file} exportiert, signiert als {author}.{created, select, true { Dein Autorenschlüssel wurde erstellt: {key}.} other {}}",
  "settings.skills.author.trust": "Diesem Autor vertrauen",
  "settings.skills.author.untrust": "Diesem Autor nicht mehr vertrauen",
  "settings.skills.author.revoke": "Diesen Autor widerrufen",
  "settings.skills.author.revokeTitle": "Schlüssel von {name} widerrufen?",
  "settings.skills.author.revokeDescription":
    "Damit signierte Skills werden nicht mehr geladen, und neue damit signierte Dateien werden abgelehnt. Du kannst ihm später wieder vertrauen.",
  "settings.skills.author.revokeConfirm": "Widerrufen",
  "settings.usage.unavailable": "Die Nutzung ist von diesem Gateway noch nicht verfügbar.",
  "settings.usage.thisMonth": "Dieser Monat",
  "settings.usage.monthLine":
    "{cost} und {tokens} Tokens in {turns, plural, one {# Zug} other {# Zügen}}. Heute bisher: {today}.",
  "settings.usage.noBudget": "Es ist kein Monatsbudget festgelegt.",
  "settings.usage.byModel": "Letzte 7 Tage nach Modell",
  "settings.usage.model": "Modell",
  "settings.usage.turns": "{n, plural, one {# Zug} other {# Züge}}",
  "settings.usage.planWindow":
    "{model}: {pct} % des Plan-Fensters verbraucht, wird {when} zurückgesetzt.",
  "settings.vm.enabledHint":
    "Aufgaben, die es verlangen, laufen im Gast, nur mit den Ordnern, die du teilst.",
  "settings.vm.credentialsHint":
    "Mit dem Tresor des Hosts bleiben Werte auf deinem Mac. Ein Gast-Tresor behält seine eigene Kopie.",
  "settings.voice.anyAppHint":
    "wo auch immer du tippst. Der Text geht an deinen Cursor, nie an den Agenten oder ein Passwortfeld.",
  "settings.voice.talkHint":
    "Eine Sprach-Schaltfläche im Eingabefeld startet ein gesprochenes Gespräch. Sprache genehmigt nie etwas.",
  "settings.people.title": "Personen und Projekte",
  "settings.people.description":
    "Die Karten, die {persona} für die Personen und Projekte in deinem Leben führt. Sie bleiben auf diesem Mac, und jeder Fakt zeigt, woher er stammt.",
  "settings.people.loadLabel": "Einstellungen zu Personen und Projekten werden geladen",
  "settings.people.off":
    "Aus. {persona} führt keine Karten für die Personen und Projekte in deinem Leben.",
  "settings.people.turnOn": "Einschalten",
  "settings.people.graph": "Personen lernen aus",
  "settings.people.entityRecall": "Namen in Antworten verwenden",
  "settings.people.entityRecallHint":
    "Nennst du in einem privaten Chat jemanden, fügt {persona} eine Zeile über die Person hinzu. Nie in Gruppen oder Kanälen.",
  "settings.people.sources": "Personen lernen aus",
  "settings.people.sourcesHint":
    "Jede Quelle ist aus, bis du sie einschaltest. Ausschalten beendet das Lesen.",
  "settings.people.source.contacts": "Kontakte",
  "settings.people.source.mail": "Mail",
  "settings.people.source.calendar": "Kalender",
  "settings.people.source.messages": "Nachrichten",
  "settings.people.source.messagesHint": "Nutzt, wem du wann schreibst, nie den Nachrichtentext.",
  "settings.people.source.notes": "Notizen",
  "settings.people.source.chats": "Deine Chats",
  "settings.people.sourceOff": "Aus",
  "settings.people.sourceCounts":
    "{entities, plural, one {# Person oder Projekt} other {# Personen und Projekte}} · {interactions, plural, one {# Interaktion} other {# Interaktionen}} · {read, select, none {noch nicht gelesen} other {gelesen um {read}}}",
  "settings.people.retention": "Wie lange Interaktionen bleiben",
  "settings.people.retentionLabel": "Interaktionen aufbewahren für",
  "settings.people.retentionHint":
    "Ältere Kopfzeilen und Verknüpfungen werden nachts gelöscht. Karten, Fakten und offene Punkte bleiben, bis du sie vergisst.",
  "settings.people.months": "{n, plural, one {# Monat} other {# Monate}}",
  "settings.people.learning": "Wie Karten geführt werden",
  "settings.people.learningHint":
    "Zusammenfassungen, Rollen und offene Punkte stammen vom Hilfsmodell, standardmäßig lokal.",
  "settings.people.budget":
    "Heute Nacht: {tokens, number} von {maxTokens, number} Tokens, {entities, number} von {maxEntities, number} Personen und Projekten. Zusammenfassungen, Rollen und offene Punkte stammen vom Hilfsmodell, standardmäßig lokal.",
  "settings.people.nightly": "Nächtlich",
  "settings.people.nightlyHint":
    "Aktualisiert Zusammenfassungen und findet offene Punkte, während du schläfst.",
  "settings.people.afterRun": "Nach jeder Aufgabe",
  "settings.people.afterRunHint":
    "Aktualisiert die wenigen Personen und Projekte, die eine Aufgabe berührt hat.",
  "settings.people.precision": "Vorgeschlagene offene Punkte, die du behalten hast: {list}.",
  "settings.people.precisionItem": "{source} {confirmed, number} von {total, number}",
  "settings.people.aboutYou": "Über dich",
  "settings.people.aboutYouHint":
    "Deine eigene Karte: jeder Fakt, den {persona} über dich gelernt hat, mit Quelle.",
  "settings.people.openOwnCard": "Deine Karte öffnen",
  "settings.people.ownCardHint":
    "Fakten über dich aus deinem Profil, deinen Chats und verbundenen Apps.",
  "settings.people.editUserMd": "USER.md bearbeiten",
  "settings.people.blocked": "Aus „Personen“ gesperrt",
  "settings.people.blockedHint":
    "Es wird nie wieder etwas darüber gelernt. Eine gesperrte Domain gilt für jede Adresse darauf.",
  "settings.people.noneBlocked": "Niemand ist gesperrt.",
  "settings.people.blockedOn": "{kind} · gesperrt am {date}",
  "settings.people.unblock": "Entsperren",
  "settings.people.unblockLabel": "{hint} entsperren",
  "settings.people.block": "Sperren",
  "settings.people.blockKindLabel": "Was gesperrt werden soll",
  "settings.people.blockValue": "Adresse, Telefonnummer oder Domain",
  "settings.people.blockKind.email": "E-Mail-Adresse",
  "settings.people.blockKind.phone": "Telefonnummer",
  "settings.people.blockKind.domain": "Domain",
  "settings.people.blockKind.contact": "Kontakt",
  "settings.people.blockKind.channel": "Kanal",
  "settings.people.blockKind.calendar": "Kalender",
  "settings.people.blockKind.url": "Webadresse",
  "settings.people.blockPlaceholder.email": "name@example.com",
  "settings.people.blockPlaceholder.phone": "+49 30 123456",
  "settings.people.blockPlaceholder.domain": "example.com",
  "settings.people.nothingStored": "Aus keiner Quelle ist bisher etwas gespeichert.",
  "settings.people.sourceStored":
    "{entities, plural, one {# Person oder Projekt} other {# Personen und Projekte}} · {interactions, plural, one {# Interaktion} other {# Interaktionen}}",
  "settings.people.deleteSource": "Löschen …",
  "settings.people.deleteSourceLabel": "Löschen, was {source} geliefert hat",
  "settings.people.deleteSourceTitle": "Löschen, was {source} geliefert hat?",
  "settings.people.deleteSourceAfter":
    "{source} wird ausgeschaltet, damit die nächste Synchronisierung es nicht zurückbringt. Fakten, die du selbst hinzugefügt hast, bleiben.",
  "settings.people.deleteSourceConfirm": "Löschen",
  "settings.people.deletedSource": "Gelöscht, was {source} geliefert hat.",
  "settings.people.forgetAll": "Alles über Personen und Projekte",
  "settings.people.forgetAllHint":
    "Löscht jede Person, jedes Projekt, jede Karte und jeden offenen Punkt und schaltet „Personen und Projekte“ aus. Deine eigenen Gedächtnisdateien bleiben.",
  "settings.people.forgetAllButton": "Vergessen …",
  "settings.people.forgetAllTitle": "Alles über Personen und Projekte vergessen?",
  "settings.people.forgetAllAfter":
    "Das lässt sich nicht rückgängig machen. „Personen & Projekte“ wird ausgeschaltet; schalte es wieder ein, um ganz von vorn zu beginnen.",
  "settings.people.typeToConfirm": "Gib „{phrase}“ zur Bestätigung ein",
  "settings.people.forgetAllConfirm": "Alles vergessen",
  "settings.people.forgotAll": "Alles über Personen und Projekte vergessen.",
  "settings.people.counting": "Es wird geprüft, was gelöscht würde …",
  "settings.people.previewFailed": "Psyche konnte nicht zählen, was es löschen würde ({reason}).",
  "settings.people.removeCounts":
    "Psyche löscht {entities, plural, one {# Person oder Projekt} other {# Personen und Projekte}}, {facts, plural, one {# Fakt} other {# Fakten}}, {interactions, plural, one {# Interaktion} other {# Interaktionen}}, {loops, plural, one {# offenen Punkt} other {# offene Punkte}} und {identifiers, plural, one {# Adresse} other {# Adressen}}.",
  "settings.specialists.title": "Spezialisten",
  "settings.specialists.description":
    "Hintergrundjobs mit benannter Rolle, jeweils innerhalb ihres Budgets, die ein Ergebnis in deinem Eingang abliefern.",
  "settings.specialists.all": "Alle Spezialisten",
  "settings.specialists.concurrent": "Spezialisten gleichzeitig",
  "settings.specialists.concurrentHint":
    "Mehr laufen nebeneinander; der Rest wartet in der Schlange.",
  "settings.specialists.monthlyCap": "Monatliche Ausgaben",
  "settings.specialists.monthlyCapHint":
    "Neue Jobs warten auf Budget, sobald es erreicht ist. Leer nutzt die Hälfte deines Monatsbudgets{budget, select, none {} other { ({budget})}}.",
  "settings.specialists.monthlyCapNone": "Kein Limit",
  "settings.specialists.showInFeed": "Ergebnisse im Feed zeigen",
  "settings.specialists.showInFeedHint": "Dein Eingang erhält in jedem Fall jedes Ergebnis.",
  "settings.specialists.roles": "Rollen",
  "settings.specialists.rolesHint":
    "Eine Rolle stammt aus einem Skill. Eine, die du installiert hast, bleibt aus, bis du sie einschaltest.",
  "settings.specialists.turnOn": "{role} an",
  "settings.specialists.summary": "{model} · {budget} · {mode}",
  "settings.specialists.budgetLine": "{tokens} Tokens · {cost} · {minutes} Min.",
  "settings.specialists.edit": "Bearbeiten",
  "settings.specialists.done": "Fertig",
  "settings.specialists.editLabel": "{role} bearbeiten",
  "settings.specialists.model": "Modell",
  "settings.specialists.modelDefault": "Standard: {class}",
  "settings.specialists.class.utility": "Hilfsmodell",
  "settings.specialists.class.primary": "Hauptmodell",
  "settings.specialists.class.harness": "Coding-Harness",
  "settings.specialists.class.vision": "Hauptmodell mit Bildverständnis",
  "settings.specialists.budget": "Budget pro Job",
  "settings.specialists.budgetTokens": "Tokens",
  "settings.specialists.budgetCost": "Kosten (USD)",
  "settings.specialists.budgetMinutes": "Minuten",
  "settings.specialists.budgetCaps":
    "Bis zu {tokens} Tokens · {cost} · {minutes} Min. Ein Job kann mehr anfordern, aber nie darüber hinaus.",
  "settings.specialists.maxMode": "Das Meiste, was es ohne Nachfrage tun darf",
  "settings.specialists.mode.plan": "Plan",
  "settings.specialists.mode.manual": "Manuell",
  "settings.specialists.mode.balanced": "Ausgewogen",
  "settings.specialists.mode.auto": "Auto",
  "settings.specialists.installed": "Aus {skill}",
  "settings.specialists.empty": "Noch kein Skill definiert einen Spezialisten.",
  "settings.language.description": "Textsprache und wie Datum und Zahlen geschrieben werden.",
  "settings.language.languageHint": "Alles, was noch nicht übersetzt ist, erscheint auf Englisch.",
  "settings.persona.identityHint": "Name und Slogan.",
  "settings.persona.avatarHint": "Wähle ein Wesen oder beschreibe eine Änderung.",
  "settings.persona.whileWorkingHint": "Was du siehst, während eine Aufgabe läuft.",
  "settings.daily.group.briefHint": "Eine kurze Zusammenfassung zum Start in den Tag.",
  "settings.daily.group.wrapupHint": "Ein Rückblick darauf, was erledigt wurde.",
  "settings.daily.group.deliveryHint": "Wie sie dich erreichen.",
  "settings.daily.group.automationsHint": "Wiederkehrende Jobs, die Psyche für dich ausführt.",
  "settings.voice.dictationHint": "Sprechen statt tippen.",
  "settings.usage.byThreadHint": "Wohin Tokens und Kosten gegangen sind.",
  "settings.skills.installedHint": "Skills, die Psyche jetzt nutzen kann.",
  "settings.about.versionsHint": "Was auf diesem Mac läuft.",
  "settings.specialists.allHint": "Rollen ein- oder ausschalten und ihre Budgets festlegen.",
  "settings.vm.sandboxMacHint": "Wo Befehle laufen.",
  "settings.computerUse.macPermissionsHint": "Was macOS erlaubt hat.",
  "settings.voice.advancedHint": "Sprach-Engine",
  "settings.files.advancedHint": "Psyche in geteilten Ordnern Befehle ausführen lassen",
  "settings.browser.advancedHint": "Webanfragen von Psyche signieren",
  "settings.skills.advancedHint": "Skills, die mit Psyche geliefert werden",
  "settings.skills.madeByAgent": "Erstellt von {persona}",
  "settings.skills.history": "{n, plural, one {# frühere Version} other {# frühere Versionen}}",
  "settings.skills.historyItem":
    "v{version} · genehmigt {approved} · {retiredBy, select, delete {gelöscht} other {ersetzt}} {retired}",
  "settings.skills.historyHint": "Zur Ansicht aufbewahrt. Diese Versionen werden nie geladen.",
  "settings.mcp.madeBy": "Von Psyche erstellt",
  "settings.mcp.madeByHint":
    "Psyche hat den Code dieses Connectors geschrieben. Er läuft nur in der Sandbox, nur der von dir genehmigte Code, und seine Tools fragen vor jeder Änderung nach.",
  "settings.mcp.code.title": "Code",
  "settings.mcp.code.view": "Code anzeigen",
  "settings.mcp.code.hide": "Code ausblenden",
  "settings.mcp.code.loading": "Code wird geladen …",
  "settings.mcp.code.version": "Version {version} · {runtime} · startet {entry}",
  "settings.mcp.code.modified":
    "Der Code auf dem Datenträger ist nicht die von dir genehmigte Version, daher bleibt dieser Connector gestoppt, bis du die Änderung genehmigst.",
  "settings.mcp.code.file": "{path} · {bytes} B",
  "settings.mcp.code.edit": "{file} bearbeiten",
  "settings.mcp.code.editing": "{file} wird bearbeitet",
  "settings.mcp.code.save": "Zur Prüfung sichern",
  "settings.mcp.code.saving": "Wird gesichert …",
  "settings.mcp.code.cancel": "Bearbeiten abbrechen",
  "settings.mcp.code.provided": "Von Psyche bereitgestellt, für jeden Connector gleich",
  "settings.mcp.code.approved": "{name} aktualisiert.",
  "settings.mcp.code.denied":
    "Änderung an {name} nicht genehmigt. Er bleibt gestoppt, bis du eine genehmigst.",
  "settings.deviceAccess.files.title": "Dateien auf diesem Mac",
  "settings.deviceAccess.files.hint":
    "Die Ordner, die {persona} lesen und, wo du es erlaubst, bearbeiten darf. Du teilst sie unter Berechtigungen → Zugriff.",
  "settings.deviceAccess.files.more": "{count, plural, one {und 1 weiterer} other {und # weitere}}",
  "settings.deviceAccess.open": "Zugriff öffnen",
  "settings.deviceAccess.terminal.title": "Terminal",
  "settings.deviceAccess.terminal.hint":
    "{persona} kann Terminalbefehle auf diesem Mac ausführen, wenn unter Berechtigungen → Zugriff „Befehle auf diesem Mac ausführen“ an ist.",
  "settings.deviceAccess.terminal.where":
    "Befehle laufen auf deinem Mac, in den Ordnern, die du geteilt hast, und dürfen nur in einen Ordner schreiben, den du mit Lesen und Schreiben geteilt hast.",
  "settings.deviceAccess.terminal.asks":
    "Befehle, die Dateien ändern könnten, fragen zuerst nach, außer du erlaubst genau diesen Befehl immer. Einfache lesende Befehle wie ls, cat oder wc laufen ohne Nachfrage, außer du schaltest das aus.",
  "settings.deviceAccess.terminal.sandbox":
    "Befehle laufen in der Sandbox. Ein genehmigter Lauf geht nur dann ohne sie, wenn du auf seiner Karte UNSANDBOXED eingibst.",
  "settings.deviceAccess.terminal.on": "Befehle ausführen ist an",
  "settings.deviceAccess.terminal.off": "Befehle ausführen ist aus",
  "settings.deviceAccess.terminal.folders":
    "{count, plural, =0 {Noch keine Ordner geteilt: Befehle haben keinen Ort zum Laufen.} one {1 Ordner geteilt.} other {# Ordner geteilt.}}",
  "settings.mcp.needs.title": "Was das auf deinem Mac braucht",
  "settings.mcp.needs.srt": "Sandbox (srt)",
  "settings.mcp.needs.srt.fix": "Hält den Server von den privaten Daten von Psyche fern.",
  "settings.mcp.needs.node": "Node.js-Tools (npm)",
  "settings.mcp.needs.node.fix":
    "Läuft auf dem eigenen Node von Psyche; braucht npm auf diesem Mac. Installiere Node.js von nodejs.org oder führe brew install node aus.",
  "settings.mcp.needs.uv": "uv (uvx)",
  "settings.mcp.needs.uv.fix":
    "Ein Python-Server. Installiere uv mit brew install uv oder von docs.astral.sh/uv.",
  "settings.mcp.needs.network": "Netzwerk",
  "settings.mcp.needs.network.fix": "Erreicht die eigene Adresse des Servers.",
  "settings.mcp.needs.networkHosts":
    "Erreicht nur {hosts}, um den Server herunterzuladen und auszuführen.",
  "settings.mcp.needs.missing": "Fehlt",
  "settings.mcp.needs.ready": "Bereit",
  "settings.mcp.needs.checked": "Geprüft bei „Server prüfen“",
  "settings.mcp.fail.no_srt":
    "Die Sandbox ist nicht installiert. Richte sie unten ein und prüfe den Server dann erneut.",
  "settings.mcp.fail.node_missing":
    "Installiere Node.js (nodejs.org oder brew install node), damit npm auf diesem Mac vorhanden ist, und prüfe dann erneut.",
  "settings.mcp.fail.uv_missing":
    "Installiere uv (brew install uv oder docs.astral.sh/uv) und prüfe den Server dann erneut.",
  "settings.mcp.fail.command_not_found":
    "Der Befehl des Servers ist hier nicht installiert. Prüfe den Befehl oder installiere das Tool, das er nennt.",
  "settings.mcp.fail.network_blocked":
    "Der Server konnte nicht herunterladen oder erreichen, was er braucht. Prüfe deine Verbindung und ob seine Hosts erlaubt sind.",
  "settings.mcp.fail.timeout":
    "Es hat zu lange gedauert. Beim ersten Lauf wird das Paket heruntergeladen; prüfe deine Verbindung und versuche es erneut.",
  "settings.mcp.fail.exited":
    "Der Server wurde direkt nach dem Start beendet. Seine letzte Ausgabe steht unten.",
  "settings.mcp.fail.failed": "Prüfe die Ausgabe des Servers unten und versuche es dann erneut.",
  "settings.mcp.fail.exitCode": "Exit-Code {code}.",
  "settings.mcp.fail.output": "Serverausgabe",
  "settings.connectors.page.description":
    "Die Apps und Tools, die {persona} nutzen kann. Jedes fragt nach, bevor es handelt, außer du bestimmst etwas anderes.",
  "settings.connectors.page.needsYou": "Braucht dich",
  "settings.connectors.page.connected": "Verbunden",
  "settings.connectors.page.onThisMac": "Auf diesem Mac",
  "settings.connectors.page.addMore": "Mehr hinzufügen",
  "settings.connectors.page.addMore.hint":
    "Mail, Kalender, Notizen und fertige Tools. Jedes fragt nach, bevor es handelt.",
  "settings.connectors.page.addMore.browse": "Alle durchsuchen",
  "settings.connectors.page.status.paused": "Pausiert",
  "settings.connectors.page.status.notWorking": "Funktioniert nicht",
  "settings.connectors.page.status.signInExpired": "Anmeldung abgelaufen",
  "settings.connectors.page.status.on": "An",
  "settings.connectors.page.status.off": "Aus",
  "settings.connectors.page.paused": "Pausiert",
  "settings.connectors.page.open": "{name} öffnen",
  "settings.connectors.page.manage": "Verwalten",
  "settings.connectors.page.fix.seeWhy": "Grund ansehen",
  "settings.connectors.page.row.never": "Noch nicht verwendet",
  "settings.connectors.page.row.lastUsed": "Verwendet {when}",
  "settings.connectors.page.row.unverified": "Nicht verifiziert",
  "settings.connectors.page.row.local": "Läuft auf diesem Mac",
  "settings.connectors.page.row.remote": "Verbindet sich über das Web",
  "settings.connectors.page.row.files":
    "{count, plural, =0 {Keine Ordner geteilt} one {1 Ordner geteilt} other {# Ordner geteilt}}",
  "settings.connectors.page.row.terminal.on": "Kann Befehle ausführen",
  "settings.connectors.page.row.terminal.off": "Befehle sind aus",
  "settings.connectors.page.detail.label": "Details zu {name}",
  "settings.connectors.page.detail.about": "Info",
  "settings.connectors.page.detail.access": "Zugriff",
  "settings.connectors.page.detail.source": "Quelle",
  "settings.connectors.page.detail.technical": "Technische Details",
  "settings.connectors.page.detail.manage": "Pausieren oder entfernen",
  "settings.connectors.page.detail.type": "Typ",
  "settings.connectors.page.detail.removeHint":
    "„Trennen“ pausiert ihn und behält seine Einstellungen. „Entfernen“ löscht ihn.",
  "settings.connectors.page.source.builtIn": "In Psyche integriert",
  "settings.connectors.page.source.verified": "Verifizierter Herausgeber",
  "settings.connectors.page.source.unverified": "Noch von niemandem geprüft",
  "settings.connectors.page.attention.signIn":
    "Deine Anmeldung bei {name} ist abgelaufen. Melde dich erneut an, damit es weiter funktioniert.",
  "settings.connectors.page.attention.error":
    "{name} funktioniert gerade nicht. Melde dich erneut an; schlägt es weiter fehl, entferne es und füge es neu hinzu.",
  "settings.connectors.page.attention.errorReason": "Meldung: {reason}",
  "settings.connectors.page.attention.server":
    "{name} ist nicht gestartet, daher sind seine Tools nicht verfügbar.",
  "settings.connectors.page.attention.serverHint":
    "Prüfe den Befehl oder die Adresse und die Geheimnisse unten, schalte ihn dann aus und wieder ein.",
  "settings.connectors.page.server.local": "Ein Tool, das in einer Sandbox auf diesem Mac läuft",
  "settings.connectors.page.server.remote": "Ein Tool, das du über eine Webadresse erreichst",
  "settings.connectors.page.server.network": "Erreicht das Netzwerk",
  "settings.connectors.page.server.noNetwork": "Kein Netzwerk",
  "settings.connectors.page.advanced": "Erweitert",
  "settings.connectors.page.advanced.hint":
    "Deine eigenen Tool-Server und eine Suche in der öffentlichen Registry.",
  "settings.connectors.page.advanced.custom": "Dein eigener Tool-Server",
  "settings.connectors.page.advanced.customHint":
    "Führe einen beliebigen MCP-Server in der Sandbox aus oder verbinde dich per Webadresse mit einem.",
  "settings.connectors.page.advanced.customAction": "Server hinzufügen",
  "settings.connectors.page.advanced.find": "Server online finden",
  "settings.connectors.page.gallery.title": "Connector hinzufügen",
  "settings.connectors.page.gallery.intro":
    "Such dir etwas zum Ausprobieren aus. Jeder fragt nach, bevor er etwas tut, und du kannst ihn jederzeit entfernen.",
  "settings.connectors.page.gallery.noMatch": "Nichts passt. Versuche ein anderes Wort.",
  "settings.connectors.page.gallery.back": "Zurück zur Galerie",
  "settings.connectors.page.gallery.community": "Community",
  "settings.nav.memory": "Prüfen",
  "settings.nav.everything": "Quellen",
  "settings.learnMore": "Mehr erfahren",
  "settings.learnLess": "Weniger anzeigen",
  "settings.nav.work": "Arbeit",
  "settings.nav.surfaces": "Wo das Gedächtnis erscheint",
  "settings.key.memory.work": "Arbeit im Gedächtnis",
  "settings.key.memory.surfaces": "Wo das Gedächtnis erscheint",
  "settings.key.memory.work.enabled": "Meine Arbeit verfolgen",
  "settings.key.memory.work.trackedLists": "Als Arbeit verfolgte Erinnerungslisten",
  "settings.key.memory.work.anchorsFromFolders": "Welche Ordner als Arbeit zählen",
  "settings.key.memory.work.remind.enabled": "Mich erinnern, was morgen fällig ist",
  "settings.key.memory.work.remind.dueSoonHours": "Wie weit im Voraus nach Fälligem gesucht wird",
  "settings.key.memory.work.remind.dayOf": "Mir morgens auch sagen, was heute fällig ist",
  "settings.key.memory.surfaces.tiers.work.home": "Arbeit auf Home",
  "settings.key.memory.surfaces.tiers.work.brief": "Arbeit in der Tagesübersicht",
  "settings.key.memory.surfaces.tiers.work.notification": "Arbeit in Mitteilungen",
  "settings.key.memory.surfaces.tiers.work.channel":
    "Arbeit in der an einen Kanal gesendeten Übersicht",
  "settings.key.memory.surfaces.tiers.workMail.home": "Mails zur Arbeit auf Home",
  "settings.key.memory.surfaces.tiers.workMail.brief": "Mails zur Arbeit in der Tagesübersicht",
  "settings.key.memory.surfaces.tiers.workMail.notification": "Mails zur Arbeit in Mitteilungen",
  "settings.key.memory.surfaces.tiers.workMail.channel":
    "Mails zur Arbeit in der an einen Kanal gesendeten Übersicht",
  "settings.key.memory.surfaces.tiers.people.home": "Personen auf Home",
  "settings.key.memory.surfaces.tiers.people.brief": "Personen in der Tagesübersicht",
  "settings.key.memory.surfaces.tiers.people.notification": "Personen in Mitteilungen",
  "settings.key.memory.surfaces.tiers.people.channel":
    "Personen in der an einen Kanal gesendeten Übersicht",
  "settings.key.memory.surfaces.birthdays":
    "Geburtstage und Jahrestage in der Übersicht und auf Home",
  "settings.key.memory.surfaces.hideSources":
    "Eine Quelle aus Home, Übersichten und Mitteilungen heraushalten",
  "settings.key.memory.surfaces.kinds.project": "Projekte außerhalb des Gedächtnisses zeigen",
  "settings.key.memory.surfaces.kinds.course": "Kurse außerhalb des Gedächtnisses zeigen",
  "settings.key.memory.surfaces.kinds.assignment": "To-dos außerhalb des Gedächtnisses zeigen",
  "settings.key.memory.surfaces.kinds.event": "Termine außerhalb des Gedächtnisses zeigen",
  "settings.recording.madeBy": "Aus einer Aufnahme",
  "settings.recording.open": "Jede Woche ausführen",
  "settings.recording.title": "Nach Zeitplan ausführen",
  "settings.recording.checking": "Die Schritte werden geprüft.",
  "settings.recording.cannot": "Dieser kann nicht laufen, wenn du nicht da bist:",
  "settings.recording.reason.sensitive": "Schritt {step} ist ein Feld, das du selbst ausfüllst.",
  "settings.recording.reason.input": "Schritt {step} fragt dich jedes Mal nach einem Wert.",
  "settings.recording.reason.unreadable":
    "Seine Schritte lassen sich nicht lesen. Nimm ihn erneut auf, um ihn zu planen.",
  "settings.recording.reason.browserOnly":
    "Geplante Läufe gibt es vorerst nur für Browser-Aufnahmen.",
  "settings.recording.reason.off":
    "Er ist ausgeschaltet oder hat sich seit deiner Genehmigung geändert.",
  "settings.recording.reason.notRecording":
    "Das ist kein Skill, der aus einer Aufnahme entstanden ist.",
  "settings.recording.cannotWhy":
    "Bei einem geplanten Lauf ist niemand da, den man fragen könnte, daher füllt er nie ein Passwort aus und fragt nie nach einem Wert. Du kannst ihn weiterhin selbst im Chat ausführen.",
  "settings.recording.rules":
    "Du bestimmst, wann. Jeder Lauf nutzt deine üblichen Genehmigungen. Hat sich die Seite geändert oder braucht ein Schritt deine Genehmigung, stoppt er an diesem Schritt, pausiert und sagt dir Bescheid. Er rät nie.",
  "settings.recording.every": "Jede/n",
  "settings.recording.daily": "Tag",
  "settings.recording.weekly": "Woche am",
  "settings.recording.monthly": "Monat am Tag",
  "settings.recording.dayOfWeek": "Wochentag",
  "settings.recording.dayOfMonth": "Tag des Monats",
  "settings.recording.at": "um",
  "settings.recording.confirm": "Planen",
  "settings.recording.close": "Abbrechen",
  "settings.recording.runs": "Läufe",
  "settings.recording.seeScheduled":
    "unter „Geplant“ pausieren, entfernen oder den Verlauf ansehen",
  "settings.teach.storage.title": "Aufnahmen, die du behältst",
  "settings.teach.storage.description":
    "Bittest du Psyche, eine Aufnahme zu behalten, damit du eine weitere Version erstellen kannst, werden die Schritte auf diesem Mac gesichert.",
  "settings.teach.storage.encrypted":
    "Verschlüsselt. Die Datei ist mit einem Schlüssel im Schlüsselbund dieses Macs gesperrt und lässt sich daher außerhalb von Psyche nicht lesen. Sie läuft nach 90 Tagen ab.",
  "settings.teach.storage.unavailable":
    "Aufnahmen werden nicht behalten. Der Schlüsselbund dieses Macs ist nicht verfügbar, und Psyche speichert eine Aufnahme nicht als Klartext. Du kannst eine Aufnahme weiterhin als Skill sichern.",
  "settings.key.capabilities.onlineSearch": "Das Online-MCP-Verzeichnis durchsuchen",
  "settings.key.tools.loading": "Wann Tools geladen werden",
  "settings.widgets.title": "Widgets im Chat",
  "settings.widgets.privacy":
    "Psyche kann im Chat kleine Felder zeichnen: Fortschritt, Listen, Tabellen, Diagramme und Bilder. Ein Feld kann auf ein Bild im Web verweisen. Erlaubst du das, holt dein Gateway das Bild für dich aus dem Web (ohne Cookies, ohne Referrer, nie direkt von deinem Gerät) und nur gängige Bildtypen bis 512 KB. In einem Feld, das aus nicht vertrauenswürdigen Inhalten erstellt wurde, wartet das Bild weiterhin auf deinen Klick.",
  "settings.widgets.remoteImages": "Bilder aus dem Web in Widgets zeigen",
  "settings.widgets.remoteImagesHint":
    "Standardmäßig aus: Diese Bilder zeigen einen kurzen Hinweis, und nichts wird geladen. Eine Änderung braucht deine Bestätigung.",
};
