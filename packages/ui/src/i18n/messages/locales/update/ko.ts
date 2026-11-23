import type { Catalogue } from "../../index.ts";

/** App update strings (ko); merged into `../ko.ts`. */
export const update: Partial<Catalogue> = {
  "shell.update.ready": "Psyche {version} 업데이트 준비됨",
  "shell.update.readyRequired": "Psyche {version} 업데이트 준비됨. 이 업데이트는 필수입니다.",
  "shell.update.restart": "다시 시작하여 업데이트",
  "shell.update.dismiss": "업데이트 알림 닫기",
  "settings.updates.status": "상태",
  "settings.updates.checking": "업데이트 확인 중…",
  "settings.updates.upToDate": "최신 상태",
  "settings.updates.ready": "Psyche {version} 업데이트 준비됨",
  "settings.updates.readyRequired": "Psyche {version} 업데이트 준비됨(필수)",
  "settings.updates.refused": "업데이트가 거부됨: {reason}",
  "settings.updates.installFailed":
    "Psyche가 업데이트를 설치하지 못했습니다. 나중에 다시 시도하세요.",
};
