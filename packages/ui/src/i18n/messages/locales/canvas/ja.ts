import type { Catalogue } from "../../index.ts";

/** Output canvas strings (ja); merged into `../ja.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "グラフ",
  "canvas.htmlOff":
    "信頼されていないコンテンツ由来のため、プレビューはオフです。信頼できる場合のみ実行してください。ネットワークのないサンドボックスで動作します。",
  "canvas.htmlRun": "実行",
  "canvas.htmlNoPreview": "このホストでは HTML をプレビューできないため、ソースを表示しています。",
  "canvas.label": "キャンバス: {title}",
  "canvas.recents": "最近の出力",
  "canvas.loading": "読み込み中…",
  "canvas.missing": "Psyche はこの出力を読み込めませんでした。",
  "canvas.untrusted": "信頼されていないコンテンツから作成",
  "canvas.version": "バージョン",
  "canvas.versionOption":
    "v{version} · {author, select, user {あなた} specialist {スペシャリスト} other {Psyche}} · {time}",
  "canvas.copy": "コピー",
  "canvas.copied": "コピーしました",
  "canvas.download": "ダウンロード",
  "canvas.restore": "新しいバージョンとして復元",
  "canvas.oldVersion": "バージョン {version}（読み取り専用）。",
  "canvas.conflict":
    "編集中に変更されたため、編集は保存されませんでした。最新のバージョンでもう一度お試しください。",
  "canvas.saveFailed": "保存できませんでした: {message}",
};
