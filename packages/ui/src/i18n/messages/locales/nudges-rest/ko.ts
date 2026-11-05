import type { Catalogue } from "../../index.ts";

/** nudges strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const nudgesRest: Partial<Catalogue> = {
  "nudges.kind": "연락하면 좋은 사람",
  "nudges.draftReply": "답장 초안 작성",
  "nudges.draftMessage": "메시지 초안 작성",
  "nudges.snooze": "나중에 알림",
  "nudges.snoozeWeek": "1주일 뒤",
  "nudges.snoozeMonth": "1개월 뒤",
  "nudges.mutePerson": "이 사람은 제외",
  "nudges.done": "완료",
  "nudges.overdue": "기한 지남",
  "nudges.moreActions": "다른 처리 방법: {name}",
  "nudges.result.done": "완료로 표시했습니다.",
  "nudges.result.snooze_week": "1주일 동안 미뤘습니다.",
  "nudges.result.snooze_month": "1개월 동안 미뤘습니다.",
  "nudges.result.mute_person":
    "{name}에 대한 넛지를 껐습니다. 해당 페이지에서 다시 켤 수 있습니다.",
  "nudges.gone": "여기서 할 일이 더 이상 없습니다.",
  "nudges.failed": "저장되지 않았습니다: {reason}",
  "nudges.draft.unanswered":
    "{name}에게 보낼 답장을 도와주세요. {name}이(가) 마지막으로 보낸 {channel, select, mail {메일} other {메시지}}이(가) {days}일 전에 왔고 아직 답하지 않았습니다. 대화를 살펴본 다음 제가 읽어 볼 짧은 답장 초안을 작성해 주세요. 아무것도 보내지 마세요.",
  "nudges.draft.drift":
    "한동안 {name}와(과) 이야기하지 못했습니다. 안부를 묻는 짧고 따뜻한 메시지 초안을 작성해 주세요. 아무것도 보내지 마세요.",
  "nudges.draft.birthday":
    "곧 {name}의 특별한 날({date})입니다. 보낼 수 있는 짧고 따뜻한 메시지 초안을 작성해 주세요. 아무것도 보내지 마세요.",
  "nudges.draft.promise":
    "{text} 후속 조치를 도와주세요. 이에 대해 {name}에게 보낼 짧은 메시지 초안을 작성해 주세요. 아무것도 보내지 마세요.",
  "nudges.starters.title": "꺼낼 만한 이야기",
  "nudges.draft.starters":
    "Psyche에 저장된 정보에서 꺼낼 만한 이야기 (이 내용만 사용하고 다른 것은 지어내지 말 것):",
  "nudges.settings.phrasing": "내 모델로 제안 문구 다듬기",
  "nudges.settings.phrasingHint":
    "모든 메모리에서 선택한 모델을 사용해 더 친근한 말투로 바꿉니다. 기본값은 꺼짐입니다.",
  "nudges.person.title": "연락하면 좋은 사람",
  "nudges.person.none": "후속 조치할 것이 없습니다.",
  "nudges.person.muted": "{name}에 대한 넛지가 꺼져 있습니다.",
  "nudges.person.unmute": "넛지 다시 켜기",
  "nudges.settings.title": "연락 유지",
  "nudges.settings.description":
    "연락이 뜸해진 사람, 생일, 사용자가 한 약속을 부드럽게 알려 드립니다.",
  "nudges.settings.enabled": "연락하도록 알림",
  "nudges.settings.enabledHint":
    "아침 브리핑에 최대 3개, 피드에 조용한 카드로 표시합니다. 대신 무언가가 전송되는 일은 없습니다.",
  "nudges.settings.sensitivity": "빈도",
  "nudges.settings.sensitivityHint": "Psyche가 말을 꺼내기까지 메시지를 얼마나 기다릴지입니다.",
  "nudges.settings.low": "부드럽게",
  "nudges.settings.normal": "보통",
  "nudges.settings.high": "적극적으로",
  "nudges.settings.quietHours":
    "카드는 설정 → 일반 → 알림의 방해 금지 시간이 끝날 때까지 대기합니다.",
  "nudges.consent.title": "관계 넛지를 켜시겠습니까?",
  "nudges.consent.body":
    "Psyche는 연락을 주고받는 사람과 마지막으로 연락한 시점(날짜만 보며 내용은 보지 않음), 확인된 생일, 사용자가 직접 한 약속을 살펴봅니다.",
  "nudges.consent.rules":
    '제외한 사람은 표시되지 않고 민감한 사실은 사용되지 않습니다. 넛지는 이름과 일수만 담은 평범한 한 문장입니다. "이 사람은 제외"로 누구든 끌 수 있고, 이 기능도 언제든 끌 수 있습니다.',
  "nudges.consent.confirm": "켜기",
  "nudges.consent.cancel": "나중에",
};
