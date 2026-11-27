import type { Catalogue } from "../../index.ts";

/** Windows variants of the sandbox PC, voice keys and platform terms, and Mac wording (ko); merged into `../ko.ts`. */
export const windowsPlatform202611: Partial<Catalogue> = {
  "blocks.details.runsNoHostSandbox":
    "이 컴퓨터에서, 샌드박스 없이: 여기에는 명령용 샌드박스가 없습니다",
  "blocks.execHost.noHostSandbox":
    "이 컴퓨터에는 명령용 샌드박스가 없어서, 이 명령은 샌드박스 없이만 실행할 수 있습니다. 이번 한 번만 실행하려면 {word}을(를) 입력하세요.",
  "blocks.execHost.mustTypeOnly": "허용하려면 {word}을(를) 입력하세요.",
  "settings.uninstall.stopSandboxPc":
    "샌드박스 PC 서비스가 제거됩니다. Windows가 관리자 승인을 한 번 요청합니다.",
  "settings.computerUse.tcc.microphone.name": "마이크",
  "settings.computerUse.tcc.microphone.why":
    "받아쓰기와 회의 메모를 위해 Psyche가 내 음성을 들을 수 있게 합니다",
  "settings.sandbox.restart.reopen": "Psyche를 종료했다가 다시 여세요.",
  "settings.sandbox.pc.title": "샌드박스 PC 켜기",
  "settings.sandbox.pc.body":
    "명령용 경량 샌드박스인 srt는 Windows에서 실행되지 않습니다. 대신 Psyche가 만드는 스크립트, 명령 서버, 커넥터는 개인정보 및 보안 → 컴퓨터 사용 → VM 모드에서 실행됩니다. 샌드박스 PC는 전용 소형 Linux 컴퓨터이며 내 파일에는 접근할 수 없습니다. 설정 → 샌드박스 PC에서 켠 뒤 다시 확인하세요.",
  "settings.sandbox.pc.notReady.title": "샌드박스 PC가 아직 준비되지 않았습니다",
  "settings.sandbox.pc.notReady.body":
    "켜져는 있지만 아직 실행 중이 아니거나, 안의 Psyche가 오래되었습니다. 설정 → 개인정보 및 보안 → 컴퓨터 사용 → VM 모드에서 시작하거나 업데이트한 뒤 다시 확인하세요.",
  "settings.sandbox.pc.ready":
    "샌드박스 PC가 켜져 있습니다: Psyche가 만든 스크립트, 명령 서버, 커넥터가 여기서 실행됩니다.",
  "settings.sandbox.pc.open": "샌드박스 PC 설정 열기",
  "settings.sandbox.pc.where": "설정 → 개인정보 및 보안 → 컴퓨터 사용 → VM 모드에 있습니다.",
  "settings.devices.platform.windows": "Windows PC",
  "settings.devices.nodeKind.winHelper": "Windows 헬퍼",
  "settings.devices.thisPcAdmin":
    "이 PC는 관리자 기기입니다. 다른 관리자 기기에서 여기서 해제할 수 있습니다.",
  "settings.devices.presenceKey.windowsHello": "Windows Hello 키({algorithm}), 헬퍼가 보고한 대로",
  "settings.devices.presenceKey.windowsHelloNoAlgorithm": "Windows Hello 키, 헬퍼가 보고한 대로",
  "settings.shortcut.reserved.windowsKey": "Windows(Windows 키를 쓰는 단축키)",
  "settings.shortcut.reserved.windowMenu": "창 메뉴",
  "settings.shortcut.reserved.closeApp": "앱 닫기",
  "settings.shortcut.reserved.taskManager": "작업 관리자",
  "settings.shortcut.reserved.startMenu": "시작 메뉴",
  "settings.shortcut.reserved.securityScreen": "Windows 보안 화면",
  "settings.shortcut.key.Super": "Windows 키",
  "settings.shortcut.useDefault": "기본값 사용",
  "settings.quickEntry.title": "빠른 입력",
  "settings.key.quickEntry.shortcut": "단축키",
  "settings.quickEntry.shortcutHint":
    "어떤 앱에서든 팝업 채팅을 엽니다. 다른 키를 고르지 않으면 Psyche는 {keys}를 쓰고, 다른 앱이 이 키를 쓰는 중이면 {fallback}을 씁니다.",
  "settings.voice.key.rightCtrl": "오른쪽 Ctrl",
  "settings.voice.key.rightAlt": "오른쪽 Alt",
  "settings.voice.key.rightShift": "오른쪽 Shift",
  "settings.voice.key.rightWin": "오른쪽 Windows 키",
  "settings.voice.key.capsLock": "Caps Lock",
  "settings.voice.key.scrollLock": "Scroll Lock",
  "settings.voice.key.pause": "Pause",
  "settings.voice.key.menu": "메뉴 키",
  "settings.voice.key.insert": "Insert",
  "settings.voice.key.numLock": "Num Lock",
  "settings.voice.key.other": "다른 키",
  "settings.voice.key.press": "키를 누르세요",
  "settings.voice.key.pressNow": "말하는 동안 누를 키를 누르세요…",
  "settings.voice.key.cantUse":
    "그 키는 글자를 입력하므로 말하기용으로 누르고 있을 수 없습니다. 오른쪽 Ctrl, Caps Lock, Pause, 메뉴 키 또는 F13~F24를 시도하세요.",
  "settings.voice.key.capsLockHint":
    "Caps Lock은 켜짐·꺼짐 상태를 유지합니다. 말하려고 누르고 있어도 상태는 바뀌지 않고, 짧게 누르면 여전히 전환됩니다.",
  "settings.voice.key.altGrWarning":
    "현재 키보드 배열에서 오른쪽 Alt는 AltGr이며 @나 €같은 문자를 입력합니다. 말하려고 누르고 있으면 이런 문자를 입력하는 데 방해가 될 수 있습니다. 오른쪽 Ctrl이 더 안전합니다.",
  "settings.voice.access.windowsWhy":
    "누르고 있는 키를 감지하고 포커스된 앱에 입력합니다. Windows에서는 이를 위한 권한이 필요하지 않습니다. 관리자 권한으로 실행되는 앱에는 받아쓴 텍스트가 전달되지 않습니다.",
  "settings.voice.model.title": "음성 모델",
  "settings.voice.model.usingHelper":
    "받아쓰기는 헬퍼의 음성 인식을 사용합니다. 음성 모델은 더 정확하게 받아쓰며 이 Mac에서 실행됩니다.",
  "settings.voice.model.download": "더 나은 받아쓰기를 위해 음성 모델({mb} MB) 내려받기",
  "settings.voice.model.downloadHint":
    "whisper.cpp 프로젝트에서 한 번만 내려받으며, 사용 전에 검증합니다. 오디오는 이 Mac을 떠나지 않습니다.",
  "settings.voice.model.downloading": "음성 모델 내려받는 중: {total} MB 중 {received} MB",
  "settings.voice.model.ready": "이 Mac의 Whisper({model})",
  "settings.voice.model.readyHint":
    "받아쓰기와 녹음은 여기서 텍스트로 변환됩니다. 오디오는 Mac을 떠나지 않습니다.",
  "settings.voice.model.readyNotFirst":
    "설치되었습니다. 엔진 순서에서 다른 엔진이 먼저 오므로 지금은 받아쓰기에 사용되지 않습니다.",
  "settings.voice.model.failed": "내려받기에 실패했습니다: {reason}",
  "settings.voice.model.retry": "다시 시도",
  "settings.voice.model.vcredist":
    "음성 모델에는 Microsoft Visual C++ 재배포 패키지가 필요합니다. 설치한 뒤 다시 받아쓰세요.",
  "settings.voice.model.crashed":
    "음성 엔진이 예기치 않게 멈췄습니다. 다시 시작될 때까지 받아쓰기는 헬퍼를 사용합니다.",
  "settings.sandboxPc.title": "샌드박스 PC 켜기",
  "settings.sandboxPc.explain":
    "{persona}에게는 Windows 안에서 도는 작은 개인 Linux PC가 주어집니다. 작업은 내 PC가 아니라 그곳에서 실행되며, 내가 공유한 폴더만 볼 수 있습니다.",
  "settings.sandboxPc.oneTime":
    "최초 설정: PC를 실행할 백그라운드 서비스를 추가하기 위해 Windows가 관리자 승인을 한 번 요청합니다. 그다음 Psyche가 PC 이미지({download}, 디스크에서 {disk})를 내려받습니다. 그 밖에는 관리자 권한이 필요하지 않습니다.",
  "settings.sandboxPc.oneTimeNoSize":
    "최초 설정: PC를 실행할 백그라운드 서비스를 추가하기 위해 Windows가 관리자 승인을 한 번 요청합니다. 그다음 Psyche가 PC 이미지를 내려받습니다. 그 밖에는 관리자 권한이 필요하지 않습니다.",
  "settings.sandboxPc.turnOn": "샌드박스 PC 켜기",
  "settings.sandboxPc.cancelDownload": "내려받기 취소",
  "settings.sandboxPc.waitingAdmin": "관리자 확인 창을 기다리는 중…",
  "settings.sandboxPc.restarting": "설정을 마무리하는 중…",
  "settings.sandboxPc.downloading": "PC 이미지 내려받는 중: {total} 중 {received}",
  "settings.sandboxPc.progressLabel": "PC 이미지 내려받기",
  "settings.sandboxPc.ready": "설정됨",
  "settings.sandboxPc.readyText": "샌드박스 PC 설정이 끝났습니다. 버전 {version}.",
  "settings.sandboxPc.unsupported": "여기서는 샌드박스 PC를 사용할 수 없습니다: {reason}.",
  "settings.sandboxPc.failed": "샌드박스 PC를 켜지 못했습니다: {reason}",
  "settings.sandboxPc.failedDid": "그 밖의 것은 바뀌지 않았습니다. 다시 시도할 수 있습니다.",
  "settings.sandboxPc.gb": "{value, number} GB",
  "settings.sandboxPc.mb": "{value, number} MB",
  "settings.sandboxPc.loadLabel": "샌드박스 PC",
  "settings.sandboxPc.onboarding": "샌드박스 PC",
  "settings.sandboxPc.onboardingHint":
    "선택 사항: 내 파일을 건드리면 안 되는 작업을 위한 개인 Linux PC입니다. 나중에 설정에서 준비할 수 있습니다.",
  "settings.sandboxPc.update.title": "샌드박스 PC 서비스 업데이트",
  "settings.sandboxPc.update.explainCompatible":
    "이 버전의 Psyche에는 설치된 것보다 새로운 샌드박스 PC 서비스가 들어 있습니다. 샌드박스 PC는 지금 상태 그대로 계속 동작합니다.",
  "settings.sandboxPc.update.explainRequired":
    "이 버전의 Psyche는 설치된 샌드박스 PC 서비스를 사용할 수 없습니다. 업데이트하기 전까지 샌드박스 PC는 꺼진 상태로 남습니다.",
  "settings.sandboxPc.update.available": "업데이트 있음",
  "settings.sandboxPc.update.required": "업데이트 필요",
  "settings.sandboxPc.update.versions": "설치된 버전: {installed}. 이 버전의 Psyche: {bundled}.",
  "settings.sandboxPc.update.oneStep":
    "Windows가 관리자 승인을 한 번 요청합니다. 서비스를 교체하는 동안 실행 중인 샌드박스 PC는 멈춥니다.",
  "settings.sandboxPc.update.button": "샌드박스 PC 서비스 업데이트",
  "settings.sandboxPc.update.failed": "샌드박스 PC 서비스가 업데이트되지 않았습니다: {reason}",
  "settings.sandboxPc.update.failedDid": "그 밖의 것은 바뀌지 않았습니다. 다시 시도할 수 있습니다.",
  "settings.sandboxPc.controls.title": "샌드박스 PC",
  "settings.sandboxPc.controls.hint": "한 번 만든 뒤 여기서 시작하고 중지하세요.",
  "settings.sandboxPc.controls.create": "샌드박스 PC 만들기",
  "settings.sandboxPc.controls.start": "시작",
  "settings.sandboxPc.controls.stop": "중지",
  "settings.sandboxPc.controls.resume": "재개",
  "settings.sandboxPc.controls.working": "처리 중…",
  "settings.sandboxPc.controls.helperOffline":
    "Windows 헬퍼가 실행 중이 아니거나 아직 샌드박스 PC가 없어서 제어할 수 없습니다. 설정 → 기기에서 헬퍼를 다시 시작하세요.",
  "settings.sandboxPc.controls.failed": "작동하지 않았습니다: {reason}",
  "settings.sandboxPc.controls.waitForImage": "먼저 위에서 켜기를 마치세요.",
  "settings.sandboxPc.snapshots.title": "스냅샷",
  "settings.sandboxPc.snapshots.hint":
    "나중에 돌아갈 수 있도록 샌드박스 PC의 디스크를 저장합니다. 저장하거나 복원하려면 중지되어 있어야 합니다.",
  "settings.sandboxPc.snapshots.none": "아직 스냅샷이 없습니다.",
  "settings.sandboxPc.snapshots.save": "스냅샷 저장",
  "settings.sandboxPc.snapshots.saveFresh": "새 PC로 저장",
  "settings.sandboxPc.snapshots.reset": "새 PC로 되돌리기",
  "settings.sandboxPc.snapshots.restore": "복원",
  "settings.sandboxPc.snapshots.delete": "삭제",
  "settings.sandboxPc.snapshots.fresh": "새 PC",
  "settings.sandboxPc.snapshots.item": "{label}, {when}",
  "settings.sandboxPc.snapshots.stopFirst": "먼저 샌드박스 PC를 중지하세요.",
  "onboarding.connectors.windowsHint":
    "Windows에서 {name}은(는) Microsoft, Google 또는 IMAP 계정을 통해 메일, 캘린더, 연락처를 읽습니다.",
  "web.about.windowsArm": "Arm64",
  "web.about.windowsX64": "x64",
  "web.about.windowsBuild": "빌드 {build}",
  "platform.term.os": "macOS",
  "platform.term.device": "Mac",
  "platform.term.thisDevice": "이 Mac",
  "platform.term.thisDeviceLower": "이 Mac",
  "platform.term.presence": "Touch ID",
  "platform.term.secretStore": "키체인",
  "platform.term.systemSettings": "시스템 설정",
  "platform.term.fileManager": "Finder",
  "platform.term.trayArea": "메뉴 막대",
  "platform.term.taskbar": "Dock",
  "platform.term.systemSearch": "Spotlight",
  "platform.term.helper": "Mac 헬퍼",
  "platform.term.terminal": "터미널",
  "platform.term.alt": "Option",
  "platform.term.mod": "Command",
  "platform.macOnly": "macOS에서만 사용할 수 있음",
  "platform.macOnlyHint": "{name}에는 Mac이 필요합니다. macOS의 Psyche에서 사용할 수 있습니다.",
  "platform.windows.access.title": "Windows 접근 권한",
  "platform.windows.access.hint": "Windows가 Psyche에 허용하는 것과 내게 요청하는 것입니다.",
  "platform.windows.access.noPermission": "권한이 필요하지 않음",
  "platform.windows.access.uiAutomation.name": "앱 사용",
  "platform.windows.access.uiAutomation.why":
    "{persona}은(는) Windows UI 자동화를 통해 앱 창을 읽고 사용합니다. Windows는 관리자 권한으로 실행되는 앱을 제어하지 못하게 합니다.",
  "platform.windows.access.screen.name": "화면 캡처",
  "platform.windows.access.screen.why":
    "Windows는 화면 캡처에 권한이 필요하지 않습니다. Psyche 창과 비밀번호 입력란은 캡처에서 가려집니다.",
  "platform.windows.access.microphone.name": "마이크",
  "platform.windows.access.microphone.why":
    "받아쓰기와 회의 메모를 위해서입니다. Windows에서 설정 → 개인 정보 및 보안 → 마이크에서 “데스크톱 앱이 마이크에 액세스하도록 허용”을 켜면 허용됩니다.",
  "platform.windows.access.openSettings": "설정 열기",
  "platform.windows.access.openSettingsFor": "{name}의 Windows 설정 열기",
  "platform.windows.access.state.granted": "켜짐",
  "platform.windows.access.state.denied": "Windows 설정에서 꺼짐",
  "platform.windows.access.state.not_determined": "아직 확인하지 않음",
  "platform.helper.restart": "헬퍼 다시 시작",
  "platform.helper.restarting": "다시 시작하는 중…",
  "platform.helper.restartFailed": "헬퍼가 시작되지 않았습니다({reason}).",
};
