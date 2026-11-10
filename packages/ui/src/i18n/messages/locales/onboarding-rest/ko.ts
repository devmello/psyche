import type { Catalogue } from "../../index.ts";

/** onboarding strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const onboardingRest: Partial<Catalogue> = {
  "onboarding.stepCount": "{total, number}개 중 {n, number}번째",
  "onboarding.connectors.onThisMac": "이 Mac",
  "onboarding.connectors.onThisMacHint": "각 앱은 연결될 때 하나씩 macOS에 권한을 요청합니다.",
  "onboarding.connectors.connectApps": "{n, plural, =0 {앱 연결} other {앱 #개 연결}}",
  "onboarding.connectors.connecting": "{name} 연결 중",
  "onboarding.connectors.accounts": "계정",
  "onboarding.step.memory": "메모리와 일상 습관",
  "onboarding.about.lead":
    "Psyche가 처음부터 사용자를 알 수 있도록 몇 가지 정보를 입력합니다. 모두 선택 사항이며 USER.md에 저장되고 언제든 편집할 수 있습니다.",
  "onboarding.about.name": "이름",
  "onboarding.about.nameHint": "Psyche가 어떻게 불러 드리면 좋을까요?",
  "onboarding.about.timeZone": "시간대",
  "onboarding.about.timeZoneHint": "Asia/Seoul",
  "onboarding.about.work": "직업 또는 학업",
  "onboarding.about.workHint": "하는 일을 몇 마디로",
  "onboarding.about.city": "거주 도시",
  "onboarding.about.cityHint": "주로 있는 곳",
  "onboarding.memory.lead":
    'ChatGPT나 Claude에 이미 프로필이 있습니까? 메모리 내보내기 또는 "나에 대해 무엇을 알고 있나요?"에 대한 답변을 붙여넣으십시오. 저장하기 전에 모든 내용을 검토할 수 있습니다.',
  "onboarding.memory.unavailable":
    "이 윈도우에서는 가져오기를 사용할 수 없습니다. 나중에 Soul에서 할 수 있습니다.",
  "onboarding.memory.format": "가져온 곳",
  "onboarding.memory.format.chatgpt": "ChatGPT",
  "onboarding.memory.format.claude": "Claude",
  "onboarding.memory.format.text": "기타 텍스트",
  "onboarding.memory.paste": "메모리 텍스트",
  "onboarding.memory.placeholder": "여기에 붙여넣거나 .txt, .md, .json 파일을 업로드하십시오",
  "onboarding.memory.upload": "파일 업로드",
  "onboarding.memory.review": "검토",
  "onboarding.memory.found":
    "검토할 항목 {n, number}개를 찾았습니다 ({skipped, number}개 건너뜀). 보관하고 싶지 않은 항목은 선택을 해제하십시오.",
  "onboarding.memory.items": "가져올 항목",
  "onboarding.memory.flagged": "지시처럼 읽힘",
  "onboarding.memory.edit": "텍스트로 돌아가기",
  "onboarding.memory.save": "{n, number}개를 메모리에 저장",
  "onboarding.memory.saved": "{n, number}개를 메모리에 저장했습니다.",
  "onboarding.memory.failed": "작업에 실패했습니다 ({reason}).",
  "onboarding.habits.lead":
    "홈에 아침과 저녁의 짧은 카드를 표시합니다. Psyche는 읽기만 하며, 승인 없이는 아무것도 보내지 않습니다.",
  "onboarding.habits.brief": "데일리 브리핑",
  "onboarding.habits.briefHint": "평일 아침마다 하루 일정을 알려 드립니다.",
  "onboarding.habits.wrapup": "저녁 마무리",
  "onboarding.habits.wrapupHint": "완료한 일과 내일로 넘어가는 일입니다.",
  "onboarding.habits.followups": "후속 조치 추적",
  "onboarding.habits.followupsHint": "아직 답을 기다리는 대화를 알아차립니다.",
  "onboarding.rerun.title": "설정 다시 하기",
  "onboarding.rerun.description": "첫 실행 설정을 다시 진행합니다. 이미 끝난 단계는 건너뜁니다.",
  "onboarding.rerun.button": "설정 다시 실행",
  "onboarding.step.you": "사용자와 에이전트",
  "onboarding.step.stuff": "내 데이터",
  "onboarding.step.safety": "안전",
  "onboarding.you.lead": "이 페이지의 모든 항목은 선택 사항이며 나중에 변경할 수 있습니다.",
  "onboarding.you.agent": "내 에이전트",
  "onboarding.you.customize": "모양 사용자 지정",
  "onboarding.you.more": "나에 대해 더 알려 주기",
  "onboarding.memory.habitsLead":
    "{name}이(가) 매일 하는 일과 메모리에 보관하는 내용을 선택하십시오. 모두 설정에서 변경할 수 있습니다.",
  "onboarding.memory.bring": "ChatGPT 또는 Claude에서 메모리 가져오기",
  "onboarding.habits.title": "매일",
  "onboarding.work.title": "업무와 할 일",
  "onboarding.work.hint":
    "청구서, 월세, 세금, 갱신, 업무 마감, 숙제 등 기한이 있는 모든 것의 할 일을 관리합니다. {persona}는 선택한 목록과 폴더만 읽습니다. 허용하기 전까지는 꺼져 있습니다.",
  "onboarding.work.remindHint":
    "저녁 마무리와 함께 전송됩니다. 직접 추가한 항목만 제목이 표시됩니다.",
  "onboarding.work.later":
    "대상으로 삼을 미리 알림 목록과 폴더는 설정 → 메모리 → 업무에서 선택할 수 있습니다.",
  "onboarding.people.title": "사람",
  "onboarding.people.label": "브리핑에 사람 포함",
  "onboarding.people.hint":
    "아는 사람에 대한 사실과 연락을 유지할 사람입니다. 켜기 전까지는 꺼져 있습니다.",
  "onboarding.people.needsBrief":
    "아침 브리핑이 꺼져 있어 사람은 아직 어디에도 표시되지 않습니다. 켜면 표시됩니다.",
  "onboarding.safety.lead":
    "승인이 전달되는 방식과 자동으로 실행되는 내용을 설정합니다. 파일, 앱, 화면에 대한 접근은 여기서 묻지 않으며, {name}이(가) 처음 필요할 때 대화에서 묻습니다.",
  "onboarding.safety.touchId": "결제에 Touch ID 사용",
  "onboarding.safety.touchId.checking": "Mac 도우미를 확인하는 중…",
  "onboarding.safety.touchId.again": "다시 확인",
  "onboarding.safety.touchId.set": "설정",
  "onboarding.safety.touchId.setHint": "결제에서는 지문 또는 Mac 암호를 요청합니다.",
  "onboarding.safety.touchId.starting":
    "Mac 도우미가 아직 시작 중입니다. 잠시 후 다시 확인하십시오.",
  "onboarding.safety.touchId.noKey": "Mac 도우미에 Touch ID 키가 없습니다 ({reason}).",
  "onboarding.safety.touchId.register": "이 키 등록",
  "onboarding.safety.touchId.hint":
    "Mac 도우미의 키를 한 번 등록하면 Touch ID로 결제를 확인할 수 있습니다.",
  "onboarding.safety.notifications": "알림",
  "onboarding.safety.asks":
    "{name}이(가) 이 Mac에서 명령을 실행하도록 허용하면 ls나 cat처럼 읽기만 하는 명령은 카드 없이 실행됩니다. 그 밖의 명령은 먼저 확인합니다.",
  "onboarding.safety.sandbox": "명령용 샌드박스 설정",
  "onboarding.safety.optional": "선택",
  "onboarding.done.on": "켜짐",
  "onboarding.done.off": "꺼짐",
  "onboarding.done.daily": "데일리",
  "onboarding.done.work": "업무 추적",
  "onboarding.done.people": "브리핑에 포함할 사람",
  "onboarding.done.touchId": "Touch ID",
  "onboarding.done.touchIdSet": "키 등록됨",
  "onboarding.done.touchIdNot": "아직 등록되지 않음",
  "onboarding.done.modelKept": "변경 없음",
  "onboarding.done.try": "다음으로 해 보기",
  "onboarding.done.try.search":
    "검색(⌘K)에서 질문해 보십시오. 답변에는 생활 속 어디에서 온 정보인지 표시됩니다.",
  "onboarding.done.try.home": "홈을 열어 보십시오. 따라잡기에는 미뤄 두었을 만한 일이 나열됩니다.",
  "onboarding.done.try.canDo":
    '톱니바퀴 메뉴의 "무엇을 할 수 있나요?"를 열면 바로 쓸 수 있는 작업을 찾을 수 있습니다.',
};
