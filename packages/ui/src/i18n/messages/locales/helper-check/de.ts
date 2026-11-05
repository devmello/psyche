import type { Catalogue } from "../../index.ts";

/** The Linux helper check in Settings → Devices (de); merged into `../de.ts`. */
export const helperCheck: Partial<Catalogue> = {
  "settings.devices.helperCheck.title": "Prüfung des Linux-Helfers",
  "settings.devices.helperCheck.description":
    "Wenn sich der Linux-Helfer verbindet, prüft Psyche, welches Programm er wirklich ist.",
  "settings.devices.helperCheck.state.verified": "Geprüft: installierter System-Helfer",
  "settings.devices.helperCheck.state.userOwned": "Ungeprüft: Helfer aus Ihrem Home-Ordner",
  "settings.devices.helperCheck.state.unverified":
    "Ungeprüft: Psyche konnte den Helfer nicht prüfen",
  "settings.devices.helperCheck.detail.verified":
    "Das ist der mit Psyche installierte Helfer. Nur das System kann ihn ändern.",
  "settings.devices.helperCheck.detail.userOwned":
    "Er läuft aus Dateien, die Ihnen gehören, etwa einem AppImage oder einem Build in Ihrem Home-Ordner. Psyche akzeptiert ihn, kann aber nicht ausschließen, dass ein anderes Ihrer Programme ihn ersetzt hat.",
  "settings.devices.helperCheck.detail.unverified":
    "Psyche akzeptiert ihn vorerst, konnte aber nicht feststellen, welches Programm es ist.",
  "settings.devices.helperCheck.refused": "Abgelehnt: {reason}",
  "settings.devices.helperCheck.reason.unclear": "Psyche konnte den Helfer nicht prüfen",
  "settings.devices.helperCheck.reason.notHelper": "dieses Programm ist nicht der Psyche-Helfer",
  "settings.devices.helperCheck.reason.userCopy":
    "es ist eine Kopie außerhalb der Systeminstallation, verlangt wird der installierte Helfer",
  "settings.devices.helperCheck.reason.loaderEnv":
    "er wurde mit einem Bibliothekspfad oder einer vorgeladenen Bibliothek gestartet",
  "settings.devices.helperCheck.reason.foreignCode":
    "er hat Code von außerhalb des Systems geladen",
  "settings.devices.helperCheck.reason.severalPrograms":
    "mehr als ein Programm teilt sich seine Verbindung",
  "settings.devices.helperCheck.reason.handedOver":
    "seine Verbindung wurde ihm von einem anderen Programm übergeben",
  "settings.devices.helperCheck.reason.stillStarting": "er startete noch",
  "settings.devices.helperCheck.reason.debugged": "er ist angehalten oder wird debuggt",
  "settings.devices.helperCheck.reason.restartNeeded":
    "er wurde ersetzt oder eine Systembibliothek wurde seit dem Start aktualisiert; starten Sie den Helfer neu",
  "settings.devices.helperCheck.reason.filesNotLocked":
    "seine Dateien könnten von jemand anderem als dem System geändert werden",
  "settings.devices.helperCheck.reason.otherNamespace":
    "er läuft in einer getrennten Sandbox dieses Computers",
  "settings.devices.helperCheck.reason.busy":
    "Psyche war mit anderen Verbindungen beschäftigt; der Helfer versucht es erneut",
};
