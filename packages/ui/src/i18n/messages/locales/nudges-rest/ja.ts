import type { Catalogue } from "../../index.ts";

/** nudges strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const nudgesRest: Partial<Catalogue> = {
  "nudges.kind": "連絡を取りたい人",
  "nudges.draftReply": "返信の下書きを作成",
  "nudges.draftMessage": "メッセージの下書きを作成",
  "nudges.snooze": "スヌーズ",
  "nudges.snoozeWeek": "1週間後",
  "nudges.snoozeMonth": "1か月後",
  "nudges.mutePerson": "この人は不要",
  "nudges.done": "完了",
  "nudges.overdue": "期限切れ",
  "nudges.moreActions": "ほかの片付け方: {name}",
  "nudges.result.done": "完了にしました。",
  "nudges.result.snooze_week": "1週間スヌーズしました。",
  "nudges.result.snooze_month": "1か月スヌーズしました。",
  "nudges.result.mute_person":
    "{name}へのナッジはオフになりました。相手のページから再びオンにできます。",
  "nudges.gone": "ここでやることはもうありません。",
  "nudges.failed": "保存されませんでした: {reason}",
  "nudges.draft.unanswered":
    "{name}への返信を手伝ってください。{name}からの最後の{channel, select, mail {メール} other {メッセージ}}は{days}日前に届いていて、まだ返信していません。やり取りを確認して、私が読める短い返信の下書きを作ってください。何も送信しないでください。",
  "nudges.draft.drift":
    "しばらく{name}と話していません。近況を尋ねるための、短くて温かいメッセージの下書きを作ってください。何も送信しないでください。",
  "nudges.draft.birthday":
    "もうすぐ{name}さんの特別な日（{date}）です。送れそうな短くて温かいメッセージの下書きを作ってください。何も送信しないでください。",
  "nudges.draft.promise":
    "{text} フォローアップを手伝ってください。これについて{name}への短いメッセージの下書きを作ってください。何も送信しないでください。",
  "nudges.starters.title": "話題にできること",
  "nudges.draft.starters":
    "Psycheが保存している情報から、話題にできそうなこと（これらのみを使い、ほかは作り上げないこと）:",
  "nudges.settings.phrasing": "私のモデルで提案を言い換える",
  "nudges.settings.phrasingHint":
    "「すべてのメモリ」で選んだモデルを使って、より親しみやすい言葉にします。初期値はオフです。",
  "nudges.person.title": "連絡を取りたい人",
  "nudges.person.none": "フォローアップするものはありません。",
  "nudges.person.muted": "{name}へのナッジはオフです。",
  "nudges.person.unmute": "ナッジを再びオンにする",
  "nudges.settings.title": "連絡を保つ",
  "nudges.settings.description":
    "疎遠になった人、誕生日、あなたがした約束について、やさしくお知らせします。",
  "nudges.settings.enabled": "連絡を取るようリマインド",
  "nudges.settings.enabledHint":
    "朝の概要に最大3件、フィードに静かなカードで表示します。代わりに何かが送信されることはありません。",
  "nudges.settings.sensitivity": "頻度",
  "nudges.settings.sensitivityHint": "Psycheが何か言うまで、メッセージをどのくらい待つか。",
  "nudges.settings.low": "控えめ",
  "nudges.settings.normal": "標準",
  "nudges.settings.high": "積極的",
  "nudges.settings.quietHours":
    "カードは、設定 → 一般 → 通知のおやすみ時間が終わるまで待機します。",
  "nudges.consent.title": "人間関係のナッジをオンにしますか？",
  "nudges.consent.body":
    "Psycheは、やり取りのある人と最後に連絡した時期（日付のみで、内容は見ません）、確認済みの誕生日、あなた自身の言葉での約束を確認します。",
  "nudges.consent.rules":
    "除外した人は表示されず、機微な事実は使われません。ナッジは、名前と日数だけの簡潔な1文です。「この人は不要」でいつでも誰でも除外でき、この機能もいつでもオフにできます。",
  "nudges.consent.confirm": "オンにする",
  "nudges.consent.cancel": "あとで",
};
