import type { Catalogue } from "../../index.ts";

/** The security-records banner and review panel (ja); merged into `../ja.ts`. */
export const securityState: Partial<Catalogue> = {
  "web.security.banner.changed":
    "アプリの外で行われたセキュリティ記録の変更を、Psyche が元に戻しました。",
  "web.security.banner.untrusted":
    "Psyche のセキュリティ記録の確認に失敗しました。アクセスを広げる変更はブロックされています。",
  "web.security.banner.recovery":
    "{count, plural, other {この Mac で要求されたセキュリティ変更が # 件待機中です。次の変更はキャンセルしない限り {when} に適用されます。}}",
  "web.security.banner.notice":
    "{count, plural, other {確認が必要なセキュリティ通知が # 件あります。}}",
  "web.security.review": "確認",
  "web.security.hide": "隠す",
  "web.security.panel.label": "セキュリティ記録",
  "web.security.alert.changed":
    "この Mac 上のプログラムが Psyche を通さずにセキュリティ記録を {count} 件変更しました。Psyche は元に戻しました。心当たりがない場合は、Mac に不要なソフトウェアがないか確認してください。",
  "web.security.alert.untrusted":
    "Psycheのセキュリティ記録の確認に失敗しました。新しいデバイス、セキュリティ設定、Touch IDでの承認はブロックされています。設定 → デバイスで端末を確認し、「確認済みにする」をタップしてください。現在の記録を受け入れるよう求められたら「今すぐ承認」をタップします。適用は24時間後です。",
  "web.security.alert.firstSeal":
    "Psyche はセキュリティ記録を確認するようになりました（ペアリング済みデバイス {devices} 台）。Psyche の外で行われた変更は元に戻され、ここに表示されます。一度デバイスを確認してください。",
  "web.security.alert.resealed": "Psyche がセキュリティ記録を再び封印しました。",
  "web.security.alert.restored":
    "Psyche は復元したバックアップから起動し、セキュリティ記録をそのままの状態で封印しました。バックアップを復元していない場合は、デバイスを確認してください。",
  "web.security.alert.firstAdmin":
    "この Mac のコマンドにより、{name} が最初の管理者デバイスになりました。心当たりがない場合は、デバイスで取り消してください。",
  "web.security.alert.requested": "この Mac で要求: {action} {when} に適用されます。",
  "web.security.alert.applied": "適用済み: {action}",
  "web.security.alert.cancelled": "キャンセル済み: {action}",
  "web.security.alert.failed": "適用できませんでした: {action}",
  "web.security.op.devicesApprove": "デバイス {name} を承認する。",
  "web.security.op.devicesGrant": "{name} にできることを変更する。",
  "web.security.op.presenceReset": "新しいキーが登録されるまで、支払いを保護するキーを解除する。",
  "web.security.op.sealReset": "現在のセキュリティ記録をそのまま受け入れる。",
  "web.security.device": "デバイス",
  "web.security.deviceKey": "{name}（キー {fingerprint}）",
  "web.security.change": "{change, select, added {追加} modified {変更} other {削除}}: {what}",
  "web.security.more": "{count, plural, other {ほか # 件}}",
  "web.security.ack": "確認済みにする",
  "web.security.approveNow": "今すぐ承認",
  "web.security.cancel": "要求をキャンセル",
  "web.security.needsApprovalPresence":
    "Touch ID またはパスキーでカードを承認してから、もう一度ボタンを押してください。",
  "web.security.needsApproval": "カードを承認してから、もう一度ボタンを押してください。",
  "web.security.failed": "うまくいきませんでした: {message}",
  "settings.security.title": "セキュリティ記録",
  "settings.security.description":
    "Psyche のセキュリティ記録が無事か、知らないうちに何が変わったか、適用待ちの依頼を表示します。",
  "settings.security.status.sealed": "正常",
  "settings.security.status.untrusted": "信頼できません",
  "settings.security.empty": "確認するものはありません。通知も待機中の依頼もありません。",
  "settings.security.approvalLabel": "セキュリティの変更",
  "settings.security.approve.title": "この変更を今すぐ適用しますか？",
  "settings.security.approve.body": "この依頼を {when} ではなく今すぐ適用します: {action}",
  "settings.security.approve.confirm": "今すぐ適用",
  "settings.security.cancel.title": "この依頼をキャンセルしますか？",
  "settings.security.cancel.body": "変更は行われず、依頼は破棄されます: {action}",
  "settings.security.keep": "そのままにする",
};
