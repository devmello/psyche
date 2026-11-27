import type { Catalogue } from "../../index.ts";

/** Tray labels (ar); merged into `../ar.ts`. */
export const desktopTray: Partial<Catalogue> = {
  "desktop.tray.statusConnected": "Psyche — متصل",
  "desktop.tray.statusOther": "Psyche — {phase}",
  "desktop.tray.usageUnknown": "الاستخدام: —",
  "desktop.tray.usageRemaining": "الاستخدام: {percent}% متبقٍ",
  "desktop.tray.needsYou": "بانتظارك ({count})",
  "desktop.tray.nothingNeedsYou": "لا شيء يحتاج إليك",
  "desktop.tray.gatewayRunning": "Psyche قيد التشغيل",
  "desktop.tray.gatewayRunningDev": "Psyche قيد التشغيل (تطوير)",
  "desktop.tray.gatewayRunningExternal": "Psyche قيد التشغيل (خارجي)",
  "desktop.tray.gatewayStarting": "Psyche يبدأ…",
  "desktop.tray.gatewayStopped": "توقّف Psyche",
  "desktop.tray.gatewayStoppedReason": "توقّف Psyche ({reason})",
  "desktop.tray.gatewayChecking": "جارٍ التحقق من Psyche…",
  "desktop.tray.tooltipConnected": "متصل",
  "desktop.tray.tooltipNeedOne": "شيء واحد يحتاج إليك",
  "desktop.tray.tooltipNeedMany": "{count} أشياء تحتاج إليك",
  "desktop.tray.pointsRow": "حدّد لي هذه النافذة…",
};
