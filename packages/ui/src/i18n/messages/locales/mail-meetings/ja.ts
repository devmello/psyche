import type { Catalogue } from "../../index.ts";

/** Mail and meeting settings and onboarding strings (ja); merged into `../ja.ts`. */
export const mailMeetings: Partial<Catalogue> = {
  "settings.nav.mail": "メールと会議",
  "settings.mail.title": "メールと会議",
  "settings.mail.description":
    "Wrenがメールとカレンダーで行うことを設定します。下書きの保存と操作の提案のみを行い、あなたの承認なしに送信、共有、承諾、辞退はしません。",
  "settings.mail.quietHours": "おやすみ時間は「通知」で設定します。",
  "settings.mail.loadFailed": "メールと会議の設定を読み込めませんでした。",

  // Group titles
  "settings.mail.group.master": "まとめて設定",
  "settings.mail.group.accounts": "アカウント",
  "settings.mail.group.digest": "受信トレイのダイジェスト",
  "settings.mail.group.followups": "フォローアップ",
  "settings.mail.group.style": "文体",
  "settings.mail.group.scheduling": "日程調整",
  "settings.mail.group.prep": "会議の準備",
  "settings.mail.group.notes": "会議メモ",
  "settings.mail.group.polling": "新着メールの確認",

  // Master switches
  "settings.mail.paused.hint": "オンに戻すまで、メールと会議のすべてのジョブを停止します。",
  "settings.mail.readOnly.hint":
    "ダイジェストと準備は引き続き届きます。Wrenは操作を提案せず、下書きも作成しません。",

  // Accounts
  "settings.mail.accounts.none":
    "メールアカウントが接続されていません。コネクタで接続してください。",
  "settings.mail.accounts.use": "ダイジェストとフォローアップで{account}を使う",
  "settings.mail.accounts.connect": "コネクタを開く",

  // Inbox digest
  "settings.mail.digest.time": "時刻",
  "settings.mail.digest.days": "曜日",
  "settings.mail.digest.days.weekdays": "平日",
  "settings.mail.digest.days.everyday": "毎日",
  "settings.mail.digest.onlyWhenNeeded.hint":
    "対応事項のない日は、通知せずにフィードにダイジェストを置きます。",
  "settings.mail.digest.rules": "送信者ルール",
  "settings.mail.digest.rulesHint":
    "常にアーカイブする、常に許可する、確認が必要な送信者を管理します。",
  "settings.mail.digest.openRules": "開く",
  "settings.mail.digest.openRulesAsk": "mail/RULES.mdを見せて。",

  // Follow-ups
  "settings.mail.followups.waitDays": "表示するまでの待ち時間",
  "settings.mail.followups.days": "{n, plural, other {# 営業日}}",
  "settings.mail.followups.showTwice.hint":
    "ダイジェストに2回表示されたら、それ以降は表示しません。",

  // Writing style
  "settings.mail.voice.learn.hint":
    "Wrenは送信済みメールのうち、引用部分や署名を除いたあなたの文章だけを読みます。プロファイルはこのMacのmail/VOICE.mdに保存されます。",
  "settings.mail.voice.profile": "文体プロファイル",
  "settings.mail.voice.view": "表示",
  "settings.mail.voice.edit": "編集",
  "settings.mail.voice.reset": "リセット",
  "settings.mail.voice.viewAsk": "mail/VOICE.mdを見せて。",
  "settings.mail.voice.editAsk": "mail/VOICE.mdを編集させて。",
  "settings.mail.voice.resetAsk":
    "文体プロファイルをリセットして。mail/VOICE.mdとmail/voice-samples.jsonlを削除してください。",
  "settings.mail.voice.localModel.hint":
    "あなたの文体での下書きがこのMacの外に出ることはありません。",
  "settings.mail.voice.localModel.none": "メインのモデルを使う",
  "settings.mail.voice.localModel.empty": "ローカルモデルが設定されていません。",

  // Scheduling
  "settings.mail.schedule.hours": "勤務時間",
  "settings.mail.schedule.hoursHint":
    "USER.mdの内容です。候補日時は、平日のこの時間内で提案されます。",
  "settings.mail.schedule.hoursFrom": "開始",
  "settings.mail.schedule.hoursTo": "終了",
  "settings.mail.schedule.buffer.hint": "日時を提案するとき、会議の前後にあけておく時間です。",
  "settings.mail.schedule.minutes": "{n, plural, other {# 分}}",
  "settings.mail.schedule.noBuffer": "なし",
  "settings.mail.schedule.focusTime.hint": "集中して作業するための時間枠の確保を提案します。",
  "settings.mail.schedule.link.hint": "任意です。お持ちの場合、返信で案内します。",

  // Meeting prep
  "settings.mail.prep.scope.hint": "自分のチームだけの会議は対象外にします。",
  "settings.mail.prep.leadMin": "会議の何分前に準備するか",
  "settings.mail.prep.notifyMin": "開始前に知らせる",
  "settings.mail.prep.saveToNotes.hint": "準備メモをメモアプリにも保存します。",
  "settings.mail.prep.dailyCap": "1日あたりの準備の上限",
  "settings.mail.prep.calendars": "準備の対象は、コネクタで接続したカレンダーです。",

  // Meeting notes
  "settings.mail.notes.enabled.hint":
    "音声を追加するまで何も行いません。ボイスメモ、ファイル、開始した録音が対象です。",
  "settings.mail.notes.folder": "録音フォルダ",
  "settings.mail.notes.folder.hint":
    "Wrenが読み取れるフォルダです。「ファイルアクセス」で許可してください。",
  "settings.mail.notes.folder.placeholder": "~/Documents/Recordings",
  "settings.mail.notes.tasksApp": "アクションアイテムの追加先",
  "settings.mail.notes.tasksApp.reminders": "リマインダー",
  "settings.mail.notes.tasksApp.things": "Things",
  "settings.mail.notes.recap.hint": "会議のたびに、要約メールを下書きとして保存します。",
  "settings.mail.notes.consent.hint":
    "開始するすべての録音の前に表示されます。口頭で伝えるか、通話に貼り付けてください。",
  "settings.mail.notes.consent.default": "メモを取るために録音しています。よろしいでしょうか？",
  "settings.mail.notes.cloud.hint":
    "文字起こしには他の人の発言が含まれます。オフの場合はローカルモデルで要約するか、先に確認します。",

  // Polling
  "settings.mail.poll.active": "操作中",
  "settings.mail.poll.idle": "それ以外のとき",
  "settings.mail.poll.hint":
    "Wrenが新着メールを確認する頻度です。短くするとバッテリーを多く消費します。",

  // Setting-key labels (docs/ui-audit.md: a raw key never shows at level 1)
  "settings.key.workflows.paused": "メールと会議のワークフローをすべて一時停止",
  "settings.key.workflows.readOnly": "読み取り専用（ダイジェストと準備のみ）",
  "settings.key.mail.accounts": "ダイジェストとフォローアップで{account}を使う",
  "settings.key.mail.digest.enabled": "受信トレイのダイジェスト",
  "settings.key.mail.digest.time": "ダイジェストの時刻",
  "settings.key.mail.digest.days": "ダイジェストの曜日",
  "settings.key.mail.digest.onlyWhenNeeded": "対応が必要なときだけ通知",
  "settings.key.mail.followups.enabled": "返信待ちを追跡",
  "settings.key.mail.followups.waitDays": "フォローアップの待ち時間",
  "settings.key.mail.followups.showTwice": "各フォローアップの表示は最大2回",
  "settings.key.mail.voice.enabled": "送信済みメールから学習",
  "settings.key.mail.draft.localModel": "ローカルモデルで下書き",
  "settings.key.mail.schedule.hoursStart": "勤務開始時刻",
  "settings.key.mail.schedule.hoursEnd": "勤務終了時刻",
  "settings.key.mail.schedule.bufferMin": "会議の余白",
  "settings.key.mail.schedule.focusTime": "集中時間を提案",
  "settings.key.mail.schedulingLink": "日程調整リンク",
  "settings.key.mail.poll.activeMin": "操作中のメール確認",
  "settings.key.mail.poll.idleMin": "それ以外のメール確認",
  "settings.key.meetings.prep.enabled": "会議の準備",
  "settings.key.meetings.prep.scope": "自分のドメイン外の人との会議のみ",
  "settings.key.meetings.prep.leadMin": "準備の所要時間",
  "settings.key.meetings.prep.notifyMin": "準備の通知タイミング",
  "settings.key.meetings.prep.saveToNotes": "準備をメモにも保存",
  "settings.key.meetings.prep.dailyCap": "1日あたりの準備の上限",
  "settings.key.meetings.notes.enabled": "録音からの会議メモ",
  "settings.key.meetings.notes.folder": "録音フォルダ",
  "settings.key.meetings.notes.tasksApp": "アクションアイテムの追加先",
  "settings.key.meetings.notes.recapDraft": "要約メールを下書き",
  "settings.key.meetings.notes.consentLine": "録音の同意文",
  "settings.key.meetings.notes.cloudSummary": "クラウドモデルで要約",

  // Onboarding decision screen (§7.5)
  "onboarding.step.mail": "メールと会議",
  "onboarding.mail.title": "{name}がメールと会議の状況をまとめます",
  "onboarding.mail.lead":
    "使いたい機能を選んでください。続行するまで何も実行されず、あとから設定で変更できます。",
  "onboarding.mail.digest": "毎朝7:30の受信トレイのダイジェスト",
  "onboarding.mail.digestHint": "対応が必要なことを1日1回まとめます。何も送信しません。",
  "onboarding.mail.prep": "チーム外の人との会議前に準備メモを作成",
  "onboarding.mail.prepHint": "相手が誰か、未解決のこと、前回話した内容をまとめます。",
  "onboarding.mail.followups": "返信待ちを追跡",
  "onboarding.mail.followupsHint": "ダイジェストにのみ表示します。個別の通知はありません。",
  "onboarding.mail.voice": "送信済みメールから自分の文体を学習",
  "onboarding.mail.voiceHint":
    "引用部分や署名を除き、あなたが書いた文章だけを読みます。内容はこのMacに保存され、表示、編集、リセットができます。",
  "onboarding.mail.notes": "録音からの会議メモ",
  "onboarding.mail.notesHint":
    "音声を追加するまで何も行いません。音声や文字起こしがアップロードされたり、学習に使われたりすることはありません。",
  "onboarding.mail.summary":
    "{n, plural, =0 {オンにした機能はありません} other {# 件の機能をオンにしました}}",
  "onboarding.mail.done": "メールと会議",
  "onboarding.mail.doneOff": "オフです。設定でオンにできます。",
  "onboarding.mail.doneOn": "{n, plural, other {# 件のワークフローがオン}}",
};
