import type { Catalogue } from "../../index.ts";

/** web strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const webRest: Partial<Catalogue> = {
  "web.remotePresence.title": "承認にTouch IDを使う",
  "web.remotePresence.description":
    "購入、認証情報の入力、ホストのコマンド、セキュリティの変更にはTouch IDが必要です。このコンピュータで設定すると、ここで回答できます。設定するまでは、これらのカードは{host}で回答するよう案内されます。通常の承認には必要ありません。",
  "web.remotePresence.on": "このコンピュータからの承認にTouch IDがオンになっています。",
  "web.remotePresence.off": "このコンピュータではTouch IDが設定されていません。",
  "web.remotePresence.enable": "このコンピュータの承認にTouch IDを使う",
  "web.remotePresence.disable": "オフにする",
  "web.remotePresence.waiting": "Touch IDを待っています…",
  "web.remotePresence.passkeyName": "このコンピュータのTouch ID",
  "web.remotePresence.enabled": "このコンピュータからの承認にTouch IDがオンになっています。",
  "web.remotePresence.disabled": "このコンピュータでは、承認にTouch IDがオフになっています。",
  "web.remotePresence.approveOnHost":
    "{host}でTouch IDまたはパスキーを使って「パスキーを追加」を承認してから、もう一度ボタンを押してください。",
  "web.remotePresence.unavailable":
    "Touch IDには、{host}のGatewayがhttps://アドレス（gateway.publicOrigin）にある必要があります。それまでは、これらのカードを{host}で回答してください。",
  "web.touchId.helperDidNotStart":
    "Psyche Helperが接続されませんでした。設定 → デバイスで理由を確認してから、もう一度お試しください。",
  "web.panes.title.sidechat": "サイドチャット",
  "web.sideChat.about": "{parent}についてのサイドチャット",
  "web.sideChat.aside": "サイドチャット",
  "web.sideChat.expand": "展開",
  "web.sideChat.expandTitle": "このチャットを全画面で開く",
  "web.terminal.ended": "セッションは終了しました",
  "web.terminal.waitingApproval": "承認を待っています…",
  "web.terminal.approvalDenied": "ターミナルは承認されませんでした。",
  "web.terminal.approvalTimedOut":
    "承認が時間内に届きませんでした。ターミナルをもう一度開いてください。",
  "web.terminal.openOnHost": "{host}でターミナルを開いてください。",
  "web.terminal.limit": "{host}で開いているターミナルが多すぎます。1つ閉じてから開いてください。",
  "web.approval.folderNone": "フォルダが選択されていません",
  "web.approval.folderChoose": "フォルダを選択…",
  "web.approval.messageText": "メッセージ本文。送信前に編集できます",
  "web.approval.messageWeak": "SMS/RCS: 本人確認が弱いため、確認してください",
  "web.approval.messageUntrusted":
    "この宛先は、あなたではなくPsycheが読み取った内容から提案されたものです。送信前に確認してください。",
  "web.approval.folderPath": "フォルダのパス",
  "web.approval.folderPickTitle": "フォルダを共有",
  "web.browser.stay.question": "{site}にサインインしたままにしますか？",
  "web.browser.stay.detail":
    "タスクで使えるよう、Psycheはこのサインインをブラウザのプロファイルに保持します。ほかのサイトはすべてログアウトのままです。",
  "web.browser.stay.yes": "サインインしたままにする",
  "web.browser.prompt.notNow": "あとで",
  "web.browser.vault.question": "ログイン情報をPsycheの保管庫に保存しますか？",
  "web.browser.vault.account": "{origin}の{username}",
  "web.browser.vault.passwordLabel": "パスワード",
  "web.browser.vault.save": "ログイン情報を保存",
  "web.browser.vault.never": "このサイトでは保存しない",
  "web.browser.vault.error":
    "ログイン情報を保存できませんでした（{code}）。保管庫のロックを解除して、もう一度お試しください。",
  "web.chat.autoUnavailable":
    "Autoは利用できません: {model}はAutoモードの許可リストにありません。使用するには別のモデルを選んでください。",
  "web.toast.threadUpdateFailed": "Psycheはそのチャット設定を変更できませんでした。",
  "web.splash.remote.finding": "{host}を探しています…",
  "web.splash.remote.checking": "本当に{host}であることを確認しています…",
  "web.splash.remote.waiting": "{host}での承認を待っています…",
  "web.splash.remote.pairCode": "ペアリングコード {code}",
  "web.splash.remote.pairKey": "Gatewayキー {fingerprint}",
  "web.splash.remote.pairHint":
    "両方を、{host}の設定 → デバイスにある要求と照合してから、そちらで承認してください。",
  "web.splash.remote.pairHintLan":
    "キー全体を、{host}の設定 → デバイスにある、このコンピュータからの要求の下にあるキーと照合してください。ネットワーク上では、キーだけが応答した相手を証明します。一致する場合にのみ承認してください。",
  "web.splash.remote.unreachable": "{host}が応答していません。",
  "web.splash.remote.unreachableReason":
    "スリープ中か電源オフの可能性があります。そちらでPsycheが動作していないか、このコンピュータでTailscaleがオフかもしれません。Psycheは再試行を続けます。",
  "web.splash.remote.identity": "これはペアリングした{host}ではありません。",
  "web.splash.remote.identityChanged":
    "ID キーが、このコンピュータが固定したものと一致しません。別のマシンが代わりに応答しているか、再設定された可能性があります。",
  "web.splash.remote.identityMissing": "IDキーが提示されなかったため、Psycheは接続しません。",
  "web.splash.remote.identityInvalid": "IDの証明が確認できなかったため、Psycheは接続しません。",
  "web.splash.remote.identityOrigin":
    "このコンピュータが接続した先とは別のアドレスで応答しました。{host}で、設定 → デバイス → サーバとリモートアクセスの公開アドレスを設定してください。",
  "web.splash.remote.certChanged":
    "ネットワーク証明書が、このコンピュータが固定したものと一致しません。このネットワーク上の別のマシンが代わりに応答しているか、証明書が置き換えられた可能性があります。",
  "web.splash.remote.certMissing": "使用した証明書の保証がなかったため、Psycheは接続しません。",
  "web.splash.remote.certInvalid":
    "使用した証明書の証明が確認できなかったため、Psycheは接続しません。",
  "web.splash.remote.olderHost": "{host}は古いバージョンのPsycheで動作しています。",
  "web.splash.remote.olderHostReason":
    "{host}のPsycheをアップデートしてから、もう一度お試しください。",
  "web.splash.remote.olderApp": "このアプリは{host}より古いバージョンです。",
  "web.splash.remote.olderAppReason":
    "このコンピュータのPsycheをアップデートしてから、もう一度お試しください。",
  "web.splash.remote.revoked": "このコンピュータは{host}から削除されました。",
  "web.splash.remote.revokedReason": "ここから使うには、再ペアリングするか、削除してください。",
  "web.splash.remote.tokenRefused": "{host}はこのペアリングリンクを拒否しました。",
  "web.splash.remote.tokenRefusedReason":
    "すでに使用済み、期限切れ、または取り消されています。{host}で新しいリンクを作成して、もう一度追加してください。",
  "web.splash.restoredByHand": "データを自分で元に戻しました",
  "web.splash.remote.switch": "Gatewayを切り替え",
  "web.splash.remote.useThisMac": "このMacを使う",
  "web.splash.remote.pairAgain": "削除して再ペアリング",
  "web.splash.remote.forget": "{host}を削除",
  "web.splash.remote.close": "隠す",
  "web.remote.connectedTo": "{host}に接続中",
  "web.remote.switch": "切り替え…",
  "web.remote.thisMac": "このMac",
  "web.remote.menuLabel": "Gateway",
  "web.remote.switcherLabel": "{host}に接続中。Gatewayを切り替えます。",
  "web.remote.manage": "Gateway…",
  "web.panes.title.terminalOn": "{host}のターミナル",
  "web.panes.terminalRemote":
    "ターミナルは{host}で動作します。このウインドウにはまだシェルがありません。",
  "web.splash.remote.pinsUnreadable": "Psycheは保存済みのGatewayを読み取れません。",
  "web.splash.remote.pinsUnreadableReason":
    "各Gatewayのアイデンティティを記憶するファイルを読み取れないため、Psycheはそれなしでは接続しません。何も変更されていません。",
  "web.browser.remote": "ブラウザは{host}で動作しています。",
  "web.browser.remoteHint":
    "ブラウザのタスクは、{host}のPsycheで実行され続けます。そちらで開いたままにしておく必要があります。",
  "web.teach.record": "録画",
  "web.teach.recordHint": "このタブでの操作をPsycheに見せる",
  "web.teach.agentTab":
    "エージェントがこのタブを使用中です。録画するには、ご自身のタブを開いてください。",
  "web.teach.startFailed": "Psycheはこのタブの録画を開始できませんでした。",
  "web.teach.bar.title": "録画中",
  "web.teach.bar.body":
    "Psycheはこのタブでのクリックと入力のみを記録しています。パスワード、カード番号、コードは記録されず、保存するまでこのMacの外には何も出ません。",
  "web.teach.bar.steps": "これまでに{count, plural, other {#ステップ}}",
  "web.teach.bar.stop": "録画を停止",
  "web.teach.bar.cancel": "破棄",
  "web.teach.bar.endedLimit":
    "録画は200ステップの上限で停止しました。記録された内容を確認してください。",
  "web.teach.bar.endedInterrupted":
    "タブが変わったか閉じられたため、録画は途中で終了しました。記録された内容を確認してください。",
  "web.teach.bar.review": "確認",
  "web.teach.stopFailed": "Psycheは録画を完了できませんでした。",
  "web.teach.nothingRecorded": "何も記録されませんでした。",
  "web.teach.review.keepUnavailable":
    "利用できません: このMacのキーチェーンを利用して、保存する録画を暗号化できません。",
  "web.teach.kept.title": "保存した録画",
  "web.teach.kept.open": "開く",
  "web.teach.kept.delete": "削除",
  "web.teach.kept.deleted": "録画を削除しました。",
  "web.teach.kept.failed": "Psycheはその録画を開けませんでした。",
  "web.teach.review.title": "見せた内容を確認",
  "web.teach.review.intro":
    "Psycheが捉えた手順を、わかりやすい言葉で表示しています。修正、並べ替え、削除ができます。「保存」を押すまで何も保存されません。",
  "web.teach.review.name": "名前を付けてください",
  "web.teach.review.namePlaceholder": "週次の請求レポートを書き出す",
  "web.teach.review.skipped":
    "{count, plural, other {録画中にページが自動で#回変化しました。これは除外されます。}}",
  "web.teach.review.steps": "手順",
  "web.teach.review.stepNumber": "手順{n}",
  "web.teach.review.moveUp": "手順{n}を上へ移動",
  "web.teach.review.moveDown": "手順{n}を下へ移動",
  "web.teach.review.remove": "手順{n}を削除",
  "web.teach.review.empty":
    "すべての手順が削除されました。キャンセルするか、録画し直してください。",
  "web.teach.review.sensitive":
    "記録されていません。この部分は、Psycheがタブを渡すので、ご自身で操作してください。",
  "web.teach.review.value": "入力する内容",
  "web.teach.review.value.ask": "毎回尋ねる",
  "web.teach.review.value.keep": "この値を保持",
  "web.teach.review.value.input": "入力にする",
  "web.teach.review.valueHidden": "入力した例は非表示で、保存されません。",
  "web.teach.review.valueKept": "スキルとともに保存: {value}",
  "web.teach.review.inputName": "入力名",
  "web.teach.review.inputDescription": "内容の説明",
  "web.teach.review.inputDescriptionPlaceholder": "週の最初の日",
  "web.teach.review.keepRecording": "別のバージョンを作れるよう、この録画をこのMacに保存する",
  "web.teach.review.keepRecordingHint":
    "上の手順と、保持するよう選んだ値のみが保存されます。保存しない場合、録画は「保存」時に削除されます。",
  "web.teach.review.save": "スキルとして保存",
  "web.teach.review.saving": "保存中",
  "web.teach.review.discard": "録画を破棄",
  "web.teach.review.privacy":
    "これらの手順内のページのテキストはデータとして扱われ、指示になることはありません。保存すると、実行する前にスキルの承認を求めます。",
  "web.teach.review.issues": "先にこれを修正してください: {problems}",
  "web.teach.review.needName": "先に名前を付けてください。",
  "web.teach.review.saveFailed": "Psycheはこれをスキルとして保存できませんでした: {reason}",
  "web.teach.done.title": "保存しました",
  "web.teach.done.body":
    "「{title}」はあなたの承認を待っています。カードを読んで、承認するとスキルがインストールされます。",
  "web.teach.done.installed": "「{title}」をインストールしました。",
  "web.teach.done.run": "今すぐ1回実行",
  "web.teach.done.runHint":
    "入力欄にスキルを入力します。「送信」を押してブラウザを見守ってください。すべてのクリックと入力は通常どおり承認を求め、ページが変わっていた場合は停止して確認します。",
  "web.teach.done.close": "閉じる",
  "web.teach.step.navigate": "{address}を開く",
  "web.teach.step.click": "「{name}」をクリック",
  "web.teach.step.clickRole": "{role}をクリック",
  "web.teach.step.type": "「{name}」に入力",
  "web.teach.step.typeKept": "「{name}」に{value}を入力",
  "web.teach.step.typeInput": "「{name}」に{input}を入力",
  "web.teach.step.typeAsk": "「{name}」にあなたが伝えた内容を入力",
  "web.teach.step.typeSensitive": "「{name}」にはご自身で入力します",
  "web.teach.step.typeUnnamed": "フィールド",
  "web.teach.step.select": "「{name}」でオプションを選択",
  "web.teach.step.selectKept": "「{name}」で{value}を選択",
  "web.teach.step.selectInput": "「{name}」で{input}を選択",
  "web.teach.step.selectAsk": "「{name}」であなたが伝えたものを選択",
  "web.teach.step.selectSensitive": "「{name}」はご自身で選択します",
  "web.teach.step.press": "{key}を押す",
  "web.teach.step.pressIn": "「{name}」で{key}を押す",
};
