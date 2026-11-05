import type { Catalogue } from "../../index.ts";

/** memoryAdvanced strings not covered elsewhere (ja); merged into `../ja.ts`. */
export const memoryAdvancedRest: Partial<Catalogue> = {
  "memoryAdvanced.title": "詳細設定",
  "memoryAdvanced.description": "モデル、スケジュール、呼び出し方法、暗号化、データ。",
  "memoryAdvanced.recall": "呼び出し",
  "memoryAdvanced.data": "あなたのデータ",
  "memoryAdvanced.dataHint":
    "{persona}が覚えているすべてを書き出し、バックアップ、またはリセットします。",
  "memoryAdvanced.dataOpen": "プライバシーとデータを開く",
  "memoryAdvanced.keeping": "保持期間",
  "memoryAdvanced.keepingPending": "未確認の事実",
  "memoryAdvanced.keepingUntrusted": "他の人からの事実",
  "memoryAdvanced.keepingQuarantine": "隔離",
  "memoryAdvanced.keepingDays": "{days, plural, other {#日}}",
  "memoryAdvanced.keepingMonths": "{months, plural, other {#か月}}",
  "memoryAdvanced.encryption": "暗号化",
};
