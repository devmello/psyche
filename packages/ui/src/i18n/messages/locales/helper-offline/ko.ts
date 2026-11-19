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
  "platform.helper.choose.title": "Psyche Helper가 두 개 연결되어 있습니다",
  "platform.helper.choose.text":
    "이 컴퓨터에서 실행 중인 것이 어느 쪽인지 Psyche가 추측하지 않으므로 메일, 메모, 캘린더, 미리 알림이 일시 중지되었습니다. 사용할 것을 선택하세요.",
  "platform.helper.choose.use": "{name} 사용",
  "platform.helper.choose.failed": "도우미를 선택하지 못했습니다: {reason}",
};
