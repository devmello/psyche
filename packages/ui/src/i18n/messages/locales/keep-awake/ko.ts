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
};
