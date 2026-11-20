import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (ko); merged into `../ko.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "이 컴퓨터 깨워 두기",
  "settings.daily.keepAwake.hint":
    "예약된 작업이 실행되는 동안 작업이 끝날 때까지 이 컴퓨터가 잠들지 않습니다. 화면은 꺼질 수 있습니다.",
  "settings.key.scheduled.keepAwake": "예약된 작업이 실행되는 동안 이 컴퓨터 깨워 두기",
  "scheduled.history.retryingAt": "{time}에 다시 시도합니다",
  "scheduled.history.retry": "재시도 {n}/3",
  "scheduled.history.failedAfterRetries": "재시도 {n}회 후 실패했습니다",
  "scheduled.history.cancelRetry": "재시도 취소",
  "scheduled.history.cancelRetry.aria": "{when} 실행의 재시도 취소",
  "scheduled.history.cancelRetry.failed": "재시도를 취소하지 못했습니다({reason}).",
  "settings.updates.group": "업데이트",
  "settings.updates.hint": "Psyche는 서명된 업데이트를 확인하고 종료할 때 설치합니다.",
  "settings.updates.channel": "릴리스 채널",
  "settings.updates.channel.stable": "안정",
  "settings.updates.channel.note":
    "지금은 안정 채널만 있습니다. 베타 빌드가 공개되면 여기에 베타가 표시됩니다. 어느 채널이든 모든 업데이트는 Psyche의 릴리스 키로 검증됩니다.",
  "settings.updates.saveFailed": "릴리스 채널을 저장하지 못했습니다({reason}).",
  "settings.storage.title": "저장 공간",
  "settings.storage.hint": "이 컴퓨터에서 Psyche가 데이터 폴더에 사용하는 디스크 공간입니다.",
  "settings.storage.total": "합계",
  "settings.storage.clear": "비우기…",
  "settings.storage.cleared": "비웠습니다. {size}를 확보했습니다.",
  "settings.storage.clearFailed": "저장 공간을 비우지 못했습니다({reason}).",
  "settings.storage.failed": "저장 공간 사용량을 읽지 못했습니다({reason}).",
  "settings.storage.confirm.title": "캐시와 오래된 녹화를 비울까요?",
  "settings.storage.confirm.body":
    "캐시와 7일이 지난 브라우저 녹화를 최대 {size}까지 삭제합니다. 캐시는 필요할 때 Psyche가 다시 만듭니다. 채팅, 메모리, 라이브러리, 보관함, 설정은 건드리지 않습니다.",
  "settings.storage.confirm.clear": "비우기",
  "settings.storage.cat.database": "데이터베이스",
  "settings.storage.cat.memoryIndex": "메모리 색인",
  "settings.storage.cat.library": "첨부 파일 및 라이브러리",
  "settings.storage.cat.browserProfiles": "브라우저 프로필",
  "settings.storage.cat.recordings": "녹화",
  "settings.storage.cat.logs": "로그",
  "settings.storage.cat.caches": "캐시",
  "settings.storage.cat.other": "기타 전부",
};
