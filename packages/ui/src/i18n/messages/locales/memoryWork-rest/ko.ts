import type { Catalogue } from "../../index.ts";

/** memoryWork strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const memoryWorkRest: Partial<Catalogue> = {
  "memoryWork.title": "업무",
  "memoryWork.description":
    "{persona}가 사용자를 위해 파악하는 내용: 프로젝트, 기한이 있는 할 일, 중단한 지점.",
  "memoryWork.loadLabel": "업무 메모리",
  "memoryWork.enabled.title": "메모리의 업무",
  "memoryWork.enabled.label": "내 업무 추적",
  "memoryWork.enabled.hint":
    "기한이 있는 모든 것에 대해 할 일과 진행 상황, 중단한 지점을 관리합니다. 허용하기 전까지는 꺼져 있습니다.",
  "memoryWork.enabled.off": "켜면 미리 알림 목록과 폴더를 선택하고 알림을 설정할 수 있습니다.",
  "memoryWork.consent.title": "메모리에서 업무 추적",
  "memoryWork.consent.body":
    "{persona}가 기한이 있는 모든 것(월세, 실험 보고서, 이사회 자료 등)의 할 일을 관리하고 진행 상황과 중단한 지점을 기록합니다.",
  "memoryWork.consent.reads": "읽는 내용",
  "memoryWork.consent.r1": "선택한 미리 알림 목록과 내 캘린더",
  "memoryWork.consent.r2": "프로젝트에 연결한 폴더의 파일",
  "memoryWork.consent.r3": "보낸 메일, 연결한 스레드의 메일, {persona}와의 대화",
  "memoryWork.consent.keeps": "변하지 않는 점",
  "memoryWork.consent.k1":
    "이 Mac 밖으로 아무것도 나가지 않습니다. 날짜와 상태는 코드로 계산됩니다.",
  "memoryWork.consent.k2": "다른 사람의 텍스트가 기한이나 상태를 바꾸는 일은 없습니다.",
  "memoryWork.consent.k3":
    "업무는 홈과 데일리 브리핑에 표시됩니다. 메모리가 표시되는 위치에서 변경할 수 있습니다.",
  "memoryWork.consent.cancel": "나중에",
  "memoryWork.consent.confirm": "켜기",
  "memoryWork.lists.title": "미리 알림 목록",
  "memoryWork.lists.description":
    "추적 대상 목록에서 기한이 있는 미리 알림은 선택한 프로젝트의 할 일이 됩니다. 다른 목록은 건드리지 않습니다. 커넥터에서 내 것으로 표시한 목록만 완료 처리할 수 있습니다.",
  "memoryWork.lists.none": "추적 안 함",
  "memoryWork.lists.pick": "{list}의 프로젝트",
  "memoryWork.lists.missing": "미리 알림에 더 이상 없는 목록",
  "memoryWork.lists.shared": "공유 목록",
  "memoryWork.lists.empty": "미리 알림 목록이 아직 없습니다.",
  "memoryWork.lists.noProjects": "메모리 페이지에서 프로젝트를 추가한 다음 여기서 선택하십시오.",
  "memoryWork.lists.openMemory": "메모리 열기",
  "memoryWork.lists.loading": "미리 알림 목록을 불러오는 중…",
  "memoryWork.folders.title": "폴더",
  "memoryWork.folders.anchored": "프로젝트에 연결한 폴더만",
  "memoryWork.folders.anchoredHint":
    "프로젝트 페이지에서 폴더를 연결합니다. 폴더 이름이 프로젝트와 일치하면 {persona}가 제안합니다.",
  "memoryWork.folders.all": "{persona}가 읽을 수 있는 모든 폴더 (이름으로 일치)",
  "memoryWork.folders.allHint":
    "이름이 프로젝트와 일치하는 폴더는 묻지 않고 연결됩니다. 이름과 날짜만 읽습니다.",
  "memoryWork.remind.title": "마무리를 위한 알림",
  "memoryWork.remind.description":
    "켜기 전까지 알림은 꺼져 있습니다. 방해 금지 시간에는 오지 않습니다.",
  "memoryWork.remind.enabled": "내일이 기한인 항목 알려 주기",
  "memoryWork.remind.enabledHint":
    "마무리 시간에 하루 한 번, 앞으로 {hours, plural, other {#시간}} 이내가 기한인 항목을 알려 드립니다.",
  "memoryWork.remind.hours": "얼마나 앞까지 확인할지",
  "memoryWork.remind.hoursOption": "{hours, plural, other {#시간}}",
  "memoryWork.remind.at": "시점",
  "memoryWork.remind.atWrapup": "마무리 시간({time})",
  "memoryWork.remind.atHint": "데일리에서 설정합니다. 직접 추가한 항목만 제목이 표시됩니다.",
  "memoryWork.remind.openDaily": "데일리 열기",
  "memoryWork.remind.dayOf": "오늘이 기한인 항목도 아침에 알려 주기",
  "memoryWork.remind.dayOfHint": '아침 브리핑 뒤에 두 번째 알림: "오늘 기한: …".',
  "memoryWork.remind.needsWrapup":
    "저녁 마무리가 꺼져 있어 아무것도 전송되지 않습니다. 켜면 이 알림을 받을 수 있습니다.",
  "memoryWork.remind.needsBrief":
    "아침 브리핑이 꺼져 있어 아무것도 전송되지 않습니다. 켜면 이 알림을 받을 수 있습니다.",
  "memoryWork.remind.turnOnWrapup": "마무리 켜기",
  "memoryWork.remind.turnOnBrief": "브리핑 켜기",
};
