import type { Catalogue } from "../../index.ts";

/** Native dialogs and notifications (ko); merged into `../ko.ts`. */
export const desktopDialog: Partial<Catalogue> = {
  "desktop.dialog.notificationsOn": "알림이 켜져 있습니다.",
  "desktop.dialog.anotherCopyTitle": "Psyche의 다른 사본이 이미 실행 중입니다",
  "desktop.dialog.anotherCopyDetail":
    "{path}에서 실행되고 있습니다. 이 사본을 사용하면 Psyche가 이 앱으로 전환되고, 다른 사본은 이쪽에 연결됩니다.",
  "desktop.dialog.keepOtherCopy": "다른 사본 유지",
  "desktop.dialog.useThisCopy": "이 사본 사용",
  "desktop.dialog.cancel": "취소",
  "desktop.dialog.ok": "확인",
  "desktop.dialog.shareFolderTitle": "Psyche와 폴더 공유",
  "desktop.dialog.share": "공유",
  "desktop.dialog.gatewaysFileTitle": "Psyche가 저장된 게이트웨이를 읽을 수 없습니다",
  "desktop.dialog.gatewaysFileDetail":
    "{problem}. Psyche는 {os, select, macos {이 Mac} windows {이 PC} other {이 컴퓨터}}에서 시작하며 파일을 그대로 둡니다. 고정된 ID가 사라지지 않도록 하기 위해서입니다. 다른 컴퓨터의 게이트웨이를 사용하려면 Psyche 데이터 폴더에서 파일을 고치거나 삭제하세요.",
  "desktop.dialog.stillRunningTitle": "Psyche가 아직 실행 중입니다",
  "desktop.dialog.stillRunningBody":
    "작업과 자동화는 계속 실행됩니다. 알림 영역의 아이콘에서 Psyche를 열고, 아이콘을 마우스 오른쪽 버튼으로 클릭해 종료하세요.",
  "desktop.dialog.manualStepsTitle": "Psyche 제거를 마치려면 한 단계가 더 남았습니다",
  "desktop.dialog.uninstallTitle": "Psyche를 제거할까요?",
  "desktop.dialog.uninstall": "제거",
  "desktop.dialog.uninstallAndDelete": "데이터 삭제 후 제거",
  "desktop.dialog.uninstallItems":
    "Psyche.app을 포함해 {count, plural, one {# 개 항목} other {# 개 항목}}을(를) 휴지통으로 옮깁니다.",
  "desktop.dialog.uninstallDataFolder": "데이터 폴더 {folder}도 휴지통으로 옮깁니다.",
  "desktop.dialog.uninstallDataKept": "데이터 폴더는 유지됩니다.",
  "desktop.dialog.uninstallKeychain": "Psyche가 보관하는 키체인 항목은 삭제됩니다.",
  "desktop.dialog.uninstallKeychainKept":
    "키체인 항목은 그대로 남습니다. 원하면 키체인 접근에서 삭제하세요.",
  "desktop.dialog.stopTitle":
    "{os, select, macos {이 Mac} windows {이 PC} other {이 컴퓨터}}에서 Psyche를 중지할까요?",
  "desktop.dialog.stopDetail":
    "다시 전환할 때까지 자동화와 예약된 작업이 멈춥니다. 계속 실행하려면 그대로 두세요.",
  "desktop.dialog.stopButton":
    "{os, select, macos {이 Mac} windows {이 PC} other {이 컴퓨터}}에서 Psyche 중지",
  "desktop.dialog.keepRunning": "계속 실행",
  "desktop.dialog.forgetTitle": "{name} 정보를 잊을까요?",
  "desktop.dialog.forgetDetail":
    "{origin}\n\n이 작업은 이 컴퓨터의 해당 게이트웨이용 키와, Psyche가 여기에 해당 게이트웨이를 위해 저장한 모든 정보를 삭제합니다. {name}에서는 누군가 그곳에서 이 컴퓨터를 제거할 때까지 이 컴퓨터가 계속 표시됩니다.",
  "desktop.dialog.forgetButton": "잊기",
  "desktop.dialog.repairTitle": "{name}와(과) 다시 페어링할까요?",
  "desktop.dialog.repairDetail":
    "{origin}\n\n이 작업은 Psyche가 그 게이트웨이에 고정해 둔 ID와 이 컴퓨터의 키를 잊게 합니다. 그래서 다음 연결은 그 주소에서 응답하는 대상을 고정하고, 새 컴퓨터로 페어링하도록 요청합니다. ID가 바뀐 이유를 알 때만 진행하세요.",
  "desktop.dialog.repairButton": "다시 페어링",
  "desktop.dialog.claimTitle": "{origin}의 Psyche 서버를 설정할까요?",
  "desktop.dialog.claimDetail":
    "Psyche는 입력한 설정 코드를 서버가 알고 있는지 확인한 뒤 신뢰합니다. 서버도 이 컴퓨터가 그 코드를 알고 있는지 확인한 뒤 관리자로 지정합니다. 이 서버를 방금 직접 설치했을 때만 계속하세요.",
  "desktop.dialog.setUp": "설정",
  "desktop.dialog.addLanTitle": "{origin}이(가) 이 네트워크의 Psyche인가요?",
  "desktop.dialog.addLanDetail":
    "이름: {name}\n\n이 네트워크의 Psyche는 시스템의 인증서를 신뢰하는 대신 자체 인증서를 사용하며, Psyche는 이를 고정합니다. 첫 연결에서 인증서와 게이트웨이 키를 확인하고, 이후 다른 것은 거부합니다. 일반 인증서를 쓰는 서버(예: 자체 CA를 가진 역방향 프록시)에만 「일반 https」를 고르세요. 소유자가 그곳에서 이 컴퓨터를 승인하기 전까지는 아무것도 공유되지 않습니다.",
  "desktop.dialog.psycheOnNetwork": "이 네트워크의 Psyche",
  "desktop.dialog.plainHttps": "일반 https",
  "desktop.dialog.addLinkTitleLan": "이 네트워크의 {origin}에 Psyche를 연결할까요?",
  "desktop.dialog.addLinkTitle": "{origin}에 Psyche를 연결할까요?",
  "desktop.dialog.addLinkDetail":
    "{external, select, yes {이 링크는 직접 붙여넣은 것이 아니라 다른 앱이나 웹사이트에서 열렸습니다. Psyche를 실행하는 {os, select, macos {Mac} windows {PC} other {컴퓨터}}에서 직접 만든 링크일 때만 계속하세요.\n\n} other {}}Psyche는 해당 게이트웨이가 이 ID를 증명할 때만 연결합니다:\n{fingerprint}\n\n{lan, select, yes {이 게이트웨이는 시스템이 신뢰하는 인증서가 아닌 자체 인증서를 사용합니다. Psyche는 아무것도 보내기 전에 이 링크가 가리키는 인증서({pin}…)에 고정하고, 그 밖의 것은 거부합니다. 이 네트워크에 있는 본인의 {os, select, macos {Mac} windows {PC} other {컴퓨터}}에서 온 링크일 때만 계속하세요.\n\n} other {}}링크의 일회용 코드는 그 게이트웨이가 소유자가 만들 때 고른 권한으로, 다시 묻지 않고 이 컴퓨터를 승인하게 해 줍니다.",
  "desktop.dialog.addDetailKey":
    "이름: {name}\n알린 키: {key}…\n\n이 컴퓨터는 그 게이트웨이에 페어링을 요청합니다. 소유자가 그곳에서 이 컴퓨터를 승인하기 전까지는 아무것도 공유되지 않으며, Psyche는 첫 연결에서 게이트웨이의 ID를 고정합니다.",
  "desktop.dialog.addDetailPlain":
    "이름: {name}\n\n이 컴퓨터는 그 게이트웨이에 페어링을 요청합니다. 소유자가 그곳에서 이 컴퓨터를 승인하기 전까지는 아무것도 공유되지 않으며, Psyche는 첫 연결에서 게이트웨이의 ID를 고정합니다.",
  "desktop.dialog.addGatewayButton": "게이트웨이 추가",
};
