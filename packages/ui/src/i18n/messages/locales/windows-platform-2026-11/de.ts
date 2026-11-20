import type { Catalogue } from "../../index.ts";

/** Windows variants of the sandbox PC, voice keys and platform terms, and Mac wording (de); merged into `../de.ts`. */
export const windowsPlatform202611: Partial<Catalogue> = {
  "blocks.details.runsNoHostSandbox":
    "auf diesem Computer, ohne Sandbox: Hier gibt es keine Sandbox für Befehle",
  "blocks.execHost.noHostSandbox":
    "Auf diesem Computer gibt es keine Sandbox für Befehle, daher läuft dieser Befehl nur ohne eine. Tippe {word}, um ihn diesmal auszuführen.",
  "blocks.execHost.mustTypeOnly": "Tippe {word}, um es zu erlauben.",
  "settings.uninstall.stopSandboxPc":
    "Der Dienst für den Sandbox-PC wird entfernt. Windows fragt einmal nach der Genehmigung eines Administrators.",
  "settings.computerUse.tcc.microphone.name": "Mikrofon",
  "settings.computerUse.tcc.microphone.why":
    "damit Psyche dich für Diktat und Besprechungsnotizen hören kann",
  "settings.sandbox.restart.reopen": "Beende Psyche und öffne es wieder.",
  "settings.sandbox.pc.title": "Sandbox-PC einschalten",
  "settings.sandbox.pc.body":
    "srt, Psyches leichtgewichtige Sandbox für Befehle, läuft nicht unter Windows. Stattdessen laufen Skripte, Befehlsserver und Connectoren, die Psyche erstellt, im Sandbox-PC: einem kleinen eigenen Linux-Computer ohne Zugriff auf deine Dateien. Schalte ihn unter Einstellungen → Sandbox-PC ein und prüfe danach erneut.",
  "settings.sandbox.pc.notReady.title": "Der Sandbox-PC ist noch nicht bereit",
  "settings.sandbox.pc.notReady.body":
    "Er ist eingeschaltet, läuft aber noch nicht, oder das Psyche darin ist veraltet. Starte oder aktualisiere ihn unter Einstellungen → Sandbox-PC und prüfe danach erneut.",
  "settings.sandbox.pc.ready":
    "Der Sandbox-PC ist eingeschaltet: Skripte, Befehlsserver und Connectoren, die Psyche erstellt, laufen darin.",
  "settings.sandbox.pc.open": "Einstellungen des Sandbox-PCs öffnen",
  "settings.sandbox.pc.where": "Er findet sich unter Einstellungen → Sandbox-PC.",
  "settings.devices.platform.windows": "Windows-PC",
  "settings.devices.nodeKind.winHelper": "Windows-Helper",
  "settings.devices.thisPcAdmin":
    "Dieser PC ist das Admin-Gerät. Ein anderes Admin-Gerät kann ihn hier widerrufen.",
  "settings.devices.presenceKey.windowsHello":
    "Windows-Hello-Schlüssel ({algorithm}), wie der Helper ihn meldet",
  "settings.devices.presenceKey.windowsHelloNoAlgorithm":
    "Windows-Hello-Schlüssel, wie der Helper ihn meldet",
  "settings.shortcut.reserved.windowsKey": "Windows (Kurzbefehle mit der Windows-Taste)",
  "settings.shortcut.reserved.windowMenu": "das Fenstermenü",
  "settings.shortcut.reserved.closeApp": "das Schließen von Apps",
  "settings.shortcut.reserved.taskManager": "Task-Manager",
  "settings.shortcut.reserved.startMenu": "das Startmenü",
  "settings.shortcut.reserved.securityScreen": "der Windows-Sicherheitsbildschirm",
  "settings.shortcut.key.Super": "Windows-Taste",
  "settings.shortcut.useDefault": "Standard verwenden",
  "settings.quickEntry.title": "Schnelleingabe",
  "settings.key.quickEntry.shortcut": "Kurzbefehl",
  "settings.quickEntry.shortcutHint":
    "Öffnet den Schnellchat aus jeder App. Solange du keine anderen Tasten wählst, nutzt Psyche {keys}, oder {fallback}, wenn eine andere App diese belegt.",
  "settings.voice.key.rightCtrl": "Rechte Strg-Taste",
  "settings.voice.key.rightAlt": "Rechte Alt-Taste",
  "settings.voice.key.rightShift": "Rechte Umschalttaste",
  "settings.voice.key.rightWin": "Rechte Windows-Taste",
  "settings.voice.key.capsLock": "Feststelltaste",
  "settings.voice.key.scrollLock": "Rollen-Taste",
  "settings.voice.key.pause": "Pause",
  "settings.voice.key.menu": "Menütaste",
  "settings.voice.key.insert": "Einfügen",
  "settings.voice.key.numLock": "Num-Taste",
  "settings.voice.key.other": "Eine andere Taste",
  "settings.voice.key.press": "Drücke eine Taste",
  "settings.voice.key.pressNow": "Drücke die Taste zum Halten…",
  "settings.voice.key.cantUse":
    "Diese Taste tippt Text, daher lässt sie sich nicht zum Sprechen halten. Probiere Rechte Strg, Feststelltaste, Pause, die Menütaste oder F13 bis F24.",
  "settings.voice.key.capsLockHint":
    "Die Feststelltaste behält ihren Ein- oder Aus-Zustand: Halten zum Sprechen ändert ihn nicht, und ein kurzes Tippen schaltet sie weiterhin um.",
  "settings.voice.key.altGrWarning":
    "Bei deinem Tastaturlayout ist die rechte Alt-Taste AltGr, mit der Zeichen wie @ oder € getippt werden. Wenn du sie zum Sprechen hältst, kann das beim Tippen dieser Zeichen stören; Rechte Strg ist sicherer.",
  "settings.voice.access.windowsWhy":
    "beobachtet die Taste, die du hältst, und tippt in die aktive App. Windows braucht dafür keine Berechtigung; Apps, die als Administrator laufen, bekommen diktierten Text nicht.",
  "settings.voice.model.title": "Sprachmodell",
  "settings.voice.model.usingHelper":
    "Diktat nutzt die Spracherkennung des Helpers. Das Sprachmodell transkribiert besser und läuft auf diesem Mac.",
  "settings.voice.model.download": "Lade das Sprachmodell ({mb} MB) für besseres Diktat herunter",
  "settings.voice.model.downloadHint":
    "Ein einmaliger Download vom whisper.cpp-Projekt, der vor der Nutzung geprüft wird. Audio verlässt diesen Mac nie.",
  "settings.voice.model.downloading":
    "Sprachmodell wird heruntergeladen: {received} von {total} MB",
  "settings.voice.model.ready": "Whisper ({model}) auf diesem Mac",
  "settings.voice.model.readyHint":
    "Diktate und Aufnahmen werden hier transkribiert; Audio verlässt den Mac nie.",
  "settings.voice.model.readyNotFirst":
    "Installiert. Deine Reihenfolge der Engines setzt eine andere Engine nach vorn, daher wird sie beim Diktieren gerade nicht verwendet.",
  "settings.voice.model.failed": "Der Download ist fehlgeschlagen: {reason}",
  "settings.voice.model.retry": "Erneut versuchen",
  "settings.voice.model.vcredist":
    "Das Sprachmodell braucht das Microsoft Visual C++ Redistributable. Installiere es und diktiere dann erneut.",
  "settings.voice.model.crashed":
    "Die Spracherkennung wurde unerwartet beendet; das Diktat nutzt den Helper, bis sie wieder startet.",
  "settings.sandboxPc.title": "Sandbox-PC einschalten",
  "settings.sandboxPc.explain":
    "{persona} bekommt einen kleinen privaten Linux-PC, der in Windows läuft. Aufgaben laufen dort statt auf deinem PC und sehen nur die Ordner, die du freigibst.",
  "settings.sandboxPc.oneTime":
    "Einmalige Einrichtung: Windows fragt einmal nach der Genehmigung eines Administrators, um einen Hintergrunddienst hinzuzufügen, der den PC betreibt. Danach lädt Psyche das PC-Image herunter ({download}, {disk} auf der Festplatte). Sonst braucht nichts einen Administrator.",
  "settings.sandboxPc.oneTimeNoSize":
    "Einmalige Einrichtung: Windows fragt einmal nach der Genehmigung eines Administrators, um einen Hintergrunddienst hinzuzufügen, der den PC betreibt. Danach lädt Psyche das PC-Image herunter. Sonst braucht nichts einen Administrator.",
  "settings.sandboxPc.turnOn": "Sandbox-PC einschalten",
  "settings.sandboxPc.cancelDownload": "Download abbrechen",
  "settings.sandboxPc.waitingAdmin": "Warte auf die Administrator-Abfrage…",
  "settings.sandboxPc.restarting": "Einrichtung wird abgeschlossen…",
  "settings.sandboxPc.downloading": "PC-Image wird heruntergeladen: {received} von {total}",
  "settings.sandboxPc.progressLabel": "Download des PC-Images",
  "settings.sandboxPc.ready": "Eingerichtet",
  "settings.sandboxPc.readyText": "Der Sandbox-PC ist eingerichtet. Version {version}.",
  "settings.sandboxPc.unsupported": "Der Sandbox-PC ist hier nicht verfügbar: {reason}.",
  "settings.sandboxPc.failed": "Der Sandbox-PC konnte nicht eingeschaltet werden: {reason}",
  "settings.sandboxPc.failedDid": "Sonst wurde nichts geändert. Du kannst es erneut versuchen.",
  "settings.sandboxPc.gb": "{value, number} GB",
  "settings.sandboxPc.mb": "{value, number} MB",
  "settings.sandboxPc.loadLabel": "Sandbox-PC",
  "settings.sandboxPc.onboarding": "Sandbox-PC",
  "settings.sandboxPc.onboardingHint":
    "Optional: ein privater Linux-PC für Aufgaben, die deine Dateien nicht berühren sollen. Du kannst ihn später in den Einstellungen einrichten.",
  "settings.sandboxPc.update.title": "Dienst des Sandbox-PCs aktualisieren",
  "settings.sandboxPc.update.explainCompatible":
    "Diese Psyche-Version bringt einen neueren Sandbox-PC-Dienst mit als der installierte. Der Sandbox-PC funktioniert weiter wie bisher.",
  "settings.sandboxPc.update.explainRequired":
    "Diese Psyche-Version kann den installierten Sandbox-PC-Dienst nicht nutzen. Der Sandbox-PC bleibt aus, bis du ihn aktualisierst.",
  "settings.sandboxPc.update.available": "Update verfügbar",
  "settings.sandboxPc.update.required": "Update nötig",
  "settings.sandboxPc.update.versions":
    "Installiert: {installed}. Diese Psyche-Version: {bundled}.",
  "settings.sandboxPc.update.oneStep":
    "Windows fragt einmal nach der Genehmigung eines Administrators. Ein laufender Sandbox-PC wird angehalten, während der Dienst ersetzt wird.",
  "settings.sandboxPc.update.button": "Dienst des Sandbox-PCs aktualisieren",
  "settings.sandboxPc.update.failed":
    "Der Dienst des Sandbox-PCs wurde nicht aktualisiert: {reason}",
  "settings.sandboxPc.update.failedDid":
    "Sonst wurde nichts geändert. Du kannst es erneut versuchen.",
  "settings.sandboxPc.controls.title": "Der Sandbox-PC",
  "settings.sandboxPc.controls.hint": "Einmal erstellen, dann hier starten und anhalten.",
  "settings.sandboxPc.controls.create": "Sandbox-PC erstellen",
  "settings.sandboxPc.controls.start": "Starten",
  "settings.sandboxPc.controls.stop": "Anhalten",
  "settings.sandboxPc.controls.resume": "Fortsetzen",
  "settings.sandboxPc.controls.working": "Läuft…",
  "settings.sandboxPc.controls.helperOffline":
    "Der Windows-Helper läuft nicht oder hat den Sandbox-PC noch nicht, daher lässt er sich nicht steuern. Starte den Helper unter Einstellungen → Geräte neu.",
  "settings.sandboxPc.controls.failed": "Das hat nicht funktioniert: {reason}",
  "settings.sandboxPc.controls.waitForImage": "Schalte es oben zuerst ein.",
  "settings.sandboxPc.snapshots.title": "Snapshots",
  "settings.sandboxPc.snapshots.hint":
    "Speichere die Festplatte des Sandbox-PCs, um später dorthin zurückzukehren. Zum Speichern oder Wiederherstellen muss er angehalten sein.",
  "settings.sandboxPc.snapshots.none": "Noch keine Snapshots.",
  "settings.sandboxPc.snapshots.save": "Snapshot speichern",
  "settings.sandboxPc.snapshots.saveFresh": "Als frischen PC speichern",
  "settings.sandboxPc.snapshots.reset": "Auf den frischen PC zurücksetzen",
  "settings.sandboxPc.snapshots.restore": "Wiederherstellen",
  "settings.sandboxPc.snapshots.delete": "Löschen",
  "settings.sandboxPc.snapshots.fresh": "Frischer PC",
  "settings.sandboxPc.snapshots.item": "{label}, {when}",
  "settings.sandboxPc.snapshots.stopFirst": "Halte zuerst den Sandbox-PC an.",
  "onboarding.connectors.windowsHint":
    "Unter Windows liest {name} deine E-Mails, Kalender und Kontakte über ein Microsoft-, Google- oder IMAP-Konto.",
  "web.about.windowsArm": "Arm64",
  "web.about.windowsX64": "x64",
  "web.about.windowsBuild": "Build {build}",
  "platform.term.os": "macOS",
  "platform.term.device": "Mac",
  "platform.term.thisDevice": "Dieser Mac",
  "platform.term.thisDeviceLower": "dieser Mac",
  "platform.term.presence": "Touch ID",
  "platform.term.secretStore": "Schlüsselbund",
  "platform.term.systemSettings": "Systemeinstellungen",
  "platform.term.fileManager": "Finder",
  "platform.term.trayArea": "Menüleiste",
  "platform.term.taskbar": "Dock",
  "platform.term.systemSearch": "Spotlight",
  "platform.term.helper": "Mac-Helper",
  "platform.term.terminal": "Terminal",
  "platform.term.alt": "Option",
  "platform.term.mod": "Command",
  "platform.macOnly": "Nur auf macOS verfügbar",
  "platform.macOnlyHint": "{name} braucht einen Mac. Psyche unter macOS kann es nutzen.",
  "platform.windows.access.title": "Windows-Zugriff",
  "platform.windows.access.hint": "Was Windows Psyche erlaubt und wofür es dich fragt.",
  "platform.windows.access.noPermission": "Keine Berechtigung nötig",
  "platform.windows.access.uiAutomation.name": "Apps verwenden",
  "platform.windows.access.uiAutomation.why":
    "{persona} liest und bedient App-Fenster über die Windows-UI-Automatisierung. Windows erlaubt nicht, Apps zu steuern, die als Administrator laufen.",
  "platform.windows.access.screen.name": "Bildschirmaufnahme",
  "platform.windows.access.screen.why":
    "Windows braucht keine Berechtigung, um den Bildschirm aufzunehmen. Psyches eigene Fenster und Passwortfelder sind in Aufnahmen ausgeblendet.",
  "platform.windows.access.microphone.name": "Mikrofon",
  "platform.windows.access.microphone.why":
    "Für Diktat und Besprechungsnotizen. Windows fragt unter Einstellungen → Datenschutz & Sicherheit → Mikrofon nach, mit aktivierter Option „Desktop-Apps den Zugriff auf das Mikrofon erlauben“.",
  "platform.windows.access.openSettings": "Einstellungen öffnen",
  "platform.windows.access.openSettingsFor": "Windows-Einstellungen für {name} öffnen",
  "platform.windows.access.state.granted": "An",
  "platform.windows.access.state.denied": "In den Windows-Einstellungen aus",
  "platform.windows.access.state.not_determined": "Noch nicht geprüft",
  "platform.helper.restart": "Helper neu starten",
  "platform.helper.restarting": "Wird neu gestartet…",
  "platform.helper.restartFailed": "Der Helper wurde nicht gestartet ({reason}).",
};
