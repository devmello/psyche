import type { Catalogue } from "../../index.ts";

/** Signed connector bundles and teach-by-showing in Mac apps (de); merged into `../de.ts`. */
export const final202611: Partial<Catalogue> = {
  "settings.connectorBundle.title": "Geteilter Connector {name}",
  "settings.connectorBundle.intro":
    "Jemand hat diesen Connector als Datei geteilt. Es ist noch nichts installiert. Prüfe, wer ihn erstellt hat und was er anfordert, und entscheide dann.",
  "settings.connectorBundle.update": "Das ist ein Update für den Connector, den du hast.",
  "settings.connectorBundle.signer.title": "Wer ihn erstellt hat",
  "settings.connectorBundle.signer.unsigned":
    "Diese Datei ist nicht signiert, daher lässt sich nicht feststellen, wer sie erstellt hat.",
  "settings.connectorBundle.signer.dropped":
    "Die installierte Version war signiert. Diese hier nicht.",
  "settings.connectorBundle.signer.new":
    "Signiert von {name}. Du hast diesen Schlüssel noch nie gesehen.",
  "settings.connectorBundle.signer.seen":
    "Signiert von {name}, mit einem Schlüssel, den du schon gesehen, dem du aber nicht vertraust.",
  "settings.connectorBundle.signer.trusted":
    "Signiert von {name}, einer Autorin oder einem Autor, der du vertraust.",
  "settings.connectorBundle.signer.own": "Von dir signiert.",
  "settings.connectorBundle.signer.changed":
    "Signiert von {name}, aber nicht mit dem zuvor gesehenen Schlüssel. Prüfe, ob es dieselbe Person ist.",
  "settings.connectorBundle.signer.impersonates":
    "Unter einem Namen signiert, der deinem ähnelt, mit einem Schlüssel, der nicht deiner ist.",
  "settings.connectorBundle.signer.nameChanged":
    "Ein Schlüssel, dem du vertraust, signiert unter einem Namen, den er zuvor nicht verwendet hat: {name}.",
  "settings.connectorBundle.signer.revoked":
    "Mit einem Schlüssel signiert, den du widerrufen hast.",
  "settings.connectorBundle.signer.rotated":
    "Signiert von {name}: dieselbe Person, neuer Schlüssel (vom alten Schlüssel signiert). Dem neuen Schlüssel wird nicht vertraut, bis du ihm vertraust.",
  "settings.connectorBundle.signer.claim":
    "Der Name ist die eigene Angabe des Autors. Nur der Schlüssel identifiziert ihn.",
  "settings.connectorBundle.signer.key": "Autorenschlüssel",
  "settings.connectorBundle.signer.trust": "{name} als Autor vertrauen",
  "settings.connectorBundle.signer.trustHint":
    "Das ändert nur die Kennzeichnung und die Warnungen bei späteren Dateien. Diese Karte wird dadurch nie übersprungen.",
  "settings.connectorBundle.command": "Befehl, den er ausführt",
  "settings.connectorBundle.commandHint":
    "Zuerst das Programm, dann jedes Argument in einer eigenen Zeile. Der Befehl läuft nicht über eine Shell.",
  "settings.connectorBundle.network": "Netzwerk, das er anfordert",
  "settings.connectorBundle.noNetwork": "Kein Netzwerk",
  "settings.connectorBundle.networkHint":
    "Nur die Sandbox kann das durchsetzen. Die Liste ist, was der Autor angibt.",
  "settings.connectorBundle.env": "Variablen, die er liest",
  "settings.connectorBundle.noEnv": "Keine",
  "settings.connectorBundle.envHint": "Nur Namen. Die Werte gibst du nach der Installation an.",
  "settings.connectorBundle.secrets": "Geheimnisse, die er braucht",
  "settings.connectorBundle.noSecrets": "Keine",
  "settings.connectorBundle.secretsHint":
    "Nur Namen. Die Datei enthält kein Geheimnis. Nach der Installation gibst du jedem einen Wert, und er wird in deinem Tresor aufbewahrt.",
  "settings.connectorBundle.tools": "Tools, die der Autor angibt",
  "settings.connectorBundle.toolsCount": "{n, plural, one {# Tool} other {# Tools}}",
  "settings.connectorBundle.toolsHint":
    "Psyche startet ihn in der Sandbox und listet auf, was er wirklich anbietet. Diese Tools zählen.",
  "settings.connectorBundle.toolsUndeclared":
    "Der Server hat Tools aufgelistet, die die Datei nicht angegeben hat: {names}",
  "settings.connectorBundle.toolsMissing":
    "Die Datei hat Tools angegeben, die der Server nicht aufgelistet hat: {names}",
  "settings.connectorBundle.files": "Mitgelieferte Skripte ({n})",
  "settings.connectorBundle.file": "{path} · {bytes} B",
  "settings.connectorBundle.fileBinary": "Kein Text, daher kann er hier nicht angezeigt werden.",
  "settings.connectorBundle.findings": "Was die Prüfungen gefunden haben",
  "settings.connectorBundle.finding.high": "Verhindert die Installation: {message}",
  "settings.connectorBundle.finding.warn": "Prüfen: {message}",
  "settings.connectorBundle.finding.info": "{message}",
  "settings.connectorBundle.sandbox.srt":
    "Der erste Start erfolgt in der Sandbox. Psyche startet ihn dort, um seine Tools aufzulisten, und er läuft dort weiter.",
  "settings.connectorBundle.sandbox.container":
    "Der erste Start erfolgt in einem Sandbox-Container. Psyche startet ihn dort, um seine Tools aufzulisten, und er läuft dort weiter.",
  "settings.connectorBundle.sandbox.none":
    "Dieser Mac hat keine Sandbox für Befehls-Connectors, und Psyche führt nie einen außerhalb davon aus. Dieser Connector kann hier nicht installiert werden. Es wurde nichts gestartet oder gespeichert.",
  "settings.connectorBundle.blocker.scan":
    "Die Prüfungen haben etwas gefunden, das die Installation verhindert. Es wurde nichts gestartet oder gespeichert.",
  "settings.connectorBundle.blocker.probe_failed":
    "Der erste Start ohne Netzwerk und ohne Geheimnisse konnte ihn nicht starten. Es wurde nichts gespeichert.",
  "settings.connectorBundle.signer.ownRetired":
    "Mit einem deiner Schlüssel signiert, den du ersetzt hast. Er gilt nicht mehr als deiner.",
  "settings.connectorBundle.signer.retired":
    "Signiert von {name}, mit einem Schlüssel, der durch eine Rotation ersetzt wurde, die du gesehen hast. Eine neue Datei davon ist verdächtig.",
  "settings.connectorBundle.carry.kept": "Werte, die du angegeben hast und die bleiben: {names}",
  "settings.connectorBundle.carry.cleared":
    "Werte, die du angegeben hast und die nicht übernommen werden, weil sich der Signierende oder der Befehl geändert hat. Gib sie erneut ein: {names}",
  "settings.connectorBundle.carry.vault":
    "Geheimnisse, die du zuvor gespeichert hast, bleiben in deinem Tresor, werden dieser Version aber nicht übergeben.",
  "settings.connectorBundle.reset.title": "Falls die Liste geteilter Connectors beschädigt ist",
  "settings.connectorBundle.reset.hint":
    "Connectors, die aus einer Datei stammen, bleiben aus, solange ihr Eintrag nicht gelesen werden kann. Das legt den beschädigten Eintrag beiseite (und stellt die letzte gute Kopie wieder her, falls es eine gibt). Diese Connectors bleiben aus, bis du sie entfernst oder erneut importierst.",
  "settings.connectorBundle.reset.go": "Eintrag zurücksetzen …",
  "settings.connectorBundle.reset.confirm": "Ja, zurücksetzen",
  "settings.connectorBundle.reset.done":
    "Der Eintrag wurde zurückgesetzt. {restored, select, true {Die letzte gute Kopie wurde wiederhergestellt.} other {Er beginnt leer.}}",
  "settings.connectorBundle.reset.failed":
    "Der Eintrag konnte nicht zurückgesetzt werden: {reason}",
  "settings.connectorBundle.hash": "Bundle-ID",
  "settings.connectorBundle.close": "Schließen",
  "settings.connectorBundle.widened.title": "Fordert mehr an als die Version, die du hast",
  "settings.connectorBundle.widened.hint":
    "Wenn du diese Karte bestätigst, bekommt er das alles. Eine Karte für die engere Version hätte es nicht abgedeckt.",
  "settings.connectorBundle.widened.command": "Ein anderer Befehl",
  "settings.connectorBundle.widened.commandValue": "Jetzt {now}. Vorher: {before}",
  "settings.connectorBundle.widened.env": "Mehr Variablen",
  "settings.connectorBundle.widened.secrets": "Mehr Geheimnisse",
  "settings.connectorBundle.widened.network": "Mehr Netzwerk",
  "settings.connectorBundle.widened.tools": "Mehr Tools oder Tools mit mehr Fähigkeiten",
  "settings.connectorBundle.widened.payload": "Andere Skripte",
  "settings.connectorBundle.widened.payloadValue": "Die mitgelieferten Dateien haben sich geändert",
  "settings.connectorBundle.diff": "Was sich geändert hat",
  "settings.connectorBundle.noChanges": "Sonst hat sich nichts geändert.",
  "settings.connectorBundle.import.title": "Geteilte Connectors",
  "settings.connectorBundle.import.hint":
    "Importiere einen Connector, den dir jemand als Datei oder Link geschickt hat. Du siehst alles, was er anfordert, bevor etwas installiert wird.",
  "settings.connectorBundle.import.file": "Connector-Datei importieren",
  "settings.connectorBundle.import.linkLabel": "Oder einen Link dazu einfügen",
  "settings.connectorBundle.import.linkPlaceholder": "https://example.com/notes.psyche-connector",
  "settings.connectorBundle.import.review": "Prüfen",
  "settings.connectorBundle.import.checking": "Wird geprüft …",
  "settings.connectorBundle.import.failed":
    "Der Connector konnte nicht importiert werden: {reason}",
  "settings.connectorBundle.import.tooBig": "Diese Datei ist zu groß für einen Connector.",
  "settings.connectorBundle.import.denied": "{name} wurde nicht installiert.",
  "settings.connectorBundle.import.lapsed":
    "{expired, select, true {Die Karte für {name} ist abgelaufen.} other {Die Karte für {name} gilt nicht mehr.}} Importiere ihn erneut, um ihn zu prüfen.",
  "settings.connectorBundle.import.added":
    "{name} wurde hinzugefügt. Gib ihm unten die Geheimnisse, die er braucht, dann kann er sie verwenden.",
  "settings.connectorBundle.import.addedNoSecrets": "{name} wurde hinzugefügt.",
  "settings.connectorBundle.import.addFailed": "{name} konnte nicht hinzugefügt werden: {reason}",
  "settings.connectorBundle.import.secretsTitle": "Geheimnisse für {name}",
  "settings.connectorBundle.share.title": "Diesen Connector teilen",
  "settings.connectorBundle.share.hint":
    "Erstellt eine signierte Datei mit dem Befehl, den Namen seiner Variablen und Geheimnisse, dem Netzwerk, das er erreicht, und seinen Tools. Es wird nie ein Wert mitgegeben. Du bestätigst vorher, was hineinkommt.",
  "settings.connectorBundle.share.go": "Teilen …",
  "settings.connectorBundle.share.nameLabel": "Dein Name bei geteilten Connectors",
  "settings.connectorBundle.share.nameHint":
    "Alle, die eine Datei von dir importieren, sehen diesen Namen. Er wird einmal abgefragt; dein Signaturschlüssel wird jetzt erstellt.",
  "settings.connectorBundle.share.make": "Datei erstellen",
  "settings.connectorBundle.share.label": "{name} teilen",
  "settings.connectorBundle.share.done":
    "{file} gespeichert, signiert als {author}. Sie enthält nur Namen: keinen Variablen- oder Geheimniswert.",
  "settings.connectorBundle.share.failed": "Der Connector konnte nicht geteilt werden: {reason}",
  "settings.connectorBundle.share.unavailable":
    "Nur Psyche auf dem Mac, auf dem er läuft, kann einen Connector signieren.",
  "settings.skills.signer.ownRetired":
    "Mit einem deiner Schlüssel signiert, den du ersetzt hast. Er gilt nicht mehr als deiner.",
  "settings.skills.signer.retired":
    "Signiert von {name}, mit einem Schlüssel, der durch eine Rotation ersetzt wurde, die du gesehen hast. Eine neue Datei davon ist verdächtig.",
  "settings.skills.signer.rotated":
    "Signiert von {name}: dieselbe Person, neuer Schlüssel (vom alten Schlüssel signiert). Dem neuen Schlüssel wird nicht vertraut, bis du ihm vertraust.",
  "settings.skills.author.state.seen": "Gesehen, nicht vertraut",
  "settings.skills.author.state.trusted": "Vertraut",
  "settings.skills.author.state.revoked": "Widerrufen",
  "settings.skills.keys.title": "Dein Autorenschlüssel und Hinweise",
  "settings.skills.keys.hint":
    "Der Schlüssel, der die Skills und Connectors signiert, die du teilst. Du kannst ihn ersetzen und einen Hinweis veröffentlichen, wenn einem Schlüssel oder einer Datei nicht mehr vertraut werden soll.",
  "settings.skills.keys.none":
    "Du hast noch nichts signiert. Dein Schlüssel wird erstellt, wenn du zum ersten Mal einen Skill oder einen Connector teilst.",
  "settings.skills.keys.own": "Signiert als {name}",
  "settings.skills.keys.fingerprint": "Schlüssel",
  "settings.skills.keys.rotate": "Meinen Schlüssel ersetzen …",
  "settings.skills.keys.rotateHint":
    "Erstellt einen neuen Schlüssel unter demselben Namen. Der alte Schlüssel signiert eine Erklärung, die den neuen nennt, damit Leute, die dir vertraut haben, dieselbe Person mit einem neuen Schlüssel sehen. Sie müssen ihm trotzdem selbst vertrauen. Du bestätigst vorher.",
  "settings.skills.keys.rotateLabel": "Deinen Autorenschlüssel ersetzen",
  "settings.skills.keys.rotated": "Dein Schlüssel wurde ersetzt. Der neue Schlüssel ist {key}.",
  "settings.skills.keys.rotateFailed": "Der Schlüssel konnte nicht ersetzt werden: {reason}",
  "settings.skills.keys.notice.title": "Hinweis veröffentlichen",
  "settings.skills.keys.notice.hint":
    "Ein Hinweis ist eine kleine signierte Datei. Schick sie oder stell sie online; alle, die deinen Schlüssel kennen, können sie importieren, um einen Schlüssel oder eine Datei zu sperren.",
  "settings.skills.keys.notice.kindKey": "Mein Schlüssel (der aktuelle)",
  "settings.skills.keys.notice.kindBundle": "Eine Datei, die ich geteilt habe, per Bundle-ID",
  "settings.skills.keys.notice.kind": "Was ist schlecht",
  "settings.skills.keys.notice.hash": "Bundle-ID (sha256:…)",
  "settings.skills.keys.notice.reason": "Warum (alle, die ihn importieren, sehen das)",
  "settings.skills.keys.notice.make": "Hinweis erstellen",
  "settings.skills.keys.notice.label": "Widerrufshinweis signieren",
  "settings.skills.keys.notice.done": "{file} gespeichert. Veröffentliche ihn, wie du möchtest.",
  "settings.skills.keys.notice.failed": "Der Hinweis konnte nicht erstellt werden: {reason}",
  "settings.skills.keys.import.title": "Widerrufshinweis importieren",
  "settings.skills.keys.import.hint":
    "Wird nur angewendet, wenn er von einer Autorin oder einem Autor signiert ist, den du kennengelernt hast. Er kann nur sperren: Er vertraut nie etwas.",
  "settings.skills.keys.import.file": "Hinweisdatei importieren",
  "settings.skills.keys.import.linkLabel": "Oder einen Link einfügen",
  "settings.skills.keys.import.linkPlaceholder": "https://example.com/revoke.psyche-notice",
  "settings.skills.keys.import.go": "Importieren",
  "settings.skills.keys.import.key": "Schlüssel {key} gesperrt. Angegebener Grund: {reason}",
  "settings.skills.keys.import.bundle": "Datei {hash} gesperrt. Angegebener Grund: {reason}",
  "settings.skills.keys.import.previewKey":
    "Damit wird der Schlüssel {key} widerrufen{names, select, none {} other { (bekannt als {names})}}. Grund laut Signierendem: {reason}",
  "settings.skills.keys.import.previewBundle":
    "Damit wird die Datei {hash} gesperrt. Grund laut Signierendem: {reason}",
  "settings.skills.keys.import.already": "Er ist bereits wirksam.",
  "settings.skills.keys.import.apply": "Anwenden",
  "settings.skills.keys.import.signedBy": "Signiert von {name}.",
  "settings.skills.keys.import.failed": "Der Hinweis konnte nicht verwendet werden: {reason}",
  "web.teach.app.record": "In einer App aufnehmen",
  "web.teach.app.recordHint":
    "Psyche zeigen, wie etwas in einer Mac-App geht, die du schon erlaubt hast",
  "web.teach.app.pickTitle": "In welcher App aufnehmen?",
  "web.teach.app.pickLabel": "App",
  "web.teach.app.pickHint":
    "Es werden nur Apps angezeigt, die du für die Computersteuerung erlaubt hast. Öffne die App zuerst. Passwörter, Kartennummern und Codes werden nie aufgenommen, ebenso wenig die eigenen Fenster von Psyche oder Anmelde- und Sicherheitsabfragen.",
  "web.teach.app.none":
    "Keine App ist bereit zur Aufnahme. Schalte die Computersteuerung in den Einstellungen ein und gib einer App zuerst „Klicken“ oder „Bedienen“.",
  "web.teach.app.start": "Aufnahme starten",
  "web.teach.app.cancelPick": "Nicht jetzt",
  "web.teach.app.startFailed":
    "Psyche konnte die Aufnahme dieser App nicht starten. Öffne sie zuerst und prüfe, ob Psyche Zugriff über die Bedienungshilfen hat.",
  "web.teach.app.bar.title": "{app} wird aufgenommen",
  "web.teach.app.bar.body":
    "Psyche notiert deine Klicks, Menüauswahlen und Eingaben nur in {app}. Geschützte Felder werden nie aufgenommen, es werden keine Screenshots gemacht, und nichts verlässt diesen Mac, bis du speicherst. In der Menüleiste gibt es außerdem ein Stopp.",
  "web.teach.app.bar.endedLimit":
    "Die Aufnahme wurde beim Limit von 200 Schritten beendet. Prüfe, was erfasst wurde.",
  "web.teach.app.bar.endedTimeout":
    "Die Aufnahme wurde bei ihrem Zeitlimit beendet. Prüfe, was erfasst wurde.",
  "web.teach.app.bar.endedInterrupted":
    "Die Aufnahme wurde vorzeitig beendet, weil die App geschlossen wurde. Prüfe, was erfasst wurde.",
  "web.teach.app.stopFailed": "Psyche konnte die Aufnahme nicht abschließen.",
  "web.teach.app.skipped":
    "{count, plural, one {# Element wurde ausgelassen: ein geschütztes Feld oder ein Bedienelement ohne Namen, über den man es finden könnte.} other {# Elemente wurden ausgelassen: geschützte Felder oder Bedienelemente ohne Namen, über die man sie finden könnte.}}",
  "web.teach.app.privacy":
    "Der Text in diesen Schritten stammt aus den Fenstern und Menüs der App. Er wird als Daten behandelt, nie als Anweisung. Beim Speichern musst du den Skill bestätigen, bevor er laufen kann.",
  "web.teach.app.sensitive":
    "Nicht aufgenommen. Psyche bittet dich, diesen Teil selbst zu erledigen.",
  "web.teach.app.runHint":
    "Füllt das Nachrichtenfeld mit dem Skill. Drücke Senden und sieh der App zu: Jeder Klick und jede Eingabe fragt wie gewohnt nach einer Bestätigung, und es hält an und fragt nach, wenn etwas nicht mehr dort ist, wo es war.",
  "web.teach.step.app.click": "In {app} auf „{name}“ klicken",
  "web.teach.step.app.clickRole": "In {app} auf {role} klicken",
  "web.teach.step.app.menu": "In {app} {path} wählen",
  "web.teach.step.app.type": "In {app} in „{name}“ eingeben",
  "web.teach.step.app.typeKept": "In {app} {value} in „{name}“ eingeben",
  "web.teach.step.app.typeInput": "In {app} {input} in „{name}“ eingeben",
  "web.teach.step.app.typeAsk": "In {app} das, was du angibst, in „{name}“ eingeben",
  "web.teach.step.app.typeSensitive": "In {app} tippst du selbst in „{name}“",
};
