import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (ko); merged into `../ko.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "Psyche Helper에 연결되어 있지 않습니다",
  "platform.helper.offline.text":
    "메일, 메모, 캘린더, 미리 알림과 이에 의존하는 작업은 다시 연결될 때까지 대기합니다.",
  "platform.helper.offline.reconnect": "다시 연결",
  "platform.helper.contactsPermission":
    "연락처를 사용하려면 시스템 설정에서 Psyche Helper에 권한을 허용해야 합니다.",
  "platform.helper.offline.dismiss": "닫기",
};
