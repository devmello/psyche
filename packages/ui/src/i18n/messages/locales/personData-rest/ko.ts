import type { Catalogue } from "../../index.ts";

/** personData strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const personDataRest: Partial<Catalogue> = {
  "personData.export": "모두 내보내기…",
  "personData.said": "말한 내용 지우기…",
  "personData.exclude": "이 사람에 대해 학습하지 않기…",
  "personData.excludeForget": "이 사람에 대해 학습하지 않고 지우기…",
  "personData.title.said": "{name}이(가) 말한 내용을 지우시겠습니까?",
  "personData.title.exclude": "{name}에 대한 학습을 중지하시겠습니까?",
  "personData.title.exclude_forget": "{name}에 대한 학습을 중지하고 지우시겠습니까?",
  "personData.counts":
    "해당 사람의 메시지에서 학습한 사실 {facts, number}개, 인용 {quotes, number}개, 보류된 항목 {held, number}개를 삭제합니다.",
  "personData.excludeOnly":
    "해당 사람의 메시지는 읽지 않으며 그 사람에 대해 아무것도 학습하지 않습니다. 이미 알고 있는 내용은 지우기 전까지 남습니다.",
  "personData.after.said": "그 사람, 그 사람의 메시지, 직접 추가한 내용은 그대로 남습니다.",
  "personData.after.exclude": "설정 → 메모리 → 개인정보에서 다시 허용할 수 있습니다.",
  "personData.after.exclude_forget":
    "설정 → 메모리 → 개인정보에서 다시 허용할 수 있지만, 삭제한 내용은 복구되지 않습니다.",
  "personData.confirm.said": "말한 내용 지우기",
  "personData.confirm.exclude": "학습 중지",
  "personData.confirm.exclude_forget": "중지하고 지우기",
  "personData.done.said": "{name}이(가) 말한 내용을 지웠습니다.",
  "personData.done.exclude": "{name}에 대한 학습을 중지했습니다.",
  "personData.done.exclude_forget": "{name}에 대한 학습을 중지하고 말한 내용을 지웠습니다.",
};
