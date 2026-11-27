import type { Catalogue } from "../../index.ts";

/** Tray labels (hi); merged into `../hi.ts`. */
export const desktopTray: Partial<Catalogue> = {
  "desktop.tray.statusConnected": "Psyche — जुड़ा हुआ",
  "desktop.tray.statusOther": "Psyche — {phase}",
  "desktop.tray.usageUnknown": "उपयोग: —",
  "desktop.tray.usageRemaining": "उपयोग: {percent}% शेष",
  "desktop.tray.needsYou": "आपकी ज़रूरत है ({count})",
  "desktop.tray.nothingNeedsYou": "कुछ भी आपकी ज़रूरत नहीं",
  "desktop.tray.gatewayRunning": "Psyche चल रहा है",
  "desktop.tray.gatewayRunningDev": "Psyche चल रहा है (dev)",
  "desktop.tray.gatewayRunningExternal": "Psyche चल रहा है (बाहरी)",
  "desktop.tray.gatewayStarting": "Psyche शुरू हो रहा है…",
  "desktop.tray.gatewayStopped": "Psyche रुक गया",
  "desktop.tray.gatewayStoppedReason": "Psyche रुक गया ({reason})",
  "desktop.tray.gatewayChecking": "Psyche की जाँच हो रही है…",
  "desktop.tray.tooltipConnected": "जुड़ा हुआ",
  "desktop.tray.tooltipNeedOne": "1 चीज़ आपकी ज़रूरत है",
  "desktop.tray.tooltipNeedMany": "{count} चीज़ें आपकी ज़रूरत हैं",
  "desktop.tray.pointsRow": "इस विंडो में मुझे दिखाएँ…",
};
