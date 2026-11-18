import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (ja); merged into `../ja.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "Psyche Helper が接続されていません",
  "platform.helper.offline.text":
    "メール、メモ、カレンダー、リマインダーと、それに依存する作業は再接続されるまで待機します。",
  "platform.helper.offline.reconnect": "再接続",
  "platform.helper.offline.dismiss": "閉じる",
};
