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
  "canvas.map": "地図",
  "map.label": "地図: {title}",
  "map.untitled": "地図",
  "map.list": "場所",
  "map.openLink": "リンクを開く",
  "map.empty": "表示する場所がありません。",
  "map.tilesOff": "設定で地図タイルがオフです。リストを表示しています。",
  "map.tilesFailed": "地図を読み込めませんでした。リストを表示しています。",
  "map.showMap": "地図を表示",
  "map.showList": "リストを表示",
  "map.card": "地図: {title}",
  "map.meta": "{count, plural, other {#件の場所}} · {date}",
  "map.openCanvas": "キャンバスで開く",
  "map.invalid": "この地図を読み取れませんでした。",
  "map.gesture.windows": "Ctrl +スクロールで地図をズーム",
  "map.gesture.mac": "⌘ +スクロールで地図をズーム",
  "map.gesture.mobile": "2本指で地図を動かします",
  "settings.map.title": "地図",
  "settings.map.privacy":
    "地図を表示すると、見ているエリアがタイルサーバに送られ、サーバはおおよその閲覧場所を知ることができます。タイルをオフにすると場所をリストのみで表示します。自分のタイルサーバも使えます。",
  "settings.map.tiles": "地図タイルを表示",
  "settings.map.tilesHint": "オフにすると、地図へのリクエストなしで場所をリスト表示します。",
  "settings.map.style": "タイルサーバのスタイルURL",
  "settings.map.styleHint":
    "MapLibreのスタイルJSONのURL(自分のサーバなど)。空欄の場合は無料のOpenFreeMapタイルを使います(httpsのみ、localhostはhttp可)。",
  "settings.map.styleDark": "スタイルURL(ダーク)",
  "settings.map.styleDarkHint":
    "任意。空欄の場合はダークモードでも上のスタイル、またはOpenFreeMapのダークスタイルを使います。",
};
