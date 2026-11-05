import type { Catalogue } from "../../index.ts";

/** Signed connector bundles and teach-by-showing in Mac apps (ko); merged into `../ko.ts`. */
export const final202611: Partial<Catalogue> = {
  "settings.connectorBundle.title": "공유된 커넥터 {name}",
  "settings.connectorBundle.intro":
    "누군가 이 커넥터를 파일로 공유했습니다. 아직 아무것도 설치되지 않았습니다. 만든 사람과 요청하는 내용을 확인한 다음 결정하십시오.",
  "settings.connectorBundle.update": "현재 사용 중인 커넥터의 업데이트입니다.",
  "settings.connectorBundle.signer.title": "만든 사람",
  "settings.connectorBundle.signer.unsigned": "이 파일은 서명이 없어서 만든 사람을 알 수 없습니다.",
  "settings.connectorBundle.signer.dropped":
    "설치된 버전은 서명되어 있었지만 이 버전은 서명이 없습니다.",
  "settings.connectorBundle.signer.new": "{name}이(가) 서명했습니다. 이 키는 처음 보는 키입니다.",
  "settings.connectorBundle.signer.seen":
    "{name}이(가) 서명했습니다. 이전에 본 적 있는 키이지만 신뢰하지는 않습니다.",
  "settings.connectorBundle.signer.trusted": "{name}이(가) 서명했습니다. 신뢰하는 작성자입니다.",
  "settings.connectorBundle.signer.own": "본인이 서명했습니다.",
  "settings.connectorBundle.signer.changed":
    "{name}이(가) 서명했지만 이전에 본 키와 다릅니다. 같은 사람인지 확인하십시오.",
  "settings.connectorBundle.signer.impersonates":
    "본인의 이름과 비슷한 이름으로 서명되었지만 키는 본인의 것이 아닙니다.",
  "settings.connectorBundle.signer.nameChanged":
    "신뢰하는 키가 이전에 쓰지 않은 이름으로 서명하고 있습니다: {name}.",
  "settings.connectorBundle.signer.revoked": "본인이 해제한 키로 서명되었습니다.",
  "settings.connectorBundle.signer.rotated":
    "{name}이(가) 서명했습니다. 같은 작성자이지만 키가 새 키입니다(이전 키로 서명됨). 새 키는 직접 신뢰하기 전까지 신뢰되지 않습니다.",
  "settings.connectorBundle.signer.claim":
    "이름은 작성자 본인의 주장입니다. 작성자를 구분하는 것은 키뿐입니다.",
  "settings.connectorBundle.signer.key": "작성자 키",
  "settings.connectorBundle.signer.trust": "{name}을(를) 작성자로 신뢰",
  "settings.connectorBundle.signer.trustHint":
    "이후 파일의 표시와 경고만 바뀝니다. 이 카드를 건너뛰는 일은 없습니다.",
  "settings.connectorBundle.command": "실행하는 명령",
  "settings.connectorBundle.commandHint":
    "프로그램을 먼저 적고, 각 인수는 한 줄에 하나씩 적습니다. 셸을 거치지 않고 실행됩니다.",
  "settings.connectorBundle.network": "요청하는 네트워크",
  "settings.connectorBundle.noNetwork": "네트워크 없음",
  "settings.connectorBundle.networkHint":
    "이를 강제할 수 있는 것은 샌드박스뿐입니다. 이 목록은 작성자가 밝힌 내용입니다.",
  "settings.connectorBundle.env": "읽는 변수",
  "settings.connectorBundle.noEnv": "없음",
  "settings.connectorBundle.envHint": "이름만 표시됩니다. 값은 설치한 후에 지정합니다.",
  "settings.connectorBundle.secrets": "필요한 시크릿",
  "settings.connectorBundle.noSecrets": "없음",
  "settings.connectorBundle.secretsHint":
    "이름만 표시됩니다. 파일에는 시크릿이 들어 있지 않습니다. 설치한 후 각각에 값을 지정하면 금고에 저장됩니다.",
  "settings.connectorBundle.tools": "작성자가 제공한다고 밝힌 도구",
  "settings.connectorBundle.toolsCount": "{n, plural, other {도구 #개}}",
  "settings.connectorBundle.toolsHint":
    "Psyche는 이를 샌드박스에서 시작해 실제로 제공하는 도구를 나열합니다. 그 도구가 기준입니다.",
  "settings.connectorBundle.toolsUndeclared":
    "서버가 파일에 선언되지 않은 도구를 나열했습니다: {names}",
  "settings.connectorBundle.toolsMissing":
    "파일에 선언된 도구를 서버가 나열하지 않았습니다: {names}",
  "settings.connectorBundle.files": "함께 제공되는 스크립트 ({n})",
  "settings.connectorBundle.file": "{path} · {bytes} B",
  "settings.connectorBundle.fileBinary": "텍스트가 아니므로 여기에 표시할 수 없습니다.",
  "settings.connectorBundle.findings": "검사에서 발견된 내용",
  "settings.connectorBundle.finding.high": "설치 차단: {message}",
  "settings.connectorBundle.finding.warn": "확인 필요: {message}",
  "settings.connectorBundle.finding.info": "{message}",
  "settings.connectorBundle.sandbox.srt":
    "처음 실행은 샌드박스에서 이루어집니다. Psyche는 도구를 나열하기 위해 이를 거기서 시작하며, 이후에도 계속 거기서 실행됩니다.",
  "settings.connectorBundle.sandbox.container":
    "처음 실행은 샌드박스 컨테이너에서 이루어집니다. Psyche는 도구를 나열하기 위해 이를 거기서 시작하며, 이후에도 계속 거기서 실행됩니다.",
  "settings.connectorBundle.sandbox.none":
    "이 Mac에는 명령 커넥터용 샌드박스가 없으며, Psyche는 샌드박스 밖에서는 실행하지 않습니다. 이 커넥터는 여기에 설치할 수 없습니다. 아무것도 시작되거나 저장되지 않았습니다.",
  "settings.connectorBundle.blocker.scan":
    "검사에서 설치를 막는 문제가 발견되었습니다. 아무것도 시작되거나 저장되지 않았습니다.",
  "settings.connectorBundle.blocker.probe_failed":
    "네트워크와 시크릿 없이 처음 실행했을 때 시작되지 않았습니다. 아무것도 저장되지 않았습니다.",
  "settings.connectorBundle.signer.ownRetired":
    "본인이 교체한 이전 키로 서명되었습니다. 더 이상 본인의 키로 취급되지 않습니다.",
  "settings.connectorBundle.signer.retired":
    "{name}이(가) 서명했지만, 이미 확인한 교체로 대체된 키입니다. 이 키로 서명된 새 파일은 의심스럽습니다.",
  "settings.connectorBundle.carry.kept": "유지되는, 지정해 둔 값: {names}",
  "settings.connectorBundle.carry.cleared":
    "서명자 또는 명령이 바뀌어 이어지지 않는, 지정해 둔 값입니다. 다시 입력하십시오: {names}",
  "settings.connectorBundle.carry.vault":
    "이전에 저장한 시크릿은 금고에 그대로 남지만 이 버전에는 전달되지 않습니다.",
  "settings.connectorBundle.reset.title": "공유 커넥터 기록이 손상된 경우",
  "settings.connectorBundle.reset.hint":
    "파일에서 온 커넥터는 기록을 읽을 수 없는 동안 꺼진 상태로 유지됩니다. 손상된 기록은 따로 보관되고(마지막 정상 사본이 있으면 복원됩니다), 해당 커넥터는 제거하거나 다시 가져올 때까지 꺼진 상태로 유지됩니다.",
  "settings.connectorBundle.reset.go": "기록 초기화…",
  "settings.connectorBundle.reset.confirm": "예, 초기화합니다",
  "settings.connectorBundle.reset.done":
    "기록을 초기화했습니다. {restored, select, true {마지막 정상 사본을 복원했습니다.} other {빈 상태로 시작합니다.}}",
  "settings.connectorBundle.reset.failed": "기록을 초기화하지 못했습니다: {reason}",
  "settings.connectorBundle.hash": "번들 ID",
  "settings.connectorBundle.close": "닫기",
  "settings.connectorBundle.widened.title": "현재 버전보다 더 많이 요청합니다",
  "settings.connectorBundle.widened.hint":
    "이 카드를 승인하면 아래 항목이 허용됩니다. 범위가 더 좁은 버전의 카드로는 이 항목들이 포함되지 않았습니다.",
  "settings.connectorBundle.widened.command": "다른 명령",
  "settings.connectorBundle.widened.commandValue": "현재: {now}. 이전: {before}",
  "settings.connectorBundle.widened.env": "추가 변수",
  "settings.connectorBundle.widened.secrets": "추가 시크릿",
  "settings.connectorBundle.widened.network": "추가 네트워크",
  "settings.connectorBundle.widened.tools": "추가 도구 또는 더 많은 작업을 할 수 있는 도구",
  "settings.connectorBundle.widened.payload": "다른 스크립트",
  "settings.connectorBundle.widened.payloadValue": "함께 제공되는 파일이 변경되었습니다",
  "settings.connectorBundle.diff": "변경된 내용",
  "settings.connectorBundle.noChanges": "그 밖에 변경된 내용은 없습니다.",
  "settings.connectorBundle.import.title": "공유 커넥터",
  "settings.connectorBundle.import.hint":
    "다른 사람이 파일이나 링크로 보내 준 커넥터를 가져옵니다. 설치되기 전에 요청하는 내용을 모두 확인할 수 있습니다.",
  "settings.connectorBundle.import.file": "커넥터 파일 가져오기",
  "settings.connectorBundle.import.linkLabel": "또는 링크 붙여넣기",
  "settings.connectorBundle.import.linkPlaceholder": "https://example.com/notes.psyche-connector",
  "settings.connectorBundle.import.review": "검토",
  "settings.connectorBundle.import.checking": "확인하는 중…",
  "settings.connectorBundle.import.failed": "커넥터를 가져오지 못했습니다: {reason}",
  "settings.connectorBundle.import.tooBig": "이 파일은 커넥터로 보기에는 너무 큽니다.",
  "settings.connectorBundle.import.denied": "{name}은(는) 설치되지 않았습니다.",
  "settings.connectorBundle.import.lapsed":
    "{expired, select, true {{name} 카드가 만료되었습니다.} other {{name} 카드는 더 이상 적용되지 않습니다.}} 검토하려면 다시 가져오십시오.",
  "settings.connectorBundle.import.added":
    "{name}을(를) 추가했습니다. 아래에서 필요한 시크릿을 지정하면 사용할 수 있습니다.",
  "settings.connectorBundle.import.addedNoSecrets": "{name}을(를) 추가했습니다.",
  "settings.connectorBundle.import.addFailed": "{name}을(를) 추가하지 못했습니다: {reason}",
  "settings.connectorBundle.import.secretsTitle": "{name}의 시크릿",
  "settings.connectorBundle.share.title": "이 커넥터 공유",
  "settings.connectorBundle.share.hint":
    "명령, 변수와 시크릿의 이름, 접근하는 네트워크, 도구가 담긴 서명된 파일을 만듭니다. 값은 절대 포함되지 않습니다. 무엇이 들어가는지 먼저 확인합니다.",
  "settings.connectorBundle.share.go": "공유…",
  "settings.connectorBundle.share.nameLabel": "공유 커넥터에 표시되는 내 이름",
  "settings.connectorBundle.share.nameHint":
    "내 파일을 가져오는 모든 사람에게 이 이름이 표시됩니다. 한 번만 묻습니다. 서명 키는 지금 만들어집니다.",
  "settings.connectorBundle.share.make": "파일 만들기",
  "settings.connectorBundle.share.label": "{name} 공유",
  "settings.connectorBundle.share.done":
    "{file}을(를) 저장했습니다. {author}(으)로 서명되었습니다. 이름만 들어 있으며 변수나 시크릿 값은 없습니다.",
  "settings.connectorBundle.share.failed": "커넥터를 공유하지 못했습니다: {reason}",
  "settings.connectorBundle.share.unavailable":
    "커넥터에 서명할 수 있는 것은 그 커넥터를 실행하는 Mac의 Psyche뿐입니다.",
  "settings.skills.signer.ownRetired":
    "본인이 교체한 이전 키로 서명되었습니다. 더 이상 본인의 키로 취급되지 않습니다.",
  "settings.skills.signer.retired":
    "{name}이(가) 서명했지만, 이미 확인한 교체로 대체된 키입니다. 이 키로 서명된 새 파일은 의심스럽습니다.",
  "settings.skills.signer.rotated":
    "{name}이(가) 서명했습니다. 같은 작성자이지만 키가 새 키입니다(이전 키로 서명됨). 새 키는 직접 신뢰하기 전까지 신뢰되지 않습니다.",
  "settings.skills.author.state.seen": "확인됨, 신뢰하지 않음",
  "settings.skills.author.state.trusted": "신뢰함",
  "settings.skills.author.state.revoked": "해제됨",
  "settings.skills.keys.title": "내 작성자 키와 공지",
  "settings.skills.keys.hint":
    "공유하는 스킬과 커넥터에 서명하는 키입니다. 키를 교체할 수 있으며, 키나 파일을 더 이상 신뢰하면 안 될 때 공지를 게시할 수 있습니다.",
  "settings.skills.keys.none":
    "아직 서명한 것이 없습니다. 키는 스킬이나 커넥터를 처음 공유할 때 만들어집니다.",
  "settings.skills.keys.own": "{name}(으)로 서명",
  "settings.skills.keys.fingerprint": "키",
  "settings.skills.keys.rotate": "내 키 교체…",
  "settings.skills.keys.rotateHint":
    "같은 이름으로 새 키를 만듭니다. 이전 키가 새 키를 명시한 진술에 서명하므로, 나를 신뢰하던 사람은 같은 작성자가 새 키를 쓰는 것으로 보게 됩니다. 그래도 새 키는 각자 직접 신뢰해야 합니다. 먼저 확인을 거칩니다.",
  "settings.skills.keys.rotateLabel": "작성자 키 교체",
  "settings.skills.keys.rotated": "키를 교체했습니다. 새 키는 {key}입니다.",
  "settings.skills.keys.rotateFailed": "키를 교체하지 못했습니다: {reason}",
  "settings.skills.keys.notice.title": "공지 게시",
  "settings.skills.keys.notice.hint":
    "공지는 서명된 작은 파일입니다. 보내거나 호스팅해 두면, 내 키를 알고 있는 사람이 가져와서 키 하나 또는 파일 하나를 차단할 수 있습니다.",
  "settings.skills.keys.notice.kindKey": "내 키(현재 키)",
  "settings.skills.keys.notice.kindBundle": "내가 공유한 파일 하나(번들 ID로 지정)",
  "settings.skills.keys.notice.kind": "문제가 되는 대상",
  "settings.skills.keys.notice.hash": "번들 ID (sha256:…)",
  "settings.skills.keys.notice.reason": "이유 (가져오는 모든 사람에게 표시됩니다)",
  "settings.skills.keys.notice.make": "공지 만들기",
  "settings.skills.keys.notice.label": "해제 공지에 서명",
  "settings.skills.keys.notice.done": "{file}을(를) 저장했습니다. 원하는 방법으로 게시하십시오.",
  "settings.skills.keys.notice.failed": "공지를 만들지 못했습니다: {reason}",
  "settings.skills.keys.import.title": "해제 공지 가져오기",
  "settings.skills.keys.import.hint":
    "만나 본 적 있는 작성자가 서명한 경우에만 적용됩니다. 차단만 할 수 있으며, 무엇을 신뢰하게 만들지는 않습니다.",
  "settings.skills.keys.import.file": "공지 파일 가져오기",
  "settings.skills.keys.import.linkLabel": "또는 링크 붙여넣기",
  "settings.skills.keys.import.linkPlaceholder": "https://example.com/revoke.psyche-notice",
  "settings.skills.keys.import.go": "가져오기",
  "settings.skills.keys.import.key": "키 {key}을(를) 차단했습니다. 제시된 이유: {reason}",
  "settings.skills.keys.import.bundle": "파일 {hash}을(를) 차단했습니다. 제시된 이유: {reason}",
  "settings.skills.keys.import.previewKey":
    "키 {key}{names, select, none {} other { ({names}(으)로 알려짐)}}을(를) 해제합니다. 서명자가 제시한 이유: {reason}",
  "settings.skills.keys.import.previewBundle":
    "파일 {hash}을(를) 차단합니다. 서명자가 제시한 이유: {reason}",
  "settings.skills.keys.import.already": "이미 적용되어 있습니다.",
  "settings.skills.keys.import.apply": "적용",
  "settings.skills.keys.import.signedBy": "{name}이(가) 서명했습니다.",
  "settings.skills.keys.import.failed": "공지를 사용하지 못했습니다: {reason}",
  "web.teach.app.record": "앱에서 녹화",
  "web.teach.app.recordHint": "이미 허용한 Mac 앱에서 작업하는 방법을 Psyche에 보여 줍니다",
  "web.teach.app.pickTitle": "어떤 앱에서 녹화할까요?",
  "web.teach.app.pickLabel": "앱",
  "web.teach.app.pickHint":
    "컴퓨터 사용을 허용한 앱만 표시됩니다. 먼저 앱을 여십시오. 비밀번호, 카드 번호, 코드는 녹화되지 않으며, Psyche 자체 창과 로그인 및 보안 확인 화면도 녹화되지 않습니다.",
  "web.teach.app.none":
    "녹화할 수 있는 앱이 없습니다. 설정에서 컴퓨터 사용을 켜고 먼저 앱에 클릭 또는 조작 권한을 주십시오.",
  "web.teach.app.start": "녹화 시작",
  "web.teach.app.cancelPick": "나중에",
  "web.teach.app.startFailed":
    "Psyche가 해당 앱의 녹화를 시작하지 못했습니다. 먼저 앱을 열고, Psyche에 손쉬운 사용 권한이 있는지 확인하십시오.",
  "web.teach.app.bar.title": "{app} 녹화 중",
  "web.teach.app.bar.body":
    "Psyche는 {app}에서의 클릭, 메뉴 선택, 입력만 기록합니다. 보안 입력란은 녹화되지 않고, 스크린샷도 찍지 않으며, 저장하기 전에는 아무것도 이 Mac을 벗어나지 않습니다. 메뉴 막대에도 중지 버튼이 있습니다.",
  "web.teach.app.bar.endedLimit":
    "200단계 한도에서 녹화가 중지되었습니다. 기록된 내용을 검토하십시오.",
  "web.teach.app.bar.endedTimeout":
    "시간 제한에 도달하여 녹화가 중지되었습니다. 기록된 내용을 검토하십시오.",
  "web.teach.app.bar.endedInterrupted":
    "앱이 닫혀서 녹화가 일찍 끝났습니다. 기록된 내용을 검토하십시오.",
  "web.teach.app.stopFailed": "Psyche가 녹화를 마치지 못했습니다.",
  "web.teach.app.skipped":
    "{count, plural, other {#개 항목이 제외되었습니다: 보안 입력란이거나, 찾을 수 있는 이름이 없는 컨트롤입니다.}}",
  "web.teach.app.privacy":
    "이 단계의 텍스트는 앱의 창과 메뉴에서 가져온 것입니다. 데이터로 취급되며 지시로는 취급되지 않습니다. 저장하면 스킬이 실행되기 전에 승인을 요청합니다.",
  "web.teach.app.sensitive": "녹화되지 않았습니다. 이 부분은 Psyche가 직접 해 달라고 요청합니다.",
  "web.teach.app.runHint":
    "메시지 입력란을 스킬로 채웁니다. 보내기를 누르고 앱을 지켜보십시오. 모든 클릭과 입력은 평소처럼 승인을 요청하며, 무언가 원래 위치에 없으면 멈추고 물어봅니다.",
  "web.teach.step.app.click": "{app}에서 ‘{name}’ 클릭",
  "web.teach.step.app.clickRole": "{app}에서 {role} 클릭",
  "web.teach.step.app.menu": "{app}에서 {path} 선택",
  "web.teach.step.app.type": "{app}에서 ‘{name}’에 입력",
  "web.teach.step.app.typeKept": "{app}에서 ‘{name}’에 {value} 입력",
  "web.teach.step.app.typeInput": "{app}에서 ‘{name}’에 {input} 입력",
  "web.teach.step.app.typeAsk": "{app}에서 ‘{name}’에 지정한 내용 입력",
  "web.teach.step.app.typeSensitive": "{app}에서 ‘{name}’에는 직접 입력",
};
