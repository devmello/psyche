import type { Catalogue } from "../../index.ts";

/** Completed blocks strings (de); merged into `../de.ts`. */
export const blocksRest: Partial<Catalogue> = {
  "blocks.lifeAnswer.label": "Antwort aus deinen Mails, Nachrichten und Dateien",
  "blocks.message.receipt":
    "{status, select, approved {Erlaubt{scope, select, task { für diese Aufgabe} site { für diese Website} session { für diese Sitzung} always { immer} other { einmal}}} denied {Abgelehnt} expired {Abgelaufen} invalidated {Ungültig} other {{status}}}: {summary}",
  "blocks.message.showDetails": "Details",
  "blocks.message.hideDetails": "Details ausblenden",
  "blocks.message.showDetailsOf": "Details zu {summary} anzeigen",
  "blocks.message.hideDetailsOf": "Details zu {summary} ausblenden",
  "blocks.details.requestedFolder": "Angefragt",
  "blocks.details.folderReason": "Warum",
  "blocks.details.folderAccess": "Zugriff",
  "blocks.details.folderAccess.ro": "Nur lesen",
  "blocks.details.folderAccess.rw": "Lesen und schreiben",
  "blocks.folder.title": "Ordner zum Teilen",
  "blocks.folder.choose": "Ordner wählen …",
  "blocks.folder.change": "Anderen Ordner wählen …",
  "blocks.folder.blocked":
    "{path} kann nicht geteilt werden: Er enthält private Daten oder ist ein Systemordner. Wähle einen anderen Ordner.",
  "blocks.folder.notFound":
    "Psyche hat unter {path} keinen Ordner gefunden. Wähle den Ordner zum Teilen.",
  "blocks.folder.pickTitle": "Einen Ordner mit {persona} teilen",
  "blocks.folder.pickError": "Die Ordnerauswahl konnte nicht geöffnet werden: {error}",
  "blocks.folder.pathLabel": "Ordnerpfad",
  "blocks.folder.mustPick": "Wähle den Ordner zum Teilen, bevor du erlaubst.",
  "blocks.folder.scope":
    "„Nur dieser Chat“ gilt, bis die Unterhaltung endet. „Immer“ behält den Ordner, bis du ihn unter Einstellungen → Berechtigungen → Zugriff entfernst.",
  "blocks.folder.scope.once": "Nur dieser Chat",
  "blocks.folder.scope.always": "Immer, dieser Ordner und darunter",
  "blocks.folder.explain.ro": "{persona} möchte die Dateien in einem Ordner lesen.",
  "blocks.folder.explain.rw": "{persona} möchte die Dateien in einem Ordner lesen und ändern.",
  "blocks.folder.readOnly": "Nur lesen lassen, nichts ändern",
  "blocks.message.to": "Senden an",
  "blocks.message.pick": "Empfänger wählen",
  "blocks.message.group": "Gruppenchat · {count, plural, one {# Person} other {# Personen}}",
  "blocks.message.weak":
    "SMS oder RCS: Der Mobilfunkanbieter bürgt für diese Nummer, nicht Apple. Prüfe sie.",
  "blocks.message.service.imessage": "iMessage",
  "blocks.message.service.sms": "SMS",
  "blocks.message.service.rcs": "RCS",
  "blocks.message.service.unknown": "Unbekannter Dienst",
  "blocks.message.text": "Nachricht",
  "blocks.message.textLabel": "Nachrichtentext, vor dem Senden bearbeitbar",
  "blocks.message.exact": "Genau dieser Text geht an genau diesen Empfänger.",
  "blocks.message.empty": "Schreibe etwas, das gesendet werden soll.",
  "blocks.message.untrusted":
    "Dieser Empfänger wurde von Inhalten vorgeschlagen, die Psyche gelesen hat, nicht von dir. Prüfe, wer es ist, bevor du sendest.",
  "blocks.folder.exact": "Nur dieser Ordner und sein Inhalt werden geteilt.",
  "blocks.details.executable": "Programm",
  "blocks.details.network": "Netzwerk",
  "blocks.details.networkNone": "keins",
  "blocks.details.runsSandboxed":
    "auf deinem Mac, in der Sandbox: Sie kann weder den Tresor von Psyche noch deine SSH-Schlüssel, Schlüsselbunde oder Browserprofile lesen",
  "blocks.details.runsNoSandbox":
    "auf deinem Mac, und die Sandbox ist nicht eingerichtet ({reason})",
  "blocks.details.needed": "Benötigt",
  "blocks.details.neededWhy": "Warum",
  "blocks.execHost.sandboxed":
    "Läuft in der Sandbox. Um genau diesen Befehl ohne sie auszuführen, gib unten {word} ein.",
  "blocks.execHost.noSandbox":
    "Die Sandbox ist nicht eingerichtet, daher kann dieser Befehl nur ohne sie laufen. Richte sie ein oder gib {word} ein, um ihn dieses eine Mal ohne Sandbox auszuführen.",
  "blocks.execHost.setUp": "Sandbox einrichten",
  "blocks.execHost.typeLabel": "Gib {word} ein, um ohne Sandbox auszuführen",
  "blocks.execHost.unsandboxedOnce": "Ohne Sandbox gibt es nur „Einmal erlauben“.",
  "blocks.execHost.mustType": "Gib {word} ein, um zu erlauben, oder richte zuerst die Sandbox ein.",
  "blocks.permission.need.capability": "„Befehle auf diesem Mac ausführen“ aktivieren",
  "blocks.permission.need.connector_action":
    "{connector} vor „{group}“ bei dir nachfragen lassen (derzeit auf „Ablehnen“ gesetzt)",
  "blocks.permission.need.connector": "{connector} verbinden",
  "blocks.permission.need.macos_access":
    "{connector} Zugriff in den macOS-Systemeinstellungen geben",
  "blocks.permission.need.sandbox": "Sandbox für Befehle einrichten",
  "blocks.permission.need.folder": "Ein Ordner: {path}",
  "blocks.permission.enableHint":
    "„Aktivieren“ ändert deine Einstellungen, bis du es in den Einstellungen wieder ausschaltest. Jede Aktion fragt weiterhin nach.",
  "blocks.permission.checkHint":
    "Behebe es und wähle dann „Erneut prüfen“: Psyche prüft und meldet es im Chat.",
  "blocks.permission.enable": "Aktivieren",
  "blocks.permission.checkAgain": "Erneut prüfen",
  "blocks.permission.openConnectors": "Verbindungen öffnen",
  "blocks.permission.openSystemSettings": "Systemeinstellungen öffnen",
  "blocks.permission.setUpSandbox": "Sandbox einrichten",
  "blocks.approval.scope.prepNotes": "Immer für Vorbereitungsnotizen",
  "blocks.liftFloor.title": "Ohne Nachfragen erlauben?",
  "blocks.liftFloor.what": "{persona} darf {what}, ohne zu fragen.",
  "blocks.liftFloor.consequence.destructive":
    "Gelöschte Elemente lassen sich womöglich nicht wiederherstellen.",
  "blocks.liftFloor.consequence.send":
    "Nachrichten und E-Mails gehen in deinem Namen raus und lassen sich nicht zurückholen.",
  "blocks.liftFloor.consequence.financial":
    "Ausgegebenes Geld und getätigte Zahlungen sind womöglich nicht erstattbar.",
  "blocks.liftFloor.still":
    "{persona} fragt trotzdem nach, nachdem nicht vertrauenswürdige Inhalte gelesen wurden, und im manuellen Modus jedes Mal. Das kannst du in den Einstellungen ändern.",
  "blocks.liftFloor.confirm": "Ohne Nachfragen erlauben",
  "blocks.liftFloor.cardWhat": "dies erneut tun ({summary})",
  "blocks.approval.taintSentence":
    "Zuvor in diesem Chat hat {persona} {what}{onlyOnce, select, true {, daher gibt es nur „Einmal erlauben“} other {}}.",
  "blocks.approval.taintRead": "{list} gelesen",
  "blocks.approval.taintUsed": "{list} verwendet",
  "blocks.approval.taintOther":
    "{first, select, true {nicht vertrauenswürdige Inhalte gelesen} other {weitere nicht vertrauenswürdige Inhalte}}",
  "blocks.approval.taintTranscript": "ein Transkript",
  "blocks.approval.taintAnd": "{head} und {last}",
  "blocks.approval.taintDetails": "Quellen der Verunreinigung",
  "blocks.approval.allowScope": "Erlauben für",
  "blocks.approval.sideEffect.none": "sieht nur nach",
  "blocks.approval.sideEffect.read": "liest Informationen",
  "blocks.approval.sideEffect.write": "ändert etwas",
  "blocks.approval.sideEffect.destructive":
    "ändert Einstellungen oder Daten, was sich schwer rückgängig machen lässt",
  "blocks.approval.sideEffect.financial": "betrifft Geld",
  "blocks.approval.whyMode": "Im Modus „{mode}“ wird nachgefragt, bevor es {effect}.",
  "blocks.details.params": "Details",
  "blocks.details.reason": "Grund",
  "blocks.approval.answerOnHost":
    "Antworte auf {host} oder richte unter Einstellungen → Geräte Touch ID für Genehmigungen auf diesem Computer ein.",
  "blocks.approval.rateLimited":
    "Zu viele Versuche in einer Minute. Versuche es in {seconds} s erneut.",
  "blocks.approval.touchIdFailed": "Touch ID fehlgeschlagen: {reason}. Versuche es erneut.",
  "blocks.approval.touchIdFailedNoReason": "Touch ID fehlgeschlagen. Versuche es erneut.",
  "blocks.approval.touchIdInvalid": "Psyche konnte nicht bestätigen, dass du es warst",
  "blocks.approval.touchId.helperOffline":
    "Psyche Helper läuft nicht, daher kann Touch ID das hier nicht bestätigen.",
  "blocks.approval.touchId.helperOutdated":
    "Dieser Psyche Helper ist zu alt, um Genehmigungen aus diesem Fenster zu bestätigen. Aktualisiere Psyche und versuche es erneut.",
  "blocks.approval.touchId.noKey":
    "Touch ID ist für Genehmigungen auf diesem Mac noch nicht eingerichtet. Richte es unter Einstellungen → Geräte ein, wo du den Schlüssel vorher prüfen kannst.",
  "blocks.approval.touchId.invalidated":
    "Touch ID hat sich geändert, seit der Schlüssel dieses Macs eingerichtet wurde, daher kann er keine Genehmigungen bestätigen. Richte ihn unter Einstellungen → Geräte neu ein.",
  "blocks.approval.touchId.noUnsandboxed":
    "Ein Befehl ohne Sandbox lässt sich aus diesem Fenster nicht per Touch ID genehmigen. Richte stattdessen die Sandbox ein",
  "blocks.approval.touchId.openDevices": "Einstellungen → Geräte öffnen",
  "blocks.approval.touchId.code": "Code {code}",
  "blocks.approval.touchId.onceOnly":
    "Touch-ID-Genehmigungen aus diesem Fenster gelten nur einmal.",
  "blocks.approval.status.allowedOnceTouchId":
    "Einmal erlaubt (Touch-ID-Genehmigungen aus diesem Fenster gelten nur einmal)",
  "blocks.approval.touchId.keyUnavailable":
    "Dieser Build von Psyche Helper kann keinen Touch-ID-Schlüssel speichern (er hat keine Schlüsselbund-Zugriffsgruppe), daher lassen sich Karten, die Touch ID brauchen, auf diesem Mac nicht genehmigen.",
  "blocks.approval.touchId.restartHelper": "Psyche Helper neu starten",
  "blocks.approval.touchId.startHelper": "Psyche Helper starten",
  "blocks.question.answerLine": "↳ {answer}",
  "blocks.sources.label": "Quellen",
  "blocks.sources.open": "{title} öffnen",
  "blocks.sources.untitled": "Ohne Titel",
  "blocks.sources.show": "Quelle anzeigen",
  "blocks.sources.hide": "Quelle ausblenden",
  "blocks.sources.untrusted":
    "Von jemand anderem. Wird als Daten behandelt, nicht als Anweisungen.",
  "blocks.sources.kind.mail": "Mail",
  "blocks.sources.kind.messages": "Nachrichten",
  "blocks.sources.kind.notes": "Notizen",
  "blocks.sources.kind.calendar": "Kalender",
  "blocks.sources.kind.library": "Mediathek",
  "blocks.sources.kind.other": "{source}",
  "blocks.appLink.open": "{where} öffnen",
  "blocks.appLink.settings": "Einstellungen: {section}",
  "blocks.markdown.taskDone": "Erledigt",
  "blocks.markdown.taskOpen": "Nicht erledigt",
  "blocks.workflow.label": "Diesen Workflow planen",
  "blocks.workflow.title": "„{title}“ planen?",
  "blocks.workflow.runs": "{count, plural, one {# geplanter Lauf} other {# geplante Läufe}}",
  "blocks.workflow.runOf": "{name} · {when} ({timezone})",
  "blocks.workflow.does": "Was er tut",
  "blocks.workflow.approvals": "Bittet dich um Genehmigung für",
  "blocks.workflow.noApprovals": "Keine Genehmigungen nötig.",
  "blocks.workflow.notify":
    "{how, select, messages {Sagt dir in Nachrichten Bescheid} both {Sagt dir per Mitteilung und in Nachrichten Bescheid} other {Sagt dir per Mitteilung Bescheid}}, wenn er dich braucht.",
  "blocks.workflow.obstacles": "Gut zu wissen",
  "blocks.workflow.tainted":
    "Das wurde geplant, nachdem Inhalte aus dem Web oder von einer Verbindung gelesen wurden. Prüfe die Schritte, bevor du planst.",
  "blocks.workflow.skillOffer": "Ich kann diese Schritte danach auch als Skill speichern.",
  "blocks.workflow.confirm": "Planen",
  "blocks.workflow.decline": "Nicht jetzt",
  "blocks.workflow.scheduling": "Wird geplant …",
  "blocks.workflow.done":
    "{count, plural, one {# Lauf} other {# Läufe}} geplant. Du findest sie unter „Aufgaben“.",
  "blocks.workflow.declined": "Nicht geplant.",
  "blocks.workflow.failed":
    "Das konnte nicht geplant werden. Prüfe die Zeiten und versuche es erneut.",
  "blocks.details.skillAction": "Aktion",
  "blocks.details.skillActionValue":
    "{action, select, update {Einen von {persona} erstellten Skill ändern} delete {Einen von {persona} erstellten Skill löschen} other {Einen neuen, von {persona} geschriebenen Skill hinzufügen}}",
  "blocks.details.name": "Name",
  "blocks.details.skillText": "Anweisungen",
  "blocks.details.skillTextView": "Gesamten Text anzeigen",
  "blocks.details.connector.runtime": "Läuft",
  "blocks.details.connector.runtimeValue":
    "{persona} hat diesen Connector geschrieben (Version {version})",
  "blocks.details.connector.command": "Befehl",
  "blocks.details.connector.network": "Möchte erreichen",
  "blocks.details.connector.networkNone": "Kein Netzwerk",
  "blocks.details.connector.tools": "Tools",
  "blocks.details.connector.files": "Code ({n} Dateien)",
  "blocks.details.connector.file": "{path} ({bytes} Bytes)",
  "blocks.details.connector.provided": "von Psyche bereitgestellt",
  "blocks.details.connector.diff": "Änderungen seit Version {version}",
  "blocks.details.connector.suggested":
    "{persona} schlägt diesen Connector aus dem Verzeichnis vor",
};
