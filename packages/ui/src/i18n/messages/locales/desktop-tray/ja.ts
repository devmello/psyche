import type { Catalogue } from "../../index.ts";

/** Tray labels (ja); merged into `../ja.ts`. */
export const desktopTray: Partial<Catalogue> = {
  "desktop.tray.statusConnected": "Psyche — 接続済み",
  "desktop.tray.statusOther": "Psyche — {phase}",
  "desktop.tray.usageUnknown": "使用量: —",
  "desktop.tray.usageRemaining": "使用量: 残り {percent}%",
  "desktop.tray.needsYou": "対応が必要 ({count})",
  "desktop.tray.nothingNeedsYou": "対応が必要なものはありません",
  "desktop.tray.gatewayRunning": "Psyche は実行中です",
  "desktop.tray.gatewayRunningDev": "Psyche は実行中（開発）",
  "desktop.tray.gatewayRunningExternal": "Psyche は実行中（外部）",
  "desktop.tray.gatewayStarting": "Psyche を起動しています…",
  "desktop.tray.gatewayStopped": "Psyche は停止しました",
  "desktop.tray.gatewayStoppedReason": "Psyche は停止しました（{reason}）",
  "desktop.tray.gatewayChecking": "Psyche を確認しています…",
  "desktop.tray.tooltipConnected": "接続済み",
  "desktop.tray.tooltipNeedOne": "対応が必要なもの 1 件",
  "desktop.tray.tooltipNeedMany": "対応が必要なもの {count} 件",
  "desktop.tray.pointsRow": "このウィンドウを案内…",
};
