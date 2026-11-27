import type { Catalogue } from "../../index.ts";

/** Tray labels (ko); merged into `../ko.ts`. */
export const desktopTray: Partial<Catalogue> = {
  "desktop.tray.statusConnected": "Psyche — 연결됨",
  "desktop.tray.statusOther": "Psyche — {phase}",
  "desktop.tray.usageUnknown": "사용량: —",
  "desktop.tray.usageRemaining": "사용량: {percent}% 남음",
  "desktop.tray.needsYou": "확인 필요 ({count})",
  "desktop.tray.nothingNeedsYou": "확인할 항목 없음",
  "desktop.tray.gatewayRunning": "Psyche 실행 중",
  "desktop.tray.gatewayRunningDev": "Psyche 실행 중 (개발)",
  "desktop.tray.gatewayRunningExternal": "Psyche 실행 중 (외부)",
  "desktop.tray.gatewayStarting": "Psyche 시작 중…",
  "desktop.tray.gatewayStopped": "Psyche 중지됨",
  "desktop.tray.gatewayStoppedReason": "Psyche 중지됨 ({reason})",
  "desktop.tray.gatewayChecking": "Psyche 확인 중…",
  "desktop.tray.tooltipConnected": "연결됨",
  "desktop.tray.tooltipNeedOne": "확인할 항목 1개",
  "desktop.tray.tooltipNeedMany": "확인할 항목 {count}개",
  "desktop.tray.pointsRow": "이 창을 안내해 줘…",
};
