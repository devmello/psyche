import type { Catalogue } from "../../index.ts";

/** shell strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const shellRest: Partial<Catalogue> = {
  "shell.rail.scheduled": "スケジュール",
  "shell.rail.waiting": "{label}、{n, number}件があなたの対応待ち",
  "shell.palette.addMcp": "MCPサーバを追加",
  "shell.palette.settingsSection": "設定 → {section}",
  "shell.palette.librarySection": "ライブラリ → {section}",
  "shell.palette.canDo": "何ができますか？",
  "shell.palette.rerunSetup": "セットアップをやり直す",
  "shell.palette.you": "概要（アクティビティと成長）を開く",
  "shell.palette.briefInstructions": "ホーム → 概要の指示",
  "shell.palette.fullSearch": "フル検索を開く",
  "shell.palette.keywords.feedInstructions":
    "概要 デイリー 何について書く トピック brief daily topics",
  "shell.palette.scheduledRuns": "スケジュール → 実行",
  "shell.palette.memoryReview": "メモリ → 確認",
  "shell.palette.keywords.settings": "環境設定 オプション 構成 preferences options",
  "shell.palette.keywords.canDo": "ヘルプ 機能 例 試す アイデア help capabilities examples",
  "shell.palette.keywords.rerunSetup":
    "オンボーディング セットアップ ようこそ onboarding setup welcome",
  "shell.palette.keywords.approvals": "権限 決定 対応が必要 permissions approvals",
  "shell.palette.keywords.memoryReview":
    "記憶 事実 フォローアップ 人物 隔離 確認 remember facts review",
  "shell.palette.memoryKind": "メモリ → {kind}",
  "shell.palette.keywords.memoryPeople":
    "連絡先 友人 家族 同僚 人間関係 連絡を保つ contacts friends family",
  "shell.palette.keywords.memoryProjects":
    "コース 授業 仕事 取り組み 進行中 courses jobs initiatives",
  "shell.palette.keywords.memoryDue":
    "ToDo タスク 締め切り 期限 期限切れ 宿題 課題 請求書 家賃 更新 税金 家事 成果物 提出 todo deadlines due overdue homework",
  "shell.palette.keywords.memoryEvents":
    "カレンダー 会議 予定 旅行 出来事 calendar meetings appointments trips",
  "shell.palette.addTodo": "ToDoを追加",
  "shell.palette.keywords.addTodo":
    "新規 ToDo タスク 宿題 課題 締め切り 期限 リマインド 作成 new todo task homework deadline",
  "shell.palette.addProject": "プロジェクトを追加",
  "shell.palette.keywords.addProject":
    "新規 プロジェクト コース 授業 仕事 取り組み 作成 追跡 new project course class job",
  "shell.browser.open": "ブラウザを開く",
  "shell.search.keyCmdL": "⌘L",
  "shell.search.keyCtrlL": "Ctrl L",
};
