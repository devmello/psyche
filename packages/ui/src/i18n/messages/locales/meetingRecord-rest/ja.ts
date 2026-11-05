import type { Catalogue } from "../../index.ts";

/** meetingRecord strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const meetingRecordRest: Partial<Catalogue> = {
  "meetingRecord.palette": "会議を録音…",
  "meetingRecord.title": "この会議を録音しますか？",
  "meetingRecord.intro":
    "開始する前に全員に伝えてください。口頭で伝えるか、チャットに貼り付けてください。Psycheが通話に参加することはなく、確認するまで録音もしません。",
  "meetingRecord.copy": "コピー",
  "meetingRecord.copied": "コピーしました",
  "meetingRecord.confirm": "全員に伝えました",
  "meetingRecord.cancel": "キャンセル",
  "meetingRecord.privacy":
    "音声はあなたのPsyche内に留まり、そこでノートに変換されます。ほかへアップロードされたり、学習に使われたりすることはありません。",
  "meetingRecord.unavailable":
    "録音には、音声をノートに変換する手段（Macヘルパー）が必要ですが、接続されていません。",
  "meetingRecord.micDenied": "Psycheがマイクを使用できません。システム設定で許可してください。",
  "meetingRecord.failed": "Psycheはこの会議を録音できませんでした。",
  "meetingRecord.pill": "会議を録音中 · {time}",
  "meetingRecord.stop": "停止",
  "meetingRecord.stopping": "保存中…",
  "meetingRecord.notes.processing": "ノートを作成中…",
  "meetingRecord.notes.done": "ノートがホームに用意できました。",
  "meetingRecord.notes.needs_permission": "クラウドモデルの使用についてあなたのOKを待っています。",
  "meetingRecord.notes.failed": "Psycheはこの録音からノートを作成できませんでした。",
};
