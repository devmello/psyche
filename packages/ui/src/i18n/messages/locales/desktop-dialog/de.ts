import type { Catalogue } from "../../index.ts";

/** Native dialogs and notifications (de); merged into `../de.ts`. */
export const desktopDialog: Partial<Catalogue> = {
  "desktop.dialog.notificationsOn": "Mitteilungen sind aktiviert.",
  "desktop.dialog.anotherCopyTitle": "Eine andere Kopie von Psyche läuft bereits",
  "desktop.dialog.anotherCopyDetail":
    "Sie läuft aus {path}. Wenn du diese Kopie verwendest, wechselt Psyche zu dieser App; die andere Kopie verbindet sich dann mit dieser.",
  "desktop.dialog.keepOtherCopy": "Andere Kopie behalten",
  "desktop.dialog.useThisCopy": "Diese Kopie verwenden",
  "desktop.dialog.cancel": "Abbrechen",
  "desktop.dialog.ok": "OK",
  "desktop.dialog.shareFolderTitle": "Einen Ordner mit Psyche teilen",
  "desktop.dialog.share": "Teilen",
  "desktop.dialog.gatewaysFileTitle": "Psyche kann die gespeicherten Gateways nicht lesen",
  "desktop.dialog.gatewaysFileDetail":
    "{problem}. Psyche startet auf {os, select, macos {diesem Mac} windows {diesem PC} other {diesem Computer}} und lässt die Datei unverändert, damit keine angeheftete Identität verloren geht. Behebe das Problem oder entferne die Datei im Datenordner von Psyche, um das Gateway eines anderen Computers zu verwenden.",
  "desktop.dialog.stillRunningTitle": "Psyche läuft weiter",
  "desktop.dialog.stillRunningBody":
    "Aufgaben und Automatisierungen laufen weiter. Öffne Psyche über das Symbol im Infobereich; zum Beenden Rechtsklick darauf.",
  "desktop.dialog.manualStepsTitle": "Ein Schritt fehlt noch, um Psyche vollständig zu entfernen",
  "desktop.dialog.uninstallTitle": "Psyche deinstallieren?",
  "desktop.dialog.uninstall": "Deinstallieren",
  "desktop.dialog.uninstallAndDelete": "Daten löschen und deinstallieren",
  "desktop.dialog.uninstallItems":
    "{count, plural, one {# Element wird} other {# Elemente werden}} in den Papierkorb verschoben, einschließlich Psyche.app.",
  "desktop.dialog.uninstallDataFolder":
    "Dein Datenordner {folder} wird ebenfalls in den Papierkorb verschoben.",
  "desktop.dialog.uninstallDataKept": "Dein Datenordner bleibt erhalten.",
  "desktop.dialog.uninstallKeychain":
    "Die Schlüsselbund-Einträge, die Psyche speichert, werden entfernt.",
  "desktop.dialog.uninstallKeychainKept":
    "Schlüsselbund-Einträge bleiben; entferne sie in der Schlüsselbundverwaltung, falls du das willst.",
  "desktop.dialog.stopTitle":
    "Psyche auf {os, select, macos {diesem Mac} windows {diesem PC} other {diesem Computer}} beenden?",
  "desktop.dialog.stopDetail":
    "Seine Automatisierungen und geplanten Aufgaben stehen still, bis du zurückwechselst. Lass es laufen, damit sie weiterlaufen.",
  "desktop.dialog.stopButton":
    "Psyche auf {os, select, macos {diesem Mac} windows {diesem PC} other {diesem Computer}} beenden",
  "desktop.dialog.keepRunning": "Weiter laufen lassen",
  "desktop.dialog.forgetTitle": "{name} vergessen?",
  "desktop.dialog.forgetDetail":
    "{origin}\n\nDas entfernt den Schlüssel dieses Computers für diesen Gateway und alles, was Psyche hier dafür gespeichert hat. {name} listet diesen Computer weiterhin, bis ihn dort jemand entfernt.",
  "desktop.dialog.forgetButton": "Vergessen",
  "desktop.dialog.repairTitle": "Erneut mit {name} koppeln?",
  "desktop.dialog.repairDetail":
    "{origin}\n\nDas vergisst die Identität, die Psyche dafür angeheftet hat, und den Schlüssel dieses Computers. Die nächste Verbindung heftet an, was unter dieser Adresse antwortet, und fragt, ob als neuer Computer gekoppelt werden soll. Tu das nur, wenn du weißt, warum sich seine Identität geändert hat.",
  "desktop.dialog.repairButton": "Erneut koppeln",
  "desktop.dialog.claimTitle": "Psyche-Server unter {origin} einrichten?",
  "desktop.dialog.claimDetail":
    "Psyche prüft, ob der Server den Einrichtungscode kennt, den du eingegeben hast, bevor er ihm vertraut; der Server prüft, ob dieser Computer ihn kennt, bevor er ihn zum Admin macht. Fahre nur fort, wenn du diesen Server gerade selbst installiert hast.",
  "desktop.dialog.setUp": "Einrichten",
  "desktop.dialog.addLanTitle": "Ist {origin} ein Psyche in diesem Netzwerk?",
  "desktop.dialog.addLanDetail":
    "Name: {name}\n\nEin Psyche in diesem Netzwerk verwendet ein eigenes Zertifikat, das Psyche anheftet, statt dem System zu vertrauen: Es prüft Zertifikat und Schlüssel des Gateways bei der ersten Verbindung und lehnt später jeden anderen ab. Wähle „Einfaches https“ nur für einen Server mit einem gewöhnlichen Zertifikat (zum Beispiel ein Reverse-Proxy mit deiner eigenen CA). Nichts wird geteilt, bis sein Besitzer diesen Computer dort freigibt.",
  "desktop.dialog.psycheOnNetwork": "Psyche in diesem Netzwerk",
  "desktop.dialog.plainHttps": "Einfaches https",
  "desktop.dialog.addLinkTitleLan": "Psyche mit {origin} in diesem Netzwerk verbinden?",
  "desktop.dialog.addLinkTitle": "Psyche mit {origin} verbinden?",
  "desktop.dialog.addLinkDetail":
    "{external, select, yes {Dieser Link wurde von einer anderen App oder einer Website geöffnet, nicht von dir eingefügt. Fahre nur fort, wenn du ihn selbst auf {os, select, macos {dem Mac} windows {dem PC} other {dem Computer}} erstellt hast, auf dem Psyche läuft.\n\n} other {}}Psyche verbindet sich nur, wenn dieses Gateway diese Identität nachweist:\n{fingerprint}\n\n{lan, select, yes {Es verwendet ein eigenes Zertifikat, nicht eines, dem das System vertraut. Psyche hält es an dem fest, den dieser Link nennt ({pin}…), bevor etwas gesendet wird, und lehnt jedes andere ab. Fahre nur fort, wenn der Link von deinem eigenen {os, select, macos {Mac} windows {PC} other {Computer}} in diesem Netzwerk stammt.\n\n} other {}}Der einmalige Code des Links lässt dieses Gateway diesen Computer dann ohne erneute Nachfrage freigeben, mit dem Zugriff, den sein Besitzer beim Erstellen gewählt hat.",
  "desktop.dialog.addDetailKey":
    "Name: {name}\nAngekündigter Schlüssel: {key}…\n\nDieser Computer fragt dieses Gateway, ob er sich koppeln darf. Nichts wird geteilt, bis sein Besitzer diesen Computer dort freigibt, und Psyche heftet die Identität des Gateways bei der ersten Verbindung an.",
  "desktop.dialog.addDetailPlain":
    "Name: {name}\n\nDieser Computer fragt dieses Gateway, ob er sich koppeln darf. Nichts wird geteilt, bis sein Besitzer diesen Computer dort freigibt, und Psyche heftet die Identität des Gateways bei der ersten Verbindung an.",
  "desktop.dialog.addGatewayButton": "Gateway hinzufügen",
};
