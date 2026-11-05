import type { Catalogue } from "../../index.ts";

/** gallery strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const galleryRest: Partial<Catalogue> = {
  "gallery.intro":
    "試したいものを選んでください。どのコネクタも実行前に確認し、いつでも削除できます。",
  "gallery.search": "コネクタを検索",
  "gallery.noMatch":
    "一致するものがありません。別の言葉をお試しいただくか、独自のMCPサーバを追加してください。",
  "gallery.back": "すべてのコネクタ",
  "gallery.getKey": "入手先はこちら。",
  "gallery.keyStaysInVault": "保管庫に保存され、サーバの設定には保存されません。",
  "gallery.tryAsking": "追加したら、こう頼んでみてください:",
  "gallery.custom.desc": "任意のMCPサーバ: サンドボックスで実行するコマンド、またはWebアドレス。",
  "gallery.badge.builtIn": "内蔵",
  "gallery.badge.official": "公式",
  "gallery.badge.community": "コミュニティ",
  "gallery.category.popular": "人気",
  "gallery.category.files": "ファイルとナレッジ",
  "gallery.category.dev": "開発",
  "gallery.category.productivity": "生産性",
  "gallery.category.comms": "メッセージとメール",
  "gallery.category.web": "Web",
  "gallery.category.everyday": "日常",
  "gallery.category.finance": "金融",
  "gallery.category.custom": "独自",
  "gallery.builtin.google": "Gmail、Googleカレンダー、ドライブ。",
  "gallery.builtin.microsoft": "Outlookのメールとカレンダー。",
  "gallery.builtin.imap": "IMAPに対応した任意のメールアカウント。",
  "gallery.builtin.appleNotes": "Appleメモのメモを読み取り、追記します。",
  "gallery.builtin.appleReminders": "リマインダーの確認と作成。",
  "gallery.builtin.appleCalendar": "カレンダーを確認し、予定を追加します。",
  "gallery.builtin.appleMail": "Apple Mailのメールを読み、下書きを作成します。",
  "gallery.builtin.appleShortcuts": "選んだショートカットを実行します。",
  "gallery.builtin.obsidian": "Obsidian Vaultを検索して読み取ります。",
  "gallery.builtin.slack": "SlackからPsycheとチャットします。チャンネルで設定します。",
  "gallery.preset.github.desc": "リポジトリ、Issue、プルリクエストを閲覧します。",
  "gallery.preset.github.example": "私のレビュー待ちのプルリクエストは？",
  "gallery.preset.github.field.token.label": "パーソナルアクセストークン",
  "gallery.preset.github.field.token.help":
    "Psycheに見せたいリポジトリだけに限定した、きめ細かなトークン。",
  "gallery.preset.gitlab.desc":
    "GitLab.comのプロジェクト、マージリクエスト、Issue。接続時にサインインします。",
  "gallery.preset.gitlab.example": "メインプロジェクトの未処理のマージリクエストを要約して。",
  "gallery.preset.git.desc": "ローカルの1つのリポジトリの履歴、ブランチ、差分を読み取ります。",
  "gallery.preset.git.example": "このリポジトリで過去1週間に何が変わりましたか？",
  "gallery.preset.git.field.repo.label": "リポジトリのフォルダ",
  "gallery.preset.git.field.repo.help":
    "このMac上のGitリポジトリのフォルダ。Psycheはその履歴と差分を読み取れます。",
  "gallery.preset.sentry.desc":
    "Sentryプロジェクトのエラーや問題を調べます。接続時にサインインします。",
  "gallery.preset.sentry.example": "今週最も多い未解決のエラーは？",
  "gallery.preset.linear.desc": "Issueとプロジェクトの検索と更新。接続時にサインインします。",
  "gallery.preset.linear.example": "私に割り当てられていて今週が期限のIssueは？",
  "gallery.preset.jira.desc":
    "JiraのIssueとConfluenceのページを検索します。接続時にサインインします。",
  "gallery.preset.jira.example": "昨日更新したJiraのチケットを表示して。",
  "gallery.preset.notion.desc":
    "Notionワークスペースのページを検索、閲覧、編集します。接続時にサインインします。",
  "gallery.preset.notion.example": "先週火曜の会議メモをNotionで探して。",
  "gallery.preset.todoist.desc":
    "Todoistのタスクとプロジェクトを確認・管理します。接続時にサインインします。",
  "gallery.preset.todoist.example": "Todoistで今日が期限のものは？",
  "gallery.preset.airtable.desc": "Airtableのベースのレコードを読み取り、更新します。",
  "gallery.preset.airtable.example":
    "Projectsベースで「ブロック中」になっているレコードを一覧表示して。",
  "gallery.preset.airtable.field.key.label": "パーソナルアクセストークン",
  "gallery.preset.airtable.field.key.help":
    "使いたいベースを読み取れるトークンを作成してください。",
  "gallery.preset.fetch.desc": "Webページを取得して、プレーンテキストとして読み取ります。",
  "gallery.preset.fetch.example": "このページを読んで、重要なポイントを3つ教えて。",
  "gallery.preset.fetch.field.sites.label": "アクセスできるWebサイト",
  "gallery.preset.fetch.field.sites.help":
    "ja.wikipedia.orgのようなホスト名をカンマ区切りで入力します。空欄の場合、パッケージレジストリにしか接続できません。",
  "gallery.preset.braveSearch.desc": "BraveでWeb、ニュース、画像を検索します。",
  "gallery.preset.braveSearch.example": "オープンソースAIモデルに関する今週のニュースを検索して。",
  "gallery.preset.braveSearch.field.key.label": "APIキー",
  "gallery.preset.braveSearch.field.key.help": "試すだけなら無料プランで十分です。",
  "gallery.preset.playwright.desc":
    "別のブラウザを操作して、ページを読み取り、フォームに入力します。",
  "gallery.preset.playwright.example": "example.comを開いて、ページの内容を教えて。",
  "gallery.preset.playwright.field.sites.label": "アクセスできるWebサイト",
  "gallery.preset.playwright.field.sites.help":
    "開いてよいホスト名をカンマ区切りで入力します。空欄にするとオフラインのままになります。",
  "gallery.preset.firecrawl.desc":
    "Webサイトをスクレイピング・クロールして、きれいなテキストにします。",
  "gallery.preset.firecrawl.example":
    "example.comのドキュメントサイトをクロールして、主なセクションを要約して。",
  "gallery.preset.firecrawl.field.key.label": "APIキー",
  "gallery.preset.firecrawl.field.key.help":
    "あなたの代わりにサイトをスクレイピング・クロールするために使用します。",
  "gallery.preset.time.desc": "現在時刻の取得と、タイムゾーン間の変換。",
  "gallery.preset.time.example": "サンフランシスコが午前9時のとき、東京は何時？",
  "gallery.preset.homeAssistant.desc": "Home Assistantで公開しているデバイスの確認と操作。",
  "gallery.preset.homeAssistant.example": "今ついている照明はどれ？",
  "gallery.preset.homeAssistant.field.url.label": "サーバのアドレス",
  "gallery.preset.homeAssistant.field.url.help":
    "Model Context Protocol Server連携をオンにして、設定 → システム → AIからそのアドレスをコピーしてください。https://で始まる必要があります。",
  "gallery.preset.stripe.desc":
    "顧客、支払い、残高を参照します。読み取り専用で、制限付きキーで設定されます。",
  "gallery.preset.stripe.example": "過去30日間にいくら請求しましたか？",
  "gallery.preset.stripe.field.key.label": "制限付きキー",
  "gallery.preset.stripe.field.key.help":
    "読み取り権限のみを持つ制限付きキー（rk_で始まる）を作成してください。それ以外のキーはここでは拒否されます。",
};
