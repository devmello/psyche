import type { Catalogue } from "../../index.ts";

/** The Linux helper check in Settings → Devices (ko); merged into `../ko.ts`. */
export const helperCheck: Partial<Catalogue> = {
  "settings.devices.helperCheck.title": "Linux 도우미 확인",
  "settings.devices.helperCheck.description":
    "Linux 도우미가 연결되면 Psyche는 그것이 실제로 어떤 프로그램인지 확인합니다.",
  "settings.devices.helperCheck.state.verified": "확인됨: 시스템에 설치된 도우미",
  "settings.devices.helperCheck.state.userOwned": "확인 안 됨: 홈 폴더의 도우미",
  "settings.devices.helperCheck.state.unverified":
    "확인 안 됨: Psyche가 도우미를 확인하지 못했습니다",
  "settings.devices.helperCheck.detail.verified":
    "Psyche와 함께 설치된 도우미입니다. 시스템만 바꿀 수 있습니다.",
  "settings.devices.helperCheck.detail.userOwned":
    "내가 소유한 파일(AppImage나 홈 폴더의 빌드 등)에서 실행됩니다. Psyche는 이를 허용하지만, 내 다른 프로그램이 바꿔 놓았을 가능성을 배제할 수는 없습니다.",
  "settings.devices.helperCheck.detail.unverified":
    "지금은 Psyche가 허용하지만 어떤 프로그램인지는 확인하지 못했습니다.",
  "settings.devices.helperCheck.refused": "거부됨: {reason}",
  "settings.devices.helperCheck.reason.unclear": "Psyche가 도우미를 확인하지 못했습니다",
  "settings.devices.helperCheck.reason.notHelper": "이 프로그램은 Psyche 도우미가 아닙니다",
  "settings.devices.helperCheck.reason.userCopy":
    "시스템 설치 밖의 복사본이며, 설치된 도우미가 필요합니다",
  "settings.devices.helperCheck.reason.loaderEnv":
    "라이브러리 경로나 미리 불러온 라이브러리와 함께 시작되었습니다",
  "settings.devices.helperCheck.reason.foreignCode": "시스템 밖에서 불러온 코드가 있습니다",
  "settings.devices.helperCheck.reason.severalPrograms": "둘 이상의 프로그램이 연결을 공유합니다",
  "settings.devices.helperCheck.reason.handedOver": "다른 프로그램이 연결을 넘겨주었습니다",
  "settings.devices.helperCheck.reason.stillStarting": "아직 시작하는 중이었습니다",
  "settings.devices.helperCheck.reason.debugged": "멈춰 있거나 디버깅 중입니다",
  "settings.devices.helperCheck.reason.restartNeeded":
    "시작한 뒤 교체되었거나 시스템 라이브러리가 업데이트되었습니다. 도우미를 다시 시작하세요",
  "settings.devices.helperCheck.reason.filesNotLocked":
    "시스템이 아닌 다른 쪽에서 파일을 바꿀 수 있습니다",
  "settings.devices.helperCheck.reason.otherNamespace":
    "이 컴퓨터의 별도 샌드박스에서 실행 중입니다",
  "settings.devices.helperCheck.reason.busy":
    "Psyche가 다른 연결을 확인하느라 바빴습니다. 도우미가 다시 시도합니다",
};
