import type { Catalogue } from "../../index.ts";

/** Tray labels (fr); merged into `../fr.ts`. */
export const desktopTray: Partial<Catalogue> = {
  "desktop.tray.statusConnected": "Psyche — connecté",
  "desktop.tray.statusOther": "Psyche — {phase}",
  "desktop.tray.usageUnknown": "Utilisation : —",
  "desktop.tray.usageRemaining": "Utilisation : {percent} % restant",
  "desktop.tray.needsYou": "Attend votre réponse ({count})",
  "desktop.tray.nothingNeedsYou": "Rien ne demande votre attention",
  "desktop.tray.gatewayRunning": "Psyche est en cours d’exécution",
  "desktop.tray.gatewayRunningDev": "Psyche est en cours d’exécution (dev)",
  "desktop.tray.gatewayRunningExternal": "Psyche est en cours d’exécution (externe)",
  "desktop.tray.gatewayStarting": "Psyche démarre…",
  "desktop.tray.gatewayStopped": "Psyche s’est arrêté",
  "desktop.tray.gatewayStoppedReason": "Psyche s’est arrêté ({reason})",
  "desktop.tray.gatewayChecking": "Vérification de Psyche…",
  "desktop.tray.tooltipConnected": "connecté",
  "desktop.tray.tooltipNeedOne": "1 chose attend votre réponse",
  "desktop.tray.tooltipNeedMany": "{count} choses attendent votre réponse",
  "desktop.tray.pointsRow": "Guide-moi dans cette fenêtre…",
};
