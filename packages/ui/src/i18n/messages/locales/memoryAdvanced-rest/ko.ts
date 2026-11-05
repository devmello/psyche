import type { Catalogue } from "../../index.ts";

/** memoryAdvanced strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const memoryAdvancedRest: Partial<Catalogue> = {
  "memoryAdvanced.title": "고급",
  "memoryAdvanced.description": "모델, 일정, 불러오기 방식, 암호화, 데이터.",
  "memoryAdvanced.recall": "불러오기",
  "memoryAdvanced.data": "내 데이터",
  "memoryAdvanced.dataHint": "{persona}가 기억하는 모든 것을 내보내거나 백업하거나 초기화합니다.",
  "memoryAdvanced.dataOpen": "개인정보 및 데이터 열기",
  "memoryAdvanced.keeping": "보관 기간",
  "memoryAdvanced.keepingPending": "검토 전 사실",
  "memoryAdvanced.keepingUntrusted": "다른 사람에게서 온 사실",
  "memoryAdvanced.keepingQuarantine": "격리",
  "memoryAdvanced.keepingDays": "{days, plural, other {#일}}",
  "memoryAdvanced.keepingMonths": "{months, plural, other {#개월}}",
  "memoryAdvanced.encryption": "암호화",
};
