import type { Catalogue } from "../../index.ts";

/** Linux access in Settings → Computer use (de); merged into `../de.ts`. */
export const linuxAccess: Partial<Catalogue> = {
  "settings.computerUse.linux.screen.name": "Zugriff auf Bildschirm und Eingabe",
  "settings.computerUse.linux.screen.allowed": "Erlaubt, bis Sie ihn widerrufen",
  "settings.computerUse.linux.screen.asks": "Fragt bei der ersten Nutzung",
  "settings.computerUse.linux.screen.notNeeded": "Unter X11 nicht nötig",
  "settings.computerUse.linux.screen.unavailable": "Nicht verfügbar",
  "settings.computerUse.linux.screen.why":
    "{persona} sieht Ihren Bildschirm und bedient Maus und Tastatur über den Berechtigungsdialog Ihres Desktops. Sie bestätigen das einmal.",
  "settings.computerUse.linux.revoke": "Widerrufen",
  "settings.computerUse.linux.revokeLabel": "Zugriff auf Bildschirm und Eingabe widerrufen",
  "settings.computerUse.linux.warning.x11":
    "Unter X11 kann jede App Ihren Bildschirm und Ihre Tastatureingaben lesen, auch Ihr Passwort, wenn Sie etwas freigeben.",
  "settings.computerUse.linux.warning.wlroots":
    "Auf diesem Desktop kann jede App Ihren Bildschirm lesen und für Sie tippen, ohne zu fragen. Psyche kann keinen Bestätigungsschritt hinzufügen.",
  "settings.computerUse.linux.accessibility":
    "Apps, die ab jetzt geöffnet werden, legen ihre Struktur für Psyche offen. Bereits geöffnete Apps müssen eventuell neu gestartet werden.",
  "settings.computerUse.linux.headless":
    "Dafür ist eine grafische Sitzung auf diesem Computer nötig. Melden Sie sich am Desktop an und versuchen Sie es erneut.",
};
