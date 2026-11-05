import type { Catalogue } from "../../index.ts";

/** Completed web strings (de); merged into `../de.ts`. */
export const webRest: Partial<Catalogue> = {
  "web.remotePresence.title": "Touch ID für Genehmigungen",
  "web.remotePresence.description":
    "Käufe, Passwort-Eingaben, Host-Befehle und Sicherheitsänderungen brauchen Touch ID. Richte es auf diesem Computer ein, um sie hier zu beantworten; bis dahin sagen diese Karten, dass du auf {host} antworten sollst. Normale Genehmigungen brauchen es nie.",
  "web.remotePresence.on": "Touch ID ist für Genehmigungen von diesem Computer aus an.",
  "web.remotePresence.off": "Touch ID ist auf diesem Computer nicht eingerichtet.",
  "web.remotePresence.enable": "Touch ID für Genehmigungen auf diesem Computer verwenden",
  "web.remotePresence.disable": "Ausschalten",
  "web.remotePresence.waiting": "Warten auf Touch ID …",
  "web.remotePresence.passkeyName": "Touch ID auf diesem Computer",
  "web.remotePresence.enabled": "Touch ID ist für Genehmigungen von diesem Computer aus an.",
  "web.remotePresence.disabled": "Touch ID für Genehmigungen ist auf diesem Computer aus.",
  "web.remotePresence.approveOnHost":
    "Genehmige „Passkey hinzufügen“ auf {host} mit Touch ID oder einem Passkey und drücke dann die Schaltfläche erneut.",
  "web.remotePresence.unavailable":
    "Touch ID braucht das Gateway von {host} unter einer https://-Adresse (gateway.publicOrigin). Bis dahin beantworte diese Karten auf {host}.",
  "web.touchId.helperDidNotStart":
    "Psyche Helper hat sich nicht verbunden. Öffne Einstellungen → Geräte, um den Grund zu sehen, und versuche es dann erneut.",
  "web.panes.title.sidechat": "Nebenchat",
  "web.sideChat.about": "Nebenchat zu {parent}",
  "web.sideChat.aside": "Nebenchat",
  "web.sideChat.expand": "Erweitern",
  "web.sideChat.expandTitle": "Diesen Chat im Vollbild öffnen",
  "web.terminal.ended": "Sitzung beendet",
  "web.terminal.waitingApproval": "Warten auf deine Genehmigung …",
  "web.terminal.approvalDenied": "Das Terminal wurde nicht genehmigt.",
  "web.terminal.approvalTimedOut":
    "Die Genehmigung kam nicht rechtzeitig. Öffne das Terminal erneut.",
  "web.terminal.openOnHost": "Öffne das Terminal auf {host}.",
  "web.terminal.limit":
    "Auf {host} sind zu viele Terminals offen. Schließe eines, um ein weiteres zu öffnen.",
  "web.approval.folderNone": "Kein Ordner gewählt",
  "web.approval.folderChoose": "Ordner wählen …",
  "web.approval.messageText": "Nachrichtentext, vor dem Senden bearbeitbar",
  "web.approval.messageWeak": "SMS/RCS: schwache Identität, prüfen",
  "web.approval.messageUntrusted":
    "Dieser Empfänger wurde von Inhalten vorgeschlagen, die Psyche gelesen hat, nicht von dir. Prüfe ihn vor dem Senden.",
  "web.approval.folderPath": "Ordnerpfad",
  "web.approval.folderPickTitle": "Einen Ordner teilen",
  "web.browser.stay.question": "Bei {site} angemeldet bleiben?",
  "web.browser.stay.detail":
    "Psyche behält diese Anmeldung in seinem Browserprofil, damit Aufgaben sie nutzen können. Jede andere Website bleibt abgemeldet.",
  "web.browser.stay.yes": "Angemeldet bleiben",
  "web.browser.prompt.notNow": "Nicht jetzt",
  "web.browser.vault.question": "Anmeldedaten im Tresor von Psyche sichern?",
  "web.browser.vault.account": "{username} bei {origin}",
  "web.browser.vault.passwordLabel": "Passwort",
  "web.browser.vault.save": "Anmeldedaten sichern",
  "web.browser.vault.never": "Für diese Website nie",
  "web.browser.vault.error":
    "Die Anmeldedaten konnten nicht gesichert werden ({code}). Entsperre den Tresor und versuche es erneut.",
  "web.chat.autoUnavailable":
    "Auto ist nicht verfügbar: {model} steht nicht auf der Auto-Modus-Zulassungsliste. Wähle ein anderes Modell, um es zu nutzen.",
  "web.toast.threadUpdateFailed": "Psyche konnte diese Chat-Einstellung nicht ändern.",
  "web.splash.remote.finding": "{host} wird gesucht …",
  "web.splash.remote.checking": "Es wird geprüft, ob es wirklich {host} ist …",
  "web.splash.remote.waiting": "Warten auf Genehmigung auf {host} …",
  "web.splash.remote.pairCode": "Kopplungscode {code}",
  "web.splash.remote.pairKey": "Gateway-Schlüssel {fingerprint}",
  "web.splash.remote.pairHint":
    "Vergleiche beides mit der Anfrage unter Einstellungen → Geräte auf {host} und genehmige sie dort.",
  "web.splash.remote.pairHintLan":
    "Vergleiche den ganzen Schlüssel mit dem unter Einstellungen → Geräte auf {host}, bei der Anfrage dieses Computers. In einem Netzwerk ist der Schlüssel der einzige Beweis dafür, wer geantwortet hat. Genehmige nur, wenn sie übereinstimmen.",
  "web.splash.remote.unreachable": "{host} antwortet nicht.",
  "web.splash.remote.unreachableReason":
    "Möglicherweise schläft er oder ist aus, Psyche läuft dort nicht, oder Tailscale ist auf diesem Computer aus. Psyche versucht es weiter.",
  "web.splash.remote.identity": "Das ist nicht der {host}, mit dem du gekoppelt bist.",
  "web.splash.remote.identityChanged":
    "Sein Identitätsschlüssel ist nicht der, den dieser Computer festgelegt hat. Möglicherweise antwortet eine andere Maschine an seiner Stelle, oder er wurde neu eingerichtet.",
  "web.splash.remote.identityMissing":
    "Er hat keinen Identitätsschlüssel vorgelegt, daher verbindet sich Psyche nicht.",
  "web.splash.remote.identityInvalid":
    "Sein Identitätsnachweis war nicht stimmig, daher verbindet sich Psyche nicht.",
  "web.splash.remote.identityOrigin":
    "Er hat für eine andere Adresse geantwortet als die, die dieser Computer gewählt hat. Lege auf {host} die öffentliche Adresse unter Einstellungen → Geräte → Server & Fernzugriff fest.",
  "web.splash.remote.certChanged":
    "Sein Netzwerkzertifikat ist nicht das, das dieser Computer festgelegt hat. Möglicherweise antwortet eine andere Maschine in diesem Netzwerk an seiner Stelle, oder sein Zertifikat wurde ersetzt.",
  "web.splash.remote.certMissing":
    "Er hat das verwendete Zertifikat nicht bestätigt, daher verbindet sich Psyche nicht.",
  "web.splash.remote.certInvalid":
    "Sein Nachweis für das verwendete Zertifikat war nicht stimmig, daher verbindet sich Psyche nicht.",
  "web.splash.remote.olderHost": "Auf {host} läuft ein älteres Psyche.",
  "web.splash.remote.olderHostReason":
    "Aktualisiere Psyche auf {host} und versuche es dann erneut.",
  "web.splash.remote.olderApp": "Diese App ist älter als {host}.",
  "web.splash.remote.olderAppReason":
    "Aktualisiere Psyche auf diesem Computer und versuche es dann erneut.",
  "web.splash.remote.revoked": "Dieser Computer wurde von {host} entfernt.",
  "web.splash.remote.revokedReason":
    "Koppele erneut, um {host} von hier zu nutzen, oder vergiss ihn.",
  "web.splash.remote.tokenRefused": "{host} hat diesen Kopplungslink abgelehnt.",
  "web.splash.remote.tokenRefusedReason":
    "Er wurde bereits verwendet, ist abgelaufen oder wurde widerrufen. Erstelle auf {host} einen neuen und füge ihn erneut hinzu.",
  "web.splash.remote.switch": "Gateway wechseln",
  "web.splash.remote.useThisMac": "Diesen Mac verwenden",
  "web.splash.remote.pairAgain": "Vergessen und erneut koppeln",
  "web.splash.remote.forget": "{host} vergessen",
  "web.splash.remote.close": "Ausblenden",
  "web.remote.connectedTo": "Mit {host} verbunden",
  "web.remote.switch": "Wechseln …",
  "web.remote.thisMac": "Dieser Mac",
  "web.remote.menuLabel": "Gateway",
  "web.remote.switcherLabel": "Mit {host} verbunden. Gateway wechseln.",
  "web.remote.manage": "Gateways …",
  "web.panes.title.terminalOn": "Terminal auf {host}",
  "web.panes.terminalRemote":
    "Das Terminal läuft auf {host}. Dieses Fenster hat dort noch keine Shell.",
  "web.splash.remote.pinsUnreadable": "Psyche kann seine gespeicherten Gateways nicht lesen.",
  "web.splash.remote.pinsUnreadableReason":
    "Die Datei, die sich die Identität jedes Gateways merkt, lässt sich nicht lesen, daher verbindet sich Psyche ohne sie nicht. Es wurde nichts geändert.",
  "web.browser.remote": "Der Browser läuft auf {host}.",
  "web.browser.remoteHint":
    "Browseraufgaben laufen weiter in Psyche auf {host}, das dort geöffnet sein muss.",
  "web.teach.record": "Aufnehmen",
  "web.teach.recordHint": "Psyche zeigen, wie etwas in diesem Tab geht",
  "web.teach.agentTab": "Der Agent nutzt diesen Tab. Öffne einen eigenen Tab zum Aufnehmen.",
  "web.teach.startFailed": "Psyche konnte die Aufnahme dieses Tabs nicht starten.",
  "web.teach.bar.title": "Aufnahme",
  "web.teach.bar.body":
    "Psyche notiert deine Klicks und Eingaben nur in diesem Tab. Passwörter, Kartennummern und Codes werden nie aufgezeichnet, und nichts verlässt diesen Mac, bis du sicherst.",
  "web.teach.bar.steps": "Bisher {count, plural, one {# Schritt} other {# Schritte}}",
  "web.teach.bar.stop": "Aufnahme beenden",
  "web.teach.bar.cancel": "Verwerfen",
  "web.teach.bar.endedLimit":
    "Die Aufnahme wurde beim Limit von 200 Schritten beendet. Prüfe, was erfasst wurde.",
  "web.teach.bar.endedInterrupted":
    "Die Aufnahme endete vorzeitig, weil sich der Tab geändert hat oder geschlossen wurde. Prüfe, was erfasst wurde.",
  "web.teach.bar.review": "Prüfen",
  "web.teach.stopFailed": "Psyche konnte die Aufnahme nicht abschließen.",
  "web.teach.nothingRecorded": "Es wurde nichts aufgenommen.",
  "web.teach.review.keepUnavailable":
    "Nicht verfügbar: Der Schlüsselbund dieses Macs steht nicht zur Verfügung, um eine behaltene Aufnahme zu verschlüsseln.",
  "web.teach.kept.title": "Behaltene Aufnahmen",
  "web.teach.kept.open": "Öffnen",
  "web.teach.kept.delete": "Löschen",
  "web.teach.kept.deleted": "Aufnahme gelöscht.",
  "web.teach.kept.failed": "Psyche konnte diese Aufnahme nicht öffnen.",
  "web.teach.review.title": "Prüfen, was du gezeigt hast",
  "web.teach.review.intro":
    "Das sind die Schritte, die Psyche erfasst hat, in einfachen Worten. Korrigiere, ordne um oder entferne sie. Nichts wird gesichert, bis du „Sichern“ drückst.",
  "web.teach.review.name": "Wie soll das heißen?",
  "web.teach.review.namePlaceholder": "Den wöchentlichen Abrechnungsbericht exportieren",
  "web.teach.review.skipped":
    "{count, plural, one {Die Seite hat sich während der Aufnahme # Mal selbst geändert. Das bleibt unberücksichtigt.} other {Die Seite hat sich während der Aufnahme # Mal selbst geändert. Das bleibt unberücksichtigt.}}",
  "web.teach.review.steps": "Schritte",
  "web.teach.review.stepNumber": "Schritt {n}",
  "web.teach.review.moveUp": "Schritt {n} nach oben",
  "web.teach.review.moveDown": "Schritt {n} nach unten",
  "web.teach.review.remove": "Schritt {n} entfernen",
  "web.teach.review.empty": "Alle Schritte wurden entfernt. Brich ab oder nimm erneut auf.",
  "web.teach.review.sensitive":
    "Nicht aufgenommen. Psyche gibt dir den Tab, damit du diesen Teil selbst erledigst.",
  "web.teach.review.value": "Was eingegeben werden soll",
  "web.teach.review.value.ask": "Jedes Mal nachfragen",
  "web.teach.review.value.keep": "Diesen Wert behalten",
  "web.teach.review.value.input": "Zu einer Eingabe machen",
  "web.teach.review.valueHidden":
    "Das Beispiel, das du eingegeben hast, ist verborgen und wird nicht gesichert.",
  "web.teach.review.valueKept": "Mit dem Skill gesichert: {value}",
  "web.teach.review.inputName": "Name der Eingabe",
  "web.teach.review.inputDescription": "Was es ist",
  "web.teach.review.inputDescriptionPlaceholder": "Der erste Tag der Woche",
  "web.teach.review.keepRecording":
    "Diese Aufnahme auf diesem Mac behalten, damit ich eine weitere Version erstellen kann",
  "web.teach.review.keepRecordingHint":
    "Behalten werden nur die obigen Schritte mit den Werten, die du behalten wolltest. Sonst wird die Aufnahme beim Sichern gelöscht.",
  "web.teach.review.save": "Als Skill sichern",
  "web.teach.review.saving": "Wird gesichert",
  "web.teach.review.discard": "Aufnahme verwerfen",
  "web.teach.review.privacy":
    "Seitentext in diesen Schritten wird als Daten behandelt, nie als Anweisungen. Beim Sichern musst du den Skill genehmigen, bevor er laufen kann.",
  "web.teach.review.issues": "Behebe zuerst: {problems}",
  "web.teach.review.needName": "Gib zuerst einen Namen ein.",
  "web.teach.review.saveFailed": "Psyche konnte das nicht als Skill sichern: {reason}",
  "web.teach.done.title": "Gesichert",
  "web.teach.done.body":
    "„{title}“ wartet auf deine Genehmigung. Lies die Karte und genehmige sie dann, um den Skill zu installieren.",
  "web.teach.done.installed": "„{title}“ ist installiert.",
  "web.teach.done.run": "Jetzt einmal ausführen",
  "web.teach.done.runHint":
    "Füllt das Nachrichtenfeld mit dem Skill. Drücke „Senden“ und beobachte dann den Browser: Jeder Klick und jede Eingabe fragt wie gewohnt nach Genehmigung, und er hält an und fragt, wenn sich die Seite geändert hat.",
  "web.teach.done.close": "Schließen",
  "web.teach.step.navigate": "{address} öffnen",
  "web.teach.step.click": "Auf „{name}“ klicken",
  "web.teach.step.clickRole": "Auf {role} klicken",
  "web.teach.step.type": "In „{name}“ eingeben",
  "web.teach.step.typeKept": "{value} in „{name}“ eingeben",
  "web.teach.step.typeInput": "{input} in „{name}“ eingeben",
  "web.teach.step.typeAsk": "Das, was du angibst, in „{name}“ eingeben",
  "web.teach.step.typeSensitive": "Du tippst selbst in „{name}“",
  "web.teach.step.typeUnnamed": "ein Feld",
  "web.teach.step.select": "Eine Option in „{name}“ wählen",
  "web.teach.step.selectKept": "{value} in „{name}“ wählen",
  "web.teach.step.selectInput": "{input} in „{name}“ wählen",
  "web.teach.step.selectAsk": "Das, was du angibst, in „{name}“ wählen",
  "web.teach.step.selectSensitive": "Du wählst selbst in „{name}“",
  "web.teach.step.press": "{key} drücken",
  "web.teach.step.pressIn": "{key} in „{name}“ drücken",
};
