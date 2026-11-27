import type { Catalogue } from "../../index.ts";

/** Tray labels (de); merged into `../de.ts`. */
export const desktopTray: Partial<Catalogue> = {
  "desktop.tray.statusConnected": "Psyche — verbunden",
  "desktop.tray.statusOther": "Psyche — {phase}",
  "desktop.tray.usageUnknown": "Nutzung: —",
  "desktop.tray.usageRemaining": "Nutzung: {percent} % übrig",
  "desktop.tray.needsYou": "Wartet auf dich ({count})",
  "desktop.tray.nothingNeedsYou": "Nichts wartet auf dich",
  "desktop.tray.gatewayRunning": "Psyche läuft",
  "desktop.tray.gatewayRunningDev": "Psyche läuft (Entwicklung)",
  "desktop.tray.gatewayRunningExternal": "Psyche läuft (extern)",
  "desktop.tray.gatewayStarting": "Psyche startet…",
  "desktop.tray.gatewayStopped": "Psyche ist beendet",
  "desktop.tray.gatewayStoppedReason": "Psyche ist beendet ({reason})",
  "desktop.tray.gatewayChecking": "Psyche wird geprüft…",
  "desktop.tray.tooltipConnected": "verbunden",
  "desktop.tray.tooltipNeedOne": "1 Sache wartet auf dich",
  "desktop.tray.tooltipNeedMany": "{count} Dinge warten auf dich",
  "desktop.tray.pointsRow": "Zeig mir durch dieses Fenster…",
};
