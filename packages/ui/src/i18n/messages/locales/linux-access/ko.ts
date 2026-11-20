import type { Catalogue } from "../../index.ts";

/** Linux access in Settings → Computer use (ko); merged into `../ko.ts`. */
export const linuxAccess: Partial<Catalogue> = {
  "settings.computerUse.linux.screen.name": "화면 및 입력 접근",
  "settings.computerUse.linux.screen.allowed": "허용 해제 전까지 허용됨",
  "settings.computerUse.linux.screen.asks": "처음 사용할 때 묻습니다",
  "settings.computerUse.linux.screen.notNeeded": "X11에서는 필요 없음",
  "settings.computerUse.linux.screen.unavailable": "사용할 수 없음",
  "settings.computerUse.linux.screen.why":
    "{persona}이(가) 데스크톱의 권한 대화상자를 통해 화면을 보고 마우스와 키보드를 사용합니다. 한 번만 승인하면 됩니다.",
  "settings.computerUse.linux.revoke": "허용 해제",
  "settings.computerUse.linux.revokeLabel": "화면 및 입력 접근 허용 해제",
  "settings.computerUse.linux.warning.x11":
    "X11에서는 모든 앱이 화면과 키 입력을 읽을 수 있으며, 무언가를 승인할 때 입력하는 비밀번호도 포함됩니다.",
  "settings.computerUse.linux.warning.wlroots":
    "이 데스크톱에서는 모든 앱이 묻지 않고 화면을 읽고 대신 입력할 수 있습니다. Psyche는 동의 단계를 추가할 수 없습니다.",
  "settings.computerUse.linux.accessibility":
    "지금부터 여는 앱은 구조를 Psyche에 공개합니다. 이미 열려 있는 앱은 다시 시작해야 할 수 있습니다.",
  "settings.computerUse.linux.headless":
    "이 컴퓨터에 그래픽 세션이 필요합니다. 데스크톱에 로그인한 뒤 다시 시도하세요.",
};
