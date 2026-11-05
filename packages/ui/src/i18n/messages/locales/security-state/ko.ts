import type { Catalogue } from "../../index.ts";

/** The security-records banner and review panel (ko); merged into `../ko.ts`. */
export const securityState: Partial<Catalogue> = {
  "web.security.banner.changed": "앱 밖에서 이루어진 보안 기록 변경을 Psyche가 되돌렸습니다.",
  "web.security.banner.untrusted":
    "Psyche 보안 기록 확인에 실패했습니다. 접근을 넓히는 변경은 차단됩니다.",
  "web.security.banner.recovery":
    "{count, plural, other {이 Mac에서 요청된 보안 변경 #건이 대기 중입니다. 다음 변경은 취소하지 않으면 {when}에 적용됩니다.}}",
  "web.security.banner.notice": "{count, plural, other {확인할 보안 알림이 #건 있습니다.}}",
  "web.security.review": "확인",
  "web.security.hide": "숨기기",
  "web.security.panel.label": "보안 기록",
  "web.security.alert.changed":
    "이 Mac의 프로그램이 Psyche를 거치지 않고 보안 기록 {count}건을 변경했습니다. Psyche가 원래대로 되돌렸습니다. 본인이 한 일이 아니라면 Mac에 원치 않는 소프트웨어가 있는지 확인하세요.",
  "web.security.alert.untrusted":
    "Psyche 보안 기록 확인에 실패했습니다. 새 기기, 보안 설정, Touch ID 승인이 차단됩니다. 기기를 확인한 다음 Mac에서 psyched security reseal을 실행하세요. 24시간 후에 적용됩니다.",
  "web.security.alert.firstSeal":
    "이제 Psyche가 보안 기록을 확인합니다(페어링된 기기 {devices}대). Psyche 밖에서 이루어진 변경은 되돌려지고 여기에 표시됩니다. 기기를 한 번 확인하세요.",
  "web.security.alert.resealed": "Psyche가 보안 기록을 다시 봉인했습니다.",
  "web.security.alert.restored":
    "Psyche가 복원된 백업에서 시작해 보안 기록을 현재 상태 그대로 봉인했습니다. 백업을 복원하지 않았다면 기기를 확인하세요.",
  "web.security.alert.firstAdmin":
    "이 Mac의 명령으로 {name}이(가) 첫 관리자 기기가 되었습니다. 본인이 한 일이 아니라면 기기에서 취소하세요.",
  "web.security.alert.requested": "이 Mac에서 요청됨: {action} {when}에 적용됩니다.",
  "web.security.alert.applied": "적용됨: {action}",
  "web.security.alert.cancelled": "취소됨: {action}",
  "web.security.alert.failed": "적용하지 못함: {action}",
  "web.security.op.devicesApprove": "기기 {name} 승인.",
  "web.security.op.devicesGrant": "{name}이(가) 할 수 있는 일 변경.",
  "web.security.op.presenceReset":
    "새 키가 등록될 때까지 보안 변경에 Touch ID나 패스키를 요구하지 않음.",
  "web.security.op.sealReset": "현재 보안 기록을 그대로 받아들임.",
  "web.security.device": "기기",
  "web.security.deviceKey": "{name}(키 {fingerprint})",
  "web.security.change":
    "{change, select, added {추가됨} modified {변경됨} other {삭제됨}}: {what}",
  "web.security.more": "{count, plural, other {외 #건}}",
  "web.security.ack": "확인함으로 표시",
  "web.security.approveNow": "지금 승인",
  "web.security.cancel": "요청 취소",
  "web.security.needsApproval": "Touch ID나 패스키로 카드를 승인한 다음 버튼을 다시 누르세요.",
  "web.security.failed": "작동하지 않았습니다: {message}",
};
