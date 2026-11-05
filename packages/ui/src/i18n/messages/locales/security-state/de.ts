import type { Catalogue } from "../../index.ts";

/** The security-records banner and review panel (de); merged into `../de.ts`. */
export const securityState: Partial<Catalogue> = {
  "web.security.banner.changed":
    "Psyche hat eine Änderung an seinen Sicherheitsdaten rückgängig gemacht, die außerhalb der App vorgenommen wurde.",
  "web.security.banner.untrusted":
    "Die Prüfung von Psyches Sicherheitsdaten ist fehlgeschlagen. Änderungen, die mehr Zugriff erlauben, sind gesperrt.",
  "web.security.banner.recovery":
    "{count, plural, one {Eine auf diesem Mac angeforderte Sicherheitsänderung gilt ab {when}, wenn du sie nicht abbrichst.} other {# auf diesem Mac angeforderte Sicherheitsänderungen warten. Die nächste gilt ab {when}.}}",
  "web.security.banner.notice":
    "{count, plural, one {1 Sicherheitshinweis zu prüfen.} other {# Sicherheitshinweise zu prüfen.}}",
  "web.security.review": "Prüfen",
  "web.security.hide": "Ausblenden",
  "web.security.panel.label": "Sicherheitsdaten",
  "web.security.alert.changed":
    "Ein Programm auf diesem Mac hat {count, plural, one {1 Sicherheitseintrag} other {# Sicherheitseinträge}} an Psyche vorbei geändert. Psyche hat {count, plural, one {ihn} other {sie}} wiederhergestellt. Wenn du das nicht warst, prüfe den Mac auf unerwünschte Software.",
  "web.security.alert.untrusted":
    "Die Prüfung von Psyches Sicherheitsdaten ist fehlgeschlagen. Neue Geräte, Sicherheitseinstellungen und Touch-ID-Freigaben sind gesperrt. Prüfe deine Geräte und führe dann auf dem Mac psyched security reseal aus; das gilt nach 24 Stunden.",
  "web.security.alert.firstSeal":
    "Psyche prüft jetzt seine Sicherheitsdaten ({devices, plural, one {1 gekoppeltes Gerät} other {# gekoppelte Geräte}}). Eine Änderung außerhalb von Psyche wird rückgängig gemacht und hier gezeigt. Prüfe deine Geräte einmal.",
  "web.security.alert.resealed": "Psyche hat seine Sicherheitsdaten neu versiegelt.",
  "web.security.alert.restored":
    "Psyche wurde aus einem wiederhergestellten Backup gestartet und hat seine Sicherheitsdaten so versiegelt, wie sie sind. Wenn du kein Backup wiederhergestellt hast, prüfe deine Geräte.",
  "web.security.alert.firstAdmin":
    "Ein Befehl auf diesem Mac hat {name} zum ersten Admin-Gerät gemacht. Wenn du das nicht warst, widerrufe es unter Geräte.",
  "web.security.alert.requested": "Auf diesem Mac angefordert: {action} Gilt ab {when}.",
  "web.security.alert.applied": "Übernommen: {action}",
  "web.security.alert.cancelled": "Abgebrochen: {action}",
  "web.security.alert.failed": "Nicht übernommen: {action}",
  "web.security.op.devicesApprove": "das Gerät {name} freigeben.",
  "web.security.op.devicesGrant": "ändern, was {name} darf.",
  "web.security.op.presenceReset":
    "für Sicherheitsänderungen kein Touch ID und keinen Passkey mehr verlangen, bis ein neuer Schlüssel registriert ist.",
  "web.security.op.sealReset": "die aktuellen Sicherheitsdaten so annehmen, wie sie sind.",
  "web.security.device": "ein Gerät",
  "web.security.change":
    "{change, select, added {Hinzugefügt} modified {Geändert} other {Entfernt}}: {what}",
  "web.security.more": "{count, plural, one {und 1 weiterer} other {und # weitere}}",
  "web.security.ack": "Als geprüft markieren",
  "web.security.approveNow": "Jetzt freigeben",
  "web.security.cancel": "Anfrage abbrechen",
  "web.security.needsApproval":
    "Bestätige die Karte mit Touch ID oder einem Passkey und tippe dann erneut auf die Taste.",
  "web.security.failed": "Das hat nicht geklappt: {message}",
};
