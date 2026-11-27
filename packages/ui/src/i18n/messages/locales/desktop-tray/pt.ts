import type { Catalogue } from "../../index.ts";

/** Tray labels (pt); merged into `../pt.ts`. */
export const desktopTray: Partial<Catalogue> = {
  "desktop.tray.statusConnected": "Psyche — conectado",
  "desktop.tray.statusOther": "Psyche — {phase}",
  "desktop.tray.usageUnknown": "Uso: —",
  "desktop.tray.usageRemaining": "Uso: {percent}% restante",
  "desktop.tray.needsYou": "Precisa de você ({count})",
  "desktop.tray.nothingNeedsYou": "Nada precisa de você",
  "desktop.tray.gatewayRunning": "Psyche está em execução",
  "desktop.tray.gatewayRunningDev": "Psyche está em execução (dev)",
  "desktop.tray.gatewayRunningExternal": "Psyche está em execução (externo)",
  "desktop.tray.gatewayStarting": "Psyche está iniciando…",
  "desktop.tray.gatewayStopped": "Psyche parou",
  "desktop.tray.gatewayStoppedReason": "Psyche parou ({reason})",
  "desktop.tray.gatewayChecking": "Verificando o Psyche…",
  "desktop.tray.tooltipConnected": "conectado",
  "desktop.tray.tooltipNeedOne": "1 coisa precisa de você",
  "desktop.tray.tooltipNeedMany": "{count} coisas precisam de você",
  "desktop.tray.pointsRow": "Me mostre esta janela…",
};
