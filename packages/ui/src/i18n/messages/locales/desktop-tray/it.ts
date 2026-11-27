import type { Catalogue } from "../../index.ts";

/** Tray labels (it); merged into `../it.ts`. */
export const desktopTray: Partial<Catalogue> = {
  "desktop.tray.statusConnected": "Psyche — connesso",
  "desktop.tray.statusOther": "Psyche — {phase}",
  "desktop.tray.usageUnknown": "Utilizzo: —",
  "desktop.tray.usageRemaining": "Utilizzo: {percent}% rimanente",
  "desktop.tray.needsYou": "Richiede te ({count})",
  "desktop.tray.nothingNeedsYou": "Niente richiede la tua attenzione",
  "desktop.tray.gatewayRunning": "Psyche è in esecuzione",
  "desktop.tray.gatewayRunningDev": "Psyche è in esecuzione (sviluppo)",
  "desktop.tray.gatewayRunningExternal": "Psyche è in esecuzione (esterno)",
  "desktop.tray.gatewayStarting": "Psyche si sta avviando…",
  "desktop.tray.gatewayStopped": "Psyche si è arrestato",
  "desktop.tray.gatewayStoppedReason": "Psyche si è arrestato ({reason})",
  "desktop.tray.gatewayChecking": "Verifica di Psyche…",
  "desktop.tray.tooltipConnected": "connesso",
  "desktop.tray.tooltipNeedOne": "1 cosa richiede te",
  "desktop.tray.tooltipNeedMany": "{count} cose richiedono te",
  "desktop.tray.pointsRow": "Guidami attraverso questa finestra…",
};
