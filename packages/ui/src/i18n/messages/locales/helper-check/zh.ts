import type { Catalogue } from "../../index.ts";

/** The Linux helper check in Settings → Devices (zh); merged into `../zh.ts`. */
export const helperCheck: Partial<Catalogue> = {
  "settings.devices.helperCheck.title": "Linux 助手检查",
  "settings.devices.helperCheck.description": "Linux 助手连接时，Psyche 会检查它实际是哪个程序。",
  "settings.devices.helperCheck.state.verified": "已验证：系统中安装的助手",
  "settings.devices.helperCheck.state.userOwned": "未验证：来自你主目录的助手",
  "settings.devices.helperCheck.state.unverified": "未验证：Psyche 无法检查该助手",
  "settings.devices.helperCheck.detail.verified":
    "这是随 Psyche 一起安装的助手，只有系统可以修改它。",
  "settings.devices.helperCheck.detail.userOwned":
    "它从你拥有的文件运行，例如 AppImage 或你主目录中的构建。Psyche 接受它，但无法排除你的其他程序已将它替换。",
  "settings.devices.helperCheck.detail.unverified": "Psyche 暂时接受它，但无法确定它是哪个程序。",
  "settings.devices.helperCheck.refused": "已拒绝：{reason}",
  "settings.devices.helperCheck.reason.unclear": "Psyche 无法验证该助手",
  "settings.devices.helperCheck.reason.notHelper": "这个程序不是 Psyche 助手",
  "settings.devices.helperCheck.reason.userCopy":
    "它是系统安装之外的副本，而这里要求使用已安装的助手",
  "settings.devices.helperCheck.reason.loaderEnv": "它是带着库路径或预加载的库启动的",
  "settings.devices.helperCheck.reason.foreignCode": "它加载了来自系统之外的代码",
  "settings.devices.helperCheck.reason.severalPrograms": "不止一个程序共用它的连接",
  "settings.devices.helperCheck.reason.handedOver": "它的连接是由另一个程序交给它的",
  "settings.devices.helperCheck.reason.stillStarting": "它还在启动中",
  "settings.devices.helperCheck.reason.debugged": "它已停止或正在被调试",
  "settings.devices.helperCheck.reason.restartNeeded":
    "它在启动后被替换，或系统库已更新；请重启助手",
  "settings.devices.helperCheck.reason.filesNotLocked": "除系统以外的人也可能修改它的文件",
  "settings.devices.helperCheck.reason.otherNamespace": "它运行在这台电脑上一个单独的沙盒中",
  "settings.devices.helperCheck.reason.busy": "Psyche 正忙于检查其他连接；助手会再试一次",
};
