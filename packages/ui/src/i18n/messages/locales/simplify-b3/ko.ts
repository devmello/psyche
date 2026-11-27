import type { Catalogue } from "../../index.ts";

/** Onboarding finish, recovery key and searchable switch (ko); merged into `../ko.ts`. */
export const simplifyB3: Partial<Catalogue> = {
  "onboarding.done.start": "대화 시작하기",
  "onboarding.done.psycheLabel": "Psyche",
  "onboarding.done.psycheWait":
    "지금은 Psyche에 연결할 수 없습니다. 이 창은 자동으로 다시 연결됩니다.",
  "onboarding.done.helperWait":
    "Psyche Helper가 아직 연결되지 않았습니다. 연결되면 컴퓨터 사용과 알림이 시작됩니다.",
  "onboarding.connectors.searchable": "검색할 수 있게 하기",
  "onboarding.connectors.searchableHint":
    "{name}이(가) 검색에서 이 계정의 메일, 일정, 메모를 찾을 수 있습니다. 설정에서 언제든 끌 수 있습니다.",
  "home.recoveryKey.title": "복구 키를 저장하세요",
  "home.recoveryKey.body":
    "복원한 뒤나 키를 잃어버렸을 때 보관함으로 돌아갈 수 있는 유일한 방법입니다. 키를 표시하고, 안전한 곳에 사본을 보관한 다음 확인하세요.",
  "settings.credentials.vault.recoveryKey.show": "복구 키 표시",
  "settings.credentials.vault.recoveryKey.hide": "숨기기",
  "settings.credentials.vault.recoveryKey.gone":
    "이 보관함의 복구 키는 만들 때 한 번만 표시되었으므로 다시 표시할 수 없습니다.",
  "settings.credentials.vault.recoveryKey.failed": "복구 키를 표시하지 못했습니다: {reason}",
  "settings.credentials.vault.recoveryKey.title": "복구 키",
  "settings.credentials.vault.recoveryKey.body":
    "복원한 뒤나 키를 잃어버렸을 때 보관함으로 돌아갈 수 있는 유일한 방법입니다. 안전한 곳에 사본을 보관하세요.",
};
