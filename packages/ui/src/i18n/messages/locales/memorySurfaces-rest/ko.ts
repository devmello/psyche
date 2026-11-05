import type { Catalogue } from "../../index.ts";

/** memorySurfaces strings not covered elsewhere (ko); merged into `../ko.ts`. */
export const memorySurfacesRest: Partial<Catalogue> = {
  "memorySurfaces.title": "메모리가 표시되는 위치",
  "memorySurfaces.description":
    "{persona}가 홈, 데일리 브리핑, 알림, Telegram 등 채널로 보내는 브리핑에 표시해도 되는 내용입니다. 메모리 페이지에는 제외하지 않은 모든 내용이 항상 표시됩니다.",
  "memorySurfaces.loadLabel": "메모리가 표시되는 위치",
  "memorySurfaces.surface.home": "홈",
  "memorySurfaces.surface.brief": "데일리 브리핑",
  "memorySurfaces.surface.notification": "알림",
  "memorySurfaces.surface.channel": "채널로 보내는 브리핑",
  "memorySurfaces.tier.work.title": "업무와 할 일",
  "memorySurfaces.tier.work.description":
    "프로젝트, 과정, 할 일, 진행 상황, 기한, 내 캘린더의 일정.",
  "memorySurfaces.tier.work.notificationHint":
    '직접 추가한 항목만 제목이 표시됩니다. 그 밖의 항목은 "내일이 기한인 할 일 1개"처럼 개수만 표시됩니다.',
  "memorySurfaces.tier.workMail.title": "업무 관련 메일",
  "memorySurfaces.tier.workMail.description":
    "프로젝트나 할 일에 연결한 스레드 메일의 제목과 보낸 사람.",
  "memorySurfaces.tier.people.title": "사람에 대한 사실",
  "memorySurfaces.tier.people.description":
    "다른 사람에 대한 사실, 알게 된 계기, 나눈 이야기, 연락 유지.",
  "memorySurfaces.people.warning":
    "브리핑은 사용자의 화면이나 Telegram을 볼 수 있는 사람이라면 누구나 볼 수 있습니다.",
  "memorySurfaces.birthdays.title": "생일과 기념일",
  "memorySurfaces.birthdays.label": "생일과 기념일 표시",
  "memorySurfaces.birthdays.hint":
    "날짜만 브리핑의 다가오는 일정과 홈에 표시합니다. 알림에는 표시되지 않습니다.",
  "memorySurfaces.sensitive":
    "건강이나 재정 등 민감한 정보로 표시된 내용은 메모리 밖에 표시되지 않습니다.",
  "memorySurfaces.kinds.title": "표시할 종류",
  "memorySurfaces.kinds.description":
    "종류를 끄면 메모리 페이지에만 남습니다. 항목 하나만 숨기려면 해당 페이지의 비공개로 유지를 사용하십시오.",
  "memorySurfaces.kind.project": "프로젝트",
  "memorySurfaces.kind.course": "과정",
  "memorySurfaces.kind.assignment": "할 일",
  "memorySurfaces.kind.event": "이벤트",
  "memorySurfaces.sources.title": "출처 제외",
  "memorySurfaces.sources.description":
    "켜 둔 출처에서 학습한 내용은 메모리 페이지에만 남습니다. 이는 위의 스위치에 추가로 적용됩니다.",
  "memorySurfaces.sources.label": "{source}에서 학습한 내용은 표시하지 않음",
  "memorySurfaces.source.mail": "메일",
  "memorySurfaces.source.messages": "메시지",
  "memorySurfaces.source.notes": "메모",
  "memorySurfaces.source.calendar": "캘린더",
  "memorySurfaces.source.reminders": "미리 알림",
  "memorySurfaces.source.chats": "Psyche와의 대화",
  "memorySurfaces.source.files": "파일",
  "memorySurfaces.source.transcripts": "녹취록",
  "memorySurfaces.source.contacts": "연락처",
};
