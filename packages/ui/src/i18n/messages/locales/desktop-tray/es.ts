import type { Catalogue } from "../../index.ts";

/** Tray labels (es); merged into `../es.ts`. */
export const desktopTray: Partial<Catalogue> = {
  "desktop.tray.statusConnected": "Psyche — conectado",
  "desktop.tray.statusOther": "Psyche — {phase}",
  "desktop.tray.usageUnknown": "Uso: —",
  "desktop.tray.usageRemaining": "Uso: {percent} % restante",
  "desktop.tray.needsYou": "Necesita tu atención ({count})",
  "desktop.tray.nothingNeedsYou": "Nada necesita tu atención",
  "desktop.tray.gatewayRunning": "Psyche está en marcha",
  "desktop.tray.gatewayRunningDev": "Psyche está en marcha (desarrollo)",
  "desktop.tray.gatewayRunningExternal": "Psyche está en marcha (externo)",
  "desktop.tray.gatewayStarting": "Psyche se está iniciando…",
  "desktop.tray.gatewayStopped": "Psyche se ha detenido",
  "desktop.tray.gatewayStoppedReason": "Psyche se ha detenido ({reason})",
  "desktop.tray.gatewayChecking": "Comprobando Psyche…",
  "desktop.tray.tooltipConnected": "conectado",
  "desktop.tray.tooltipNeedOne": "1 cosa necesita tu atención",
  "desktop.tray.tooltipNeedMany": "{count} cosas necesitan tu atención",
  "desktop.tray.pointsRow": "Guíame por esta ventana…",
};
