import type { Catalogue } from "../../index.ts";

/** automationChat strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const automationChatRest: Partial<Catalogue> = {
  "automationChat.label": "{title}의 실행",
  "automationChat.runs": "{n, plural, other {실행 #회}}",
  "automationChat.runs.aria": "{title}, {n, plural, other {실행 #회}}, 마지막 실행: {status}",
  "automationChat.schedule": "예약됨",
  "automationChat.runNow": "지금 실행",
  "automationChat.empty": "아직 실행되지 않았습니다. 이 자동화가 실행될 때마다 여기에 표시됩니다.",
  "automationChat.loading": "실행 기록을 불러오는 중",
  "automationChat.failed": "Psyche가 실행 기록을 불러오지 못했습니다",
  "automationChat.more": "이전 실행 보기",
  "automationChat.status.needsYou": "확인 필요",
  "automationChat.status.running": "실행 중",
  "automationChat.trigger.manual": "지금 실행",
  "automationChat.trigger.event": "이벤트 발생 시",
  "automationChat.coalesced": "놓친 {n}회를 한 번으로 묶음",
  "automationChat.noResult": "작성된 결과 없음",
  "automationChat.noSteps": "이 실행에는 기록된 단계가 없습니다.",
  "automationChat.stepsLoading": "단계를 불러오는 중",
  "automationChat.timeline": "타임라인에서 열기",
  "automationChat.approvals": "승인 열기",
  "automationChat.waiting": "이 실행은 사용자를 기다리고 있습니다.",
  "automationChat.result": "결과",
  "automationChat.openScheduled": "예약됨에서 열기",
  "automationChat.row.runs": "{n, plural, other {실행 #회}}",
  "automationChat.row.last": "마지막 실행: {status}",
};
