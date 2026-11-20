import type { Catalogue } from "../../index.ts";

/** Computers Psyche can use (ko); merged into `../ko.ts`. */
export const machines: Partial<Catalogue> = {
  "machines.title": "Psyche가 사용할 수 있는 컴퓨터",
  "machines.description":
    "페어링한 Linux 컴퓨터입니다. 이 컴퓨터를 계속 쓰는 동안 Psyche가 그곳의 앱, 명령, 파일을 사용할 수 있습니다.",
  "machines.empty":
    "Psyche에게 작업할 Linux 컴퓨터를 주면, 이 컴퓨터를 계속 쓰는 동안 그곳의 앱, 명령, 파일을 사용할 수 있습니다.",
  "machines.add": "Linux 컴퓨터 추가",
  "machines.add.description":
    "이 컴퓨터를 계속 쓰는 동안 Psyche는 그 컴퓨터에서 작업합니다. 그곳의 모든 동작은 여전히 먼저 확인을 받습니다.",
  "machines.add.account": "Psyche가 그곳에서 어떤 계정을 사용할까요?",
  "machines.add.account.own": "내 계정(권장)",
  "machines.add.account.ownHint":
    "Psyche는 나와 같이 그곳의 파일, 앱, 로그인을 사용할 수 있습니다. root 권한은 절대 얻지 않습니다.",
  "machines.add.account.dedicated": "별도의 psyche 계정",
  "machines.add.account.dedicatedHint":
    "Psyche는 그 계정의 파일과 앱만 볼 수 있습니다. sudo도 비밀번호도 없습니다.",
  "machines.add.needsNetwork":
    "다른 컴퓨터가 아직 이 컴퓨터에 연결할 수 없습니다. 먼저 설정 → 서버 및 원격 접속에서 원격 접속 또는 로컬 네트워크 접속을 켜세요.",
  "machines.add.make": "명령 보기",
  "machines.add.again": "새 명령 만들기",
  "machines.add.commands": "Linux 컴퓨터용 명령",
  "machines.add.installStep": "1. Linux 컴퓨터에서 도우미를 설치합니다",
  "machines.add.pairStep": "2. 그런 다음 페어링합니다",
  "machines.add.expires": "페어링 명령은 한 번만 사용할 수 있으며 {when} 만료됩니다.",
  "machines.add.waiting": "컴퓨터가 페어링되기를 기다리는 중…",
  "machines.add.paired": "{name}이(가) 페어링되었습니다. 이제 Psyche가 사용할 수 있습니다.",
  "machines.add.pairedToast": "{name}을(를) 추가했습니다",
  "machines.add.done": "완료",
  "machines.copy": "복사",
  "machines.status.online": "온라인",
  "machines.status.offline": "오프라인",
  "machines.status.degraded": "확인 필요",
  "machines.display.headless": "비공개 화면",
  "machines.display.desktopSession": "자체 데스크톱",
  "machines.display.container": "컨테이너",
  "machines.thisComputer": "이 컴퓨터",
  "machines.watch": "보기",
  "machines.watchNamed": "{name} 보기",
  "machines.apps": "앱 접근",
  "machines.appsNamed": "{name}의 앱 접근",
  "machines.folders": "폴더",
  "machines.foldersNamed": "{name}의 폴더",
  "machines.rename.action": "이름 바꾸기",
  "machines.rename.named": "{name} 이름 바꾸기",
  "machines.rename.label": "{name}의 새 이름",
  "machines.rename.save": "저장",
  "machines.rename.cancel": "취소",
  "machines.remove": "제거",
  "machines.removeTitle": "{name}을(를) 제거할까요?",
  "machines.removeDescription":
    "Psyche가 {name} 사용을 즉시 중단하고 페어링이 취소됩니다. 다시 사용하려면 다시 페어링하세요.",
  "machines.err.nameTaken":
    "다른 컴퓨터가 이미 그 이름을 쓰고 있거나 예약된 이름입니다. 다른 이름을 고르세요.",
  "machines.err.nameInvalid":
    "그 이름은 사용할 수 없습니다. 일반 문자, 숫자, 문장 부호를 64자 이내로 쓰고, 비슷하게 생긴 문자를 섞지 마세요.",
  "machines.err.forbidden":
    "이름을 바꾸려면 관리자 기기가 필요합니다. 관리자 기기에서 다시 시도하세요.",
  "machines.err.failed": "작동하지 않았습니다({reason}). 바뀐 것은 없습니다.",
  "machines.account.own":
    "{name}에서 내 계정으로 실행됩니다. Psyche는 나와 같이 그곳의 파일, 앱, 로그인을 사용할 수 있습니다. Psyche가 침해되면 공격자도 같은 일을 할 수 있습니다. 다만 Psyche가 절대 얻지 못하는 root는 제외입니다.",
  "machines.account.dedicated":
    "{name}에서 별도의 계정으로 실행됩니다. Psyche는 그 계정의 파일과 앱만 볼 수 있습니다.",
  "machines.account.useSeparate": "대신 별도의 계정 사용…",
  "machines.account.useSeparateHint":
    "{name}에서 별도 계정 옵션으로 설치 프로그램을 다시 실행한 다음 다시 페어링하세요:",
  "machines.shell.contained": "명령이 격리된 셸에서 실행됩니다",
  "machines.shell.full": "명령이 계정의 전체 셸에서 실행됩니다",
  "machines.shell.off": "명령이 꺼져 있습니다",
  "machines.limits.folders": "{count, plural, =0 {허용된 폴더 없음} other {허용된 폴더 #개}}",
  "machines.helperVersion": "도우미 {version}",
  "machines.helperVersionUnknown": "도우미 버전을 알 수 없음",
  "machines.update": "더 새로운 도우미가 있습니다. {name}의 도우미를 업데이트하세요:",
  "machines.warnings": "{name} 경고",
  "machines.warn.fullShell":
    "계정의 전체 셸입니다. 명령이 격리되지 않아 이 계정이 닿는 모든 것에 닿습니다.",
  "machines.warn.userLimits":
    "제한을 사용자가 관리합니다. 이 계정으로 실행되는 어떤 프로그램도 {name}에서 Psyche가 할 수 있는 일을 바꿀 수 있습니다.",
  "machines.warn.sudo":
    "이 계정은 비밀번호 없이 sudo를 사용할 수 있습니다. Psyche는 여기서 sudo를 쓸 수 없지만, 이 계정으로 실행하는 다른 프로그램은 쓸 수 있습니다.",
  "machines.paired": "{when} 페어링됨",
  "machines.line": "{name} · Linux · {place}",
  "machines.place.screen": "비공개 화면",
  "machines.place.desktop": "해당 데스크톱",
  "machines.place.command": "명령",
  "machines.place.files": "파일",
  "machines.step.on": "{name}에서 {label}",
  "machines.picker.title": "컴퓨터",
  "machines.picker.description":
    "이 설정이 적용될 컴퓨터와, 특정 컴퓨터를 보고 있지 않을 때 Psyche가 작업할 곳을 고릅니다.",
  "machines.picker.show": "앱 접근을 표시할 컴퓨터",
  "machines.picker.default": "백그라운드 작업의 기본 컴퓨터",
  "machines.picker.defaultHint":
    "작업과 자동화는 컴퓨터를 지정하지 않으면 그곳에서 실행됩니다. Linux 컴퓨터를 고르면 내가 여기서 일하는 동안 Psyche가 저기서 일합니다.",
  "machines.picker.appsOn": "{name}의 앱",
  "machines.picker.appsHint":
    "Psyche는 이를 {name}과(와) 동기화하며, 그 컴퓨터 자체의 제한을 넘지 않습니다.",
  "machines.picker.noApps":
    "Psyche가 아직 {name}에서 앱을 보지 못했습니다. 보게 되면 여기에 나타납니다.",
  "machines.picker.offline": "{name}이(가) 오프라인입니다. 다시 연결되면 변경이 전달됩니다.",
  "computerWatch.titleMachine": "{name} · 비공개 화면",
  "computerWatch.machineOffline": "{name}에 연결할 수 없습니다. 다시 시도하는 중…",
  "computerWatch.empty.bodyMachine": "에이전트가 {name}의 화면이 필요하면 여기서 볼 수 있습니다.",
  "notice.machine.working.title": "Psyche가 {name}에서 작업 중입니다",
  "notice.machine.working.body":
    "그 컴퓨터의 화면, 앱, 파일을 사용하고 있습니다. 설정 → 기기에서 볼 수 있습니다.",
  "notice.machine.offline.title": "{name}이(가) 오프라인이 되었습니다",
  "notice.machine.offline.body":
    "다시 연결될 때까지 Psyche가 사용할 수 없습니다. 필요한 작업은 사용자를 기다립니다.",
};
