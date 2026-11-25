import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (ja); merged into `../ja.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.install.failed.title": "承認したインストールが完了しませんでした",
  "notice.connectors.matrix.failed.title": "コネクタのルールを保存できませんでした",
  "notice.connectors.matrix.failed.body":
    "{connector} の {action} を適用できなかったため、以前のルールのままです。設定 › コネクタで確認してください。",
  "notice.install.failed.body":
    "{reason, select, lost {承認の前に Psyche が再起動したため、提案は失われました。もう一度提案してください。} expired {承認の前に提案の有効期限が切れていました。もう一度提案してください。} other {Psyche はインストールできませんでした。もう一度提案するか、Psyche に頼んでください。}}",
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
  "notice.connector.syncFailing.title": "{name} が同期されていません",
  "notice.connector.syncFailing.body":
    "{name} の同期が続けて失敗しました ({reason})。Psyche は再試行を続けます。設定 › コネクタで確認してください。",
  "notice.connector.testingExpired.title": "Google からサインアウトされました",
  "notice.connector.testingExpired.body":
    "Psyche の OAuth アプリがテストモードの間、Google は 7 日後にサインアウトします。Google Cloud で OAuth アプリを公開すると解消します。そのあと設定 › コネクタで Google を再接続してください。",
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
  "notice.codeRun.incident.title":
    "Psyche は {repo} でのコード実行によるものではないかもしれないものを保留しました",
  "notice.codeRun.incident.body":
    "{paths} を移す途中で経路上のフォルダが変わったため、移したものは別の場所のものかもしれません。{place} に保管しています。「残す」をタップする前に確認してください。「残す」は {repo} の {paths} に戻します。",
  "notice.codeRun.unmoved.title": "{repo} でのコード実行が作った起動設定がそのまま残っています",
  "notice.codeRun.unmoved.body":
    "サンドボックス内のコマンドが {paths} を作成しましたが、Psyche は別の場所へ移せなかったため、保留されていません。アプリや次のコマンドがここからコードを実行する可能性があります。フォルダを開いたり、そこで何かを実行したりする前に削除してください。中を見るために先にアクセス権を変更しないでください。実行できる状態になるおそれがあります。",
  "notice.codeRun.unchecked.title": "コード実行の後、Psyche は {repo} の一部を確認できませんでした",
  "notice.codeRun.unchecked.body":
    "サンドボックスでコマンドを実行した後、Psyche が {paths} を確認している間にそれが変わったため、中の起動設定は何も確認されていません。あなたやツールが変更したのでなければ、フォルダを開いたり、そこで何かを実行したりする前に確認してください。",
  "notice.machine.added.title": "{name}を Psyche が使えるコンピュータとして追加しました",
  "notice.machine.added.body":
    "Psyche はその画面、アプリ、シェル、ファイルを使えますが、そこでの操作はそのつど先に確認します。心当たりがない場合は、設定 → デバイスから削除してください。",
  "notice.machine.removed.title": "{name}が自分自身を削除しました",
  "notice.machine.removed.body":
    "Psyche が使えるコンピュータでした。もう一度追加しない限り、Psyche はこのコンピュータを使いません。",
  "notice.machine.scanIncomplete.title":
    "コマンドの実行後、{name} の {folder} を最後まで確認できませんでした",
  "notice.machine.scanIncomplete.body":
    "そこにある新しいリポジトリや起動用ファイルは、退避されていない可能性があります。エディタで開いたり git を実行したりする前に、新しい .git や .vscode フォルダがないか確認してください。{name} で Psyche が再起動するまで、コマンドはそこに書き込めません。",
  "notice.machine.offline.title": "{name} がオフラインになりました",
  "notice.machine.offline.body":
    "タスクがこのコンピュータを使うために待っています。{name} が戻ると続きます。タスクをキャンセルすることもできます。",
  "notice.automation.needsApproval.title": "{title} はあなたの承認を待っています",
  "notice.automation.needsApproval.body":
    "承認の期限が切れたため停止しました。「承認」を開いて必要な内容を確認し、もう一度実行してください。",
  "notice.automation.interrupted.title": "{title} は中断されました",
  "notice.automation.interrupted.body":
    "実行中に Psyche が再起動したため、一部がすでに実行された可能性があります。結果を確認し、必要ならもう一度実行してください。",
  "notice.promise.due.title": "もうすぐ期限の約束があります",
  "notice.promise.due.body": "Psyche を開いて、どの約束か確認してください。",
};
