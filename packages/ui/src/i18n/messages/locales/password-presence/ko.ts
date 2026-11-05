import type { Catalogue } from "../../index.ts";

/** Password presence on Linux (ko); merged into `../ko.ts`. */
export const passwordPresence: Partial<Catalogue> = {
  "blocks.approval.password.needsAuth": "승인하려면 비밀번호 또는 패스키가 필요합니다.",
  "blocks.approval.password.waiting":
    "{code}을(를) 승인하려면 시스템 대화상자에 비밀번호를 입력하세요",
  "blocks.approval.password.waitingShort": "비밀번호를 기다리는 중…",
  "blocks.approval.password.onceOnly": "이 창에서의 비밀번호 승인은 한 번만 유효합니다.",
  "blocks.approval.status.allowedOncePassword":
    "한 번 허용됨(이 창에서의 비밀번호 승인은 한 번만 유효합니다)",
  "blocks.approval.password.noUnsandboxed":
    "샌드박스 없이 명령을 실행하는 것은 이 창에서 비밀번호로 승인할 수 없습니다. 대신 샌드박스를 설정하세요",
  "blocks.approval.password.cancelled": "비밀번호 대화상자가 취소되어 아무것도 승인되지 않았습니다",
  "blocks.approval.password.failed":
    "비밀번호가 받아들여지지 않아 아무것도 승인되지 않았습니다. 다시 시도하세요.",
  "blocks.approval.password.unavailableHere":
    "이 컴퓨터에서 승인하거나 다른 기기의 패스키로 승인하세요.",
  "blocks.approval.password.agentMissing":
    "이 데스크톱에는 비밀번호 대화상자가 없습니다. polkit-gnome 또는 lxpolkit 같은 polkit 에이전트를 설치하거나 패스키를 사용하세요.",
  "blocks.approval.password.policyMissing":
    "Psyche의 비밀번호 정책이 이 컴퓨터에 설치되어 있지 않습니다. Psyche의 일회성 설정을 실행하거나 패스키를 사용하세요.",
  "blocks.approval.password.notEnforced":
    "이 컴퓨터의 polkit 규칙이 Psyche를 비밀번호 없이 승인하므로 본인인지 확인할 수 없습니다. 규칙을 제거하거나 패스키를 사용하세요.",
  "blocks.approval.password.unreachable":
    "시스템의 비밀번호 서비스를 사용할 수 없습니다. 다시 시도하거나 패스키를 사용하세요.",
  "settings.devices.password.title": "비밀번호 승인",
  "settings.devices.password.description":
    "민감한 작업을 승인하기 전에 Psyche는 시스템 자체 대화상자에서 비밀번호를 요청합니다. 비밀번호는 Psyche로 전달되지 않습니다.",
  "settings.devices.password.state.ready": "준비됨",
  "settings.devices.password.state.policyMissing": "정책이 설치되지 않음",
  "settings.devices.password.state.notEnforced": "꺼짐",
  "settings.devices.password.state.noSession": "데스크톱 세션 없음",
  "settings.devices.password.state.agentMissing": "비밀번호 대화상자 없음",
  "settings.devices.password.state.unavailable": "사용할 수 없음",
  "settings.devices.password.detail.ready":
    "민감한 작업을 승인할 때 Psyche는 시스템 대화상자에서 비밀번호를 요청합니다.",
  "settings.devices.password.detail.policyMissing":
    "Psyche의 비밀번호 정책이 이 컴퓨터에 설치되어 있지 않습니다. Psyche의 일회성 설정을 실행하세요.",
  "settings.devices.password.detail.notEnforced":
    "이 컴퓨터의 polkit 규칙이 Psyche를 비밀번호 없이 승인합니다. 규칙을 제거하기 전까지 비밀번호 승인은 꺼져 있습니다.",
  "settings.devices.password.detail.noSession":
    "비밀번호 승인에는 이 컴퓨터의 활성 데스크톱 세션이 필요합니다. 그곳에서 Psyche를 여세요.",
  "settings.devices.password.detail.agentMissing":
    "이 데스크톱에는 비밀번호 대화상자가 없습니다. polkit-gnome 또는 lxpolkit 같은 polkit 에이전트를 설치하세요.",
  "settings.devices.password.detail.unavailable":
    "Psyche가 시스템의 비밀번호 서비스에 연결하지 못했습니다.",
  "settings.devices.password.x11Warning":
    "X11 세션입니다. 다른 프로그램이 여기서 입력하는 내용을 읽을 수 있어서 비밀번호는 장벽이 아니라 속도 방지턱일 뿐입니다. Wayland 세션이 더 안전합니다.",
};
