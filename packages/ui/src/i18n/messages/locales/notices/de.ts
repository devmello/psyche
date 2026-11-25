import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (de); merged into `../de.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.install.failed.title": "Eine genehmigte Installation wurde nicht abgeschlossen",
  "notice.connectors.matrix.failed.title": "Eine Connector-Regel wurde nicht gespeichert",
  "notice.connectors.matrix.failed.body":
    "{action} für {connector} konnte nicht angewendet werden, daher gilt weiter die bisherige Regel. Prüfe sie unter Einstellungen › Konnektoren.",
  "notice.install.failed.body":
    "{reason, select, lost {Psyche wurde neu gestartet, bevor du genehmigt hast, daher ging der Vorschlag verloren. Schlage es erneut vor.} expired {Der Vorschlag war abgelaufen, bevor du genehmigt hast. Schlage es erneut vor.} other {Psyche konnte es nicht installieren. Schlage es erneut vor oder bitte Psyche darum.}}",
  "notice.security.changed.title":
    "Psyche hat eine Sicherheitsänderung rückgängig gemacht, die außerhalb der App erfolgte",
  "notice.security.changed.body":
    "Ein Programm auf diesem Mac hat {count, plural, =1 {# Sicherheitseintrag} other {# Sicherheitseinträge}} (Geräte, Schlüssel, Freigaben oder Einstellungen) geändert, ohne über Psyche zu gehen{times, plural, =0 {} =1 {} other {, bisher # Mal}}. Psyche hat sie wiederhergestellt. Wenn du das nicht warst, prüfe den Mac auf unerwünschte Software.",
  "notice.security.untrusted.title": "Psyche kann seinen Sicherheitsdaten nicht vertrauen",
  "notice.security.untrusted.body":
    "Die Prüfung von Psyches Sicherheitsdaten ist fehlgeschlagen. Sicherheitsänderungen, neue Geräte und Touch-ID-Freigaben sind deshalb gesperrt. Prüfe deine Geräte und führe dann auf dem Mac `psyched security reseal` aus (es gilt nach 24 Stunden).",
  "notice.security.firstSeal.title": "Psyche prüft jetzt seine Sicherheitsdaten",
  "notice.security.firstSeal.body":
    "Psyche hat {devices, plural, =1 {# gekoppeltes Gerät} other {# gekoppelte Geräte}} und seine Sicherheitseinstellungen versiegelt. Ab jetzt wird eine Änderung außerhalb von Psyche rückgängig gemacht und hier angezeigt. Prüfe deine Geräte einmal.",
  "notice.security.resealed.title":
    "{restored, select, yes {Sicherheitsdaten nach einer Wiederherstellung versiegelt} other {Sicherheitsdaten erneut versiegelt}}",
  "notice.security.resealed.body":
    "{restored, select, yes {Psyche wurde aus einem wiederhergestellten Backup gestartet und hat seine Sicherheitsdaten so versiegelt, wie sie sind. Wenn du kein Backup wiederhergestellt hast, prüfe deine Geräte.} other {Psyche hat seine Sicherheitsdaten nach der Wartezeit erneut versiegelt.}}",
  "notice.security.firstAdmin.title":
    "Ein Befehl auf diesem Mac hat das erste Admin-Gerät angelegt",
  "notice.security.firstAdmin.body":
    "{device}{key, select, none {} other { (Schlüssel {key})}} wurde auf diesem Mac {via, select, desktop {über die Psyche-App} other {über `psyched`}} das erste Admin-Gerät. Wenn du das nicht warst, widerrufe es unter Einstellungen → Geräte.",
  "notice.security.recovery.title":
    "{state, select, requested {Ein Befehl auf diesem Mac hat eine Sicherheitsänderung angefordert} applied {Eine Sicherheitsänderung von diesem Mac wurde angewendet} cancelled {Eine Sicherheitsänderung von diesem Mac wurde abgebrochen} other {Eine Sicherheitsänderung von diesem Mac konnte nicht angewendet werden}}",
  "notice.security.recovery.body":
    "{op, select, approve {Das Gerät {device}{key, select, none {} other { (Schlüssel {key})}} mit {scopes} freigeben.} grant {{device}{key, select, none {} other { (Schlüssel {key})}} {scopes} geben.} presence {Die Touch-ID- und Passkey-Pflicht für Sicherheitsänderungen ausschalten, bis ein neuer Schlüssel registriert ist.} seal {Die aktuellen Sicherheitsdaten so übernehmen, wie sie sind.} other {Eine Sicherheitsänderung.}}{state, select, requested { Sie gilt {when, select, none {in 24 Stunden} other {ab {when}}}, wenn du sie nicht in Psyche abbrichst.} failed {{reason, select, none {} other { {reason}}}} other {}}",
  "notice.browser.chrome.title": "Psyche steuert dein Chrome",
  "notice.browser.chrome.body":
    "Eine Aufgabe nutzt das Psyche-Chrome-Profil, in dem du angemeldet bist. Der Fenstertitel lautet „Psyche is driving this window“. Es schließt sich, wenn die Aufgabe fertig ist; du kannst Chrome auch beenden.",
  "notice.browser.takeover.title": "Psyche braucht dich im Browser",
  "notice.browser.takeover.body":
    "Auf {host} fragt der Agent: {reason}. Übernimm im Browserbereich die Steuerung und gib sie dann zurück.",
  "notice.connector.consent.title": "Verbindung mit Google abschließen",
  "notice.connector.consent.body":
    "Öffne diesen Link auf dem Computer, auf dem Psyche läuft, um den Zugriff zu erlauben: {url}",
  "notice.connector.changed.title": "Eine Verbindung hat sich geändert",
  "notice.connector.changed.body":
    "{reason, select, account_changed {Ein Connector meldet sich jetzt bei einem anderen Konto an. Arbeit, die ans alte Konto gebunden war, wurde gestoppt.} disconnected {Ein Connector wurde getrennt. Arbeit, die ihn brauchte, wurde gestoppt.} scope_changed {Ein Connector ist jetzt schreibgeschützt. Ausstehende Aktionen darüber wurden gestoppt.} other {Der Zugriff eines Connectors wurde widerrufen. Melde dich erneut an, um ihn weiter zu nutzen.}}",
  "notice.connector.reconnect.title": "Erneut verbinden",
  "notice.connector.reconnect.body":
    "Ein Connector hat den Zugriff verloren. Melde dich erneut an.",
  "notice.connector.syncFailing.title": "{name} wird nicht synchronisiert",
  "notice.connector.syncFailing.body":
    "{name} konnte mehrmals hintereinander nicht synchronisiert werden ({reason}). Psyche versucht es weiter. Prüfe es unter Einstellungen › Connectors.",
  "notice.connector.testingExpired.title": "Google hat dich abgemeldet",
  "notice.connector.testingExpired.body":
    "Google meldet dich nach 7 Tagen ab, solange die Psyche-OAuth-App im Testmodus ist. Veröffentliche die OAuth-App in Google Cloud, damit das aufhört, und verbinde Google dann unter Einstellungen › Connectors neu.",
  "notice.attention.paused.title": "Eine Aufgabe wartet auf dich",
  "notice.attention.paused.body":
    "Vor {tool} auf einer sensiblen App oder Website pausiert, bis du wieder in Psyche bist.",
  "notice.apiKey.changed.title":
    "{kind, select, brave {Der {provider}-Schlüssel wurde {action, select, changed {geändert} other {entfernt}}} other {Der {provider}-API-Schlüssel wurde {action, select, changed {geändert} other {entfernt}}}}",
  "notice.apiKey.changed.body":
    '{action, select, changed {Geändert} other {Entfernt}} von {device, select, none {einem Gerät} other {"{device}" ({platform}{paired, select, none {} other {, gekoppelt am {paired}}})}}. Wenn du das nicht warst, widerrufe das Gerät unter Einstellungen → Geräte.',
  "notice.approvals.digest.title":
    "{count, plural, =1 {# Aktion deiner Automationen wartet} other {# Aktionen deiner Automationen warten}}",
  "notice.approvals.digest.body": "Öffne Genehmigungen, um sie zu genehmigen oder abzulehnen",
  "notice.approvals.resumeMissed.title":
    "{automation, select, none {Eine genehmigte Aktion einer Automation wurde nicht ausgeführt} other {{automation}: Die genehmigte Aktion wurde nicht ausgeführt}}",
  "notice.approvals.resumeMissed.body":
    "{why, select, expired {Die Genehmigung ist abgelaufen, bevor die Automation die Aktion erreicht hat, also ist nichts passiert. Braucht sie sie noch, fragt sie erneut.} paused {Die Automation ist pausiert oder wurde entfernt, lief also nicht erneut, und es ist nichts passiert. Braucht sie sie noch, fragt sie erneut.} restart {Psyche wurde neu gestartet, bevor die Automation erneut laufen konnte, also ist nichts passiert. Braucht sie sie noch, fragt sie erneut.} restart_kept {Psyche wurde neu gestartet, bevor die Automation erneut laufen konnte. Deine Berechtigung bleibt bestehen, also tut ihr nächster Lauf das ohne Nachfrage. Zum Zurücknehmen widerrufe sie unter Dauerhafte Berechtigungen in Genehmigungen.} failed {Die Automation hat die Aktion erneut ausgeführt, aber sie ist fehlgeschlagen. Unter Aktivität siehst du, was schiefging. Braucht sie sie noch, fragt sie erneut.} failed_kept {Die Automation hat die Aktion erneut ausgeführt, aber sie ist fehlgeschlagen. Unter Aktivität siehst du, was schiefging. Deine Berechtigung bleibt bestehen, also versucht es ihr nächster Lauf ohne Nachfrage erneut. Zum Zurücknehmen widerrufe sie unter Dauerhafte Berechtigungen in Genehmigungen.} unknown {Die Automation hat die Aktion erneut ausgeführt, aber Psyche kann nicht erkennen, ob sie geklappt hat. Sieh unter Aktivität nach.} not_reached_kept {Die Automation lief erneut, hat aber nicht dieselbe Aktion erreicht, also ist nichts passiert. Deine Berechtigung bleibt bestehen, also tut ihr nächster Lauf das ohne Nachfrage. Zum Zurücknehmen widerrufe sie unter Dauerhafte Berechtigungen in Genehmigungen.} other {Die Automation lief erneut, hat aber nicht dieselbe Aktion erreicht, also ist nichts passiert. Braucht sie sie noch, fragt sie erneut.}}",
  "notice.specialist.result.title":
    "{outcome, select, done {{who} hat {title} fertiggestellt} partial {{who} hat bei {title} früh aufgehört} cancelled {{who} wurde bei {title} gestoppt} other {{who} konnte {title} nicht abschließen}}",
  "notice.specialist.result.body":
    "{outcome, select, done {Fertig} partial {Teilweise} cancelled {Abgebrochen} other {Fehlgeschlagen}}{findings, plural, =0 {} one { · # Befund} other { · # Befunde}}{cost, select, none {} other { · {cost}}} · {minutes, plural, =0 {unter 1 Min.} other {# Min.}}",
  "notice.mcp.changed.title": "MCP-Server {server} hat seine Werkzeuge geändert",
  "notice.mcp.suspicious.title": "MCP-Server {server} hat verdächtige Werkzeugbeschreibungen",
  "notice.mcp.review.body": "Prüfe das, bevor du diesen Server nutzt: {details}",
  "notice.security.tightened.title":
    "Sicherheitseinstellungen wurden verschärft von {device, select, none {einem Gerät} other {{device}}}",
  "notice.security.tightened.body":
    "Das hat nur eingeschränkt, was Psyche darf, deshalb war keine Freigabe nötig. Warst du das nicht, entferne das Gerät unter Einstellungen → Geräte.",
  "notice.codeRun.held.title":
    "Psyche hat Startkonfiguration aus einem Code-Lauf in {repo} zurückgehalten",
  "notice.codeRun.held.body":
    "Ein Befehl in der Sandbox hat {paths} angelegt. Apps oder dein nächster Befehl könnten daraus Code ausführen, deshalb hat Psyche es beiseitegelegt, ohne es zu löschen. Wenn du oder deine Werkzeuge es angelegt habt, tippe auf Behalten.",
  "notice.codeRun.changed.title":
    "Startkonfiguration hat sich während eines Code-Laufs in {repo} geändert",
  "notice.codeRun.changed.body":
    "{paths} hat sich geändert, während ein Befehl in der Sandbox lief. Warst das nicht du oder dein Editor, prüfe es, bevor du den Ordner öffnest.",
  "notice.codeRun.partial.title": "{repo} ist zu groß für eine vollständige Prüfung",
  "notice.codeRun.partial.body":
    "Psyche hat nur die oberen Ordner auf Startkonfiguration geprüft, die Code-Läufe anlegen.",
  "notice.codeRun.recreated.title": "Die Sandbox für {repo} wurde neu eingerichtet",
  "notice.codeRun.recreated.body":
    "Ihre schreibgeschützten Ordner haben sich geändert, daher sind laufende Server und alles, was außerhalb des Repositorys installiert war, weg. Starte neu, was du brauchst.",
  "notice.action.keepIt": "Behalten",
  "notice.codeRun.incident.title":
    "Psyche hat etwas zurückgehalten, das vielleicht nicht aus einem Code-Lauf in {repo} stammt",
  "notice.codeRun.incident.body":
    "Während {paths} beiseitegelegt wurde, hat sich ein Ordner auf dem Weg geändert, daher kann das Verschobene von woanders stammen. Es liegt in {place}. Sieh es dir an, bevor du auf Behalten tippst, das es nach {paths} in {repo} legt.",
  "notice.codeRun.unmoved.title":
    "Startkonfiguration aus einem Code-Lauf in {repo} ist noch vorhanden",
  "notice.codeRun.unmoved.body":
    "Ein Befehl in der Sandbox hat {paths} angelegt, und Psyche konnte es nicht beiseitelegen, es ist also nicht zurückgehalten. Apps oder dein nächster Befehl könnten daraus Code ausführen. Lösche es, bevor du den Ordner öffnest oder dort etwas ausführst. Ändere nicht zuerst seine Berechtigungen, um hineinzusehen, denn dadurch kann es ausgeführt werden.",
  "notice.codeRun.unchecked.title":
    "Psyche konnte nach einem Code-Lauf einen Teil von {repo} nicht prüfen",
  "notice.codeRun.unchecked.body":
    "{paths} hat sich geändert, während Psyche es nach einem Befehl in der Sandbox geprüft hat, deshalb wurde darin nichts auf Startkonfiguration geprüft. Wenn weder du noch deine Tools es geändert haben, sieh es dir an, bevor du den Ordner öffnest oder dort etwas ausführst.",
  "notice.machine.added.title": "{name} wurde als Computer hinzugefügt, den Psyche nutzen kann",
  "notice.machine.added.body":
    "Psyche kann dort Bildschirm, Apps, Shell und Dateien nutzen, und jede Aktion fragt zuerst bei dir nach. Wenn du ihn nicht hinzugefügt hast, entferne ihn unter Einstellungen → Geräte.",
  "notice.machine.removed.title": "{name} hat sich selbst entfernt",
  "notice.machine.removed.body":
    "Es war ein Computer, den Psyche nutzen konnte. Psyche nutzt ihn nicht wieder, solange du ihn nicht erneut hinzufügst.",
  "notice.machine.scanIncomplete.title":
    "{folder} auf {name} konnte nach einem Befehl nicht vollständig geprüft werden",
  "notice.machine.scanIncomplete.body":
    "Neue Repositorys oder Startdateien dort wurden womöglich nicht beiseitegelegt. Prüfe den Ordner auf neue .git- oder .vscode-Ordner, bevor du ihn in einem Editor öffnest oder dort git ausführst. Befehle können dort erst wieder schreiben, wenn Psyche auf {name} neu startet.",
  "notice.machine.offline.title": "{name} ist offline",
  "notice.machine.offline.body":
    "Eine Aufgabe wartet darauf, ihn zu nutzen, und läuft weiter, sobald {name} wieder da ist. Du kannst die Aufgabe auch abbrechen.",
  "notice.automation.needsApproval.title": "{title} wartet auf deine Freigabe",
  "notice.automation.needsApproval.body":
    "Es wurde angehalten, weil die Freigabe abgelaufen ist. Öffne die Freigaben, um zu sehen, was es braucht, und starte es dann erneut.",
  "notice.automation.interrupted.title": "{title} wurde unterbrochen",
  "notice.automation.interrupted.body":
    "Psyche wurde neu gestartet, während es lief, und hat vielleicht einen Teil schon erledigt. Prüfe das Ergebnis und starte es bei Bedarf erneut.",
  "notice.promise.due.title": "Ein Versprechen ist bald fällig",
  "notice.promise.due.body": "Öffne Psyche, um zu sehen, welches.",
};
