import type { Catalogue } from "../../index.ts";

/** memoryWork strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const memoryWorkRest: Partial<Catalogue> = {
  "memoryWork.title": "仕事",
  "memoryWork.description":
    "{persona}があなたのために把握しているもの: プロジェクト、期限のあるToDo、中断した箇所。",
  "memoryWork.loadLabel": "業務メモリ",
  "memoryWork.enabled.title": "メモリ内の仕事",
  "memoryWork.enabled.label": "自分の仕事を追跡",
  "memoryWork.enabled.hint":
    "期限のあるものすべてについて、ToDoと進み具合、中断した箇所を管理します。許可するまではオフです。",
  "memoryWork.enabled.off":
    "オンにすると、リマインダーのリストやフォルダを選んだり、リマインダーを設定したりできます。",
  "memoryWork.consent.title": "メモリで仕事を追跡",
  "memoryWork.consent.body":
    "{persona}は、期限のあるもの（家賃、実験レポート、役員会向け資料など）のToDoを管理し、進み具合や中断した箇所を記録します。",
  "memoryWork.consent.reads": "読み取る内容",
  "memoryWork.consent.r1": "選んだリマインダーのリストと、ご自身のカレンダー",
  "memoryWork.consent.r2": "プロジェクトにリンクしたフォルダ内のファイル",
  "memoryWork.consent.r3": "送信したメール、リンクしたスレッドのメール、{persona}とのチャット",
  "memoryWork.consent.keeps": "変わらないこと",
  "memoryWork.consent.k1": "このMacの外には何も出ません。日付とステータスはコードで算出されます。",
  "memoryWork.consent.k2": "他の人のテキストが、期限やステータスを変えることはありません。",
  "memoryWork.consent.k3":
    "仕事はホームとデイリーの概要に表示されます。「メモリの表示場所」で変更できます。",
  "memoryWork.consent.cancel": "あとで",
  "memoryWork.consent.confirm": "オンにする",
  "memoryWork.lists.title": "リマインダーのリスト",
  "memoryWork.lists.description":
    "追跡対象のリストで期限のあるリマインダーは、選んだプロジェクトのToDoになります。それ以外のリストには手を加えません。コネクタで自分のものと設定したリストだけが、完了にできます。",
  "memoryWork.lists.none": "追跡しない",
  "memoryWork.lists.pick": "{list}のプロジェクト",
  "memoryWork.lists.missing": "リマインダーに存在しなくなったリスト",
  "memoryWork.lists.shared": "共有リスト",
  "memoryWork.lists.empty": "リマインダーのリストはまだありません。",
  "memoryWork.lists.noProjects": "メモリページでプロジェクトを追加してから、ここで選んでください。",
  "memoryWork.lists.openMemory": "メモリを開く",
  "memoryWork.lists.loading": "リマインダーのリストを読み込んでいます…",
  "memoryWork.folders.title": "フォルダ",
  "memoryWork.folders.anchored": "プロジェクトにリンクしたフォルダのみ",
  "memoryWork.folders.anchoredHint":
    "プロジェクトのページからフォルダをリンクします。フォルダ名がプロジェクトと一致すると、{persona}が提案します。",
  "memoryWork.folders.all": "{persona}が読み取れるすべてのフォルダ（名前で照合）",
  "memoryWork.folders.allHint":
    "名前がプロジェクトと一致するフォルダは、確認なしでリンクされます。読み取るのは名前と日付のみです。",
  "memoryWork.remind.title": "やり遂げるためのリマインダー",
  "memoryWork.remind.description": "オンにするまで通知はオフです。おやすみ時間中は届きません。",
  "memoryWork.remind.enabled": "明日が期限のものをリマインド",
  "memoryWork.remind.enabledHint":
    "まとめの時刻に1日1回、今後{hours, plural, other {#時間}}以内が期限のものを通知します。",
  "memoryWork.remind.hours": "どのくらい先まで確認するか",
  "memoryWork.remind.hoursOption": "{hours, plural, other {#時間}}",
  "memoryWork.remind.at": "タイミング",
  "memoryWork.remind.atWrapup": "まとめの時刻（{time}）",
  "memoryWork.remind.atHint":
    "デイリーで設定します。タイトルが表示されるのは、ご自身で追加した項目のみです。",
  "memoryWork.remind.openDaily": "デイリーを開く",
  "memoryWork.remind.dayOf": "今日が期限のものも朝にお知らせ",
  "memoryWork.remind.dayOfHint": "朝の概要のあとに2回目の通知: 「今日が期限: …」。",
  "memoryWork.remind.needsWrapup":
    "夕方のまとめがオフのため、何も送信されません。オンにするとこの通知が届きます。",
  "memoryWork.remind.needsBrief":
    "朝の概要がオフのため、何も送信されません。オンにするとこの通知が届きます。",
  "memoryWork.remind.turnOnWrapup": "まとめをオンにする",
  "memoryWork.remind.turnOnBrief": "概要をオンにする",
};
