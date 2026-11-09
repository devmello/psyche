import type { Catalogue } from "../../index.ts";

/** onboarding strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const onboardingRest: Partial<Catalogue> = {
  "onboarding.stepCount": "{total, number}中{n, number}",
  "onboarding.connectors.onThisMac": "このMac上",
  "onboarding.connectors.onThisMacHint": "各アプリは接続時に、1つずつmacOSに許可を求めます。",
  "onboarding.connectors.connectApps": "{n, plural, =0 {アプリを接続} other {#個のアプリを接続}}",
  "onboarding.connectors.connecting": "{name}を接続中",
  "onboarding.connectors.accounts": "アカウント",
  "onboarding.step.memory": "メモリと毎日の習慣",
  "onboarding.about.lead":
    "Psycheが最初からあなたのことを知っているための、いくつかの情報です。すべて任意で、USER.mdに保存され、いつでも編集できます。",
  "onboarding.about.name": "お名前",
  "onboarding.about.nameHint": "Psycheにどう呼んでほしいですか？",
  "onboarding.about.timeZone": "タイムゾーン",
  "onboarding.about.timeZoneHint": "Asia/Tokyo",
  "onboarding.about.work": "仕事または学業",
  "onboarding.about.workHint": "していることを数語で",
  "onboarding.about.city": "お住まいの都市",
  "onboarding.about.cityHint": "普段いる場所",
  "onboarding.memory.lead":
    "ChatGPTまたはClaudeにすでにプロフィールがありますか？ メモリのエクスポート、または「私について何を知っていますか？」への回答を貼り付けてください。保存する前に、すべて確認できます。",
  "onboarding.memory.unavailable":
    "このウインドウでは読み込みを利用できません。あとでSoulから行えます。",
  "onboarding.memory.format": "取得元",
  "onboarding.memory.format.chatgpt": "ChatGPT",
  "onboarding.memory.format.claude": "Claude",
  "onboarding.memory.format.text": "その他のテキスト",
  "onboarding.memory.paste": "メモリのテキスト",
  "onboarding.memory.placeholder": "ここに貼り付けるか、.txt、.md、.jsonファイルをアップロード",
  "onboarding.memory.upload": "ファイルをアップロード",
  "onboarding.memory.review": "確認",
  "onboarding.memory.found":
    "確認する項目が{n, number}件見つかりました（{skipped, number}件はスキップ）。残したくないものはチェックを外してください。",
  "onboarding.memory.items": "読み込む項目",
  "onboarding.memory.flagged": "指示のように読める",
  "onboarding.memory.edit": "テキストに戻る",
  "onboarding.memory.save": "{n, number}件をメモリに保存",
  "onboarding.memory.saved": "{n, number}件をメモリに保存しました。",
  "onboarding.memory.failed": "うまくいきませんでした（{reason}）。",
  "onboarding.habits.lead":
    "ホームに朝と夕方の短いカードを表示します。Psycheは読み取るだけで、承認なしに何かを送信することはありません。",
  "onboarding.habits.brief": "デイリーの概要",
  "onboarding.habits.briefHint": "平日の毎朝、1日の予定をお届けします。",
  "onboarding.habits.wrapup": "夕方のまとめ",
  "onboarding.habits.wrapupHint": "終わったことと、明日に持ち越すこと。",
  "onboarding.habits.followups": "フォローアップの追跡",
  "onboarding.habits.followupsHint": "まだ返事を待っているやり取りに気づきます。",
  "onboarding.rerun.title": "セットアップをやり直す",
  "onboarding.rerun.description":
    "初回セットアップをもう一度行います。完了済みのステップはスキップされます。",
  "onboarding.rerun.button": "セットアップをやり直す",
  "onboarding.step.you": "あなたとエージェント",
  "onboarding.step.stuff": "あなたのデータ",
  "onboarding.step.safety": "安全性",
  "onboarding.you.lead": "このページの内容はすべて任意で、あとから変更できます。",
  "onboarding.you.agent": "あなたのエージェント",
  "onboarding.you.customize": "見た目をカスタマイズ",
  "onboarding.you.more": "あなたについてもっと",
  "onboarding.memory.habitsLead":
    "{name}が毎日行うことと、メモリに保持することを選んでください。すべて設定で変更できます。",
  "onboarding.memory.bring": "ChatGPTまたはClaudeからメモリを持ち込む",
  "onboarding.habits.title": "毎日",
  "onboarding.work.title": "仕事とToDo",
  "onboarding.work.hint":
    "請求書、家賃、税金、更新手続き、仕事の締め切り、宿題など、期限のあるものすべてについてToDoを管理します。{persona}が読むのは、選んだリストとフォルダのみです。許可するまではオフです。",
  "onboarding.work.remindHint":
    "夕方のまとめと一緒に送信されます。タイトルが表示されるのは、ご自身で追加した項目のみです。",
  "onboarding.work.later":
    "対象にするリマインダーのリストとフォルダは、設定 → メモリ → 仕事で選べます。",
  "onboarding.people.title": "人物",
  "onboarding.people.label": "概要に人物を含める",
  "onboarding.people.hint":
    "知っている人についての事実と、連絡を保つ相手。オンにするまでオフです。",
  "onboarding.people.needsBrief":
    "朝の概要がオフのため、人物はまだどこにも表示されません。オンにすると表示されます。",
  "onboarding.safety.lead":
    "承認の届け方と、自動で実行される内容を設定します。ファイル、アプリ、画面へのアクセスはここでは尋ねません。{name}が初めて必要としたときにチャットで尋ねます。",
  "onboarding.safety.touchId": "支払いにTouch IDを使う",
  "onboarding.safety.touchId.checking": "Macヘルパーを確認しています…",
  "onboarding.safety.touchId.again": "もう一度確認",
  "onboarding.safety.touchId.set": "設定",
  "onboarding.safety.touchId.setHint": "支払いでは、指紋かMacのパスワードを求めます。",
  "onboarding.safety.touchId.starting":
    "Macヘルパーはまだ起動中です。しばらくしてからもう一度確認してください。",
  "onboarding.safety.touchId.noKey": "MacヘルパーにTouch IDキーがありません（{reason}）。",
  "onboarding.safety.touchId.register": "このキーを登録",
  "onboarding.safety.touchId.hint":
    "Macヘルパーのキーを一度登録しておくと、Touch IDで支払いを確認できます。",
  "onboarding.safety.notifications": "通知",
  "onboarding.safety.asks":
    "{name}にこのMacでのコマンド実行を許可した場合、lsやcatのように読み取るだけのものはカードなしで実行されます。それ以外は先に確認します。",
  "onboarding.safety.sandbox": "コマンド用のサンドボックスを設定",
  "onboarding.safety.optional": "任意",
  "onboarding.done.on": "オン",
  "onboarding.done.off": "オフ",
  "onboarding.done.daily": "デイリー",
  "onboarding.done.work": "仕事の追跡",
  "onboarding.done.people": "概要に含める人物",
  "onboarding.done.touchId": "Touch ID",
  "onboarding.done.touchIdSet": "キーを登録済み",
  "onboarding.done.touchIdNot": "まだ登録されていません",
  "onboarding.done.modelKept": "変更なし",
  "onboarding.done.try": "次に試す",
  "onboarding.done.try.search":
    "検索（⌘K）で質問してみましょう。回答には、生活のどこから得た情報かが表示されます。",
  "onboarding.done.try.home":
    "ホームを開きましょう。「追いつく」には、後回しにしていそうなことが一覧表示されます。",
  "onboarding.done.try.canDo":
    "歯車メニューの「何ができますか？」を開くと、すぐに使えるタスクが見つかります。",
};
