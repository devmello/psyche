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
  "settings.updates.channel": "リリースチャンネル",
  "settings.updates.channel.stable": "安定版",
  "settings.updates.channel.note":
    "現在、チャンネルは安定版のみです。ベータ版が公開されると、ここに表示されます。どのチャンネルでも、アップデートは必ず Psyche のリリースキーで検証されます。",
  "settings.updates.saveFailed": "リリースチャンネルを保存できませんでした（{reason}）。",
  "settings.storage.title": "ストレージ",
  "settings.storage.hint":
    "このコンピュータ上の Psyche のデータフォルダが使用しているディスク容量です。",
  "settings.storage.total": "合計",
  "settings.storage.clear": "消去…",
  "settings.storage.cleared": "消去しました。{size} を解放しました。",
  "settings.storage.clearFailed": "ストレージを消去できませんでした（{reason}）。",
  "settings.storage.failed": "ストレージ使用量を読み取れませんでした（{reason}）。",
  "settings.storage.confirm.title": "キャッシュと古い録画を消去しますか？",
  "settings.storage.confirm.body":
    "キャッシュと、7日より古いブラウザ録画を最大 {size} 削除します。キャッシュは必要になると Psyche が作り直します。チャット、メモリ、ライブラリ、ボールト、設定には影響しません。",
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
