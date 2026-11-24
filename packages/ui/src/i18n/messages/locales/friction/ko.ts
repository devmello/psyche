import type { Catalogue } from "../../index.ts";

/** Approval-friction and person-interaction strings (ko); merged into `../ko.ts`. */
export const friction: Partial<Catalogue> = {
  "friction.title": "승인 마찰",
  "friction.hint":
    "Psyche가 행동하기 전에 얼마나 자주 멈춰서 묻는지, 그리고 어떻게 답하는지 보여 줍니다. 감사 로그의 개수만 사용합니다.",
  "friction.window": "기간",
  "friction.window.days": "최근 {days}일",
  "friction.loading": "승인 횟수를 집계하는 중…",
  "friction.error": "승인 마찰을 불러오지 못했습니다: {reason}",
  "friction.retry": "다시 시도",
  "friction.empty": "이 기간에 Psyche가 확인한 작업이 없어서 보여 줄 마찰이 없습니다.",
  "friction.since": "{date} 이후",
  "friction.asked":
    "확인한 작업 {decisions, plural, one {#개} other {#개}} 중 {asks, plural, one {#개} other {#개}}에 대해 물었습니다 ({rate}%).",
  "friction.perRun": "한 번 이상 물은 실행은 평균 {n}번씩 물었습니다.",
  "friction.answered": "끝난 질문 중 {rate}%는 만료되기 전에 답변되었습니다.",
  "friction.approved": "끝난 질문 중 {rate}%는 승인되었습니다.",
  "friction.noTimes": "이 기간에 답변된 질문이 없어서 답변 시간이 없습니다.",
  "friction.times": "답변까지 중간값은 {p50}였습니다. 가장 느린 10%는 {p90} 이상 걸렸습니다.",
  "friction.expired":
    "{n, plural, =0 {답변 없이 만료된 질문이 없습니다.} other {답변 없이 만료된 질문이 #개 있습니다.}}",
  "friction.rejected":
    "{n, plural, =0 {거부된 답변이 없습니다.} other {잘못된 답변으로 거부된 답변이 #개 있습니다.}}",
  "friction.saved":
    "{n, plural, =0 {카드 없이 상시 허용으로 실행된 작업이 없습니다.} other {카드 없이 상시 허용으로 실행된 작업이 #개 있습니다.}}",
  "friction.grantsCreated":
    "{n, plural, =0 {만들어진 상시 허용이 없습니다.} other {만들어진 상시 허용이 #개 있습니다.}}",
  "friction.kinds": "질문이 발생한 작업",
  "friction.kind.row": "{kind}: 질문 {asks}, 승인 {approved}, 거부 {declined}, 만료 {expired}",
  "friction.rules": "질문하는 가장 흔한 이유",
  "friction.rule.row": "{label}: {count}",
  "friction.rule.mode": "모드 설정",
  "friction.rule.taint": "외부에서 온 내용",
  "friction.rule.policy": "내 정책",
  "friction.rule.designated": "보호된 위치",
  "friction.rule.site": "사이트 규칙",
  "friction.rule.other": "다른 규칙",
  "friction.modes": "모드별",
  "friction.mode.row": "{mode}: {decisions}개 중 {asks}개 질문",

  "people.interactions.error": "이전 상호작용을 불러오지 못했습니다: {reason}",
  "people.interactions.older": "이전 항목 보기",
  "people.interactions.retry": "다시 시도",
  "people.interactions.loadingMore": "불러오는 중…",
};
