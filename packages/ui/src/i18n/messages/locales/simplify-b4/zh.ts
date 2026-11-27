import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (zh); merged into `../zh.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplifyB4.devices.title": "设备",
  "simplifyB4.devices.description": "可以使用 Psyche 的电脑和 iPhone。",
  "simplifyB4.devices.details": "详情",
  "simplifyB4.devices.canDo": "可以做什么",
  "simplifyB4.devices.canDoOf": "{name}可以做什么",
  "simplifyB4.devices.hostKey": "这台电脑的密钥：{fingerprint}",
  "simplifyB4.devices.helpers": "辅助程序",
  "simplifyB4.devices.helpersHint": "让 Psyche 在电脑上工作的小型应用。",
  "simplifyB4.devices.noHelpers": "还没有辅助程序。Psyche 在电脑上运行后，辅助程序会显示在这里。",
  "simplifyB4.server.title": "网络与远程访问",
  "simplifyB4.server.description": "其他设备如何连接这台电脑，以及如何在外面使用 Psyche。",
  "simplifyB4.server.away": "在外面使用",
  "simplifyB4.pairIphone.title": "配对 iPhone",
  "simplifyB4.pairIphone.description": "用 iPhone 上的 Psyche 扫描二维码。iPhone 和这台电脑需要连接同一个 Wi-Fi。",
  "simplifyB4.pairIphone.button": "配对 iPhone",
  "simplifyB4.pairIphone.scan": "在 iPhone 上打开 Psyche 并扫描此二维码。它只能使用一次。",
  "simplifyB4.pairIphone.lanOn": "配对时已开启网络访问，这样 iPhone 才能找到这台电脑。",
  "simplifyB4.pairIphone.lanOff": "网络访问已再次关闭。",
  "simplifyB4.pairIphone.turnOff": "关闭网络访问",
  "simplifyB4.pairIphone.enableFailed": "无法开启网络访问：{reason}",
  "simplifyB4.pairIphone.turnOffFailed": "无法关闭网络访问：{reason}",
  "simplifyB4.pairIphone.noNetwork": "目前无法通过你的网络连接到这台电脑。请确认 Wi-Fi 已开启，然后重试。",
};
