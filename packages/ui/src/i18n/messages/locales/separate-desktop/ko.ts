import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (ko); merged into `../ko.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "별도 데스크톱",
  "settings.separateDesktop.description":
    "컨테이너 안에 있는 전용 데스크톱으로, 자체 앱과 파일이 있습니다. 작업을 위해 공유한 폴더만 볼 수 있고, 그 작업에 허용하지 않으면 인터넷을 쓸 수 없으며, 작업이 끝나면 멈춥니다.",
  "settings.separateDesktop.state.off": "실행 중 아님",
  "settings.separateDesktop.state.starting": "시작하는 중",
  "settings.separateDesktop.state.running": "실행 중",
  "settings.separateDesktop.state.stopping": "멈추는 중",
  "settings.separateDesktop.state.failed": "시작할 수 없음",
  "settings.separateDesktop.engine": "컨테이너 엔진: {engine}",
  "settings.separateDesktop.rootful":
    "이 컨테이너 엔진은 root로 실행됩니다. 별도 데스크톱에는 rootless Podman을 사용하세요.",
  "settings.separateDesktop.memory": "메모리 한도",
  "settings.separateDesktop.memoryHint":
    "별도 데스크톱이 실행되는 동안 쓸 수 있는 최대 메모리입니다.",
  "settings.separateDesktop.memoryOption": "{gb} GB",
  "settings.separateDesktop.shares": "공유한 폴더: {names}",
  "settings.separateDesktop.internet": "이 작업에서는 인터넷이 켜져 있습니다",
  "settings.separateDesktop.reset": "별도 데스크톱 초기화",
  "settings.separateDesktop.resetHint":
    "컨테이너와 그 안에 저장된 모든 것을 삭제합니다. 공유한 폴더는 건드리지 않습니다.",
  "blocks.folder.sd.explain.ro":
    "{persona}이(가) 별도 데스크톱이 폴더의 파일을 읽도록 하려고 합니다.",
  "blocks.folder.sd.explain.rw":
    "{persona}이(가) 별도 데스크톱이 폴더의 파일을 읽고 바꾸도록 하려고 합니다. 별도 데스크톱의 프로그램은 그곳의 파일을 바꿀 수 있고, 그 변경 내용은 이 컴퓨터에 나타납니다.",
  "blocks.folder.sd.scope":
    "별도 데스크톱은 이 작업 동안에만 이 폴더를 볼 수 있습니다. 이 컴퓨터의 다른 것은 공유되지 않으며, 이 컴퓨터의 다른 도구도 이 폴더를 얻지 않습니다.",
  "blocks.folder.sd.scope.once": "이 작업에서만",
  "settings.separateDesktop.limitMemory": "이 시스템에서는 메모리 한도가 적용되지 않습니다",
  "settings.separateDesktop.limitPids": "이 시스템에서는 프로세스 한도가 적용되지 않습니다",
  "blocks.details.sdUnverified":
    "별도 데스크톱은 이 페이지가 정말 {origin}인지 확인할 수 없습니다. 작업이 이동한 곳을 신뢰할 때만 계속하세요.",
  "blocks.details.sdFiles": "파일",
  "blocks.details.sdAlsoChanges":
    "이 작업은 {folder}도 바꿀 수 있고, 그곳의 파일을 보낼 수도 있습니다.",
};
