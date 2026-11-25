import type { Catalogue } from "../../index.ts";

/** Failure messages for user actions (ja); merged into `../ja.ts`. */
export const actionErrors: Partial<Catalogue> = {
  "actionError.exportPerson": "この人のデータを書き出せませんでした（{reason}）。",
  "actionError.revokeGrant": "この承認を取り消せませんでした（{reason}）。まだ有効です。",
  "actionError.reindex": "検索インデックスを再構築できませんでした（{reason}）。",
  "actionError.rerun": "このオートメーションを再実行できませんでした（{reason}）。",
  "actionError.stopResearch": "リサーチを停止できませんでした（{reason}）。まだ実行中です。",
  "actionError.unmute": "通知をオンに戻せませんでした（{reason}）。",
  "actionError.language": "言語を変更できませんでした（{reason}）。",
  "actionError.transcriptMode": "文字起こしの詳細度を変更できませんでした（{reason}）。",
  "actionError.screenAskDestination": "画面への質問の送信先を変更できませんでした（{reason}）。",
  "actionError.stopVirtualScreen":
    "仮想画面を停止できませんでした（{reason}）。まだ動いている可能性があります。",
  "actionError.takeOver": "仮想画面を引き継げませんでした（{reason}）。",
};
