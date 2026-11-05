import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (ko); merged into `../ko.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "별도 데스크톱",
  "settings.separateDesktop.description": "컨테이너 안에 있는 전용 데스크톱으로, 자체 앱과 파일이 있습니다. 작업을 위해 공유한 폴더만 볼 수 있고, 그 작업에 허용하지 않으면 인터넷을 쓸 수 없으며, 작업이 끝나면 멈춥니다.",
  "settings.separateDesktop.state.off": "실행 중 아님",
  "settings.separateDesktop.state.starting": "시작하는 중",
  "settings.separateDesktop.state.running": "실행 중",
  "settings.separateDesktop.state.stopping": "멈추는 중",
  "settings.separateDesktop.state.failed": "시작할 수 없음",
  "settings.separateDesktop.engine": "컨테이너 엔진: {engine}",
  "settings.separateDesktop.rootful": "이 컨테이너 엔진은 root로 실행됩니다. 별도 데스크톱에는 rootless Podman을 사용하세요.",
  "settings.separateDesktop.memory": "메모리 한도",
  "settings.separateDesktop.memoryHint": "별도 데스크톱이 실행되는 동안 쓸 수 있는 최대 메모리입니다.",
  "settings.separateDesktop.memoryOption": "{gb} GB",
  "settings.separateDesktop.shares": "공유한 폴더: {names}",
  "settings.separateDesktop.internet": "이 작업에서는 인터넷이 켜져 있습니다",
  "settings.separateDesktop.reset": "별도 데스크톱 초기화",
  "settings.separateDesktop.resetHint": "컨테이너와 그 안에 저장된 모든 것을 삭제합니다. 공유한 폴더는 건드리지 않습니다.",
};
