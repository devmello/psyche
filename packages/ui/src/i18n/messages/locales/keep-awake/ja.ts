import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (ja); merged into `../ja.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "このコンピュータをスリープさせない",
  "settings.daily.keepAwake.hint":
    "予定された処理の実行中は、完了までこのコンピュータがスリープしません。ディスプレイは消えることがあります。",
  "settings.key.scheduled.keepAwake": "予定された処理の実行中、このコンピュータをスリープさせない",
  "scheduled.history.retryingAt": "{time} に再試行します",
  "scheduled.history.retry": "再試行 {n}/3",
  "scheduled.history.failedAfterRetries": "{n} 回再試行しましたが失敗しました",
  "scheduled.history.cancelRetry": "再試行をキャンセル",
  "scheduled.history.cancelRetry.aria": "{when} の実行の再試行をキャンセル",
  "scheduled.history.cancelRetry.failed": "再試行をキャンセルできませんでした（{reason}）。",
  "settings.updates.group": "アップデート",
  "settings.updates.hint": "Psyche は署名付きアップデートを確認し、終了時にインストールします。",
  "settings.storage.title": "ストレージ",
  "settings.storage.hint":
    "このコンピュータ上の Psyche のデータフォルダが使用しているディスク容量です。",
  "settings.storage.total": "合計",
  "settings.storage.clear": "消去…",
  "settings.storage.cleared": "消去しました。{size} を解放しました。",
  "settings.storage.clearFailed": "ストレージを消去できませんでした（{reason}）。",
  "settings.storage.compact.title": "データベースを最適化",
  "settings.storage.compact.hint":
    "データベースは {size} で、最大 {reclaimable} を解放できます。実行中は Psyche が少し止まります。",
  "settings.storage.compact.button": "最適化",
  "settings.storage.compact.running": "最適化中…",
  "settings.storage.compact.done": "{seconds} 秒で最適化し、{size} を解放しました。",
  "settings.storage.compact.failed": "データベースを最適化できませんでした（{reason}）。",
  "settings.storage.compact.busy": "Psyche は作業中です。終わってからもう一度お試しください。",
  "settings.storage.failed": "ストレージ使用量を読み取れませんでした（{reason}）。",
  "settings.storage.confirm.title": "キャッシュと古い録画を消去しますか？",
  "settings.storage.confirm.body":
    "キャッシュと、7日より古いブラウザ録画を合計 {size} 削除し、それらの録画のライブラリ項目も削除します。キャッシュは必要になると Psyche が作り直します。チャット、メモリ、その他のライブラリファイル、ボールト、設定には影響しません。",
  "settings.storage.confirm.clear": "消去",
  "settings.storage.cat.database": "データベース",
  "settings.storage.cat.memoryIndex": "メモリインデックス",
  "settings.storage.cat.library": "添付ファイルとライブラリ",
  "settings.storage.cat.browserProfiles": "ブラウザプロファイル",
  "settings.storage.cat.recordings": "録画",
  "settings.storage.cat.logs": "ログ",
  "settings.storage.cat.caches": "キャッシュ",
  "settings.storage.cat.other": "その他すべて",
};
