import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (ko); merged into `../ko.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplify.b4.devices.title": "기기",
  "simplify.b4.devices.description": "Psyche를 사용할 수 있는 컴퓨터와 iPhone입니다.",
  "simplify.b4.devices.details": "세부 정보",
  "simplify.b4.devices.canDo": "할 수 있는 일",
  "simplify.b4.devices.canDoOf": "{name}이(가) 할 수 있는 일",
  "simplify.b4.devices.hostKey": "이 컴퓨터의 키: {fingerprint}",
  "simplify.b4.devices.helpers": "도우미",
  "simplify.b4.devices.helpersHint": "Psyche가 컴퓨터에서 작업하도록 돕는 작은 앱입니다.",
  "simplify.b4.devices.noHelpers":
    "아직 도우미가 없습니다. 컴퓨터에서 Psyche가 실행되면 도우미가 여기에 표시됩니다.",
  "simplify.b4.server.title": "네트워크 및 원격 접속",
  "simplify.b4.server.description":
    "다른 기기가 이 컴퓨터에 연결하는 방법과 집 밖에서 Psyche를 사용하는 방법입니다.",
  "simplify.b4.server.away": "집 밖에서 사용하기",
  "simplify.b4.pairIphone.title": "iPhone 연결",
  "simplify.b4.pairIphone.description":
    "iPhone의 Psyche에서 코드를 스캔하세요. iPhone과 이 컴퓨터가 같은 Wi-Fi에 있어야 합니다.",
  "simplify.b4.pairIphone.button": "iPhone 연결",
  "simplify.b4.pairIphone.scan":
    "iPhone에서 Psyche를 열고 이 코드를 스캔하세요. 한 번만 사용할 수 있습니다.",
  "simplify.b4.pairIphone.lanOn":
    "연결하면서 네트워크 접근을 켰습니다. iPhone이 이 컴퓨터를 찾을 수 있습니다.",
  "simplify.b4.pairIphone.lanOff": "네트워크 접근이 다시 꺼졌습니다.",
  "simplify.b4.pairIphone.turnOff": "네트워크 접근 끄기",
  "simplify.b4.pairIphone.enableFailed": "네트워크 접근을 켜지 못했습니다: {reason}",
  "simplify.b4.pairIphone.turnOffFailed": "네트워크 접근을 끄지 못했습니다: {reason}",
  "simplify.b4.pairIphone.noNetwork":
    "지금은 네트워크에서 이 컴퓨터에 연결할 수 없습니다. Wi-Fi가 켜져 있는지 확인한 뒤 다시 시도하세요.",
};
