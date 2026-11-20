import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (ko); merged into `../ko.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.security.changed.title": "앱 밖에서 이루어진 보안 변경을 Psyche가 되돌렸습니다",
  "notice.security.changed.body":
    "이 Mac의 프로그램이 Psyche를 거치지 않고 보안 기록 {count, plural, =1 {# 개} other {# 개}}(기기, 키, 권한, 설정)를 변경했습니다{times, plural, =0 {} =1 {} other {(지금까지 # 번)}}. Psyche가 되돌려 놓았습니다. 직접 하신 일이 아니라면 Mac에 원치 않는 소프트웨어가 없는지 확인하세요.",
  "notice.security.untrusted.title": "Psyche가 보안 기록을 신뢰할 수 없습니다",
  "notice.security.untrusted.body":
    "Psyche의 보안 기록 확인에 실패해서 보안 변경, 새 기기, Touch ID 승인이 차단되었습니다. 기기를 확인한 다음 Mac에서 `psyched security reseal`을 실행하세요(24시간 후에 적용됩니다).",
  "notice.security.firstSeal.title": "Psyche가 이제 보안 기록을 확인합니다",
  "notice.security.firstSeal.body":
    "Psyche가 페어링된 기기 {devices, plural, =1 {# 대} other {# 대}}와 보안 설정을 봉인했습니다. 이제부터 Psyche 밖에서 이루어진 변경은 되돌려지고 여기에 표시됩니다. 기기를 한 번 확인하세요.",
  "notice.security.resealed.title":
    "{restored, select, yes {복원 후 보안 기록을 봉인했습니다} other {보안 기록을 다시 봉인했습니다}}",
  "notice.security.resealed.body":
    "{restored, select, yes {Psyche가 복원된 백업에서 시작되어 보안 기록을 현재 상태 그대로 봉인했습니다. 백업을 복원하지 않았다면 기기를 확인하세요.} other {Psyche가 대기 기간이 지난 뒤 보안 기록을 다시 봉인했습니다.}}",
  "notice.security.firstAdmin.title": "이 Mac의 명령으로 첫 관리자 기기가 만들어졌습니다",
  "notice.security.firstAdmin.body":
    "{device}{key, select, none {} other {(키 {key})}}가 이 Mac에서 {via, select, desktop {Psyche 앱을 통해} other {`psyched`를 통해}} 첫 관리자 기기가 되었습니다. 직접 하신 일이 아니라면 설정 → 기기에서 해제하세요.",
  "notice.security.recovery.title":
    "{state, select, requested {이 Mac의 명령이 보안 변경을 요청했습니다} applied {이 Mac에서 요청한 보안 변경이 적용되었습니다} cancelled {이 Mac에서 요청한 보안 변경이 취소되었습니다} other {이 Mac에서 요청한 보안 변경을 적용하지 못했습니다}}",
  "notice.security.recovery.body":
    "{op, select, approve {기기 {device}{key, select, none {} other {(키 {key})}}를 {scopes} 권한으로 승인합니다.} grant {{device}{key, select, none {} other {(키 {key})}}에 {scopes} 권한을 부여합니다.} presence {새 키가 등록될 때까지 보안 변경에 Touch ID와 패스키 요구를 끕니다.} seal {현재 보안 기록을 그대로 받아들입니다.} other {보안 변경입니다.}}{state, select, requested { {when, select, none {24시간 후에} other {{when}에}} 적용됩니다. Psyche에서 취소할 수 있습니다.} failed {{reason, select, none {} other { {reason}}}} other {}}",
  "notice.browser.chrome.title": "Psyche가 Chrome을 조작하고 있습니다",
  "notice.browser.chrome.body":
    "작업이 로그인되어 있는 Psyche용 Chrome 프로필을 사용하고 있습니다. 창 제목은 “Psyche is driving this window”입니다. 작업이 끝나면 닫히며, Chrome을 직접 종료해도 됩니다.",
  "notice.browser.takeover.title": "브라우저에서 Psyche가 도움을 필요로 합니다",
  "notice.browser.takeover.body":
    "{host}에서 에이전트가 묻습니다: {reason}. 브라우저 창에서 직접 조작한 뒤 다시 넘겨주세요.",
  "notice.connector.consent.title": "Google 연결을 마무리하세요",
  "notice.connector.consent.body":
    "접근을 허용하려면 Psyche가 실행 중인 컴퓨터에서 이 링크를 여세요: {url}",
  "notice.connector.changed.title": "연결이 변경되었습니다",
  "notice.connector.changed.body":
    "{reason, select, account_changed {커넥터가 이제 다른 계정으로 로그인합니다. 이전 계정에 묶인 작업은 중단되었습니다.} disconnected {커넥터 연결이 끊어졌습니다. 해당 커넥터가 필요한 작업은 중단되었습니다.} scope_changed {커넥터가 이제 읽기 전용입니다. 이를 통한 대기 중인 작업은 중단되었습니다.} other {커넥터의 접근 권한이 취소되었습니다. 계속 사용하려면 다시 로그인하세요.}}",
  "notice.connector.reconnect.title": "다시 연결해야 합니다",
  "notice.connector.reconnect.body": "커넥터가 접근 권한을 잃었습니다. 다시 로그인하세요.",
  "notice.attention.paused.title": "작업이 기다리고 있습니다",
  "notice.attention.paused.body":
    "민감한 앱이나 사이트에서 {tool} 직전에 멈췄습니다. Psyche로 돌아올 때까지 기다립니다.",
  "notice.apiKey.changed.title":
    "{kind, select, brave {{provider} 키가 {action, select, changed {변경} other {삭제}}되었습니다} other {{provider} API 키가 {action, select, changed {변경} other {삭제}}되었습니다}}",
  "notice.apiKey.changed.body":
    '{action, select, changed {변경} other {삭제}}한 기기: {device, select, none {기기} other {"{device}" ({platform}{paired, select, none {} other {, 페어링 날짜 {paired}}})}}. 직접 하신 일이 아니라면 설정 → 기기에서 이 기기를 해제하세요.',
  "notice.approvals.digest.title": "{count, plural, other {자동화의 작업 #개가 기다리고 있습니다}}",
  "notice.approvals.digest.body": "승인을 열어 승인하거나 거절하세요",
  "notice.approvals.resumeMissed.title":
    "{automation, select, none {승인한 자동화 작업이 실행되지 않았습니다} other {{automation}: 승인한 작업이 실행되지 않았습니다}}",
  "notice.approvals.resumeMissed.body":
    "{why, select, expired {자동화가 작업에 도달하기 전에 승인이 만료되어 아무것도 하지 않았습니다. 여전히 필요하면 다시 요청합니다.} paused {자동화가 일시 중지되었거나 삭제되어 다시 실행되지 않았고 아무것도 하지 않았습니다. 여전히 필요하면 다시 요청합니다.} restart {자동화가 다시 실행되기 전에 Psyche가 다시 시작되어 아무것도 하지 않았습니다. 여전히 필요하면 다시 요청합니다.} restart_kept {자동화가 다시 실행되기 전에 Psyche가 다시 시작되었습니다. 부여한 권한은 그대로이므로 다음 실행에서 묻지 않고 이 작업을 합니다. 되돌리려면 승인의 상시 권한에서 취소하세요.} failed {자동화가 작업을 다시 실행했지만 실패했습니다. 무엇이 잘못되었는지 활동에서 확인하세요. 여전히 필요하면 다시 요청합니다.} failed_kept {자동화가 작업을 다시 실행했지만 실패했습니다. 무엇이 잘못되었는지 활동에서 확인하세요. 부여한 권한은 그대로이므로 다음 실행에서 묻지 않고 다시 시도합니다. 되돌리려면 승인의 상시 권한에서 취소하세요.} unknown {자동화가 작업을 다시 실행했지만 성공했는지 Psyche가 알 수 없습니다. 활동에서 확인하세요.} not_reached_kept {자동화가 다시 실행되었지만 같은 작업에 도달하지 않아 아무것도 하지 않았습니다. 부여한 권한은 그대로이므로 다음 실행에서 묻지 않고 이 작업을 합니다. 되돌리려면 승인의 상시 권한에서 취소하세요.} other {자동화가 다시 실행되었지만 같은 작업에 도달하지 않아 아무것도 하지 않았습니다. 여전히 필요하면 다시 요청합니다.}}",
  "notice.specialist.result.title":
    "{outcome, select, done {{who}이(가) {title}을(를) 마쳤습니다} partial {{who}이(가) {title}을(를) 일찍 멈췄습니다} cancelled {{who}의 {title} 작업이 중지되었습니다} other {{who}이(가) {title}을(를) 끝내지 못했습니다}}",
  "notice.specialist.result.body":
    "{outcome, select, done {완료} partial {일부 완료} cancelled {취소됨} other {실패}}{findings, plural, =0 {} other { · 발견 #건}}{cost, select, none {} other { · {cost}}} · {minutes, plural, =0 {1분 미만} other {#분}}",
  "notice.mcp.changed.title": "MCP 서버 {server}의 도구가 바뀌었습니다",
  "notice.mcp.suspicious.title": "MCP 서버 {server}의 도구 설명이 의심스럽습니다",
  "notice.mcp.review.body": "이 서버를 쓰기 전에 확인하세요: {details}",
  "notice.security.tightened.title":
    "{device, select, none {어떤 기기} other {{device}}}에서 보안 설정이 강화되었습니다",
  "notice.security.tightened.body":
    "Psyche가 할 수 있는 일을 줄이기만 했으므로 승인이 필요하지 않았습니다. 본인이 아니라면 설정 → 기기에서 해당 기기를 해제하세요.",
  "notice.codeRun.held.title": "Psyche가 {repo}에서 코드 실행이 만든 실행 구성을 보류했습니다",
  "notice.codeRun.held.body":
    "샌드박스의 명령이 {paths}을(를) 만들었습니다. 앱이나 다음 명령이 여기서 코드를 실행할 수 있어 Psyche가 삭제하지 않고 따로 옮겨 두었습니다. 직접 또는 사용하는 도구가 만든 것이라면 유지를 탭하세요.",
  "notice.codeRun.changed.title": "{repo}에서 코드 실행 중 실행 구성이 바뀌었습니다",
  "notice.codeRun.changed.body":
    "샌드박스에서 명령이 실행되는 동안 {paths}이(가) 바뀌었습니다. 직접 또는 편집기가 바꾼 것이 아니라면 폴더를 열기 전에 확인하세요.",
  "notice.codeRun.partial.title": "{repo}이(가) 너무 커서 전부 확인할 수 없습니다",
  "notice.codeRun.partial.body":
    "Psyche는 코드 실행이 만드는 실행 구성을 상위 폴더에서만 확인했습니다.",
  "notice.codeRun.recreated.title": "{repo}의 샌드박스를 다시 만들었습니다",
  "notice.codeRun.recreated.body":
    "읽기 전용 폴더가 바뀌어 실행 중인 서버와 저장소 밖에 설치한 항목이 사라졌습니다. 필요한 것을 다시 시작하세요.",
  "notice.action.keepIt": "유지",
  "notice.codeRun.incident.title":
    "Psyche가 {repo}의 코드 실행에서 나온 것이 아닐 수도 있는 항목을 보류했습니다",
  "notice.codeRun.incident.body":
    "{paths}을(를) 옮기는 동안 경로의 폴더가 바뀌어, 옮긴 항목이 다른 곳의 것일 수 있습니다. {place}에 보관되어 있습니다. 유지를 탭하기 전에 확인하세요. 유지를 누르면 {repo}의 {paths}에 다시 놓입니다.",
  "notice.codeRun.unmoved.title": "{repo}에서 코드 실행이 만든 실행 구성이 그대로 남아 있습니다",
  "notice.codeRun.unmoved.body":
    "샌드박스의 명령이 {paths}을(를) 만들었지만 Psyche가 따로 옮기지 못해 보류되지 않았습니다. 앱이나 다음 명령이 여기서 코드를 실행할 수 있습니다. 폴더를 열거나 그곳에서 무엇이든 실행하기 전에 삭제하세요. 안을 보려고 먼저 권한을 바꾸지 마세요. 그러면 실행될 수 있습니다.",
  "notice.machine.added.title": "{name}이(가) Psyche가 사용할 수 있는 컴퓨터로 추가되었습니다",
  "notice.machine.added.body":
    "Psyche는 이 컴퓨터의 화면, 앱, 셸, 파일을 사용할 수 있으며, 그곳에서의 모든 동작은 먼저 사용자에게 확인을 요청합니다. 직접 추가한 것이 아니라면 설정 → 기기에서 삭제하세요.",
};
