import type { Catalogue } from "../../index.ts";

/** Onboarding finish, recovery key and searchable switch (de); merged into `../de.ts`. */
export const simplifyB3: Partial<Catalogue> = {
  "onboarding.done.start": "Chat starten",
  "onboarding.done.psycheLabel": "Psyche",
  "onboarding.done.psycheWait":
    "Psyche ist gerade nicht erreichbar. Dieses Fenster verbindet sich von selbst neu.",
  "onboarding.done.helperWait":
    "Der Psyche-Helfer ist noch nicht verbunden. Computersteuerung und Mitteilungen starten, sobald er es ist.",
  "onboarding.connectors.searchable": "Durchsuchbar machen",
  "onboarding.connectors.searchableHint":
    "{name} kann in der Suche Mails, Termine und Notizen aus diesen Konten finden. Du kannst jedes in den Einstellungen ausschalten.",
  "home.recoveryKey.title": "Speichere deinen Wiederherstellungsschlüssel",
  "home.recoveryKey.body":
    "Er ist der einzige Weg zurück in deinen Tresor nach einer Wiederherstellung oder bei einem verlorenen Schlüssel. Zeige ihn an, bewahre eine Kopie sicher auf und bestätige dann.",
  "settings.credentials.vault.recoveryKey.show": "Wiederherstellungsschlüssel anzeigen",
  "settings.credentials.vault.recoveryKey.hide": "Ausblenden",
  "settings.credentials.vault.recoveryKey.gone":
    "Der Wiederherstellungsschlüssel dieses Tresors wurde nur beim Anlegen angezeigt und kann nicht erneut angezeigt werden.",
  "settings.credentials.vault.recoveryKey.failed":
    "Der Wiederherstellungsschlüssel konnte nicht angezeigt werden: {reason}",
  "settings.credentials.vault.recoveryKey.title": "Wiederherstellungsschlüssel",
  "settings.credentials.vault.recoveryKey.body":
    "Der einzige Weg zurück in den Tresor nach einer Wiederherstellung oder bei einem verlorenen Schlüssel. Bewahre eine Kopie sicher auf.",
};
