import type { Catalogue } from "../../index.ts";

/** automationChat strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const automationChatRest: Partial<Catalogue> = {
  "automationChat.label": "{title}の実行",
  "automationChat.runs": "{n, plural, other {#回の実行}}",
  "automationChat.runs.aria": "{title}、{n, plural, other {#回の実行}}、前回の実行: {status}",
  "automationChat.schedule": "スケジュール",
  "automationChat.runNow": "今すぐ実行",
  "automationChat.empty":
    "まだ実行されていません。このオートメーションが実行されるたびに、ここに表示されます。",
  "automationChat.loading": "実行を読み込み中",
  "automationChat.failed": "Psycheは実行を読み込めませんでした",
  "automationChat.more": "古い実行を表示",
  "automationChat.status.needsYou": "対応が必要",
  "automationChat.status.running": "実行中",
  "automationChat.trigger.manual": "今すぐ実行",
  "automationChat.trigger.event": "イベント発生時",
  "automationChat.coalesced": "見逃した{n}回分を1回に集約",
  "automationChat.noResult": "結果は書き込まれていません",
  "automationChat.noSteps": "この実行にはステップが記録されていません。",
  "automationChat.stepsLoading": "ステップを読み込み中",
  "automationChat.timeline": "タイムラインで開く",
  "automationChat.approvals": "承認を開く",
  "automationChat.waiting": "この実行はあなたの対応を待っています。",
  "automationChat.result": "結果",
  "automationChat.openScheduled": "スケジュールで開く",
  "automationChat.row.runs": "{n, plural, other {#回の実行}}",
  "automationChat.row.last": "前回の実行: {status}",
};
