import type { Catalogue } from "../../index.ts";

/** The Virtual screen watch pane (ko); merged into `../ko.ts`. */
export const computerWatch: Partial<Catalogue> = {
  "computerWatch.title": "가상 화면",
  "computerWatch.frame.alt": "가상 화면 실시간 보기",
  "computerWatch.stop": "중지",
  "computerWatch.takeOver": "직접 제어",
  "computerWatch.control.agent": "에이전트가 제어하고 있습니다.",
  "computerWatch.control.you": "직접 제어 중입니다. 에이전트는 일시 중지되었습니다.",
  "computerWatch.apps.title": "열려 있는 앱",
  "computerWatch.apps.empty": "열려 있는 앱이 없습니다.",
  "computerWatch.apps.unsaved": "저장하지 않은 변경 사항",
  "computerWatch.empty.title": "실행 중인 가상 화면이 없습니다",
  "computerWatch.empty.body": "에이전트에게 전용 화면이 필요하면 여기에서 볼 수 있습니다.",
  "computerWatch.starting": "가상 화면을 시작하는 중…",
  "computerWatch.error": "가상 화면에 연결할 수 없습니다. 다시 시도하는 중…",
  "computerWatch.parked.title": "확인을 기다리는 중",
  "computerWatch.parked.body":
    "저장하지 않은 변경 사항이 있는 앱이 있어 작업이 일시 중지되었습니다.",
  "computerWatch.parked.look": "보기",
  "computerWatch.parked.discard": "버리기",
  "computerWatch.parked.keepOpen": "열어 두기",
};
