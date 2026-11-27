import type { Catalogue } from "../../index.ts";

/** Tray labels (zh); merged into `../zh.ts`. */
export const desktopTray: Partial<Catalogue> = {
  "desktop.tray.statusConnected": "Psyche — 已连接",
  "desktop.tray.statusOther": "Psyche — {phase}",
  "desktop.tray.usageUnknown": "用量：—",
  "desktop.tray.usageRemaining": "用量：剩余 {percent}%",
  "desktop.tray.needsYou": "需要你处理（{count}）",
  "desktop.tray.nothingNeedsYou": "没有需要你处理的事项",
  "desktop.tray.gatewayRunning": "Psyche 正在运行",
  "desktop.tray.gatewayRunningDev": "Psyche 正在运行（开发）",
  "desktop.tray.gatewayRunningExternal": "Psyche 正在运行（外部）",
  "desktop.tray.gatewayStarting": "Psyche 正在启动…",
  "desktop.tray.gatewayStopped": "Psyche 已停止",
  "desktop.tray.gatewayStoppedReason": "Psyche 已停止（{reason}）",
  "desktop.tray.gatewayChecking": "正在检查 Psyche…",
  "desktop.tray.tooltipConnected": "已连接",
  "desktop.tray.tooltipNeedOne": "1 件事需要你处理",
  "desktop.tray.tooltipNeedMany": "{count} 件事需要你处理",
  "desktop.tray.pointsRow": "引导我操作此窗口…",
};
