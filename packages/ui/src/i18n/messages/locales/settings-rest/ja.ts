import type { Catalogue } from "../../index.ts";

/** settings strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const settingsRest: Partial<Catalogue> = {
  "settings.appearance.accent.ink": "インク",
  "settings.appearance.gray.paper": "ペーパー",
  "settings.nav.daily": "デイリー",
  "settings.daily.title": "デイリー",
  "settings.daily.description":
    "朝の概要と夕方のまとめを、ホームに表示します。Psycheは読み取るだけで、承認なしに何かを送信することはありません。",
  "settings.daily.loadFailed": "デイリーの設定を読み込めませんでした。",
  "settings.daily.group.brief": "朝の概要",
  "settings.daily.group.wrapup": "夕方のまとめ",
  "settings.daily.group.delivery": "表示場所",
  "settings.daily.group.followups": "フォローアップの設定",
  "settings.daily.group.automations": "オートメーション",
  "settings.key.daily.brief.enabled": "朝の概要",
  "settings.key.daily.wrapup.enabled": "夕方のまとめ",
  "settings.key.daily.notify": "通知する",
  "settings.key.daily.messages": "メッセージでも送信",
  "settings.key.daily.followups.enabled": "フォローアップを追跡",
  "settings.key.daily.brief.time": "朝の概要の時刻",
  "settings.key.daily.wrapup.time": "夕方のまとめの時刻",
  "settings.key.daily.followups.sensitivity": "追跡する範囲",
  "settings.daily.time": "時刻",
  "settings.daily.notify.hint": "カードとともに通知します。おやすみ時間中は終了まで保留されます。",
  "settings.daily.messages.hint": "メッセージチャンネルが必要です。あなたにだけ送信されます。",
  "settings.daily.sensitivity": "追跡する範囲",
  "settings.daily.sensitivity.low": "日付のある明確な約束のみ",
  "settings.daily.sensitivity.normal": "約束と依頼（推奨）",
  "settings.daily.sensitivity.high": "自分が「やる」と言ったこと全般",
  "settings.daily.runNow": "今すぐプレビュー",
  "settings.daily.runFailed": "カードを作成できませんでした。",
  "settings.key.nudges.enabled": "人間関係のナッジ",
  "settings.key.nudges.consentedAt": "人間関係のナッジへの同意",
  "settings.key.nudges.sensitivity": "ナッジの頻度",
  "settings.key.nudges.phrasing": "ナッジの提案を言い換える",
  "settings.shared.advanced": "詳細設定",
  "settings.nav.inPage": "{page}内",
  "settings.nav.essentials": "基本",
  "settings.nav.learning": "基礎",
  "settings.search.count": "{count, plural, other {#件の結果}}",
  "settings.search.result.page": "ページ",
  "settings.page.essentials": "基本",
  "settings.page.essentials.description":
    "多くの人が選ぶ、いくつかの項目です。それぞれ安全な初期値があり、残りは以下のページにあります。",
  "settings.page.general.description":
    "{persona}の見た目、人柄、割り込んでよい時間帯、話しかけ方を設定します。",
  "settings.page.model.description":
    "{persona}が考えるときに使うモデル、そのキー、料金を設定します。",
  "settings.page.connectors.description":
    "{persona}が使えるアプリやアカウントと、検索対象にするものを設定します。",
  "settings.page.memory.description":
    "{persona}が覚えていること、学習元、その管理方法を設定します。",
  "settings.page.daily.description":
    "朝の概要と夕方のまとめ、オートメーション、スキル、{persona}が呼び出せるスペシャリストを設定します。",
  "settings.page.permissions.description":
    "{persona}がこのMacで確認なしにできること、必ず確認を求める場面を設定します。",
  "settings.page.data.description":
    "このMacに残るデータ、保存期間、書き出し、バックアップ、初期化を管理します。",
  "settings.page.devices.description":
    "ほかのデバイス、Gatewayサーバ、外出先から{persona}に接続する方法を設定します。",
  "settings.page.about.description": "バージョン、ヘルスチェック、ログ。",
  "settings.essentials.title": "基本",
  "settings.essentials.description":
    "多くの人が選ぶ、いくつかの項目です。それぞれ安全な初期値があります。ほかに必要なことがあれば{persona}が尋ねます。",
  "settings.essentials.more": "その他",
  "settings.essentials.moreIn": "{place}のその他の設定",
  "settings.essentials.model.title": "モデル",
  "settings.essentials.model.thinksWith": "{persona}が考えるときに使うもの",
  "settings.essentials.model.ready": "準備完了",
  "settings.essentials.model.noKey": "キーが必要",
  "settings.essentials.model.none": "モデルがありません",
  "settings.essentials.model.noneHint":
    "{persona}が答えるにはモデルが必要です。キーを追加するか、このMacのモデルを使ってください。",
  "settings.essentials.model.setUp": "モデルを設定",
  "settings.essentials.read.title": "{persona}が読んでよいもの",
  "settings.essentials.read.hint":
    "オンにするまではオフです。読み取った内容は、探し物をしやすくするためにこのMac上でインデックス化され、メモリの「情報源」でオプトアウトしない限り、メモリの学習にも使われます。",
  "settings.essentials.asks.title": "{persona}が先に確認する頻度",
  "settings.essentials.interrupt.title": "{persona}が割り込んでよい時間",
  "settings.essentials.interrupt.quietHint":
    "{from}から{until}まで、通知は受信トレイで待機します。",
  "settings.essentials.interrupt.briefHint": "{time}に、フィードに短い概要が届きます。",
  "settings.essentials.memory.title": "メモリ",
  "settings.essentials.memory.remember": "{persona}にチャットを覚えさせる",
  "settings.essentials.memory.rememberHint":
    "オフにするとメモリが一時停止します。オンに戻すまで、チャットから新たに記憶やインデックス化は行われません。",
  "settings.essentials.rest":
    "これ以外の項目や、それぞれの細かな設定は、以下のページにあります。設定を検索すれば見つかります。",
  "settings.searchModel.title": "検索用のモデル",
  "settings.searchModel.description":
    "質問の読み取り、コンテキストカードの作成、結果の並べ替えに使うモデルです。",
  "settings.searchModel.utility": "ユーティリティモデル",
  "settings.searchModel.utilityHint":
    "「モデル」で設定した小型モデルです。クラウドモデルの場合、読み取るテキストはそのプロバイダに送信されます。",
  "settings.searchModel.apple": "非公開の検索処理にAppleのオンデバイスモデルを使う",
  "settings.searchModel.appleName": "Appleのオンデバイスモデル",
  "settings.searchModel.appleHint":
    "テキストはこのMacの外に出ません。ダウンロードもキーも不要で、クラウドには何も送信されません。一度に読み取れるのは約{k}kトークンのため、長いテキストはスキップされます。答えられない場合、その処理はスキップされ、クラウドモデルに切り替わることはありません。",
  "settings.searchModel.apple.why.off":
    "Apple Intelligenceがオフです。システム設定の「Apple IntelligenceとSiri」でオンにしてください。",
  "settings.searchModel.apple.why.os": "このMacにはmacOS 26以降が必要です。",
  "settings.searchModel.apple.why.device":
    "このMacまたは地域はApple Intelligenceに対応していません。",
  "settings.searchModel.apple.why.notReady":
    "Appleがモデルを準備中です。しばらくしてからもう一度お試しください。",
  "settings.searchModel.apple.why.unknown": "モデルは現在利用できません。",
  "settings.searchModel.apple.whySkipped": "それまでは、これらの処理はスキップされます。",
  "settings.searchModel.apple.host":
    "これは{host}の設定です。モデルはこのコンピュータではなく{host}で動作し、変更はすべてのウインドウに適用されます。",
  "settings.searchModel.apple.ready": "このMacで利用可能",
  "settings.searchModel.apple.needsAi": "Apple Intelligenceが必要",
  "settings.searchModel.apple.notReady": "準備中",
  "settings.searchModel.apple.notOnThisMac": "このMacでは利用できません",
  "settings.searchModel.apple.unavailable": "現在利用できません",
  "settings.search.advancedHint": "質問を読み取るモデル",
  "settings.search.description":
    "探し物を見つけやすくするためにPsycheがインデックス化する対象と、Web検索で使うエンジンです。",
  "settings.nav.specialists": "スペシャリスト",
  "settings.nav.notifications": "通知",
  "settings.nav.people": "人物とプライバシー",
  "settings.key.appearance.showInDock": "ウインドウがないときもDockに表示",
  "settings.key.appearance.openAtLogin": "ログイン時にPsycheを開く",
  "settings.key.browser.useSignedInSessions": "サインイン済みのセッションを使う",
  "settings.key.exec.srtPath": "srtの場所",
  "settings.key.devices.hostHelper.status": "Linux ヘルパーの確認",
  "settings.key.search.model.engine": "検索用のモデル",
  "settings.key.search.semantic.enabled": "セマンティック検索（オンデバイス）",
  "settings.key.search.cards.enabled": "検索用のコンテキストカード",
  "settings.semanticSearch.cardsHint":
    "小型のクラウドモデルが、保存した各項目の短い要約を作成します。1日あたり約200,000トークンが上限です。",
  "settings.key.search.encrypt": "検索インデックスを暗号化",
  "settings.semanticSearch.encryptHint":
    "別に保管されたキーがなければ検索インデックスを読めないようにします。次回の起動時に適用され、インデックスが一度再構築されます。",
  "settings.semanticSearch.encrypt.on": "インデックスは暗号化済み",
  "settings.semanticSearch.encrypt.pending":
    "Macヘルパーが暗号化インデックスを開くのを待っています",
  "settings.semanticSearch.encrypt.unavailable": "暗号化されていません: {why}",
  "settings.key.search.rerank.enabled": "小型のクラウドモデルで上位の結果を並べ替える",
  "settings.semanticSearch.rerankHint":
    "小型のクラウドモデルが最適な結果を上位に並べます。上位20件のスニペットがこのMacの外に送信されます。初期値はオフです。",
  "settings.key.search.runOnBattery": "バッテリー駆動中もインデックス化",
  "settings.key.search.queryModel.enabled": "小型モデルで質問を読み取る",
  "settings.semanticSearch.queryModelHint":
    "小型のクラウドモデルが、時間・人物・情報源の絞り込み条件を判断します。送信されるのは質問のみで、項目は送信されません。",
  "settings.key.search.semantic.engine": "埋め込みエンジン",
  "settings.key.search.semantic.allowCloud": "クラウドの埋め込みサービスを許可",
  "settings.key.memory.recall.mode": "メモリの呼び出し方法",
  "settings.key.widgets.remoteImages": "ウィジェット内のリモート画像",
  "settings.key.ui.map.tiles": "地図タイル",
  "settings.key.ui.map.styleUrl": "地図スタイルのURL",
  "settings.key.ui.map.styleUrlDark": "地図スタイルのURL（ダーク）",
  "settings.key.teaching.enabled": "フィードバックから学習",
  "settings.key.teaching.implicit": "編集、取り消し、却下を検知",
  "settings.key.teaching.paused": "学習を一時停止",
  "settings.key.teaching.weeklyCard": "毎週の「学んだこと」カード",
  "settings.key.memory.graph": "人物とプロジェクト",
  "settings.key.memory.everything": "バックグラウンドのメモリ",
  "settings.key.agent.showReasoning": "作業中の思考を表示",
  "settings.key.data.reasoningRetentionDays": "思考の保存期間",
  "settings.key.notifications.quietHours.enabled": "おやすみ時間",
  "settings.key.notifications.quietHours.start": "開始時刻",
  "settings.key.notifications.quietHours.end": "終了時刻",
  "settings.notifications.title": "通知",
  "settings.notifications.description": "Psycheが割り込んでよいタイミング。",
  "settings.notifications.group.quietHours": "おやすみ時間",
  "settings.notifications.quietHours.hint":
    "設定した時間が終わるまで通知を保留します。時間に制約のある承認は通常どおり届きます。",
  "settings.key.ui.onboarding.progress": "オンボーディングの進行状況",
  "settings.key.permissions.liftedFloors": "{id}で確認なしに許可する操作",
  "settings.key.specialists.maxConcurrent": "同時に動くスペシャリスト数",
  "settings.key.specialists.monthlyCapUsd": "スペシャリストの月間利用額",
  "settings.key.specialists.showInFeed": "スペシャリストの結果をフィードに表示",
  "settings.key.specialists.enabled": "{role}をオン",
  "settings.key.specialists.model": "{role}のモデル",
  "settings.key.specialists.budget": "{role}の予算",
  "settings.key.specialists.maxMode": "{role}の権限モード",
  "settings.credentials.payments.description":
    "各購入を承認すると、1回限りのカードが使われます。カード番号がPsycheに渡ることはありません。",
  "settings.approval.presenceUnavailable":
    "このウインドウでは本人確認ができません。MacのPsycheアプリ（Touch ID）か、パスキーのあるデバイスで変更を承認してください。それまで何も変更されません。",
  "settings.doctor.gateway": "Gateway",
  "settings.doctor.gatewayOk": "応答しています。",
  "settings.doctor.model": "モデル",
  "settings.doctor.noModel": "モデルがまだ選択されていません。設定 → モデルで追加してください。",
  "settings.doctor.sandbox": "サンドボックス",
  "settings.doctor.noSandbox":
    "利用できるサンドボックスがないため、コマンドはブロックされたままです。",
  "settings.doctor.memory": "メモリ",
  "settings.doctor.memoryPaused": "メモリは一時停止中です。新たに記憶されることはありません。",
  "settings.doctor.memoryOk": "メモリに{files, plural, other {#個のファイル}}があります。",
  "settings.appearance.description": "ペアリング済みのすべてのデバイスに適用されます。",
  "settings.appearance.colors": "カラー",
  "settings.appearance.colorsHint": "ライトまたはダーク、およびアクセントカラー。",
  "settings.appearance.comfort": "快適さ",
  "settings.appearance.comfortHint": "目や動きへの負担を軽くします。",
  "settings.appearance.backgroundHint": "ウインドウを閉じてもPsycheを動かし続けるかどうか。",
  "settings.appearance.advancedHint":
    "グレーの色調、カスタムカラー、文字の方向、コントラストチェック",
  "settings.appearance.fineTune": "色を細かく調整",
  "settings.appearance.fineTuneHint": "細かく見た目を決めたい方向けです。",
  "settings.appearance.contrastCheck": "コントラストチェック",
  "settings.appearance.contrastCheckHint": "各テーマの読みやすさを段階ごとに確認します。",
  "settings.appearance.background": "バックグラウンド",
  "settings.appearance.showInDockHint":
    "オフの場合、最後のウインドウを閉じてもPsycheはメニューバーで動き続けます。",
  "settings.appearance.openAtLoginHint":
    "サインイン時にメニューバーでPsycheを起動し、スケジュール済みのオートメーションがいつでも実行できるようにします。",
  "settings.appearance.glass.hint":
    "メニュー、ポップオーバー、入力欄の背後が透けて見えるようにします。",
  "settings.browser.description":
    "{persona}は専用のウインドウでブラウズします。実際のChromeモードでは、一度サインインする別のプロファイルを使います。",
  "settings.browser.signedIn.title": "サインイン済みのサイト",
  "settings.browser.signedIn.description":
    "Psycheのブラウザでサインインしているサイトです。タスクはこのサインインを再利用します。",
  "settings.browser.signedIn.auto": "自動で検出",
  "settings.browser.useSignedIn.title": "サインイン済みのセッション",
  "settings.browser.useSignedIn.description":
    "{persona}は同じサイトであなたのサインインを使い続けます。書き込み、購入、送信は引き続き先に確認します。",
  "settings.browser.useSignedIn.label": "Psycheにサインイン済みのセッションを使わせる",
  "settings.browser.useSignedIn.hint":
    "初期値はオンです。オフにすると、サインインを維持するよう選んだサイト以外は、すべてログアウトした状態で開きます。",
  "settings.browser.signedIn.none": "サインイン済みのサイトはまだありません。",
  "settings.browser.signedIn.viaHosts": "{hosts}経由でもサインイン済み",
  "settings.browser.signedIn.forget": "サインアウト / 削除",
  "settings.browser.signedIn.loadFailed":
    "Psycheはサインイン済みのサイトを一覧表示できませんでした（{reason}）。",
  "settings.browser.signedIn.forgetFailed":
    "Psycheは{site}からサインアウトできませんでした（{reason}）。",
  "settings.computerUse.appsHint": "各アプリでPsycheが操作できる範囲。",
  "settings.connectors.catalog.appleShortcuts": "ショートカット",
  "settings.connectors.catalog.obsidian": "Obsidian",
  "settings.connectors.trust.verified": "確認済み",
  "settings.connectors.filter.label": "表示",
  "settings.connectors.filter.all": "すべて",
  "settings.connectors.filter.apps": "アプリ",
  "settings.connectors.filter.mcp": "MCPサーバ",
  "settings.connectors.configureFailed": "Psycheは{name}の設定を保存できませんでした: {reason}",
  "settings.shortcuts.title": "ショートカット",
  "settings.shortcuts.loading": "このMacからショートカットを読み込んでいます…",
  "settings.shortcuts.none": "ショートカットAppにショートカットがまだありません。",
  "settings.shortcuts.noHelper":
    "MacでPsycheを開くとショートカットを一覧表示できます。ヘルパーが読み取ります。",
  "settings.shortcuts.failed": "Psycheはショートカットを読み取れませんでした。",
  "settings.shortcuts.hint":
    "オフ: 実行しません。確認: 毎回カードを表示します。許可: 確認なしで実行します（読み取りのみのショートカットに限る）。",
  "settings.shortcuts.rule.off": "オフ",
  "settings.shortcuts.rule.ask": "確認",
  "settings.shortcuts.rule.allow": "許可",
  "settings.shortcuts.actions": "Psycheアクション",
  "settings.shortcuts.install": "インストール",
  "settings.shortcuts.installNamed": "{name}をインストール",
  "settings.shortcuts.installed": "インストール済み",
  "settings.trusted.title.reminders": "リマインダーのリスト",
  "settings.trusted.title.notes": "メモのフォルダ",
  "settings.trusted.title.calendar": "カレンダー",
  "settings.trusted.none.reminders": "リマインダーのリストはまだありません。",
  "settings.trusted.none.notes": "メモにフォルダがまだありません。",
  "settings.trusted.none.calendar": "カレンダーはまだありません。",
  "settings.trusted.loading": "このMacから読み込んでいます…",
  "settings.trusted.noHelper": "MacでPsycheを開くと一覧表示できます。ヘルパーが読み取ります。",
  "settings.trusted.failed": "PsycheはこのMacから読み取れませんでした。",
  "settings.trusted.toggle": "自分のもの — 信頼済みとして扱う",
  "settings.trusted.shared": "共有",
  "settings.trusted.hint":
    "これを読み取っても、チャットが再度確認を求めることはなくなります。ほかの人が編集できないリストにのみオンにしてください。",
  "settings.obsidian.vault": "Vaultフォルダ",
  "settings.obsidian.newVault": "新しいVaultフォルダ",
  "settings.obsidian.noVault": "Vaultが選択されていません",
  "settings.obsidian.vaultHint":
    "Psycheは共有フォルダ（設定 → 権限 → アクセス）を通じてVaultを読み取ります。共有してから使用してください。",
  "settings.obsidian.share": "このフォルダを共有",
  "settings.obsidian.shared": "共有済み",
  "settings.obsidian.useVault": "このVaultを使用",
  "settings.obsidian.change": "Vaultを変更…",
  "settings.obsidian.daily": "デイリーノートのフォルダ",
  "settings.obsidian.dailyPlaceholder": "ObsidianのDaily notes設定から",
  "settings.connectors.can.title": "{persona}にできること",
  "settings.connectors.can.label": "{persona}が{name}でできること",
  "settings.connectors.can.alwaysAsks": "常に先に確認",
  "settings.connectors.can.asksByDefault": "許可しない限り先に確認",
  "settings.connectors.can.lifted": "確認なしで実行",
  "settings.connectors.can.liftWhat": "{name}での{action}",
  "settings.connectors.can.readOnly": "{name}が読み取り専用で接続されている間はオフ",
  "settings.connectors.can.mail.read.title": "メールを読む",
  "settings.connectors.can.mail.read.lines":
    "未読を含めてメールを読み、検索 · メールボックスごとの未読数を確認 · 選択中のメールを使用",
  "settings.connectors.can.mail.draft.title": "メールの下書き",
  "settings.connectors.can.mail.draft.lines":
    "新規メール、返信、転送の下書きを作成（保存のみ、送信はしません）",
  "settings.connectors.can.mail.organize.title": "メールを整理",
  "settings.connectors.can.mail.organize.lines":
    "既読にする、フラグを付ける、振り分け、アーカイブ · 添付ファイルを保存",
  "settings.connectors.can.mail.send.title": "メールを送信",
  "settings.connectors.can.mail.send.lines": "メールと保存済みの下書きを送信",
  "settings.connectors.can.notes.read.title": "メモを読む",
  "settings.connectors.can.notes.read.lines": "メモとフォルダを検索、一覧表示、読み取り",
  "settings.connectors.can.notes.create.title": "メモを書く",
  "settings.connectors.can.notes.create.lines": "メモの作成と追記",
  "settings.connectors.can.reminders.read.title": "リマインダーを読む",
  "settings.connectors.can.reminders.read.lines": "期限、期限切れ、フラグ付きの項目を確認",
  "settings.connectors.can.reminders.write.title": "リマインダーを変更",
  "settings.connectors.can.reminders.write.lines": "リマインダーの追加、完了、フラグ設定",
  "settings.connectors.can.calendar.read.title": "カレンダーを読む",
  "settings.connectors.can.calendar.read.lines": "予定、参加者、会議リンクを確認 · 空き時間を検索",
  "settings.connectors.can.calendar.write.title": "カレンダーを変更",
  "settings.connectors.can.calendar.write.lines": "予定の追加、移動、変更",
  "settings.connectors.grant.allowed":
    "システム設定 → プライバシーとセキュリティ → {grant}で許可済み",
  "settings.connectors.grant.automation": "オートメーション → {app}",
  "settings.connectors.grant.calendars": "カレンダー",
  "settings.connectors.grant.reminders": "リマインダー",
  "settings.connectors.grant.contacts": "連絡先",
  "settings.connectors.grant.photos": "写真",
  "settings.connectors.app.mail": "メール",
  "settings.connectors.app.notes": "メモ",
  "settings.connectors.app.music": "ミュージック",
  "settings.connectors.app.safari": "Safari",
  "settings.connectors.app.chrome": "Google Chrome",
  "settings.connectors.app.things": "Things",
  "settings.connectors.app.shortcuts": "ショートカット",
  "settings.connectors.try.title": "試してみる",
  "settings.connectors.try.mail.unread": "今日の未読メールは？",
  "settings.connectors.try.mail.reminder": "選択中のメールからリマインダーを作成して",
  "settings.connectors.try.mail.reply": "Danaからの最新のメールに返信の下書きを作って",
  "settings.connectors.try.notes.find": "オフサイトについてのメモを探して",
  "settings.connectors.try.notes.append": "今日の決定事項をオフサイトのメモに追加して",
  "settings.connectors.try.reminders.due": "今日期限のものは？",
  "settings.connectors.try.reminders.add": "明日の9時に歯医者に電話するようリマインドして",
  "settings.connectors.try.calendar.today": "今日の予定は？",
  "settings.connectors.try.calendar.focus": "明日の午前中に集中時間として2時間確保して",
  "settings.connectors.actionFailed":
    "Psycheは{name}を変更できませんでした（{reason}）。何も変更されていません。",
  "settings.mcp.badge": "MCP",
  "settings.mcp.showDetails": "詳細を表示",
  "settings.mcp.hideDetails": "詳細を隠す",
  "settings.sandbox.setUp": "サンドボックスを設定",
  "settings.mcp.sandboxHelp": "コマンドサーバにはこのMac上のサンドボックスが必要です。",
  "settings.sandbox.title": "サンドボックスを設定",
  "settings.sandbox.why":
    "コマンドはあなたのファイルとともにMac上で実行されますが、保管庫、キー、Psycheの非公開データは読み取れません。",
  "settings.sandbox.whyHow":
    "macOS標準のサンドボックス上で、Anthropicのサンドボックスランタイムであるsrtを使います。仮想マシンは不要です。",
  "settings.sandbox.privacy":
    "Psycheが自動でインストールすることはありません。以下の手順をご自身で実行するか、ダウンロードページを開いてください。",
  "settings.sandbox.checking": "このMacを確認しています…",
  "settings.sandbox.checkAgain": "もう一度確認",
  "settings.sandbox.done": "完了",
  "settings.sandbox.copy": "コピー",
  "settings.sandbox.copied": "コピーしました",
  "settings.sandbox.ready": "準備完了",
  "settings.sandbox.srt.ready": "srtは{path}に設定されています。コマンドサーバを追加できます。",
  "settings.sandbox.srt.missing.title": "srtをインストール",
  "settings.sandbox.srt.missing.body":
    "srtはnpmから入手します。コマンドが書き込み権限を求めた場合は、ご自身のアカウントの権限で実行してください。Psycheが代わりに実行することはありません。",
  "settings.sandbox.srt.install": "npmでインストール",
  "settings.sandbox.srt.link": "GitHubでsrtについて読む",
  "settings.sandbox.srt.thenCheck": "そのあと、もう一度確認",
  "settings.sandbox.srt.thenCheckBody":
    "PsycheはPATH、Homebrewとnpmのフォルダからsrtを見つけます。再起動は不要です。",
  "settings.sandbox.srt.broken":
    "{path}のsrtは使用できません: {problem, select, not_absolute {パスは/で始まる必要があります} not_executable {実行できるプログラムがありません} other {見つかりませんでした}}。",
  "settings.sandbox.srt.fromEnv":
    "この場所はPSYCHE_SRT_PATHで指定されているため、ここでは変更できません。",
  "settings.sandbox.srt.installButton": "Psycheでインストール",
  "settings.sandbox.srt.reinstallButton": "再インストール",
  "settings.sandbox.srt.updateButton": "srtをアップデート",
  "settings.sandbox.srt.installOr": "またはPsycheにインストールを任せる",
  "settings.sandbox.srt.installConfirm.title": "srt {version}をインストールしますか？",
  "settings.sandbox.srt.installConfirm.body":
    "Psycheはnpmレジストリ（registry.npmjs.org）から{package} {version}とその依存関係をダウンロードし、このバージョンのPsycheに組み込まれたチェックサムで各ファイルを検証して、独自のNodeで展開します。システム全体へのインストールは行わず、インストールスクリプトも実行せず、パスワードも不要です。",
  "settings.sandbox.srt.installConfirm.where": "{dir}に配置されます",
  "settings.sandbox.srt.installConfirm.go": "インストール",
  "settings.sandbox.srt.installConfirm.cancel": "キャンセル",
  "settings.sandbox.srt.installing": "srtをインストールしています…",
  "settings.sandbox.srt.installed": "Psycheがインストールしました: srt {version}。",
  "settings.sandbox.srt.installFailed": "srtをインストールできませんでした: {reason}",
  "settings.sandbox.srt.updateAvailable":
    "このバージョンのPsycheにはより新しいsrt（{version}）が付属しています。インストール済みは{installed}です。",
  "settings.sandbox.srt.choose": "srtは別の場所にある",
  "settings.sandbox.srt.path": "srtのフルパス",
  "settings.sandbox.srt.use": "このsrtを使用",
  "settings.sandbox.srt.useHint":
    "コマンドの実行方法を決めるものなので、保存時にこのデバイスでの確認が求められます。",
  "settings.sandbox.containers.title": "より強力な分離（任意）",
  "settings.sandbox.containers.body":
    "コンテナランタイムは、Macのファイルにアクセスできない専用のLinuxマシンでコードを実行します。エージェントが実行するコードや一部のファイル変換に使われます。Gatewayがコンテナを使うよう設定されていない限り、コマンドサーバはsrtを使い続けます。",
  "settings.sandbox.containers.ready": "{runtime}は実行中です。",
  "settings.sandbox.runtime.appleContainer": "Appleコンテナ",
  "settings.sandbox.runtime.docker": "Docker",
  "settings.sandbox.runtime.podman": "Podman",
  "settings.sandbox.missing.title": "{runtime}をインストール",
  "settings.sandbox.missing.appleContainer":
    "Appleのコンテナランタイムはサンドボックスごとにそれぞれ軽量VMを用意します。Appleシリコン搭載のmacOS 26が必要で、Macのパスワードで承認するインストーラを使います。",
  "settings.sandbox.missing.docker":
    "Colima経由のDockerは無料で軽量です。Docker Desktopはクリックだけで使える選択肢です。",
  "settings.sandbox.step.download": "インストーラをダウンロードして開く",
  "settings.sandbox.step.downloadLink": "Appleコンテナのリリースを開く",
  "settings.sandbox.step.start": "起動する",
  "settings.sandbox.step.install": "Homebrewでインストール",
  "settings.sandbox.step.orDesktop": "またはDocker Desktopをダウンロードして一度開く",
  "settings.sandbox.step.desktopLink": "Docker Desktopのダウンロードを開く",
  "settings.sandbox.stopped.title": "{runtime}はインストール済みですが、実行されていません",
  "settings.sandbox.stopped.appleContainer":
    "システムサービスを起動してから、もう一度確認してください。",
  "settings.sandbox.stopped.docker":
    "Dockerデーモンを起動（Docker Desktopを開くか、以下のコマンドを実行）してから、もう一度確認してください。",
  "settings.sandbox.stopped.podman": "Podmanマシンを起動してから、もう一度確認してください。",
  "settings.sandbox.restart.title":
    "{runtime}は実行中です。使用するにはGatewayを再起動してください",
  "settings.sandbox.restart.body":
    "Gatewayは起動時にコンテナランタイムを探しましたが、見つかりませんでした。再起動すると{runtime}を認識します。",
  "settings.sandbox.restart.step": "Gatewayを再起動",
  "settings.sandbox.without":
    "srtがなくても、PsycheはURLサーバやコネクタを使えますが、ローカルのMCPコマンドサーバは実行できません。",
  "settings.mcp.off": "オフ",
  "settings.mcp.turnedOn": "{name}をオンにしました。",
  "settings.mcp.turnedOff": "{name}をオフにしました。",
  "settings.mcp.tools.title": "ツール",
  "settings.mcp.tools.hint":
    "{off, plural, =0 {Psycheはすべてのツールを使えます。} other {#個のツールはPsycheから除外されています。}}ツールをオフにしてもサーバは再起動しません。",
  "settings.mcp.tools.loadFailed": "ツールを読み込めませんでした: {reason}",
  "settings.mcp.tools.off": "このサーバはオフです。オンにするとツールが表示されます。",
  "settings.mcp.tools.notConnected": "このサーバは接続されていないため、ツールは表示されません。",
  "settings.mcp.tools.none": "このサーバにはツールがありません。",
  "settings.mcp.money.title": "支払い",
  "settings.mcp.money.description":
    "お金を動かすツールは、毎回支払いの確認を求めます。このサーバのどのツールが該当するかを指定します。",
  "settings.mcp.money.auto": "ツール名で判断",
  "settings.mcp.money.autoHint":
    "Psyche がツールの名前と説明から推測します。サーバは言い回しを変えてこれを避けられます。",
  "settings.mcp.money.always": "すべてのツールがお金を動かす",
  "settings.mcp.money.alwaysHint": "このサーバへの呼び出しはすべて、支払いの承認を求めます。",
  "settings.mcp.money.never": "お金を動かすツールはない",
  "settings.mcp.money.neverHint":
    "ツール名に関係なく、支払いの承認は求めません。お金を使えないサーバにだけ使ってください。",
  "settings.mcp.secrets.title": "シークレット",
  "settings.mcp.secrets.intro":
    "このサーバが起動時に使うキーです。保管庫に保存され、Psycheには設定済みかどうかだけが表示されます。",
  "settings.mcp.secrets.loadFailed": "シークレットを読み込めませんでした: {reason}",
  "settings.mcp.secrets.set": "設定済み",
  "settings.mcp.secrets.unset": "未設定",
  "settings.mcp.secrets.replace": "置き換え",
  "settings.mcp.secrets.setIt": "値を設定",
  "settings.mcp.secrets.replaceFor": "{name}を置き換え",
  "settings.mcp.secrets.plain":
    "保管庫ではなくサーバの設定に保存されています。置き換えると保管庫に移ります。",
  "settings.mcp.secrets.newValue": "{name}の新しい値",
  "settings.mcp.secrets.hint": "保管庫に保存してから、その値でサーバを再起動します。",
  "settings.mcp.secrets.replaced": "{name}を置き換えました。サーバは新しい値で再起動します。",
  "settings.mcp.danger.title": "危険な操作",
  "settings.mcp.danger.disable": "このサーバをオフにする",
  "settings.mcp.danger.disableHint":
    "設定は残したままサーバを停止します。ツールは使えなくなり、それらに与えた権限も終了します。",
  "settings.mcp.danger.disableAction": "オフにする",
  "settings.mcp.danger.enable": "このサーバをオンにする",
  "settings.mcp.danger.enableHint":
    "サーバを再び起動します。シークレットについて承認を求められます。",
  "settings.mcp.danger.enableAction": "オンにする",
  "settings.mcp.danger.remove": "このサーバを削除",
  "settings.mcp.danger.removeHint": "設定を削除します。保管庫のシークレットは残ります。",
  "settings.mcp.json.toggle": "JSONを貼り付け",
  "settings.mcp.json.label": "サーバのJSON",
  "settings.mcp.json.hint":
    "一般的なmcpServers形式です。キーやトークンは設定ではなく保管庫に保存されます。",
  "settings.mcp.json.fill": "フォームに反映",
  "settings.mcp.json.choose": "どのサーバですか？",
  "settings.mcp.json.empty": "先にサーバのJSONを貼り付けてください。",
  "settings.mcp.json.invalid": "有効なJSONではありません。",
  "settings.mcp.json.shape": "mcpServersエントリを持つJSONオブジェクトが必要です。",
  "settings.mcp.json.noServers": "そのJSONには、コマンドまたはURLを持つサーバがありません。",
  "settings.mcp.json.secrets":
    "JSON内の{n, plural, other {#個のシークレット}}を保管庫に保存します: {names}。",
  "settings.mcp.json.ignored": "引き継がれない項目: {names}。",
  "settings.searchSources.title": "検索の情報源",
  "settings.searchSources.description":
    "検索インデックスに取り込む内容です。オンにするまですべてオフで、インデックスはこのMac上に保持されます。情報源をオンにすると、メモリの「情報源」でオプトアウトしない限りメモリもそこから学習します（メモリと連絡先は例外で、どちらからも学習しません）。",
  "settings.searchSources.hint.mail":
    "Apple Mailのメールの件名、差出人、宛先、日付、本文。引用された返信は除外されます。",
  "settings.searchSources.hint.messages":
    "iMessageの会話をチャットと日付ごとに。他の人のメッセージが指示として扱われることはありません。",
  "settings.searchSources.hint.notes": "Appleメモのタイトルと本文。",
  "settings.searchSources.hint.calendar":
    "過去3年間と今後12か月の予定: タイトル、時間、場所、参加者、メモ。",
  "settings.searchSources.hint.reminders": "リマインダーとそのリスト、期限、メモ。",
  "settings.searchSources.hint.contacts":
    "Apple連絡先: 名前、ニックネーム、会社、役職、メールアドレス、電話番号、各住所の市区町村と国、誕生日。番地、メモ、グループは読み取りません。許可するまでエージェントは検索できず、このスイッチが対象とするのはこのインデックスのみです。メモリが人物について学習した内容や、メールアドレスや電話番号を含む個人ページは、メモリ自体のエージェントアクセスに従います。",
  "settings.searchSources.hint.files":
    "共有したフォルダ内のテキスト、コード、PDF、Word、Excelファイル。画像は名前でインデックス化されます。",
  "settings.searchSources.hint.browser":
    "Psycheのブラウザが代わりに読んだページを90日間保持します。非公開ページ、サインインページ、支払いページは保持されません。",
  "settings.searchSources.hint.transcripts":
    "ボイスメモと会議を、話者ごとに分けて取り込みます。他の人の発言が指示として扱われることはありません。",
  "settings.searchSources.hint.memory":
    "Psycheが覚えていること: 人物、プロジェクト、期限のある作業、イベント、Psycheが承認した事実。機密性のあるもの、確認待ちのもの、エージェントが検索できない情報源から学んだもの、非公開のものは除外されます。メモリはこのインデックスから学習せず、メモリがオンである必要があります。",
  "settings.searchSources.runOnBatteryHint":
    "Macがバッテリー駆動中も、インデックス化、再構築、画像内のテキスト読み取りを控えめなペースで続けます。バッテリーの消費は増えます。低電力モード中は引き続き一時停止します。",
  "settings.searchSources.cannotEnable": "まだオンにできません: {why}",
  "settings.searchSources.cannotAgent": "エージェントはまだこれを検索できません: {why}",
  "settings.searchSources.state.off": "オフ: 読み取りません",
  "settings.searchSources.state.unavailable": "オンですが利用できません: {why}",
  "settings.searchSources.state.error": "問題があります: {why}",
  "settings.searchSources.state.indexing": "インデックス化中: これまでに{n, plural, other {#件}}",
  "settings.searchSources.state.idle": "最新の状態です: {n, plural, other {#件}}",
  "settings.searchSources.neverIndexed": "未インデックス",
  "settings.searchSources.lastIndexed": "最終インデックス: {when}",
  "settings.searchSources.rebuild": "再構築",
  "settings.searchSources.rebuildLabel": "{source}を再構築",
  "settings.searchSources.rebuilding": "再構築中…",
  "settings.searchSources.rebuild.turnOnFirst": "先に{source}をオンにしてください",
  "settings.searchSources.rebuild.starting": "{source}を再構築しています…",
  "settings.searchSources.rebuild.progress":
    "{source}を再構築中: これまでに{n, plural, other {#件}}を読み取りました。バックグラウンドで続行します。",
  "settings.searchSources.rebuild.done": "{source}を再構築しました: {n, plural, other {#件}}。",
  "settings.searchSources.rebuild.failed": "{source}を再構築できませんでした: {why}",
  "settings.searchSources.agent": "Psycheのエージェントにこれを検索させる",
  "settings.searchSources.agentLabel": "{source}のエージェント検索",
  "settings.searchSources.ocr": "画像内のテキストを読み取る（OCR）",
  "settings.searchSources.ocrHint":
    "Apple VisionでスクリーンショットとスキャンしたPDFを1ページずつ読み取ります。電源接続時（または「バッテリー駆動中もインデックス化」がオンならバッテリー駆動中も）に実行します。Macの外には何も送信されません。",
  "settings.searchSources.ocrLabel": "{source}の画像内のテキストを読み取る",
  "settings.searchSources.processing": "処理",
  "settings.searchSources.processingLabel": "{source}の処理",
  "settings.searchSources.processing.cloud": "クラウドモデル（現在）",
  "settings.searchSources.processing.local": "ローカルモデル",
  "settings.searchSources.processing.none": "なし: 要約を作成しない",
  "settings.searchSources.excludeContacts": "これらの連絡先をインデックス化しない",
  "settings.searchSources.excludeContactsHint":
    "メールアドレス、電話番号、名前をカンマで区切って入力",
  "settings.searchSources.excludeFolders": "これらのフォルダをインデックス化しない",
  "settings.searchSources.excludeFoldersPlaceholder": "~/Documents/Private",
  "settings.searchSources.indexSize": "検索インデックスのサイズ: {size}",
  "settings.semanticSearch.title": "意味で検索",
  "settings.semanticSearch.description":
    "言葉だけでなく意味でも探せます。すべてこのMac上で処理されます。",
  "settings.semanticSearch.enabledHint":
    "初回は118 MBのモデルをダウンロードします。オフにすると意味のインデックスは削除されます。",
  "settings.semanticSearch.engine.builtin": "内蔵モデル",
  "settings.semanticSearch.engine.builtinHint":
    "Multilingual E5 small。約100言語に対応し、このMacのプロセッサで動作します。",
  "settings.semanticSearch.engine.router": "自分のローカルモデルサーバ",
  "settings.semanticSearch.engine.routerHint":
    "このMac上のOllamaやLM Studioなど、「ロール」で設定した埋め込みモデルを使います。",
  "settings.semanticSearch.state.off": "オフ: 検索は言葉で照合します",
  "settings.semanticSearch.state.starting": "起動中…",
  "settings.semanticSearch.state.downloading": "モデルをダウンロード中: {received} / {total} MB",
  "settings.semanticSearch.state.indexing": "意味をインデックス化中: {done} / {total}",
  "settings.semanticSearch.state.ready":
    "オン: {n, plural, other {#個のパッセージ}}をインデックス化済み",
  "settings.semanticSearch.state.readyCloud":
    "オン（クラウドサービス使用）: {n, plural, other {#個のパッセージ}}をインデックス化済み",
  "settings.semanticSearch.allowCloudHint":
    "埋め込みモデルがクラウドサービスの場合のみ有効です。チャット、タスク、ライブラリのテキストが送信されます。オフにすると、すべてこのMac上に留まります。",
  "settings.semanticSearch.state.noModel":
    "「ロール」に埋め込みモデルが設定されていません。選択するか、内蔵モデルを使ってください。",
  "settings.semanticSearch.state.cloudBlocked":
    "「ロール」の埋め込みモデルはクラウドサービスです。セマンティック検索はこのMac上のモデルのみ使用します。",
  "settings.semanticSearch.state.error": "停止しました: {reason}",
  "settings.webSearch.description":
    "エージェントがWebで調べる方法です。Webページがあなたの指示として扱われることはありません。",
  "settings.data.description":
    "{persona}が保持するものはすべてこのマシン上にあります。学習のために送信されるものはありません。",
  "settings.data.advancedHint": "ウィジェット内の地図と画像",
  "settings.data.keep": "保存期間",
  "settings.data.keepHint": "古い思考とタスクのリプレイは自動的に削除されます。",
  "settings.data.danger": "削除して最初からやり直す",
  "settings.memoryControls.title": "基礎",
  "settings.memoryControls.description":
    "{persona}が覚える内容と学習元を選びます。どれもいつでもオフにできます。",
  "settings.learning.title": "フィードバックからの学習",
  "settings.learning.implicit": "編集、取り消し、却下を検知",
  "settings.learning.implicitHint":
    "編集した下書きを送信したり、操作を取り消したりすると、フィードバックとして扱われます。",
  "settings.learning.signals": "シグナル",
  "settings.learning.signal.draftEdits": "下書きの編集",
  "settings.learning.signal.undo": "取り消し",
  "settings.learning.signal.approvalEdits": "承認時の編集",
  "settings.learning.signal.dismissals": "却下",
  "settings.learning.paused": "学習を一時停止",
  "settings.learning.pausedHint":
    "オンの間は何も読み書きせず、あとから埋め戻されることもありません。",
  "settings.learning.weeklyCard": "毎週の「学んだこと」カード",
  "settings.learning.weeklyCardHint":
    "毎週日曜に、確認する内容があるときだけフィードに投稿します。",
  "settings.learning.open": "{persona}が学んだこと",
  "settings.learning.openButton": "成長を開く",
  "settings.learning.forgetAll": "{persona}が学んだことをすべて忘れさせる",
  "settings.learning.forgetAllTitle": "{persona}があなたから学んだことをすべて忘れさせますか？",
  "settings.learning.forgetAllBody":
    "ノート、Soul、スキルが、あなたが書いた状態に戻ります。確認のため「{phrase}」と入力してください。",
  "settings.learning.forgetPhrase": "忘れる",
  "settings.learning.forgetAllGo": "すべて忘れさせる",
  "settings.learning.forgotAll":
    "{lessons, plural, other {#件の学び}}と{events, plural, other {#件のフィードバック}}を忘れました。",
  "settings.data.reasoningRetentionHint":
    "各ステップの思考全文を保持する期間です。オフにすると1行の要約のみ残ります。",
  "settings.data.recallModeHint":
    "Markdownのメモリファイルが引き続き正となります。埋め込みにより、各ターンで意味からメモリを探せます。",
  "settings.data.recallMode.markdown": "Markdownのみ",
  "settings.data.recallMode.markdownHint":
    "ファイルを読み、言葉で照合します。追加で動かすものはありません。",
  "settings.data.recallMode.embeddings": "Markdownと埋め込み",
  "settings.data.recallMode.embeddingsHint":
    "検索と同じ埋め込みの設定を使います。モデルは必要なときに読み込まれ、使われなければ解放されます。",
  "settings.data.recallState.off": "Markdownのみ。",
  "settings.data.encryptMemory": "ディスク上のメモリを暗号化",
  "settings.data.encryptMemoryHint":
    "{persona}が人物について知っていることを暗号化ファイルに保存し、キーは保管庫に置きます。オフにすると、先にすべてを元に戻します。",
  "settings.data.encryptMemory.restart": "次回Psycheを起動したときにオンになります。",
  "settings.data.encryptMemory.on": "暗号化済み。",
  "settings.data.encryptMemory.pending": "Macヘルパーからのキーを待っています。",
  "settings.data.encryptMemory.unavailable": "利用できません: {why}",
  "settings.data.encryptMemory.offDone":
    "メモリはメインデータベースに戻りました。暗号化ファイルは削除されました。",
  "settings.data.recallState.semantic":
    "意味と言葉でメモリを呼び出しています: メモリのパッセージ{chunks}件中{vectors}件をインデックス化済み。",
  "settings.data.recallState.modelMissing":
    "埋め込みモデルがまだダウンロードされていないため、言葉のみで照合します。設定 → コネクタと情報源 → 検索でセマンティック検索をオンにしてダウンロードしてください。",
  "settings.data.recallState.cloudBlocked":
    "埋め込みサービスにメモリの送信が許可されていないため、言葉のみで照合します。",
  "settings.data.recallState.textOnly":
    "利用できる埋め込みモデルがないため、言葉のみで照合します。",
  "settings.data.replayRetentionHint":
    "作業中に{persona}が見ていた画面で、タイムライン用です。オフにすると保持されません。",
  "settings.devices.presenceKey.unknown": "Touch IDキー（種類はヘルパーから報告されていません）",
  "settings.devices.presenceKey.deviceIdentity":
    "支払いにはTouch IDまたはMacのパスワードを使います。設定は不要です。",
  "settings.devices.touchId.none":
    "Touch IDキーはまだありません。登録するまで、Touch IDが必要なカードは承認できません。",
  "settings.devices.touchId.bundled": "このアプリのPsyche Helperのキーを表示",
  "settings.devices.touchId.notBundled":
    "このヘルパーはこのアプリに同梱のものではないため、ここでキーを登録できません。",
  "settings.devices.touchId.keyMismatch":
    "このアプリのPsyche Helperは、登録済みの {registered} ではなくキー {shown} を示しています。自分でキーをリセットしていない場合は不審と見なし、登録しないでください。",
  "settings.devices.touchId.confirmReplace":
    "このMacに登録されているTouch IDキー {previous} を置き換えます。自分でキーをリセットした場合にだけ置き換えてください。",
  "settings.devices.touchId.confirmReplaceButton": "キーを置き換える",
  "settings.devices.touchId.noBundledKey":
    "このアプリのPsyche HelperにはTouch IDキーがありません（{reason}）。",
  "settings.devices.touchId.register": "このキーを登録",
  "settings.devices.touchId.remove": "キーを削除",
  "settings.devices.touchId.manualLabel": "キーID",
  "settings.devices.touchId.manualHint":
    "コンピューターでpsyche-helper --print-identityを実行し、表示されるpresenceKeyIdを貼り付けてください。",
  "settings.files.execHost": "このMacでコマンドを実行",
  "settings.files.execHostHint":
    "{persona}が共有フォルダ内でサンドボックスを使ってコマンドを実行できるようにします。ファイルを変更する可能性のあるコマンドは先に確認します。",
  "settings.files.execHostSwitch": "このMacでのコマンドを許可",
  "settings.files.readOnlyQuiet": "読み取り専用のコマンドは確認なしで実行",
  "settings.files.readOnlyQuietHint":
    "ls、cat、wcなど、読み取るだけの基本的なファイル・情報コマンドは、カードなしでサンドボックス内で実行されます。gitを含むそれ以外はすべて確認し、{persona}が外部から何かを読み取った後のコマンドもすべて確認します。",
  "settings.files.revoke": "取り消す",
  "settings.files.description":
    "{persona}は許可したものにのみアクセスし、さらに必要なときはチャットで確認します。",
  "settings.files.foldersHint":
    "読み取り専用では{persona}はフォルダを開いて検索できます。読み書きでは変更の保存もできます。取り消しはすぐに反映されます。",
  "settings.files.addYourself": "フォルダを自分で追加",
  "settings.files.addYourselfHint":
    "通常は不要です。作業にフォルダが必要になると{persona}が尋ねます。追加したフォルダは読み取り専用で始まります。",
  "settings.access.title": "{persona}がアクセスできるもの",
  "settings.access.listLabel": "{persona}がアクセスできるもの",
  "settings.access.empty":
    "まだありません。{persona}がフォルダやアプリを必要とするとチャットで尋ね、許可したものがここに表示されます。",
  "settings.access.scope.always": "常時",
  "settings.access.scope.conversation": "このチャット",
  "settings.access.scope.limited": "一時的",
  "settings.access.used": "{when}に使用",
  "settings.access.revokeNamed": "{name}を取り消す",
  "settings.access.loadLabel": "Psycheがアクセスできるもの",
  "settings.access.loadFailed": "Psycheはアクセスできるものを読み込めませんでした（{reason}）。",
  "settings.access.unchanged": "アクセスは変更されていません。",
  "settings.model.advancedHint": "コンテキストの上限、ローカルモデル",
  "settings.permissions.subject.prepNotes": "「Prep:」で始まるタイトルのメモ（会議の準備）",
  "settings.permissions.specificConnectors":
    "特定のコネクタの権限は、コネクタ内のそのコネクタのページで設定します。",
  "settings.permissions.openConnectors": "コネクタを開く",
  "settings.persona.description": "{name}の見た目と自己紹介の仕方。",
  "settings.persona.whileWorking": "作業中",
  "settings.persona.showReasoningHint":
    "{persona}の思考を作業中に表示します。保存されることはありません。",
  "settings.connectors.page.onHost": "{host}上",
  "settings.connectors.page.row.onHost": "{host}上",
  "settings.computerUse.remote":
    "コンピュータの操作は{host}で行われます。そちらから依頼するか、ブラウザを使ってください。",
  "settings.gateways.title": "このコンピュータのGateway",
  "settings.gateways.description":
    "自宅のMacなど、別のコンピュータのGatewayを使って、このコンピュータからPsycheを利用します。有効なGatewayは一度に1つで、切り替えるとPsycheが再起動します。",
  "settings.gateways.loadLabel": "保存済みのGateway",
  "settings.gateways.thisMac": "このMac",
  "settings.gateways.active": "接続中",
  "settings.gateways.pinned": "IDを固定済み",
  "settings.gateways.notPinned": "初回接続時にIDを固定します",
  "settings.gateways.switch": "切り替え",
  "settings.gateways.switchTo": "{name}に切り替え",
  "settings.gateways.switchTitle": "{name}に切り替えますか？",
  "settings.gateways.switchKeep":
    "Psycheは{name}で再起動します。このMac上のPsycheは動き続けるため、オートメーションも継続します。",
  "settings.gateways.switchOnly": "切り替え",
  "settings.gateways.switchAndStop": "切り替えて、このMac上のPsycheを停止",
  "settings.gateways.pairAgain": "再ペアリング",
  "settings.gateways.pairAgainNamed": "{name}と再ペアリング",
  "settings.gateways.forget": "削除",
  "settings.gateways.forgetNamed": "{name}を削除",
  "settings.gateways.add": "Gatewayを追加",
  "settings.gateways.addressLabel": "ペアリングリンクまたはアドレス",
  "settings.gateways.addressPlaceholder": "studio-mac.your-tailnet.ts.net",
  "settings.gateways.nameLabel": "名前（任意）",
  "settings.gateways.addHint":
    "Psycheを実行しているMacのペアリングリンクを貼り付けてください（設定 → サーバとリモートアクセス → 別のコンピュータをペアリング）。リンクがない場合は、そのTailscaleアドレス（https://<host>.<tailnet>.ts.net）を入力します。このコンピュータがペアリングを要求し、所有者がそちらで承認します。",
  "settings.gateways.newLink": "新しいペアリングリンクが届きました。使用しますか？",
  "settings.gateways.useNewLink": "使用する",
  "settings.gateways.ignoreNewLink": "無視",
  "settings.gateways.fromLink":
    "ペアリングリンクから開きました。内容を確認し、「Gatewayを追加」を押してください。接続する前にPsycheがアドレスの確認を求めます。",
  "settings.gateways.adding": "Gatewayを追加",
  "settings.gateways.problem.empty": "Gatewayのアドレスを入力してください。",
  "settings.gateways.problem.invalid": "Psycheで使用できるアドレスではありません。",
  "settings.gateways.problem.needs_full_name":
    "studio-mac.your-tailnet.ts.netのような完全な名前を使ってください。短い名前は確認できません。",
  "settings.gateways.problem.needs_https":
    "https://のアドレスを使ってください。通常のhttpは、このコンピュータ上のSSHトンネル経由でのみ使用できます。",
  "settings.gateways.problem.has_path": "パスを含めず、アドレスのみを入力してください。",
  "settings.gateways.problem.has_credentials": "ユーザー名とパスワードは含めないでください。",
  "settings.gateways.problem.link_not_a_pairing_link": "ペアリングリンクではありません。",
  "settings.gateways.problem.link_unsupported_version":
    "このペアリングリンクは新しいバージョンのPsycheのものです。このコンピュータのPsycheをアップデートして、もう一度お試しください。",
  "settings.gateways.problem.link_malformed":
    "このペアリングリンクは破損しています。作成したMacからもう一度コピーしてください。",
  "settings.gateways.problem.link_extra_fields":
    "このペアリングリンクにPsycheが認識できない内容が含まれているため、使用されません。",
  "settings.gateways.problem.link_bad_field":
    "このペアリングリンクは破損しています。作成したMacからもう一度コピーしてください。",
  "settings.gateways.problem.link_lan":
    "このペアリングリンクはローカルネットワーク上のコンピュータ用ですが、証明書が含まれていないため使用されません。そのMacで「別のコンピュータをペアリング」→「このネットワークから」を選び、新しく作成してください。",
  "settings.gateways.problem.link_not_lan":
    "このペアリングリンクはローカルネットワーク上にないアドレスを指しているため、使用されません。",
  "settings.gateways.problem.link_pin_mismatch":
    "このGatewayは別のIDですでに保存されています。先に「再ペアリング」を行ってから、リンクを追加してください。",
  "settings.gateways.problem.failed": "Gatewayを追加できませんでした。何も変更されていません。",
  "settings.gateways.problem.declined": "Gatewayの追加はキャンセルされました。",
  "settings.gateways.problem.actionFailed": "うまくいきませんでした。何も変更されていません。",
  "settings.remote.title": "ほかのコンピュータを許可",
  "settings.remote.description":
    "ほかのコンピュータのPsycheが、Tailscale経由でこのMacのGatewayを使えるようにします。GatewayはこのMac上に留まり、Tailscaleのみを待ち受けます。入口はTailscale Serveだけです。",
  "settings.remote.step1":
    "このMacとほかのコンピュータにTailscaleをインストールし、同じtailnetにサインインします。",
  "settings.remote.step2":
    "このMacのターミナルで、Gatewayをtailnetに公開します。これはFunnelではなくServeです。",
  "settings.remote.copyCommand": "コマンドをコピー",
  "settings.remote.copied": "コピーしました",
  "settings.remote.step3":
    "Gatewayに自分のアドレスを知らせます。Psycheのデータフォルダにあるconfig.jsonに次を設定します:",
  "settings.remote.step4":
    "Psycheを再起動します。次に、ほかのコンピュータでこのMacをGatewayとして追加します。ペアリングコードとキーのフィンガープリントが表示されるので、ここの「ペアリング待ち」の要求と照合してから承認してください。",
  "settings.remote.funnel":
    "このためにTailscale Funnelをオンにしないでください。Gatewayが公開インターネットに出てしまいます。",
  "settings.remote.configWarnings":
    "config.json に、このバージョンのPsycheが認識できない設定があるため、無視されます: {keys}。いずれかを意図していた場合は、つづりを確認してください。",
  "settings.uninstall.group": "Psycheをアンインストール",
  "settings.uninstall.groupHint":
    "GatewayとHelperを停止し、アプリをゴミ箱に移動します。データは、別の選択をしない限り残ります。",
  "settings.uninstall.open": "Psycheをアンインストール…",
  "settings.uninstall.title": "Psycheをアンインストール",
  "settings.uninstall.description":
    "以下はすべてゴミ箱に移動されるため、あとで元に戻せます。完全に削除されるものはありません。",
  "settings.uninstall.dataChoice": "データ",
  "settings.uninstall.keep": "データを残す",
  "settings.uninstall.keepHint":
    "チャット、メモリ、保管庫、バックアップはデータフォルダに残ります。",
  "settings.uninstall.delete": "データを削除する",
  "settings.uninstall.deleteHint":
    "データフォルダもゴミ箱に移動します。チャット、メモリ、保管庫、バックアップが含まれます。",
  "settings.uninstall.willDo": "実行される内容",
  "settings.uninstall.stopAgent": "Gateway LaunchAgentを停止して削除します。",
  "settings.uninstall.stopHelper": "Psyche Helperを停止し、「ログイン時に開く」をオフにします。",
  "settings.uninstall.trash": "ゴミ箱に移動",
  "settings.uninstall.kind.agent": "Gateway LaunchAgent",
  "settings.uninstall.kind.support": "Application Support",
  "settings.uninstall.kind.cache": "キャッシュ、ログ、設定、保存された状態",
  "settings.uninstall.kind.data": "データ",
  "settings.uninstall.kind.app": "アプリ",
  "settings.uninstall.agentOther":
    "Gatewayエージェントは別のPsycheのコピーまたはコマンドラインツールのものなので、そのままにします。",
  "settings.uninstall.blocked": "{path} はここからゴミ箱に移動できません: {reason}",
  "settings.uninstall.keychainStays":
    "キーチェーンの項目は残ります(保管庫のキーとHelperの項目)。必要ならキーチェーンアクセスで削除してください。",
  "settings.uninstall.keychainGoes": "保管庫とHelperのキーチェーン項目も削除されます。",
  "settings.uninstall.removeKeychain":
    "キーチェーンの項目(com.psyche.vaultとHelperの項目)も削除する。データがなければ使い道はありません。",
  "settings.uninstall.kind.state": "保存されたウインドウの状態",
  "settings.uninstall.dataStays": "データフォルダには触れません。",
  "settings.uninstall.typeWord": "確認のため {word} と入力してください",
  "settings.uninstall.presence":
    "データが削除されるため、このあとTouch IDまたはこのデバイスで確認が求められます。",
  "settings.uninstall.approvalLabel": "Psycheをアンインストールしてデータを削除",
  "settings.uninstall.failed":
    "Psycheをアンインストールできませんでした({reason})。それ以上の変更は行われていません。",
  "settings.uninstall.cancel": "キャンセル",
  "settings.uninstall.go": "アンインストールして終了",
  "settings.uninstall.goDelete": "データを削除してアンインストール",
  "settings.remote.admin":
    "ペアリングしたコンピュータには、読み取り、書き込み、承認の権限が付与されます。管理者権限は、承認時にチェックしない限りオフのままで、管理者としての変更には毎回ここでTouch IDが必要です。",
  "settings.remote.address": "公開アドレス",
  "settings.remote.addressUnset": "未設定",
  "settings.remote.proxy": "信頼済みプロキシ",
  "settings.remote.on": "オン",
  "settings.remote.off": "オフ",
  "settings.remote.fingerprint": "このGatewayのキー",
  "settings.remote.fingerprintHint":
    "初回接続時にほかのコンピュータが表示するフィンガープリントと照合してください。",
  "settings.remote.loadLabel": "Gatewayの識別情報",
  "settings.remote.clientNote":
    "このコンピュータは{host}のクライアントです。リモートアクセスは{host}で設定します。",
  "settings.pair.title": "別のコンピュータをペアリング",
  "settings.pair.description":
    "ほかのコンピュータのPsyche用にペアリングリンクまたはQRコードを作成します。リンクは1回限り、10分間有効で、使用したコンピュータはここでチェックしたアクセス権でペアリングされ、再度の承認は不要です。",
  "settings.pair.needsAddress":
    "先にこのMacの公開アドレス（上のステップ3）を設定してから、ペアリングリンクを作成してください。",
  "settings.pair.scopes": "ほかのコンピュータにできること",
  "settings.pair.adminHint":
    "管理者権限があると、セキュリティ設定、デバイス、保管庫を変更できます。チェックしない限りオフです。管理者としての変更には毎回ここでTouch IDが必要です。",
  "settings.pair.make": "ペアリングリンクを作成",
  "settings.pair.resultRegion": "ペアリングリンクとQRコード",
  "settings.pair.qrLabel": "{host}のペアリングリンクのQRコード",
  "settings.pair.scan":
    "ほかのコンピュータで「Gatewayを追加」を選び、{host}のこのリンクを貼り付けてください。",
  "settings.pair.expires": "{when}に期限切れ。",
  "settings.pair.linkLabel": "ペアリングリンク",
  "settings.pair.copy": "リンクをコピー",
  "settings.pair.gives": "使用されると、そのコンピュータには次が付与されます: {scopes}。",
  "settings.pair.compare":
    "リンクを使う前に、そのコンピュータはこのMacのキーを確認します: {fingerprint}。照合できます。",
  "settings.pair.secret":
    "今後10分間にこのリンクを持っている人は、誰でも1台のコンピュータをペアリングできます。投稿したり、このMacを任せられない相手に送ったりしないでください。",
  "settings.pair.live": "未使用のペアリングリンク",
  "settings.pair.unused": "未使用",
  "settings.pair.revoke": "取り消す",
  "settings.pair.revokeNamed": "{when}に作成したペアリングリンクを取り消す",
  "settings.pair.madeToast": "ペアリングリンクを作成しました。1回限り、10分間有効です。",
  "settings.pair.usedToast": "コンピュータがリンクでペアリングされました。",
  "settings.pair.gone": "このペアリングリンクは無効になったため、表示されなくなりました。",
  "settings.pair.err.noAddress":
    "このMacにはまだ公開アドレスがないため、リンクに含めるものがありません。",
  "settings.pair.err.tooMany":
    "未使用のペアリングリンクがすでに3つあります。1つを取り消すか、期限切れを待ってください。",
  "settings.pair.err.forbidden":
    "ペアリングリンクを作成できるのは、管理者としてペアリングされたホスト自身のPsycheのみです。",
  "settings.pair.err.failed": "ペアリングリンクを作成できませんでした（{reason}）。",
  "settings.pair.via": "ほかのコンピュータはどこから接続しますか？",
  "settings.pair.viaAddress": "Tailscale経由で、このMacのアドレスに",
  "settings.pair.viaLan": "このネットワークから",
  "settings.pair.viaLanHint":
    "このネットワーク用のリンクにはこのMacのキーと証明書が含まれるため、同じWi-FiまたはEthernet上のコンピュータでのみ使えます。",
  "settings.pair.lanNote":
    "このリンクは、このMacと同じネットワーク上のコンピュータ用です。Psycheが必ず確認するキーと証明書が指定されています。",
  "settings.pair.err.noLan":
    "このネットワーク用のリンクを作成するには、「このネットワーク上のコンピュータを許可」をオンにし、待ち受けが始まるまでお待ちください。",
  "settings.key.gateway.lan": "このネットワーク上のコンピュータを許可",
  "settings.key.gateway.lan.rotateCert": "ネットワーク証明書",
  "settings.lan.title": "このネットワーク上のコンピュータを許可",
  "settings.lan.description":
    "同じWi-FiまたはEthernet上のほかのコンピュータのPsycheが、Tailscaleなしでこの MacのGatewayに接続できるようにします。オンにするまではオフです。",
  "settings.lan.loadLabel": "ネットワークアクセス",
  "settings.lan.unsupported": "このGatewayは古すぎて、ネットワークで待ち受けできません。",
  "settings.lan.toggle": "このネットワーク上のコンピュータを許可",
  "settings.lan.toggleHint":
    "Psycheは1つのネットワークで、独自の証明書による暗号化接続で待ち受けます。接続してきたコンピュータは、ここでTouch IDによる承認が必要です。",
  "settings.lan.ipv6": "このネットワークのIPv6アドレスも使用",
  "settings.lan.ipv6Hint":
    "選択したネットワークのプライベートIPv6アドレス（fdまたはfcで始まるもの）を追加します。パブリックIPv6アドレスとfe80アドレスは使用されません。",
  "settings.lan.problem.ipv6Off":
    "{address}はIPv6アドレスですが、IPv6がオフのためPsycheは待ち受けていません。上でIPv6をオンにするか、削除してください。",
  "settings.lan.problem.ipv6NeedsIpv4":
    "Psycheは{address}で待ち受けていません。IPv6はこのネットワークのIPv4アドレスと併用する場合にのみ使われるため、先にそれをここで許可する必要があります。",
  "settings.lan.interface": "ネットワーク",
  "settings.lan.interfaceDefault": "プライマリネットワーク",
  "settings.lan.interfaceOption": "{name}（{address}）",
  "settings.lan.noInterface": "このMacにWi-FiまたはEthernet接続が見つかりませんでした。",
  "settings.lan.trustedOnly":
    "信頼できるネットワークでのみオンにしてください。共有Wi-Fiやゲスト用Wi-Fiでは、接続している人なら誰でもペアリング画面にアクセスできます。",
  "settings.lan.status": "状態",
  "settings.lan.listening": "{addresses}で待ち受け中",
  "settings.lan.notListening": "待ち受けていません",
  "settings.lan.address": "アドレス",
  "settings.lan.discovery": "検出",
  "settings.lan.advertised": "このネットワーク上のPsycheに表示中",
  "settings.lan.notAdvertised": "表示されていません。このMacはアドレスで追加してください。",
  "settings.lan.certificate": "証明書",
  "settings.lan.certificateHint":
    "ペアリングしたコンピュータはこれを記憶しています。証明書を置き換えると、すべてのコンピュータで再ペアリングが必要になります。",
  "settings.lan.rotate": "証明書を置き換え",
  "settings.lan.rotateTitle": "ネットワーク証明書を置き換えますか？",
  "settings.lan.rotateBody":
    "ネットワーク経由でペアリング済みのコンピュータは、再ペアリングするまで接続できなくなります。証明書がコピーされた疑いがある場合に使用してください。",
  "settings.lan.rotateConfirm": "置き換えて接続を切断",
  "settings.lan.rotateFailed":
    "証明書を置き換えられませんでした（{reason}）。何も変更されていません。",
  "settings.lan.problem.unknownInterface": "{name}はこのMacにあるネットワークではありません。",
  "settings.lan.problem.noInterface": "待ち受けるネットワークがないため、何も待ち受けていません。",
  "settings.lan.problem.bindFailed":
    "{address}で待ち受けできませんでした。ほかのプログラムがポートを使用している可能性があります。",
  "settings.lan.problem.paused":
    "このネットワークではLANアクセスが一時停止されています。別のネットワークでオンにされています。",
  "settings.lan.allowHere": "このネットワークで許可",
  "settings.lan.problem.cert":
    "Psycheはネットワーク証明書を作成または読み取れなかったため、待ち受けていません。",
  "settings.lan.problem.cloudflare":
    "このGatewayはCloudflare Access経由でのみ接続できるよう設定されているため、ネットワークでは待ち受けません。",
  "settings.gateways.discoverConflict":
    "複数のコンピュータが異なるキーで同じ名前を通知したため、Psycheは追加しません。正しいものをアドレスで追加してください。",
  "settings.lan.problem.container":
    "コンテナ内のGatewayは、この方法ではネットワークで待ち受けしません。",
  "settings.lan.problem.advertise":
    "Psycheはネットワーク上で自身を通知できませんでした。コンピュータはこのMacをアドレスで追加できます。",
  "settings.gateways.discover": "このネットワークを検索",
  "settings.gateways.discovering": "検索中…",
  "settings.gateways.discoverTitle": "このネットワーク上",
  "settings.gateways.discoverNone":
    "Psycheが見つかりません。そのコンピュータで「このネットワーク上のコンピュータを許可」をオンにしてください。",
  "settings.gateways.discoverFailed":
    "ネットワークを検索できませんでした。代わりにアドレスで追加してください。",
  "settings.gateways.discoverKey": "キー {fingerprint}",
  "settings.gateways.discoverHint":
    "ネットワーク上でコンピュータが通知する内容は自己申告です。ペアリング画面にキーが表示されるので、承認する前にホストのキーと照合してください。",
  "settings.gateways.discoverAdd": "{name}を追加",
  "settings.gateways.discoverSaved": "保存済み",
  "settings.devices.gatewayKey": "このGatewayのキー {fingerprint}",
  "settings.devices.fromAddress": "{address}から",
  "settings.devices.fromLan": "ネットワーク上の{address}から。下のキー全体を確認してください。",
  "settings.devices.adminOptIn":
    "管理者権限があると、このコンピュータはセキュリティ設定、デバイス、保管庫を変更できます。必要な場合を除きオフのままにしてください。",
  "settings.skills.signer.title": "作成者",
  "settings.skills.signer.unsigned":
    "署名なし。作成者や途中で改変されていないことを示すものがないため、不明な発行元としてインストールされます。",
  "settings.skills.signer.new": "{name}が署名。このキーは初めて見るものです。",
  "settings.skills.signer.seen":
    "{name}が署名。以前に見たことのあるキーですが、信頼はしていません。",
  "settings.skills.signer.trusted": "{name}が署名。信頼している作成者です。",
  "settings.skills.signer.own": "あなたが署名。",
  "settings.skills.signer.changed":
    "{name}が署名していますが、以前見たキーとは異なります。インストールする前に同一人物であることを確認してください。",
  "settings.skills.signer.changedUpdate":
    "{name}が署名していますが、インストール済みのバージョンとは異なるキーです。アップデートする前に同一人物であることを確認してください。",
  "settings.skills.signer.dropped":
    "インストール済みのバージョンは{name}が署名していましたが、このバージョンには署名がありません。",
  "settings.skills.signer.impersonates":
    "{name}が署名していますが、ご自身のスキルへの署名に使う名前に似ているのにキーは別物です。出どころがわからない場合はインストールしないでください。",
  "settings.skills.signer.nameChanged":
    "信頼しているキーで署名されていますが、これまで使われていない名前です: {name}。同一人物であることを確認してください。",
  "settings.skills.signer.originAgent":
    "送信者のMac上のアシスタントが作成しました。署名者に関わらず、未確認のテキストとして読んでください。",
  "settings.skills.widened.specialist": "バックグラウンドロール",
  "settings.skills.bundleOriginAgent": "ほかの場所のアシスタントが作成",
  "settings.skills.export.label": "「{name}」に署名",
  "settings.skills.author.label": "作成者の信頼",
  "settings.skills.signer.claim":
    "名前は作成者自身の申告です。バージョン同士を結びつけるのはキーです。",
  "settings.skills.signer.key": "作成者のキー",
  "settings.skills.signer.trust": "{name}を作成者として信頼",
  "settings.skills.signer.trustHint":
    "このキーで署名された以降のバージョンは、信頼している作成者のものとして表示されます。インストールの際は毎回先に確認します。",
  "settings.skills.widened.title": "インストール済みのバージョンより多くを要求しています",
  "settings.skills.widened.hint":
    "承認しても、それ自体では権限は付与されませんが、今後はこれらの確認も表示されるようになります。",
  "settings.skills.widened.permissions": "新しい権限",
  "settings.skills.widened.tools": "新しいツール",
  "settings.skills.widened.prompts": "新しいプロンプトファイル",
  "settings.skills.import.file": "ファイルを読み込む…",
  "settings.skills.import.hint":
    "他の人からの.psyche-skillファイル、またはそれへのhttpsリンクです。インストールする前に確認され、内容が表示されます。",
  "settings.skills.import.failed": "Psycheはそのファイルを読み取れませんでした（{reason}）。",
  "settings.skills.import.tooBig": "ファイルが8 MBを超えています",
  "settings.skills.signedBy": "{name}が署名",
  "settings.skills.signedState":
    "{state, select, own {自分} trusted {信頼済み} revoked {取り消し済み} other {未信頼}}",
  "settings.skills.export": "書き出し…",
  "settings.skills.export.title": "「{name}」を書き出し",
  "settings.skills.export.hint":
    "ファイルはあなたの作成者キーで署名されるため、受け取った人はあなたのものであり改変されていないことを確認できます。キーはこのMac上に残ります。",
  "settings.skills.export.nameLabel": "署名に使う名前",
  "settings.skills.export.nameHint":
    "一度だけ作成します。スキルを読み込むすべての人に表示されます。",
  "settings.skills.export.go": "書き出して署名",
  "settings.skills.exported":
    "「{name}」を{file}として書き出し、{author}として署名しました。{created, select, true {作成者キーを作成しました: {key}。} other {}}",
  "settings.skills.author.trust": "この作成者を信頼",
  "settings.skills.author.untrust": "この作成者の信頼をやめる",
  "settings.skills.author.revoke": "この作成者を取り消す",
  "settings.skills.author.revokeTitle": "{name}のキーを取り消しますか？",
  "settings.skills.author.revokeDescription":
    "このキーで署名されたスキルは読み込まれなくなり、このキーで署名された新しいファイルは拒否されます。あとでもう一度信頼できます。",
  "settings.skills.author.revokeConfirm": "取り消す",
  "settings.usage.unavailable": "このGatewayでは使用状況をまだ確認できません。",
  "settings.usage.thisMonth": "今月",
  "settings.usage.monthLine":
    "{turns, plural, other {#ターン}}で{cost}、{tokens}トークン。今日これまでの分: {today}。",
  "settings.usage.noBudget": "月間予算は設定されていません。",
  "settings.usage.byModel": "過去7日間（モデル別）",
  "settings.usage.model": "モデル",
  "settings.usage.turns": "{n, plural, other {#ターン}}",
  "settings.usage.planWindow": "{model}: プランの枠の{pct}%を使用。{when}にリセットされます。",
  "settings.vm.enabledHint":
    "要求されたタスクは、共有したフォルダのみを持つゲスト内で実行されます。",
  "settings.vm.credentialsHint":
    "ホストの保管庫を使うと、値はMac上に残ります。ゲストの保管庫は独自のコピーを保持します。",
  "settings.voice.anyAppHint":
    "入力している場所ならどこでも。テキストはカーソル位置に入力され、エージェントやパスワード欄に送られることはありません。",
  "settings.voice.talkHint":
    "入力欄の音声ボタンで音声会話を開始します。音声で何かが承認されることはありません。",
  "settings.people.title": "人物とプロジェクト",
  "settings.people.description":
    "{persona}があなたの生活の中の人物とプロジェクトについて保持するカードです。このMac上に留まり、すべての事実に出どころが表示されます。",
  "settings.people.loadLabel": "人物とプロジェクトの設定を読み込み中",
  "settings.people.off":
    "オフ。{persona}は、あなたの生活の中の人物やプロジェクトのカードを保持しません。",
  "settings.people.turnOn": "オンにする",
  "settings.people.graph": "人物を学習する情報源",
  "settings.people.entityRecall": "返信で名前を使う",
  "settings.people.entityRecallHint":
    "非公開チャットで誰かの名前を出すと、{persona}がその人について1行を添えます。グループやチャンネルでは行いません。",
  "settings.people.sources": "人物を学習する情報源",
  "settings.people.sourcesHint":
    "各情報源はオンにするまでオフです。オフにすると読み取りを停止します。",
  "settings.people.source.contacts": "連絡先",
  "settings.people.source.mail": "メール",
  "settings.people.source.calendar": "カレンダー",
  "settings.people.source.messages": "メッセージ",
  "settings.people.source.messagesHint":
    "誰といつメッセージしたかを使い、メッセージの本文は使いません。",
  "settings.people.source.notes": "メモ",
  "settings.people.source.chats": "あなたのチャット",
  "settings.people.sourceOff": "オフ",
  "settings.people.sourceCounts":
    "{entities, plural, other {#件の人物とプロジェクト}} · {interactions, plural, other {#件のやり取り}} · {read, select, none {未読み取り} other {{read}に読み取り}}",
  "settings.people.retention": "やり取りの保持期間",
  "settings.people.retentionLabel": "やり取りの保持期間",
  "settings.people.retentionHint":
    "古いヘッダーとリンクは毎晩削除されます。カード、事実、未完了の項目は、忘れさせるまで残ります。",
  "settings.people.months": "{n, plural, other {#か月}}",
  "settings.people.learning": "カードの保ち方",
  "settings.people.learningHint":
    "要約、役割、未完了の項目は、デフォルトではローカルのユーティリティモデルが作成します。",
  "settings.people.budget":
    "今夜: {tokens, number}/{maxTokens, number}トークン、{entities, number}/{maxEntities, number}件の人物とプロジェクト。要約、役割、未完了項目はユーティリティモデルが作成し、デフォルトはローカルです。",
  "settings.people.nightly": "毎晩",
  "settings.people.nightlyHint": "就寝中に要約を更新し、未完了の項目を見つけます。",
  "settings.people.afterRun": "タスクのあとで毎回",
  "settings.people.afterRunHint": "タスクが関わった少数の人物とプロジェクトを更新します。",
  "settings.people.precision": "提案された未完了項目のうち採用した割合: {list}。",
  "settings.people.precisionItem": "{source} {total, number}件中{confirmed, number}件",
  "settings.people.aboutYou": "あなたについて",
  "settings.people.aboutYouHint":
    "あなた自身のカード: {persona}があなたについて学んだ各事実と、その出どころ。",
  "settings.people.openOwnCard": "あなたのカードを開く",
  "settings.people.ownCardHint":
    "プロフィール、チャット、接続済みアプリから得たあなたに関する事実。",
  "settings.people.editUserMd": "USER.mdを編集",
  "settings.people.blocked": "人物からブロック済み",
  "settings.people.blockedHint":
    "今後は学習されません。ドメインをブロックすると、そのすべてのアドレスが対象になります。",
  "settings.people.noneBlocked": "ブロックしている相手はいません。",
  "settings.people.blockedOn": "{kind} · {date}にブロック",
  "settings.people.unblock": "ブロックを解除",
  "settings.people.unblockLabel": "{hint}のブロックを解除",
  "settings.people.block": "ブロック",
  "settings.people.blockKindLabel": "ブロックする対象",
  "settings.people.blockValue": "アドレス、電話番号、またはドメイン",
  "settings.people.blockKind.email": "メールアドレス",
  "settings.people.blockKind.phone": "電話番号",
  "settings.people.blockKind.domain": "ドメイン",
  "settings.people.blockKind.contact": "連絡先",
  "settings.people.blockKind.channel": "チャンネル",
  "settings.people.blockKind.calendar": "カレンダー",
  "settings.people.blockKind.url": "Webアドレス",
  "settings.people.blockPlaceholder.email": "name@example.com",
  "settings.people.blockPlaceholder.phone": "+81 90 0000 0000",
  "settings.people.blockPlaceholder.domain": "example.com",
  "settings.people.nothingStored": "どの情報源からも、まだ何も保存されていません。",
  "settings.people.sourceStored":
    "{entities, plural, other {#件の人物とプロジェクト}} · {interactions, plural, other {#件のやり取り}}",
  "settings.people.deleteSource": "削除…",
  "settings.people.deleteSourceLabel": "{source}から取り込んだ内容を削除",
  "settings.people.deleteSourceTitle": "{source}から取り込んだ内容を削除しますか？",
  "settings.people.deleteSourceAfter":
    "次回の同期で再び取り込まれないよう、{source}はオフになります。ご自身で追加した事実は残ります。",
  "settings.people.deleteSourceConfirm": "削除",
  "settings.people.deletedSource": "{source}から取り込んだ内容を削除しました。",
  "settings.people.forgetAll": "人物とプロジェクトに関するすべて",
  "settings.people.forgetAllHint":
    "すべての人物、プロジェクト、カード、未完了項目を削除し、「人物とプロジェクト」をオフにします。ご自身のメモリファイルは残ります。",
  "settings.people.forgetAllButton": "忘れる…",
  "settings.people.forgetAllTitle": "人物とプロジェクトに関するすべてを忘れさせますか？",
  "settings.people.forgetAllAfter":
    "この操作は元に戻せません。「人物とプロジェクト」はオフになります。オンに戻すと、最初からやり直せます。",
  "settings.people.typeToConfirm": "確認のため「{phrase}」と入力してください",
  "settings.people.forgetAllConfirm": "すべて忘れさせる",
  "settings.people.forgotAll": "人物とプロジェクトに関するすべてを忘れさせました。",
  "settings.people.counting": "削除される内容を確認しています…",
  "settings.people.previewFailed": "Psycheは削除される件数を数えられませんでした（{reason}）。",
  "settings.people.removeCounts":
    "Psycheは{entities, plural, other {#件の人物とプロジェクト}}、{facts, plural, other {#件の事実}}、{interactions, plural, other {#件のやり取り}}、{loops, plural, other {#件の未完了項目}}、{identifiers, plural, other {#件のアドレス}}を削除します。",
  "settings.specialists.title": "スペシャリスト",
  "settings.specialists.description":
    "役割が決まったバックグラウンドの作業です。それぞれ予算の範囲内で動き、結果を1つ受信トレイに届けます。",
  "settings.specialists.all": "すべてのスペシャリスト",
  "settings.specialists.concurrent": "同時に動くスペシャリスト数",
  "settings.specialists.concurrentHint": "多いほど並行して実行され、残りは順番を待ちます。",
  "settings.specialists.monthlyCap": "月間の利用額",
  "settings.specialists.monthlyCapHint":
    "上限に達すると、新しい作業は予算が空くまで待機します。空欄の場合は月間予算の半分を使います{budget, select, none {} other {（{budget}）}}。",
  "settings.specialists.monthlyCapNone": "上限なし",
  "settings.specialists.showInFeed": "結果をフィードに表示",
  "settings.specialists.showInFeedHint": "どちらの場合も、結果はすべて受信トレイに届きます。",
  "settings.specialists.roles": "役割",
  "settings.specialists.rolesHint":
    "役割はスキルから作られます。インストールしたものは、オンにするまでオフのままです。",
  "settings.specialists.turnOn": "{role}をオン",
  "settings.specialists.summary": "{model} · {budget} · {mode}",
  "settings.specialists.budgetLine": "{tokens}トークン · {cost} · {minutes}分",
  "settings.specialists.edit": "編集",
  "settings.specialists.done": "完了",
  "settings.specialists.editLabel": "{role}を編集",
  "settings.specialists.model": "モデル",
  "settings.specialists.modelDefault": "デフォルト: {class}",
  "settings.specialists.class.utility": "ユーティリティモデル",
  "settings.specialists.class.primary": "プライマリモデル",
  "settings.specialists.class.harness": "コーディングハーネス",
  "settings.specialists.class.vision": "ビジョン対応のプライマリモデル",
  "settings.specialists.budget": "作業ごとの予算",
  "settings.specialists.budgetTokens": "トークン",
  "settings.specialists.budgetCost": "コスト（USD）",
  "settings.specialists.budgetMinutes": "分",
  "settings.specialists.budgetCaps":
    "最大{tokens}トークン · {cost} · {minutes}分。作業はこれ以上を要求することもできますが、この上限を超えることはありません。",
  "settings.specialists.maxMode": "確認なしでできる最大の範囲",
  "settings.specialists.mode.plan": "プラン",
  "settings.specialists.mode.manual": "手動",
  "settings.specialists.mode.balanced": "バランス",
  "settings.specialists.mode.auto": "自動",
  "settings.specialists.installed": "{skill}から",
  "settings.specialists.empty": "スペシャリストを定義するスキルはまだありません。",
  "settings.language.description": "テキストの言語と、日付や数値の表記方法。",
  "settings.language.languageHint": "まだ翻訳されていない部分は英語で表示されます。",
  "settings.persona.identityHint": "名前とキャッチフレーズ。",
  "settings.persona.avatarHint": "生き物を選ぶか、変更内容を説明してください。",
  "settings.persona.whileWorkingHint": "タスクの実行中に表示されるもの。",
  "settings.daily.group.briefHint": "1日の始まりに届く短い要約。",
  "settings.daily.group.wrapupHint": "終わったことの振り返り。",
  "settings.daily.group.deliveryHint": "これらが届く方法。",
  "settings.daily.group.automationsHint": "Psycheが代わりに実行する定期的な作業。",
  "settings.voice.dictationHint": "入力せずに話して操作します。",
  "settings.usage.byThreadHint": "トークンとコストの内訳。",
  "settings.skills.installedHint": "Psycheが今使えるスキル。",
  "settings.about.versionsHint": "このMacで動作しているもの。",
  "settings.specialists.allHint": "役割のオン/オフと予算を設定します。",
  "settings.vm.sandboxMacHint": "コマンドが実行される場所。",
  "settings.computerUse.macPermissionsHint": "macOSが許可しているもの。",
  "settings.voice.advancedHint": "音声エンジン",
  "settings.files.advancedHint": "共有フォルダでPsycheにコマンドを実行させる",
  "settings.browser.advancedHint": "PsycheのWebリクエストに署名する",
  "settings.skills.advancedHint": "Psycheに同梱のスキル",
  "settings.skills.madeByAgent": "{persona}が作成",
  "settings.skills.history": "{n, plural, other {以前のバージョン#件}}",
  "settings.skills.historyItem":
    "v{version} · {approved}に承認 · {retiredBy, select, delete {削除} other {置き換え}}: {retired}",
  "settings.skills.historyHint":
    "参照用に保存されています。これらのバージョンが読み込まれることはありません。",
  "settings.mcp.madeBy": "Psycheが作成",
  "settings.mcp.madeByHint":
    "このコネクタのコードはPsycheが書きました。サンドボックス内でのみ、承認されたコードだけが実行され、変更を伴うツールは事前に確認します。",
  "settings.mcp.code.title": "コード",
  "settings.mcp.code.view": "コードを表示",
  "settings.mcp.code.hide": "コードを隠す",
  "settings.mcp.code.loading": "コードを読み込んでいます…",
  "settings.mcp.code.version": "バージョン{version} · {runtime} · 起動: {entry}",
  "settings.mcp.code.modified":
    "ディスク上のコードが承認されたバージョンと異なるため、変更を承認するまでこのコネクタは停止しています。",
  "settings.mcp.code.file": "{path} · {bytes} B",
  "settings.mcp.code.edit": "{file}を編集",
  "settings.mcp.code.editing": "{file}を編集中",
  "settings.mcp.code.save": "確認用に保存",
  "settings.mcp.code.saving": "保存中…",
  "settings.mcp.code.cancel": "編集をキャンセル",
  "settings.mcp.code.provided": "Psycheが提供。すべてのコネクタで共通",
  "settings.mcp.code.approved": "{name}を更新しました。",
  "settings.mcp.code.denied":
    "{name}への変更は承認されませんでした。承認するまで停止したままです。",
  "settings.deviceAccess.files.title": "このMac上のファイル",
  "settings.deviceAccess.files.hint":
    "{persona}が読み取れるフォルダと、許可した場合に編集できるフォルダです。共有は「権限 → アクセス」で行います。",
  "settings.deviceAccess.files.more": "{count, plural, other {ほか#件}}",
  "settings.deviceAccess.open": "アクセスを開く",
  "settings.deviceAccess.terminal.title": "ターミナル",
  "settings.deviceAccess.terminal.hint":
    "「権限 → アクセス」で「このMacでコマンドを実行」がオンのとき、{persona}はこのMacでターミナルコマンドを実行できます。",
  "settings.deviceAccess.terminal.where":
    "コマンドはMac上で、共有したフォルダ内で実行され、読み書きで共有したフォルダにのみ書き込めます。",
  "settings.deviceAccess.terminal.asks":
    "ファイルを変更する可能性のあるコマンドは、そのコマンドを常に許可すると選ばない限り、先に確認します。lsやcat、wcなど読み取り専用の基本コマンドは、オフにしない限り確認なしで実行されます。",
  "settings.deviceAccess.terminal.sandbox":
    "コマンドはサンドボックス内で実行されます。承認した1回の実行をサンドボックスなしで行うには、そのカードにUNSANDBOXEDと入力する必要があります。",
  "settings.deviceAccess.terminal.on": "コマンドの実行はオン",
  "settings.deviceAccess.terminal.off": "コマンドの実行はオフ",
  "settings.deviceAccess.terminal.folders":
    "{count, plural, =0 {共有フォルダがまだないため、コマンドを実行する場所がありません。} other {#個のフォルダを共有中。}}",
  "settings.mcp.needs.title": "このMacで必要なもの",
  "settings.mcp.needs.srt": "サンドボックス（srt）",
  "settings.mcp.needs.srt.fix": "サーバがPsycheの非公開データに触れないようにします。",
  "settings.mcp.needs.node": "Node.jsツール（npm）",
  "settings.mcp.needs.node.fix":
    "Psyche独自のNodeで動作しますが、このMacにnpmが必要です。nodejs.orgからNode.jsをインストールするか、brew install nodeを実行してください。",
  "settings.mcp.needs.uv": "uv（uvx）",
  "settings.mcp.needs.uv.fix":
    "Pythonサーバです。brew install uvまたはdocs.astral.sh/uvからuvをインストールしてください。",
  "settings.mcp.needs.network": "ネットワーク",
  "settings.mcp.needs.network.fix": "サーバ自身のアドレスに接続します。",
  "settings.mcp.needs.networkHosts":
    "サーバをダウンロードして実行するために、{hosts}にのみ接続します。",
  "settings.mcp.needs.missing": "不足",
  "settings.mcp.needs.ready": "準備完了",
  "settings.mcp.needs.checked": "サーバの確認時にチェック済み",
  "settings.mcp.fail.no_srt":
    "サンドボックスがインストールされていません。下で設定してから、もう一度サーバを確認してください。",
  "settings.mcp.fail.node_missing":
    "npmがこのMacにあるよう、Node.js（nodejs.org、またはbrew install node）をインストールしてから、もう一度確認してください。",
  "settings.mcp.fail.uv_missing":
    "uv（brew install uv、またはdocs.astral.sh/uv）をインストールしてから、もう一度サーバを確認してください。",
  "settings.mcp.fail.command_not_found":
    "サーバのコマンドがここにインストールされていません。コマンドを確認するか、指定されたツールをインストールしてください。",
  "settings.mcp.fail.network_blocked":
    "サーバが必要なものをダウンロードまたは取得できませんでした。接続を確認し、ホストが許可されているか確認してください。",
  "settings.mcp.fail.timeout":
    "時間がかかりすぎました。初回はパッケージをダウンロードします。接続を確認して、もう一度お試しください。",
  "settings.mcp.fail.exited": "サーバは起動直後に停止しました。最後の出力を以下に表示します。",
  "settings.mcp.fail.failed": "以下のサーバ出力を確認してから、もう一度お試しください。",
  "settings.mcp.fail.exitCode": "終了コード{code}。",
  "settings.mcp.fail.output": "サーバの出力",
  "settings.connectors.page.description":
    "{persona}が使えるアプリとツールです。それぞれ、特に指定しない限り、実行前に確認します。",
  "settings.connectors.page.needsYou": "対応が必要",
  "settings.connectors.page.connected": "接続済み",
  "settings.connectors.page.onThisMac": "このMac上",
  "settings.connectors.page.addMore": "さらに追加",
  "settings.connectors.page.addMore.hint":
    "メール、カレンダー、メモ、すぐに使えるツール。それぞれ実行前に確認します。",
  "settings.connectors.page.addMore.browse": "すべて見る",
  "settings.connectors.page.status.paused": "一時停止中",
  "settings.connectors.page.status.notWorking": "動作していません",
  "settings.connectors.page.status.signInExpired": "サインインの期限切れ",
  "settings.connectors.page.status.on": "オン",
  "settings.connectors.page.status.off": "オフ",
  "settings.connectors.page.paused": "一時停止中",
  "settings.connectors.page.open": "{name}を開く",
  "settings.connectors.page.manage": "管理",
  "settings.connectors.page.fix.seeWhy": "理由を見る",
  "settings.connectors.page.row.never": "まだ使用されていません",
  "settings.connectors.page.row.lastUsed": "{when}に使用",
  "settings.connectors.page.row.unverified": "未確認",
  "settings.connectors.page.row.local": "このMac上で動作",
  "settings.connectors.page.row.remote": "Web経由で接続",
  "settings.connectors.page.row.files":
    "{count, plural, =0 {共有フォルダなし} other {#個のフォルダを共有中}}",
  "settings.connectors.page.row.terminal.on": "コマンドを実行可能",
  "settings.connectors.page.row.terminal.off": "コマンドはオフ",
  "settings.connectors.page.detail.label": "{name}の詳細",
  "settings.connectors.page.detail.about": "概要",
  "settings.connectors.page.detail.access": "アクセス",
  "settings.connectors.page.detail.source": "提供元",
  "settings.connectors.page.detail.technical": "技術情報",
  "settings.connectors.page.detail.manage": "一時停止または削除",
  "settings.connectors.page.detail.type": "種類",
  "settings.connectors.page.detail.removeHint":
    "「接続解除」は一時停止して設定を残します。「削除」は設定を削除します。",
  "settings.connectors.page.source.builtIn": "Psycheに組み込み",
  "settings.connectors.page.source.verified": "確認済みの発行元",
  "settings.connectors.page.source.unverified": "まだ誰にも確認されていません",
  "settings.connectors.page.attention.signIn":
    "{name}のサインインの有効期限が切れました。引き続き使えるよう、もう一度サインインしてください。",
  "settings.connectors.page.attention.error":
    "{name}は現在動作していません。もう一度サインインしてみてください。それでも失敗する場合は、削除して追加し直してください。",
  "settings.connectors.page.attention.errorReason": "返ってきた内容: {reason}",
  "settings.connectors.page.attention.server":
    "{name}が起動しなかったため、そのツールは利用できません。",
  "settings.connectors.page.attention.serverHint":
    "下のコマンドまたはアドレスとシークレットを確認してから、オフにして再びオンにしてください。",
  "settings.connectors.page.server.local": "このMac上のサンドボックスで動作するツール",
  "settings.connectors.page.server.remote": "Webアドレスで接続するツール",
  "settings.connectors.page.server.network": "ネットワークに接続します",
  "settings.connectors.page.server.noNetwork": "ネットワークなし",
  "settings.connectors.page.advanced": "詳細設定",
  "settings.connectors.page.advanced.hint": "独自のツールサーバと、公開レジストリの検索。",
  "settings.connectors.page.advanced.custom": "独自のツールサーバ",
  "settings.connectors.page.advanced.customHint":
    "任意のMCPサーバをサンドボックスで実行するか、Webアドレスで接続します。",
  "settings.connectors.page.advanced.customAction": "サーバを追加",
  "settings.connectors.page.advanced.find": "オンラインでサーバを探す",
  "settings.connectors.page.gallery.title": "コネクタを追加",
  "settings.connectors.page.gallery.intro":
    "試したいものを選んでください。それぞれ実行前に確認し、いつでも削除できます。",
  "settings.connectors.page.gallery.noMatch":
    "一致するものがありません。別の言葉をお試しください。",
  "settings.connectors.page.gallery.back": "ギャラリーに戻る",
  "settings.connectors.page.gallery.community": "コミュニティ",
  "settings.nav.memory": "確認",
  "settings.nav.everything": "情報源",
  "settings.learnMore": "詳しく見る",
  "settings.learnLess": "表示を減らす",
  "settings.nav.work": "仕事",
  "settings.nav.surfaces": "メモリの表示場所",
  "settings.key.memory.work": "メモリ内の仕事",
  "settings.key.memory.surfaces": "メモリの表示場所",
  "settings.key.memory.work.enabled": "自分の仕事を追跡",
  "settings.key.memory.work.trackedLists": "仕事として追跡するリマインダーのリスト",
  "settings.key.memory.work.anchorsFromFolders": "仕事として扱うフォルダ",
  "settings.key.memory.work.remind.enabled": "明日が期限のものをリマインド",
  "settings.key.memory.work.remind.dueSoonHours": "期限のものを何時間先まで確認するか",
  "settings.key.memory.work.remind.dayOf": "今日が期限のものも朝にお知らせ",
  "settings.key.memory.surfaces.tiers.work.home": "ホームの仕事",
  "settings.key.memory.surfaces.tiers.work.brief": "デイリーの概要の仕事",
  "settings.key.memory.surfaces.tiers.work.notification": "通知の仕事",
  "settings.key.memory.surfaces.tiers.work.channel": "チャンネルに送る概要の仕事",
  "settings.key.memory.surfaces.tiers.workMail.home": "ホームの仕事関連のメール",
  "settings.key.memory.surfaces.tiers.workMail.brief": "デイリーの概要の仕事関連のメール",
  "settings.key.memory.surfaces.tiers.workMail.notification": "通知の仕事関連のメール",
  "settings.key.memory.surfaces.tiers.workMail.channel": "チャンネルに送る概要の仕事関連のメール",
  "settings.key.memory.surfaces.tiers.people.home": "ホームの人物",
  "settings.key.memory.surfaces.tiers.people.brief": "デイリーの概要の人物",
  "settings.key.memory.surfaces.tiers.people.notification": "通知の人物",
  "settings.key.memory.surfaces.tiers.people.channel": "チャンネルに送る概要の人物",
  "settings.key.memory.surfaces.birthdays": "概要とホームに誕生日と記念日を表示",
  "settings.key.memory.surfaces.hideSources": "ホーム、概要、通知に表示しない情報源",
  "settings.key.memory.surfaces.kinds.project": "プロジェクトをメモリ以外にも表示",
  "settings.key.memory.surfaces.kinds.course": "コースをメモリ以外にも表示",
  "settings.key.memory.surfaces.kinds.assignment": "ToDoをメモリ以外にも表示",
  "settings.key.memory.surfaces.kinds.event": "イベントをメモリ以外にも表示",
  "settings.recording.madeBy": "録画から作成",
  "settings.recording.open": "毎週実行する",
  "settings.recording.title": "スケジュールして実行",
  "settings.recording.checking": "手順を確認しています。",
  "settings.recording.cannot": "これは、あなたがいないときには実行できません:",
  "settings.recording.reason.sensitive": "手順{step}は、ご自身で入力する欄です。",
  "settings.recording.reason.input": "手順{step}は、毎回値の入力を求めます。",
  "settings.recording.reason.unreadable":
    "手順を読み取れません。スケジュールするには録画し直してください。",
  "settings.recording.reason.browserOnly":
    "スケジュール実行は、今のところブラウザの録画のみ対象です。",
  "settings.recording.reason.off": "オフになっているか、承認した後に変更されています。",
  "settings.recording.reason.notRecording": "録画から作成したスキルではありません。",
  "settings.recording.cannotWhy":
    "スケジュール実行では確認できる相手がいないため、パスワードの入力や値の確認は行いません。チャットからご自身で実行することはできます。",
  "settings.recording.rules":
    "実行のタイミングはあなたが決めます。毎回、通常の承認が使われます。ページが変わっていたり、手順で承認が必要だったりした場合は、その手順で一時停止して通知します。推測で進めることはありません。",
  "settings.recording.every": "繰り返し",
  "settings.recording.daily": "日",
  "settings.recording.weekly": "週（曜日）",
  "settings.recording.monthly": "月（日付）",
  "settings.recording.dayOfWeek": "曜日",
  "settings.recording.dayOfMonth": "日付",
  "settings.recording.at": "時刻",
  "settings.recording.confirm": "スケジュールする",
  "settings.recording.close": "キャンセル",
  "settings.recording.runs": "実行回数",
  "settings.recording.seeScheduled": "一時停止、削除、履歴の確認は「スケジュール」で行えます",
  "settings.teach.storage.title": "保存している録画",
  "settings.teach.storage.description":
    "Psycheに別のバージョンを作れるよう録画を保存しておくよう頼むと、手順がこのMacに保存されます。",
  "settings.teach.storage.encrypted":
    "暗号化済み。ファイルはこのMacのキーチェーンに保管されたキーでロックされるため、Psyche以外では読み取れません。90日後に期限切れになります。",
  "settings.teach.storage.unavailable":
    "録画は保存されません。このMacのキーチェーンを利用できず、Psycheは録画を平文で保存しないためです。録画をスキルとして保存することは引き続き可能です。",
  "settings.key.capabilities.onlineSearch": "オンラインのMCPレジストリを検索",
  "settings.key.tools.loading": "ツールを読み込むタイミング",
  "settings.widgets.title": "チャット内のウィジェット",
  "settings.widgets.privacy":
    "Psycheはチャット内に小さなパネル（進捗、リスト、表、グラフ、画像）を表示できます。パネルがWeb上の画像を指すことがあります。許可すると、Gatewayがあなたの代わりにWebから画像を取得します（Cookieやリファラなし、デバイスから直接は取得しません）。対象は一般的な画像形式で、512 KBまでです。信頼できない内容から作られたパネルでは、画像はクリックするまで読み込まれません。",
  "settings.widgets.remoteImages": "ウィジェットにWeb上の画像を表示",
  "settings.widgets.remoteImagesHint":
    "初期値はオフです。オフの場合、画像の代わりに短い注記が表示され、何も取得されません。変更には確認が必要です。",
};
