import type { Catalogue } from "../../index.ts";

/** Password presence on Linux (de); merged into `../de.ts`. */
export const passwordPresence: Partial<Catalogue> = {
  "blocks.approval.password.needsAuth": "Zum Freigeben ist Ihr Passwort oder ein Passkey nötig.",
  "blocks.approval.password.waiting":
    "Geben Sie Ihr Passwort im Systemdialog ein, um {code} freizugeben",
  "blocks.approval.password.waitingShort": "Warten auf Ihr Passwort …",
  "blocks.approval.password.onceOnly": "Passwort-Freigaben aus diesem Fenster gelten nur einmal.",
  "blocks.approval.status.allowedOncePassword":
    "Einmal erlaubt (Passwort-Freigaben aus diesem Fenster gelten nur einmal)",
  "blocks.approval.password.noUnsandboxed":
    "Einen Befehl ohne Sandbox auszuführen, lässt sich aus diesem Fenster nicht mit einem Passwort freigeben. Richten Sie stattdessen die Sandbox ein",
  "blocks.approval.password.failed":
    "Das Passwort wurde nicht akzeptiert, daher wurde nichts freigegeben. Versuchen Sie es erneut.",
  "blocks.approval.password.unavailableHere":
    "Geben Sie an diesem Computer frei oder mit einem Passkey von einem anderen Gerät.",
  "blocks.approval.password.agentMissing":
    "Auf diesem Desktop ist kein Passwortdialog verfügbar. Installieren Sie einen polkit-Agenten wie polkit-gnome oder lxpolkit oder verwenden Sie einen Passkey.",
  "blocks.approval.password.policyMissing":
    "Die Passwortrichtlinie von Psyche ist auf diesem Computer nicht installiert. Führen Sie die einmalige Einrichtung von Psyche aus oder verwenden Sie einen Passkey.",
  "blocks.approval.password.notEnforced":
    "Eine polkit-Regel auf diesem Computer gibt Psyche ohne Passwort frei, daher lässt sich nicht bestätigen, dass Sie es waren. Entfernen Sie die Regel oder verwenden Sie einen Passkey.",
  "blocks.approval.password.unreachable":
    "Der Passwortdienst des Systems ist nicht erreichbar. Versuchen Sie es erneut oder verwenden Sie einen Passkey.",
  "settings.devices.password.title": "Passwort-Freigaben",
  "settings.devices.password.description":
    "Bevor eine sensible Aktion freigegeben wird, fragt Psyche Ihr Passwort im Systemdialog ab. Das Passwort gelangt nie zu Psyche.",
  "settings.devices.password.state.ready": "Bereit",
  "settings.devices.password.state.policyMissing": "Richtlinie nicht installiert",
  "settings.devices.password.state.notEnforced": "Aus",
  "settings.devices.password.state.noSession": "Keine Desktop-Sitzung",
  "settings.devices.password.state.agentMissing": "Kein Passwortdialog",
  "settings.devices.password.state.unavailable": "Nicht verfügbar",
  "settings.devices.password.detail.ready":
    "Psyche fragt Ihr Passwort im Systemdialog ab, wenn Sie eine sensible Aktion freigeben.",
  "settings.devices.password.detail.policyMissing":
    "Die Passwortrichtlinie von Psyche ist auf diesem Computer nicht installiert. Führen Sie die einmalige Einrichtung von Psyche aus.",
  "settings.devices.password.detail.notEnforced":
    "Eine polkit-Regel auf diesem Computer gibt Psyche ohne Passwort frei. Passwort-Freigaben sind aus, bis sie entfernt wird.",
  "settings.devices.password.detail.noSession":
    "Passwort-Freigaben brauchen eine aktive Desktop-Sitzung an diesem Computer. Öffnen Sie Psyche dort.",
  "settings.devices.password.detail.agentMissing":
    "Auf diesem Desktop ist kein Passwortdialog verfügbar. Installieren Sie einen polkit-Agenten wie polkit-gnome oder lxpolkit.",
  "settings.devices.password.detail.unavailable":
    "Psyche konnte den Passwortdienst des Systems nicht erreichen.",
  "settings.devices.password.x11Warning":
    "Dies ist eine X11-Sitzung. Andere Programme können hier mitlesen, was Sie eintippen, daher ist ein Passwort nur eine Hürde, keine Grenze. Eine Wayland-Sitzung ist sicherer.",
};
