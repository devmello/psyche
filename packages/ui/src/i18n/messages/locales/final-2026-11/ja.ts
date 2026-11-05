import type { Catalogue } from "../../index.ts";

/** Signed connector bundles and teach-by-showing in Mac apps (ja); merged into `../ja.ts`. */
export const final202611: Partial<Catalogue> = {
  "settings.connectorBundle.title": "共有されたコネクタ {name}",
  "settings.connectorBundle.intro":
    "誰かがこのコネクタをファイルとして共有しました。まだ何もインストールされていません。作成者と要求している内容を確認してから決めてください。",
  "settings.connectorBundle.update": "お使いのコネクタのアップデートです。",
  "settings.connectorBundle.signer.title": "作成者",
  "settings.connectorBundle.signer.unsigned":
    "このファイルには署名がないため、誰が作成したかを確かめる方法がありません。",
  "settings.connectorBundle.signer.dropped":
    "インストール済みのバージョンには署名がありました。こちらにはありません。",
  "settings.connectorBundle.signer.new": "{name}が署名。このキーは初めて見るものです。",
  "settings.connectorBundle.signer.seen":
    "{name}が署名。以前に見たことのあるキーですが、信頼はしていません。",
  "settings.connectorBundle.signer.trusted": "{name}が署名。信頼している作成者です。",
  "settings.connectorBundle.signer.own": "あなたが署名。",
  "settings.connectorBundle.signer.changed":
    "{name}が署名していますが、以前に見たキーとは異なります。同じ人物か確認してください。",
  "settings.connectorBundle.signer.impersonates":
    "あなたの名前に似た名前で署名されていますが、キーはあなたのものではありません。",
  "settings.connectorBundle.signer.nameChanged":
    "信頼しているキーが、これまで使っていなかった名前で署名しています：{name}。",
  "settings.connectorBundle.signer.revoked": "取り消したキーで署名されています。",
  "settings.connectorBundle.signer.rotated":
    "{name}が署名。作成者は同じで、キーは新しくなっています（古いキーで署名）。新しいキーは、あなたが信頼するまで信頼されません。",
  "settings.connectorBundle.signer.claim":
    "名前は作成者自身の主張です。作成者を特定できるのはキーだけです。",
  "settings.connectorBundle.signer.key": "作成者キー",
  "settings.connectorBundle.signer.trust": "{name}を作成者として信頼する",
  "settings.connectorBundle.signer.trustHint":
    "変わるのは、以降のファイルのラベルと警告だけです。このカードの確認が省略されることはありません。",
  "settings.connectorBundle.command": "実行するコマンド",
  "settings.connectorBundle.commandHint":
    "最初にプログラム、その後に引数を1行に1つずつ並べます。シェルを経由せずに実行されます。",
  "settings.connectorBundle.network": "要求するネットワーク",
  "settings.connectorBundle.noNetwork": "ネットワークなし",
  "settings.connectorBundle.networkHint":
    "これを強制できるのはサンドボックスだけです。一覧は作成者の申告内容です。",
  "settings.connectorBundle.env": "読み取る変数",
  "settings.connectorBundle.noEnv": "なし",
  "settings.connectorBundle.envHint": "名前だけです。値はインストール後に設定します。",
  "settings.connectorBundle.secrets": "必要なシークレット",
  "settings.connectorBundle.noSecrets": "なし",
  "settings.connectorBundle.secretsHint":
    "名前だけです。ファイルにシークレットは含まれません。インストール後にそれぞれ値を設定すると、保管庫に保存されます。",
  "settings.connectorBundle.tools": "作成者が提供すると申告しているツール",
  "settings.connectorBundle.toolsCount": "{n, plural, other {#個のツール}}",
  "settings.connectorBundle.toolsHint":
    "Psycheはサンドボックス内でこれを起動し、実際に提供されるツールを一覧にします。有効なのはそのツールです。",
  "settings.connectorBundle.toolsUndeclared":
    "ファイルで宣言されていないツールがサーバから一覧に表示されました：{names}",
  "settings.connectorBundle.toolsMissing":
    "ファイルで宣言されていたツールがサーバの一覧にありませんでした：{names}",
  "settings.connectorBundle.files": "同梱のスクリプト（{n}）",
  "settings.connectorBundle.file": "{path} · {bytes} B",
  "settings.connectorBundle.fileBinary": "テキストではないため、ここには表示できません。",
  "settings.connectorBundle.findings": "チェックで見つかったこと",
  "settings.connectorBundle.finding.high": "インストールをブロック：{message}",
  "settings.connectorBundle.finding.warn": "要確認：{message}",
  "settings.connectorBundle.finding.info": "{message}",
  "settings.connectorBundle.sandbox.srt":
    "最初の実行はサンドボックス内で行われます。Psycheはツールを一覧にするためにそこで起動し、その後もそこで実行され続けます。",
  "settings.connectorBundle.sandbox.container":
    "最初の実行はサンドボックスコンテナ内で行われます。Psycheはツールを一覧にするためにそこで起動し、その後もそこで実行され続けます。",
  "settings.connectorBundle.sandbox.none":
    "このMacにはコマンドコネクタ用のサンドボックスがなく、Psycheはサンドボックスの外では実行しません。このコネクタはここにインストールできません。何も起動も保存もされていません。",
  "settings.connectorBundle.blocker.scan":
    "チェックで、インストールをブロックする問題が見つかりました。何も起動も保存もされていません。",
  "settings.connectorBundle.blocker.probe_failed":
    "ネットワークもシークレットもない状態での最初の実行で、起動できませんでした。何も保存されていません。",
  "settings.connectorBundle.signer.ownRetired":
    "あなたが置き換えた、以前のあなたのキーで署名されています。もうあなたのものとしては扱われません。",
  "settings.connectorBundle.signer.retired":
    "{name}が署名。ただし、確認済みのローテーションで置き換えられたキーが使われています。このキーによる新しいファイルは疑わしいものです。",
  "settings.connectorBundle.carry.kept": "引き継がれる、設定済みの値：{names}",
  "settings.connectorBundle.carry.cleared":
    "署名者またはコマンドが変わったため、引き継がれない設定済みの値です。もう一度入力してください：{names}",
  "settings.connectorBundle.carry.vault":
    "以前に保存したシークレットは保管庫に残りますが、このバージョンには渡されません。",
  "settings.connectorBundle.reset.title": "共有コネクタの記録が壊れている場合",
  "settings.connectorBundle.reset.hint":
    "ファイルから追加されたコネクタは、記録を読み取れない間はオフのままです。壊れた記録は別に保管され（直前の正常なコピーがあれば復元されます）、それらのコネクタは削除するか読み込み直すまでオフのままです。",
  "settings.connectorBundle.reset.go": "記録をリセット…",
  "settings.connectorBundle.reset.confirm": "はい、リセットします",
  "settings.connectorBundle.reset.done":
    "記録をリセットしました。{restored, select, true {直前の正常なコピーを復元しました。} other {空の状態から始まります。}}",
  "settings.connectorBundle.reset.failed": "記録をリセットできませんでした：{reason}",
  "settings.connectorBundle.hash": "バンドルID",
  "settings.connectorBundle.close": "閉じる",
  "settings.connectorBundle.widened.title": "お使いのバージョンより多くを要求しています",
  "settings.connectorBundle.widened.hint":
    "このカードを承認すると、これらが許可されます。範囲の狭いバージョン用のカードでは、これらはカバーされていませんでした。",
  "settings.connectorBundle.widened.command": "異なるコマンド",
  "settings.connectorBundle.widened.commandValue": "現在：{now}。以前：{before}",
  "settings.connectorBundle.widened.env": "追加の変数",
  "settings.connectorBundle.widened.secrets": "追加のシークレット",
  "settings.connectorBundle.widened.network": "追加のネットワーク",
  "settings.connectorBundle.widened.tools": "追加のツール、またはより多くのことができるツール",
  "settings.connectorBundle.widened.payload": "異なるスクリプト",
  "settings.connectorBundle.widened.payloadValue": "同梱ファイルが変更されました",
  "settings.connectorBundle.diff": "変更内容",
  "settings.connectorBundle.noChanges": "ほかに変更はありません。",
  "settings.connectorBundle.import.title": "共有コネクタ",
  "settings.connectorBundle.import.hint":
    "ファイルまたはリンクで送られてきたコネクタを読み込みます。何かがインストールされる前に、要求している内容がすべて表示されます。",
  "settings.connectorBundle.import.file": "コネクタファイルを読み込む",
  "settings.connectorBundle.import.linkLabel": "またはリンクを貼り付け",
  "settings.connectorBundle.import.linkPlaceholder": "https://example.com/notes.psyche-connector",
  "settings.connectorBundle.import.review": "確認",
  "settings.connectorBundle.import.checking": "チェック中…",
  "settings.connectorBundle.import.failed": "コネクタを読み込めませんでした：{reason}",
  "settings.connectorBundle.import.tooBig": "そのファイルはコネクタとしては大きすぎます。",
  "settings.connectorBundle.import.denied": "{name}はインストールされませんでした。",
  "settings.connectorBundle.import.lapsed":
    "{expired, select, true {{name}のカードの有効期限が切れました。} other {{name}のカードはもう適用されません。}}確認するには、もう一度読み込んでください。",
  "settings.connectorBundle.import.added":
    "{name}を追加しました。必要なシークレットを下で設定すると、使えるようになります。",
  "settings.connectorBundle.import.addedNoSecrets": "{name}を追加しました。",
  "settings.connectorBundle.import.addFailed": "{name}を追加できませんでした：{reason}",
  "settings.connectorBundle.import.secretsTitle": "{name}のシークレット",
  "settings.connectorBundle.share.title": "このコネクタを共有",
  "settings.connectorBundle.share.hint":
    "コマンド、変数とシークレットの名前、アクセスするネットワーク、ツールを含む署名付きファイルを作成します。値は一切含まれません。含める内容は先に確認します。",
  "settings.connectorBundle.share.go": "共有…",
  "settings.connectorBundle.share.nameLabel": "共有コネクタに表示するあなたの名前",
  "settings.connectorBundle.share.nameHint":
    "あなたのファイルを読み込む人全員にこの名前が表示されます。入力を求めるのは1回だけで、署名キーはこのときに作成されます。",
  "settings.connectorBundle.share.make": "ファイルを作成",
  "settings.connectorBundle.share.label": "{name}を共有",
  "settings.connectorBundle.share.done":
    "{file}を保存しました（{author}として署名）。含まれるのは名前だけで、変数やシークレットの値はありません。",
  "settings.connectorBundle.share.failed": "コネクタを共有できませんでした：{reason}",
  "settings.connectorBundle.share.unavailable":
    "コネクタに署名できるのは、それを実行しているMac上のPsycheだけです。",
  "settings.skills.signer.ownRetired":
    "あなたが置き換えた、以前のあなたのキーで署名されています。もうあなたのものとしては扱われません。",
  "settings.skills.signer.retired":
    "{name}が署名。ただし、確認済みのローテーションで置き換えられたキーが使われています。このキーによる新しいファイルは疑わしいものです。",
  "settings.skills.signer.rotated":
    "{name}が署名。作成者は同じで、キーは新しくなっています（古いキーで署名）。新しいキーは、あなたが信頼するまで信頼されません。",
  "settings.skills.author.state.seen": "確認済み・未信頼",
  "settings.skills.author.state.trusted": "信頼済み",
  "settings.skills.author.state.revoked": "取り消し済み",
  "settings.skills.keys.title": "あなたの作成者キーと通知",
  "settings.skills.keys.hint":
    "共有するスキルとコネクタに署名するキーです。キーを置き換えたり、キーやファイルをもう信頼すべきでないときに通知を公開したりできます。",
  "settings.skills.keys.none":
    "まだ何にも署名していません。キーは、初めてスキルまたはコネクタを共有するときに作成されます。",
  "settings.skills.keys.own": "{name}として署名",
  "settings.skills.keys.fingerprint": "キー",
  "settings.skills.keys.rotate": "自分のキーを置き換える…",
  "settings.skills.keys.rotateHint":
    "同じ名前で新しいキーを作成します。古いキーが新しいキーを示す声明に署名するので、あなたを信頼していた人には、同じ作成者が新しいキーを使っているように見えます。それでも、新しいキーは相手自身が信頼する必要があります。先に確認が求められます。",
  "settings.skills.keys.rotateLabel": "作成者キーを置き換える",
  "settings.skills.keys.rotated": "キーを置き換えました。新しいキーは{key}です。",
  "settings.skills.keys.rotateFailed": "キーを置き換えられませんでした：{reason}",
  "settings.skills.keys.notice.title": "通知を公開",
  "settings.skills.keys.notice.hint":
    "通知は署名付きの小さなファイルです。送るか公開しておくと、あなたのキーを知っている人が読み込んで、キーまたは1つのファイルをブロックできます。",
  "settings.skills.keys.notice.kindKey": "自分のキー（現在のもの）",
  "settings.skills.keys.notice.kindBundle": "共有した1つのファイル（バンドルIDで指定）",
  "settings.skills.keys.notice.kind": "問題の対象",
  "settings.skills.keys.notice.hash": "バンドルID（sha256:…）",
  "settings.skills.keys.notice.reason": "理由（読み込んだ全員に表示されます）",
  "settings.skills.keys.notice.make": "通知を作成",
  "settings.skills.keys.notice.label": "取り消し通知に署名",
  "settings.skills.keys.notice.done": "{file}を保存しました。好きな方法で公開してください。",
  "settings.skills.keys.notice.failed": "通知を作成できませんでした：{reason}",
  "settings.skills.keys.import.title": "取り消し通知を読み込む",
  "settings.skills.keys.import.hint":
    "会ったことのある作成者が署名している場合にのみ適用されます。できるのはブロックだけで、何かを信頼することはありません。",
  "settings.skills.keys.import.file": "通知ファイルを読み込む",
  "settings.skills.keys.import.linkLabel": "またはリンクを貼り付け",
  "settings.skills.keys.import.linkPlaceholder": "https://example.com/revoke.psyche-notice",
  "settings.skills.keys.import.go": "読み込む",
  "settings.skills.keys.import.key": "キー{key}をブロックしました。示された理由：{reason}",
  "settings.skills.keys.import.bundle": "ファイル{hash}をブロックしました。示された理由：{reason}",
  "settings.skills.keys.import.previewKey":
    "キー{key}{names, select, none {} other {（{names}として知られています）}}を取り消します。署名者が示した理由：{reason}",
  "settings.skills.keys.import.previewBundle":
    "ファイル{hash}をブロックします。署名者が示した理由：{reason}",
  "settings.skills.keys.import.already": "すでに有効です。",
  "settings.skills.keys.import.apply": "適用",
  "settings.skills.keys.import.signedBy": "{name}が署名。",
  "settings.skills.keys.import.failed": "通知を使用できませんでした：{reason}",
  "web.teach.app.record": "アプリで録画",
  "web.teach.app.recordHint": "すでに許可したMacアプリでの操作をPsycheに見せます",
  "web.teach.app.pickTitle": "どのアプリで録画しますか？",
  "web.teach.app.pickLabel": "アプリ",
  "web.teach.app.pickHint":
    "コンピュータ操作を許可したアプリだけが表示されます。先にアプリを開いてください。パスワード、カード番号、コードは録画されません。Psyche自身のウインドウや、サインインとセキュリティの確認画面も同様です。",
  "web.teach.app.none":
    "録画できるアプリがありません。設定でコンピュータ操作をオンにして、先にアプリに「クリック」または「操作」を許可してください。",
  "web.teach.app.start": "録画を開始",
  "web.teach.app.cancelPick": "今はしない",
  "web.teach.app.startFailed":
    "Psycheはそのアプリの録画を開始できませんでした。先にアプリを開き、Psycheにアクセシビリティの権限があることを確認してください。",
  "web.teach.app.bar.title": "{app}を録画中",
  "web.teach.app.bar.body":
    "Psycheは{app}でのクリック、メニューの選択、入力だけを記録します。保護されたフィールドは記録されず、スクリーンショットも撮られず、保存するまで何もこのMacの外には出ません。メニューバーにも停止ボタンがあります。",
  "web.teach.app.bar.endedLimit":
    "録画は200ステップの上限で停止しました。記録された内容を確認してください。",
  "web.teach.app.bar.endedTimeout":
    "録画は制限時間で停止しました。記録された内容を確認してください。",
  "web.teach.app.bar.endedInterrupted":
    "アプリが閉じたため、録画は途中で終了しました。記録された内容を確認してください。",
  "web.teach.app.stopFailed": "Psycheは録画を完了できませんでした。",
  "web.teach.app.skipped":
    "{count, plural, other {#件を除外しました：保護されたフィールド、または見つけるための名前がないコントロールです。}}",
  "web.teach.app.privacy":
    "これらのステップのテキストは、アプリのウインドウとメニューから取得したものです。データとして扱われ、指示として扱われることはありません。保存すると、実行する前にスキルの承認を求められます。",
  "web.teach.app.sensitive": "記録されていません。この部分はPsycheからあなたにお願いします。",
  "web.teach.app.runHint":
    "メッセージ欄にスキルを入力します。送信を押して、アプリの動きを見守ってください。すべてのクリックと入力はいつも通り承認を求め、何かが以前の場所にない場合は停止して確認します。",
  "web.teach.step.app.click": "{app}で「{name}」をクリック",
  "web.teach.step.app.clickRole": "{app}で{role}をクリック",
  "web.teach.step.app.menu": "{app}で{path}を選択",
  "web.teach.step.app.type": "{app}で「{name}」に入力",
  "web.teach.step.app.typeKept": "{app}で「{name}」に{value}を入力",
  "web.teach.step.app.typeInput": "{app}で「{name}」に{input}を入力",
  "web.teach.step.app.typeAsk": "{app}で「{name}」に指定した内容を入力",
  "web.teach.step.app.typeSensitive": "{app}では「{name}」にご自身で入力",
  "app.integrity.title": "Psyche のファイルが変更されました",
  "app.integrity.detail":
    "この Psyche は、公開時の署名と一致しなくなりました。何かが書き換えた可能性があります。公式のダウンロードから入れ直すまで、Psyche はマイク、画面、Apple イベント、連絡先、カレンダーの機能をオフにしたままにします。 Psyche のバックグラウンドサービス（Gateway）は動き続けます。",
  "app.integrity.blocked":
    "オフになっています: この Psyche は変更されています。公式のダウンロードから入れ直してください。",
  "app.integrity.ok": "OK",
};
