import type { Catalogue } from "../../index.ts";

/** Computers Psyche can use (de); merged into `../de.ts`. */
export const machines: Partial<Catalogue> = {
  "machines.title": "Computer, die Psyche nutzen kann",
  "machines.description":
    "Linux-Computer, die du gekoppelt hast, damit Psyche dort Apps, Befehle und Dateien nutzen kann, während du diesen weiter benutzt.",
  "machines.empty":
    "Gib Psyche einen Linux-Computer zum Arbeiten, damit es dort Apps, Befehle und Dateien nutzen kann, während du diesen weiter benutzt.",
  "machines.add": "Linux-Computer hinzufügen",
  "machines.add.description":
    "Psyche arbeitet auf diesem Computer, während du diesen weiter benutzt. Aktionen dort folgen deinen Freigabe-Einstellungen.",
  "machines.add.account": "Welches Konto soll Psyche dort verwenden?",
  "machines.add.account.own": "Dein Konto (empfohlen)",
  "machines.add.account.ownHint":
    "Psyche kann dort deine Dateien, Apps und Anmeldungen nutzen, so wie du. Root bekommt es nie.",
  "machines.add.account.dedicated": "Ein eigenes Konto namens psyche",
  "machines.add.account.dedicatedHint":
    "Psyche sieht nur die Dateien und Apps dieses Kontos. Es hat kein sudo und kein Passwort.",
  "machines.add.needsNetwork":
    "Andere Computer können diesen noch nicht erreichen. Schalte zuerst den Fernzugriff oder den Zugriff im lokalen Netzwerk unter Einstellungen → Geräte & Server ein.",
  "machines.add.make": "Befehle anzeigen",
  "machines.add.again": "Neue Befehle erstellen",
  "machines.add.commands": "Befehle für den Linux-Computer",
  "machines.add.installStep": "1. Installiere den Helfer auf dem Linux-Computer",
  "machines.add.pairStep": "2. Starte dort die Kopplung",
  "machines.add.expires": "Der Link funktioniert einmal und läuft {when} ab.",
  "machines.add.waiting": "Warte, bis sich der Computer koppelt …",
  "machines.add.paired": "{name} ist gekoppelt. Psyche kann es jetzt nutzen.",
  "machines.add.pairedToast": "{name} wurde hinzugefügt",
  "machines.add.done": "Fertig",
  "machines.copy": "Kopieren",
  "machines.status.online": "Online",
  "machines.status.offline": "Offline",
  "machines.status.degraded": "Braucht Aufmerksamkeit",
  "machines.display.headless": "Privater Bildschirm",
  "machines.display.desktopSession": "Eigener Desktop",
  "machines.display.container": "Container",
  "machines.thisComputer": "Dieser Computer",
  "machines.watch": "Ansehen",
  "machines.watchNamed": "{name} ansehen",
  "machines.apps": "App-Zugriff",
  "machines.appsNamed": "App-Zugriff auf {name}",
  "machines.folders": "Ordner",
  "machines.foldersNamed": "Ordner auf {name}",
  "machines.rename.action": "Umbenennen",
  "machines.rename.named": "{name} umbenennen",
  "machines.rename.label": "Neuer Name für {name}",
  "machines.rename.save": "Sichern",
  "machines.rename.cancel": "Abbrechen",
  "machines.remove": "Entfernen",
  "machines.removeTitle": "{name} entfernen?",
  "machines.removeDescription":
    "Psyche nutzt {name} sofort nicht mehr und die Kopplung wird widerrufen. Um es wieder zu nutzen, koppelst du es neu.",
  "machines.err.nameTaken":
    "Ein anderer Computer hat diesen Namen bereits oder er ist reserviert. Wähle einen anderen.",
  "machines.err.nameInvalid":
    "Dieser Name ist nicht möglich. Verwende normale Buchstaben, Ziffern und Satzzeichen, höchstens 64 Zeichen, und mische keine ähnlich aussehenden Buchstaben.",
  "machines.err.forbidden": "Umbenennen braucht ein Admin-Gerät. Versuche es von einem aus erneut.",
  "machines.err.failed": "Das hat nicht geklappt ({reason}). Nichts wurde geändert.",
  "machines.account.own":
    "Läuft unter deinem eigenen Konto auf {name}. Psyche kann dort deine Dateien, Apps und Anmeldungen nutzen, so wie du. Würde dein Psyche je kompromittiert, könnte es auch ein Angreifer, außer für root, das Psyche nie bekommt.",
  "machines.account.dedicated":
    "Läuft unter einem eigenen Konto auf {name}. Psyche sieht nur die Dateien und Apps dieses Kontos.",
  "machines.account.useSeparate": "Stattdessen ein eigenes Konto verwenden …",
  "machines.account.useSeparateHint":
    "Führe auf {name} das Installationsprogramm noch einmal mit der Option für ein eigenes Konto aus und koppele es dann neu:",
  "machines.shell.contained": "Befehle laufen in einer abgeschotteten Shell",
  "machines.shell.full": "Befehle laufen in der vollen Konto-Shell",
  "machines.shell.off": "Befehle sind aus",
  "machines.limits.folders":
    "{count, plural, =0 {Keine Ordner freigegeben} one {# Ordner freigegeben} other {# Ordner freigegeben}}",
  "machines.helperVersion": "Helfer {version}",
  "machines.helperVersionUnknown": "Helferversion unbekannt",
  "machines.update": "Ein neuerer Helfer ist verfügbar. Aktualisiere den Helfer auf {name}:",
  "machines.warnings": "Warnungen für {name}",
  "machines.warn.fullShell":
    "Volle Konto-Shell. Befehle sind nicht abgeschottet und erreichen alles, was dieses Konto erreicht.",
  "machines.warn.userLimits":
    "Die Grenzen gehören dem Benutzer. Jedes Programm mit diesem Konto kann ändern, was Psyche auf {name} darf.",
  "machines.warn.sudo":
    "Dieses Konto hat sudo ohne Passwort. Psyche kann hier kein sudo nutzen, andere Programme, die du mit diesem Konto startest, aber schon.",
  "machines.paired": "Gekoppelt {when}",
  "machines.line": "Auf „{name}“ · Linux · {place}",
  "machines.place.screen": "privater Bildschirm",
  "machines.place.desktop": "sein Desktop",
  "machines.place.command": "Befehl",
  "machines.place.files": "Dateien",
  "machines.step.on": "{label} auf {name}",
  "machines.picker.title": "Computer",
  "machines.picker.description":
    "Wähle, für welchen Computer diese Einstellungen gelten und wo Psyche arbeitet, wenn du keinen bestimmten beobachtest.",
  "machines.picker.show": "App-Zugriff anzeigen für",
  "machines.picker.default": "Standardcomputer für Hintergrundarbeit",
  "machines.picker.defaultHint":
    "Aufgaben und Automationen laufen dort, sofern sie keinen Computer nennen. Wähle einen Linux-Computer, damit Psyche dort drüben arbeitet, während du hier arbeitest.",
  "machines.picker.appsOn": "Apps auf {name}",
  "machines.picker.appsHint":
    "Psyche gleicht diese mit {name} ab und geht nie über die eigenen Grenzen dieses Computers hinaus.",
  "machines.picker.noApps":
    "Psyche hat auf {name} noch keine Apps gesehen. Sie erscheinen hier, sobald es welche gesehen hat.",
  "machines.picker.offline":
    "{name} ist offline. Änderungen kommen an, sobald es sich wieder verbindet.",
  "computerWatch.titleMachine": "{name} · privater Bildschirm",
  "computerWatch.machineOffline": "{name} ist nicht erreichbar. Neuer Versuch …",
  "computerWatch.empty.bodyMachine":
    "Wenn der Agent einen Bildschirm auf {name} braucht, kannst du ihm hier zusehen.",
  "notice.machine.working.title": "Psyche arbeitet auf {name}",
  "notice.machine.working.body":
    "Es nutzt Bildschirm, Apps oder Dateien dieses Computers. Sieh zu unter Einstellungen → Geräte.",
  "notice.machine.offline.title": "{name} ist offline gegangen",
  "notice.machine.offline.body":
    "Psyche kann es nicht nutzen, bis es sich wieder verbindet. Aufgaben, die es brauchen, warten auf dich.",
  "machines.add.linkStep": "3. Wenn nach dem Link gefragt wird, füge diesen ein",
  "machines.add.installSource":
    "Hole das Helfer-Paket von {url}, entpacke es und führe dann dies auf dem Linux-Computer aus.",
  "machines.reports": "{name} meldet:",
  "computerWatch.machineLoading": "Computer wird geladen …",
  "computerWatch.machineMissing": "Dieser Computer ist nicht verfügbar.",
  "settings.key.computerUse.defaultMachine": "Standardcomputer für Hintergrundarbeit",
  "settings.key.computerUse.machineApps": "App-Zugriff auf einem Linux-Computer",
  "machines.card.folder": "Ordner",
  "machines.card.runsContained":
    "abgeschirmt, nur im freigegebenen Ordner: keine Schlüssel, Browserprofile oder anderen Ordner",
  "machines.card.runsFullAccount": "mit dem vollen Konto: es kann alles, was dieses Konto kann",
  "machines.card.networkOff": "aus",
  "machines.card.networkOn": "an",
  "machines.card.folderReadOnly": "{path}, nur lesen",
  "machines.card.folderReadWrite": "{path}, lesen und schreiben",
  "machines.card.folderNotEnforced":
    "{path}, „nur lesen“ wird mit dem vollen Konto nicht durchgesetzt",
};
