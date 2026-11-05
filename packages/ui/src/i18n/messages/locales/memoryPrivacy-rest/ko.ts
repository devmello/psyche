import type { Catalogue } from "../../index.ts";

/** memoryPrivacy strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const memoryPrivacyRest: Partial<Catalogue> = {
  "memoryPrivacy.title": "개인정보",
  "memoryPrivacy.description":
    "{persona}가 학습해도 되는 대상, 절대 보관하면 안 되는 내용, 지우는 방법을 설정합니다.",
  "memoryPrivacy.forget": "지우기",
  "memoryPrivacy.forgetHint":
    "하나의 출처에서 가져온 내용 또는 사람 및 프로젝트에 관한 모든 것을 삭제합니다.",
  "memoryPrivacy.sensitiveSummary": "{total, number}개 중 {n, number}개 허용",
  "memoryPrivacy.sensitiveChoose": "주제 선택",
};
