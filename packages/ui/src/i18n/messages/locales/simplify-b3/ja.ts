import type { Catalogue } from "../../index.ts";

/** Onboarding finish, recovery key and searchable switch (ja); merged into `../ja.ts`. */
export const simplifyB3: Partial<Catalogue> = {
  "onboarding.done.start": "チャットを始める",
  "onboarding.done.psycheLabel": "Psyche",
  "onboarding.done.psycheWait": "いまPsycheに接続できません。このウインドウは自動で再接続します。",
  "onboarding.done.helperWait":
    "Psyche Helperがまだ接続されていません。接続されると、コンピュータ操作と通知が始まります。",
  "onboarding.connectors.searchable": "検索できるようにする",
  "onboarding.connectors.searchableHint":
    "{name}は、これらのアカウントのメール、予定、メモを検索で見つけられます。設定でいつでもオフにできます。",
  "home.recoveryKey.title": "リカバリーキーを保存してください",
  "home.recoveryKey.body":
    "復元後やキーを紛失したときに、保管庫へ戻る唯一の方法です。表示して、安全な場所にコピーを保管し、確認してください。",
  "settings.credentials.vault.recoveryKey.show": "リカバリーキーを表示",
  "settings.credentials.vault.recoveryKey.hide": "非表示",
  "settings.credentials.vault.recoveryKey.gone":
    "この保管庫のリカバリーキーは作成時にだけ表示されたため、もう一度表示することはできません。",
  "settings.credentials.vault.recoveryKey.failed": "リカバリーキーを表示できませんでした: {reason}",
  "settings.credentials.vault.recoveryKey.title": "リカバリーキー",
  "settings.credentials.vault.recoveryKey.body":
    "復元後やキーを紛失したときに、保管庫へ戻る唯一の方法です。安全な場所にコピーを保管してください。",
};
