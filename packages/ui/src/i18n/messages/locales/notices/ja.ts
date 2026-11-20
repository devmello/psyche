import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (ja); merged into `../ja.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.security.changed.title": "アプリの外で行われたセキュリティ変更を Psyche が元に戻しました",
  "notice.security.changed.body":
    "この Mac のプログラムが、Psyche を通さずに {count, plural, =1 {# 件のセキュリティ記録} other {# 件のセキュリティ記録}}（デバイス、キー、許可、設定）を変更しました{times, plural, =0 {} =1 {} other {（これまでに # 回）}}。Psyche は元に戻しました。心当たりがない場合は、Mac に不要なソフトウェアがないか確認してください。",
  "notice.security.untrusted.title": "Psyche はセキュリティ記録を信頼できません",
  "notice.security.untrusted.body":
    "Psyche のセキュリティ記録の確認に失敗したため、セキュリティ変更、新しいデバイス、Touch ID による承認はブロックされています。デバイスを確認してから、Mac で `psyched security reseal` を実行してください（24 時間後に適用されます）。",
  "notice.security.firstSeal.title": "Psyche がセキュリティ記録の確認を開始しました",
  "notice.security.firstSeal.body":
    "Psyche は、ペアリング済みの {devices, plural, =1 {# 台のデバイス} other {# 台のデバイス}}とセキュリティ設定を保護しました。今後、Psyche の外で行われた変更は元に戻され、ここに表示されます。デバイスを一度確認してください。",
  "notice.security.resealed.title":
    "{restored, select, yes {復元後にセキュリティ記録を保護しました} other {セキュリティ記録を再び保護しました}}",
  "notice.security.resealed.body":
    "{restored, select, yes {Psyche は復元されたバックアップから起動し、セキュリティ記録をそのまま保護しました。バックアップを復元していない場合は、デバイスを確認してください。} other {Psyche は待機期間の後、セキュリティ記録を再び保護しました。}}",
  "notice.security.firstAdmin.title": "この Mac のコマンドで最初の管理デバイスが作られました",
  "notice.security.firstAdmin.body":
    "{device}{key, select, none {} other {（キー {key}）}}が、この Mac で{via, select, desktop {Psyche アプリから} other {`psyched` を通じて}}最初の管理デバイスになりました。心当たりがない場合は、設定 → デバイスで取り消してください。",
  "notice.security.recovery.title":
    "{state, select, requested {この Mac のコマンドがセキュリティ変更を要求しました} applied {この Mac からのセキュリティ変更を適用しました} cancelled {この Mac からのセキュリティ変更を取り消しました} other {この Mac からのセキュリティ変更を適用できませんでした}}",
  "notice.security.recovery.body":
    "{op, select, approve {デバイス {device}{key, select, none {} other {（キー {key}）}}を {scopes} で承認する。} grant {{device}{key, select, none {} other {（キー {key}）}}に {scopes} を付与する。} presence {新しいキーが登録されるまで、セキュリティ変更に Touch ID やパスキーを求めない。} seal {現在のセキュリティ記録をそのまま受け入れる。} other {セキュリティ変更。}}{state, select, requested {{when, select, none {24 時間後} other {{when}}}に適用されます。Psyche で取り消すこともできます。} failed {{reason, select, none {} other { {reason}}}} other {}}",
  "notice.browser.chrome.title": "Psyche があなたの Chrome を操作しています",
  "notice.browser.chrome.body":
    "タスクが、サインイン済みの Psyche 用 Chrome プロファイルを使っています。ウィンドウのタイトルは「Psyche is driving this window」です。タスクが終わると閉じます。Chrome を終了することもできます。",
  "notice.browser.takeover.title": "ブラウザで Psyche の手助けが必要です",
  "notice.browser.takeover.body":
    "{host} でエージェントが尋ねています: {reason}。ブラウザのペインで操作を引き継ぎ、終わったら戻してください。",
  "notice.connector.consent.title": "Google の接続を完了してください",
  "notice.connector.consent.body":
    "アクセスを許可するには、Psyche が動いているコンピュータでこのリンクを開いてください: {url}",
  "notice.connector.changed.title": "接続が変更されました",
  "notice.connector.changed.body":
    "{reason, select, account_changed {コネクタが別のアカウントでサインインするようになりました。以前のアカウントに紐づく作業は停止しました。} disconnected {コネクタが切断されました。それを必要とする作業は停止しました。} scope_changed {コネクタが読み取り専用になりました。それを通じた保留中の操作は停止しました。} other {コネクタのアクセスが取り消されました。引き続き使うには、もう一度サインインしてください。}}",
  "notice.connector.reconnect.title": "再接続が必要です",
  "notice.connector.reconnect.body":
    "コネクタがアクセスを失いました。もう一度サインインしてください。",
  "notice.attention.paused.title": "タスクがあなたを待っています",
  "notice.attention.paused.body":
    "機密性の高いアプリやサイトで {tool} の前に一時停止しています。Psyche に戻るまで待機します。",
  "notice.apiKey.changed.title":
    "{kind, select, brave {{provider} のキーが{action, select, changed {変更} other {削除}}されました} other {{provider} の API キーが{action, select, changed {変更} other {削除}}されました}}",
  "notice.apiKey.changed.body":
    '{action, select, changed {変更} other {削除}}元: {device, select, none {デバイス} other {"{device}" ({platform}{paired, select, none {} other {、ペアリング日 {paired}}})}}。心当たりがない場合は、設定 → デバイスでこのデバイスを取り消してください。',
  "notice.approvals.digest.title": "{count, plural, other {自動化の操作が#件待っています}}",
  "notice.approvals.digest.body": "承認を開いて、承認または拒否してください",
  "notice.approvals.resumeMissed.title":
    "{automation, select, none {承認した自動化の操作は行われませんでした} other {{automation}：承認した操作は行われませんでした}}",
  "notice.approvals.resumeMissed.body":
    "{why, select, expired {自動化が操作に到達する前に承認の期限が切れたため、何も行われませんでした。まだ必要な場合は、もう一度確認されます。} paused {自動化が一時停止中か削除されたため、再実行されず、何も行われませんでした。まだ必要な場合は、もう一度確認されます。} restart {自動化が再実行される前にPsycheが再起動したため、何も行われませんでした。まだ必要な場合は、もう一度確認されます。} restart_kept {自動化が再実行される前にPsycheが再起動しました。与えた許可は残るため、次回の実行では確認なしでこれを行います。取り消すには、承認の常時許可から取り消してください。} failed {自動化は操作を再実行しましたが、失敗しました。原因はアクティビティで確認できます。まだ必要な場合は、もう一度確認されます。} failed_kept {自動化は操作を再実行しましたが、失敗しました。原因はアクティビティで確認できます。与えた許可は残るため、次回の実行では確認なしでもう一度試します。取り消すには、承認の常時許可から取り消してください。} unknown {自動化は操作を再実行しましたが、成功したかどうかPsycheには判断できません。アクティビティで確認してください。} not_reached_kept {自動化は再実行されましたが、同じ操作に到達しなかったため何も行われませんでした。与えた許可は残るため、次回の実行では確認なしでこれを行います。取り消すには、承認の常時許可から取り消してください。} other {自動化は再実行されましたが、同じ操作に到達しなかったため何も行われませんでした。まだ必要な場合は、もう一度確認されます。}}",
  "notice.specialist.result.title":
    "{outcome, select, done {{who}が{title}を終えました} partial {{who}は{title}を途中で止めました} cancelled {{who}は{title}で停止されました} other {{who}は{title}を完了できませんでした}}",
  "notice.specialist.result.body":
    "{outcome, select, done {完了} partial {一部} cancelled {キャンセル} other {失敗}}{findings, plural, =0 {} other { · # 件の所見}}{cost, select, none {} other { · {cost}}} · {minutes, plural, =0 {1分未満} other {# 分}}",
  "notice.mcp.changed.title": "MCP サーバー {server} のツールが変わりました",
  "notice.mcp.suspicious.title": "MCP サーバー {server} のツールの説明が不審です",
  "notice.mcp.review.body": "このサーバーを使う前に確認してください: {details}",
  "notice.security.tightened.title":
    "{device, select, none {あるデバイス} other {{device}}}からセキュリティ設定が厳しくなりました",
  "notice.security.tightened.body":
    "Psycheができることを減らしただけなので、承認は不要でした。心当たりがない場合は、設定 → デバイスでそのデバイスを取り消してください。",
  "notice.codeRun.held.title": "Psyche は {repo} でのコード実行が作った起動設定を保留しました",
  "notice.codeRun.held.body":
    "サンドボックス内のコマンドが {paths} を作成しました。アプリや次のコマンドがここからコードを実行する可能性があるため、Psyche は削除せずに別の場所へ移しました。あなたやあなたのツールが作ったものなら「残す」をタップしてください。",
  "notice.codeRun.changed.title": "{repo} でのコード実行中に起動設定が変わりました",
  "notice.codeRun.changed.body":
    "サンドボックスでコマンドの実行中に {paths} が変わりました。あなたやエディタによる変更でなければ、フォルダを開く前に確認してください。",
  "notice.codeRun.partial.title": "{repo} は大きすぎて全体を確認できません",
  "notice.codeRun.partial.body":
    "Psyche はコード実行が作る起動設定について、上位のフォルダだけを確認しました。",
  "notice.codeRun.recreated.title": "{repo} のサンドボックスを作り直しました",
  "notice.codeRun.recreated.body":
    "読み取り専用のフォルダが変わったため、実行中のサーバーとリポジトリ外にインストールしたものは消えました。必要なものを再起動してください。",
  "notice.action.keepIt": "残す",
};
