import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (ja); merged into `../ja.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "Psyche Helper が接続されていません",
  "platform.helper.offline.text":
    "メール、メモ、カレンダー、リマインダーと、それに依存する作業は再接続されるまで待機します。",
  "platform.helper.offline.reconnect": "再接続",
  "platform.helper.contactsPermission":
    "連絡先を使うには、システム設定で Psyche Helper に許可が必要です。",
  "platform.helper.offline.dismiss": "閉じる",
  "platform.helper.choose.title": "Psyche Helper が 2 つ接続されています",
  "platform.helper.choose.text":
    "このコンピュータで動いているのがどちらか Psyche は推測しないため、メール、メモ、カレンダー、リマインダーは一時停止中です。使用する方を選んでください。",
  "platform.helper.choose.use": "{name} を使う",
  "platform.helper.choose.failed": "ヘルパーを選べませんでした: {reason}",
};
