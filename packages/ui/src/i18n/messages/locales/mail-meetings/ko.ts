import type { Catalogue } from "../../index.ts";

/** Mail and meeting settings and onboarding strings (ko); merged into `../ko.ts`. */
export const mailMeetings: Partial<Catalogue> = {
  "settings.nav.mail": "메일 및 회의",
  "settings.mail.title": "메일 및 회의",
  "settings.mail.description":
    "Wren이 메일과 캘린더로 하는 일을 설정합니다. 임시 저장과 작업 제안만 하며, 사용자의 승인 없이는 아무것도 보내거나 공유하거나 수락하거나 거절하지 않습니다.",
  "settings.mail.quietHours": "방해 금지 시간은 알림에서 설정합니다.",
  "settings.mail.loadFailed": "메일 및 회의 설정을 불러오지 못했습니다.",

  // Group titles
  "settings.mail.group.master": "한꺼번에 설정",
  "settings.mail.group.accounts": "계정",
  "settings.mail.group.digest": "받은 편지함 요약",
  "settings.mail.group.followups": "후속 조치",
  "settings.mail.group.style": "문체",
  "settings.mail.group.scheduling": "일정 조율",
  "settings.mail.group.prep": "회의 준비",
  "settings.mail.group.notes": "회의 노트",
  "settings.mail.group.polling": "새 메일 확인",

  // Master switches
  "settings.mail.paused.hint": "다시 켤 때까지 모든 메일 및 회의 작업을 중지합니다.",
  "settings.mail.readOnly.hint":
    "요약과 준비는 계속 제공됩니다. Wren은 작업을 제안하지 않으며 초안도 작성하지 않습니다.",

  // Accounts
  "settings.mail.accounts.none": "연결된 메일 계정이 없습니다. 커넥터에서 연결하십시오.",
  "settings.mail.accounts.use": "요약과 후속 조치에 {account} 사용",
  "settings.mail.accounts.connect": "커넥터 열기",

  // Inbox digest
  "settings.mail.digest.time": "시간",
  "settings.mail.digest.days": "요일",
  "settings.mail.digest.days.weekdays": "평일",
  "settings.mail.digest.days.everyday": "매일",
  "settings.mail.digest.onlyWhenNeeded.hint":
    "처리할 일이 없는 날은 알림 없이 피드에 요약을 올립니다.",
  "settings.mail.digest.rules": "발신자 규칙",
  "settings.mail.digest.rulesHint":
    "항상 보관할 발신자, 항상 허용할 발신자, 확인이 필요한 발신자입니다.",
  "settings.mail.digest.openRules": "열기",
  "settings.mail.digest.openRulesAsk": "mail/RULES.md를 보여줘.",

  // Follow-ups
  "settings.mail.followups.waitDays": "표시하기까지 기다리는 기간",
  "settings.mail.followups.days": "{n, plural, other {영업일 #일}}",
  "settings.mail.followups.showTwice.hint": "요약에 두 번 표시된 뒤에는 더 이상 표시하지 않습니다.",

  // Writing style
  "settings.mail.voice.learn.hint":
    "Wren은 보낸 메일에서 인용문과 서명을 제외하고 직접 쓴 내용만 읽습니다. 프로필은 이 Mac의 mail/VOICE.md에 저장됩니다.",
  "settings.mail.voice.profile": "문체 프로필",
  "settings.mail.voice.view": "보기",
  "settings.mail.voice.edit": "편집",
  "settings.mail.voice.reset": "초기화",
  "settings.mail.voice.viewAsk": "mail/VOICE.md를 보여줘.",
  "settings.mail.voice.editAsk": "mail/VOICE.md를 편집할 수 있게 해줘.",
  "settings.mail.voice.resetAsk":
    "내 문체 프로필을 초기화해줘. mail/VOICE.md와 mail/voice-samples.jsonl을 삭제해.",
  "settings.mail.voice.localModel.hint": "내 문체로 쓴 초안은 이 Mac을 벗어나지 않습니다.",
  "settings.mail.voice.localModel.none": "기본 모델 사용",
  "settings.mail.voice.localModel.empty": "설정된 로컬 모델이 없습니다.",

  // Scheduling
  "settings.mail.schedule.hours": "근무 시간",
  "settings.mail.schedule.hoursHint":
    "USER.md 기준입니다. 평일 이 시간 안에서만 가능한 시간을 제안합니다.",
  "settings.mail.schedule.hoursFrom": "시작",
  "settings.mail.schedule.hoursTo": "종료",
  "settings.mail.schedule.buffer.hint": "시간을 제안할 때 회의 앞뒤로 비워 두는 시간입니다.",
  "settings.mail.schedule.minutes": "{n, plural, other {#분}}",
  "settings.mail.schedule.noBuffer": "없음",
  "settings.mail.schedule.focusTime.hint": "집중 작업을 위한 시간 확보를 제안합니다.",
  "settings.mail.schedule.link.hint": "선택 사항입니다. 있으면 답장에 함께 안내합니다.",

  // Meeting prep
  "settings.mail.prep.scope.hint": "내 팀원끼리만 하는 회의는 건너뜁니다.",
  "settings.mail.prep.leadMin": "회의 전 준비 시점",
  "settings.mail.prep.notifyMin": "시작 전에 알림",
  "settings.mail.prep.saveToNotes.hint": "준비 노트를 메모 앱에도 보관합니다.",
  "settings.mail.prep.dailyCap": "하루 최대 준비 횟수",
  "settings.mail.prep.calendars": "커넥터에서 연결한 캘린더를 대상으로 준비합니다.",

  // Meeting notes
  "settings.mail.notes.enabled.hint":
    "오디오를 추가하기 전에는 아무 일도 하지 않습니다. 음성 메모, 파일 또는 직접 시작한 녹음이 대상입니다.",
  "settings.mail.notes.folder": "녹음 폴더",
  "settings.mail.notes.folder.hint": "Wren이 읽을 수 있는 폴더입니다. 파일 접근에서 허용하십시오.",
  "settings.mail.notes.folder.placeholder": "~/Documents/Recordings",
  "settings.mail.notes.tasksApp": "실행 항목 추가 위치",
  "settings.mail.notes.tasksApp.reminders": "미리 알림",
  "settings.mail.notes.tasksApp.things": "Things",
  "settings.mail.notes.recap.hint": "회의가 끝날 때마다 요약 메일을 임시 저장합니다.",
  "settings.mail.notes.consent.hint":
    "직접 시작하는 모든 녹음 전에 표시됩니다. 말로 전달하거나 통화에 붙여넣으십시오.",
  "settings.mail.notes.consent.default": "메모를 위해 녹음하고 있습니다. 괜찮으신가요?",
  "settings.mail.notes.cloud.hint":
    "녹취록에는 다른 사람의 발언이 포함됩니다. 끄면 로컬 모델로 요약하거나 먼저 묻습니다.",

  // Polling
  "settings.mail.poll.active": "사용 중일 때",
  "settings.mail.poll.idle": "그 외",
  "settings.mail.poll.hint":
    "Wren이 새 메일을 확인하는 주기입니다. 짧을수록 배터리를 더 많이 사용합니다.",

  // Setting-key labels (docs/ui-audit.md: a raw key never shows at level 1)
  "settings.key.workflows.paused": "모든 메일 및 회의 워크플로 일시 중지",
  "settings.key.workflows.readOnly": "읽기 전용(요약과 준비만)",
  "settings.key.mail.accounts": "요약과 후속 조치에 {account} 사용",
  "settings.key.mail.digest.enabled": "받은 편지함 요약",
  "settings.key.mail.digest.time": "요약 시간",
  "settings.key.mail.digest.days": "요약 요일",
  "settings.key.mail.digest.onlyWhenNeeded": "처리할 일이 있을 때만 알림",
  "settings.key.mail.followups.enabled": "답장 대기 추적",
  "settings.key.mail.followups.waitDays": "후속 조치 대기 기간",
  "settings.key.mail.followups.showTwice": "후속 조치당 최대 두 번 표시",
  "settings.key.mail.voice.enabled": "보낸 메일에서 학습",
  "settings.key.mail.draft.localModel": "로컬 모델로 초안 작성",
  "settings.key.mail.schedule.hoursStart": "근무 시작 시간",
  "settings.key.mail.schedule.hoursEnd": "근무 종료 시간",
  "settings.key.mail.schedule.bufferMin": "회의 여유 시간",
  "settings.key.mail.schedule.focusTime": "집중 시간 제안",
  "settings.key.mail.schedulingLink": "일정 조율 링크",
  "settings.key.mail.poll.activeMin": "사용 중 메일 확인",
  "settings.key.mail.poll.idleMin": "그 외 메일 확인",
  "settings.key.meetings.prep.enabled": "회의 준비",
  "settings.key.meetings.prep.scope": "내 도메인 밖 사람과의 회의만",
  "settings.key.meetings.prep.leadMin": "준비 소요 시간",
  "settings.key.meetings.prep.notifyMin": "준비 알림 시점",
  "settings.key.meetings.prep.saveToNotes": "준비 내용을 메모에도 저장",
  "settings.key.meetings.prep.dailyCap": "하루 최대 준비 횟수",
  "settings.key.meetings.notes.enabled": "녹음으로 회의 노트 작성",
  "settings.key.meetings.notes.folder": "녹음 폴더",
  "settings.key.meetings.notes.tasksApp": "실행 항목 추가 위치",
  "settings.key.meetings.notes.recapDraft": "요약 메일 초안 작성",
  "settings.key.meetings.notes.consentLine": "녹음 동의 문구",
  "settings.key.meetings.notes.cloudSummary": "클라우드 모델로 요약",

  // Onboarding decision screen (§7.5)
  "onboarding.step.mail": "메일 및 회의",
  "onboarding.mail.title": "{name}이(가) 메일과 회의 소식을 정리해 드립니다",
  "onboarding.mail.lead":
    "원하는 기능을 선택하십시오. 계속하기 전에는 아무것도 실행되지 않으며, 나중에 설정에서 바꿀 수 있습니다.",
  "onboarding.mail.digest": "매일 아침 7:30 받은 편지함 요약",
  "onboarding.mail.digestHint": "처리할 일을 하루 한 번 요약합니다. 아무것도 보내지 않습니다.",
  "onboarding.mail.prep": "팀 외부 사람과의 회의 전 준비 노트",
  "onboarding.mail.prepHint": "상대가 누구인지, 남은 이야기, 지난번에 논의한 내용을 정리합니다.",
  "onboarding.mail.followups": "답장 대기 추적",
  "onboarding.mail.followupsHint": "요약에만 표시됩니다. 별도 알림은 없습니다.",
  "onboarding.mail.voice": "보낸 메일에서 내 문체 학습",
  "onboarding.mail.voiceHint":
    "인용문과 서명을 제외하고 직접 쓴 내용만 읽습니다. 이 Mac에만 저장되며 보기, 편집, 초기화할 수 있습니다.",
  "onboarding.mail.notes": "녹음으로 회의 노트 작성",
  "onboarding.mail.notesHint":
    "오디오를 추가하기 전에는 아무 일도 하지 않습니다. 오디오와 녹취록은 업로드되거나 학습에 사용되지 않습니다.",
  "onboarding.mail.summary": "{n, plural, =0 {켜진 기능 없음} other {#개 기능 켜짐}}",
  "onboarding.mail.done": "메일 및 회의",
  "onboarding.mail.doneOff": "꺼져 있습니다. 설정에서 켤 수 있습니다.",
  "onboarding.mail.doneOn": "{n, plural, other {워크플로 #개 켜짐}}",
};
