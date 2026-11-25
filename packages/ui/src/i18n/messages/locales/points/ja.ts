import type { Catalogue } from "../../index.ts";

/** Psyche points (ja); merged into `../ja.ts`. */
export const points: Partial<Catalogue> = {
  "points.sheet.title": "フォームを案内して",
  "points.sheet.description":
    "ウインドウを選ぶと、Psycheが次に入力する欄を指し示します。クリックと入力はあなたが行います。",
  "points.sheet.windows.label": "ウインドウ",
  "points.sheet.windows.loading": "ウインドウを探しています…",
  "points.sheet.windows.empty":
    "指し示せるウインドウがありません。フォームを開いて、もう一度お試しください。",
  "points.sheet.windows.error":
    "ウインドウを一覧にできませんでした。Psyche Helperが動いているか確認して、もう一度お試しください。",
  "points.sheet.windows.retry": "再試行",
  "points.sheet.window.untitled": "無題のウインドウ",
  "points.sheet.window.frontmost": "最前面",
  "points.refusal.never_app": "Psycheはこのアプリでは案内しません。",
  "points.refusal.fixed_off": "このアプリはPsycheの対象外です。",
  "points.refusal.terminal_or_ide": "ターミナルやコードエディタはフォームではありません。",
  "points.refusal.owner_off": "設定でこのアプリをオフにしています。",
  "points.refusal.not_a_window": "Psycheはこのウインドウを読み取れません。",
  "points.refusal.permission_missing":
    "このウインドウを読み取るには、アクセシビリティを許可してください。",
  "points.sheet.goal.label": "このフォームは何のためですか？（任意）",
  "points.sheet.goal.placeholder": "2026年の確定申告、夫婦合算",
  "points.sheet.data.provider":
    "案内のため、Psycheはフォームのラベルと入力内容を{provider}に送ります。パスワード、カード、銀行、ID番号は除きます。",
  "points.sheet.data.local": "このコンピュータの外には出ません。",
  "points.sheet.data.providerFallback": "お使いのモデルプロバイダ",
  "points.sheet.payments":
    "支払いページでは、Psycheは案内だけを行います。それらの欄はご自身で入力してください。",
  "points.sheet.permission.hint":
    "Psycheはアクセシビリティ経由でウインドウを読み取ります。開始するには、Psyche Helperに許可してください。",
  "points.sheet.start": "案内を始める",
  "points.sheet.starting": "開始中…",
  "points.sheet.cancel": "キャンセル",
  "points.sheet.startFailed": "案内を開始できませんでした。もう一度お試しください。",
  "points.sheet.session.active": "{app}で案内中",
  "points.sheet.session.stop": "案内をやめる",
  "points.state.reading": "フォームを読み取り中…",
  "points.state.pointing": "{of}欄中{step}欄目",
  "points.state.paused": "一時停止中",
  "points.needs.screenRecording.title": "Psycheに見てもらうには画面収録が必要です",
  "points.needs.screenRecording.hint":
    "Psycheがこのウインドウの画像を送るのは、「Psycheに見てもらう」を押したときだけです。",
  "points.needs.done": "完了",
  "points.offer.button": "案内して",
  "points.offer.hint": "Psycheが見る場所を示します。クリックと入力はあなたが行います。",
  "points.offer.elsewhere":
    "Psycheが動いているコンピュータでPsyche pointsを始めます。{keys}を押して「フォームを案内して」を選んでください。",
  "points.palette.start": "フォームを案内して",
  "points.palette.keywords": "psyche points 矢印 案内 フォーム 入力 税金 ビザ 書類 手伝い",
  "points.settings.title": "Psyche points",
  "points.settings.description":
    "ウインドウを選ぶと、Psycheが次に入力する欄を指し示します。クリックも入力も決してしません。",
  "points.settings.enabledHint":
    "「フォームを案内して」をコマンドパレットとメニューバーのメニューに追加します。",
  "settings.key.points.enabled": "フォームを案内してもらう",
  "points.card.back": "戻る",
  "points.card.skip": "スキップ",
  "points.card.next": "次へ",
  "points.card.looksWrong": "違う？",
  "points.card.stuck": "困った？",
  "points.card.stuckMissing": "手元にない",
  "points.card.stuckUnclear": "意味がわからない",
  "points.card.stuckBlocked": "入力できない",
  "points.card.askInPsyche": "Psycheで質問…",
  "points.card.letLook": "Psycheに見てもらう",
  "points.card.stop": "停止",
  "points.card.hideNote": "メモを隠す",
  "points.card.copy": "コピー",
  "points.card.selfFill": "ここはご自身で入力してください：{label}",
  "points.card.selfFillPlain": "ここはご自身で入力してください",
  "points.card.payButton":
    "このボタンは支払いを行います。金額を確認して、ご自身で判断してください。",
  "points.card.unknownValue": "Psycheはこの項目を知りません。",
  "points.card.scrollTo": "{label}までスクロールしてください",
  "points.card.menuBarTitle": "◉ 案内中：{app}",
  "points.card.stepFormat": "{n}/{total}",
  "points.card.visionBadge": "このウインドウの画像を使用中",
  "points.card.followWindow": "このウインドウに追従",
};
