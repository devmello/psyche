import type { Catalogue } from "../../index.ts";

/** Native dialogs and notifications (zh); merged into `../zh.ts`. */
export const desktopDialog: Partial<Catalogue> = {
  "desktop.dialog.notificationsOn": "通知已开启。",
  "desktop.dialog.anotherCopyTitle": "Psyche 的另一个副本已在运行",
  "desktop.dialog.anotherCopyDetail":
    "它从 {path} 运行。使用此副本会将 Psyche 切换到这个应用；另一个副本随后会连接到这个副本。",
  "desktop.dialog.keepOtherCopy": "保留另一个副本",
  "desktop.dialog.useThisCopy": "使用此副本",
  "desktop.dialog.cancel": "取消",
  "desktop.dialog.ok": "好",
  "desktop.dialog.shareFolderTitle": "与 Psyche 共享文件夹",
  "desktop.dialog.share": "共享",
  "desktop.dialog.gatewaysFileTitle": "Psyche 无法读取已保存的网关",
  "desktop.dialog.gatewaysFileDetail":
    "{problem}。Psyche 将在{os, select, macos {这台 Mac} windows {这台 PC} other {这台电脑}}上启动，并保持该文件不变，因此不会丢失已固定的身份。要使用其他电脑的网关，请修复或删除 Psyche 数据文件夹中的该文件。",
  "desktop.dialog.stillRunningTitle": "Psyche 仍在运行",
  "desktop.dialog.stillRunningBody":
    "任务和自动化会继续运行。请从通知区域中的图标打开 Psyche；右键点击图标即可退出。",
  "desktop.dialog.manualStepsTitle": "还需一步才能完成 Psyche 的移除",
  "desktop.dialog.uninstallTitle": "卸载 Psyche？",
  "desktop.dialog.uninstall": "卸载",
  "desktop.dialog.uninstallAndDelete": "删除数据并卸载",
  "desktop.dialog.uninstallItems":
    "包括 Psyche.app 在内的 {count, plural, one {# 个项目} other {# 个项目}}将被移到废纸篓。",
  "desktop.dialog.uninstallDataFolder": "你的数据文件夹 {folder} 也将被移到废纸篓。",
  "desktop.dialog.uninstallDataKept": "你的数据文件夹将被保留。",
  "desktop.dialog.uninstallKeychain": "Psyche 保存的钥匙串项目将被删除。",
  "desktop.dialog.uninstallKeychainKept": "钥匙串项目将保留；如需要，可在“钥匙串访问”中删除。",
  "desktop.dialog.stopTitle":
    "在{os, select, macos {这台 Mac} windows {这台 PC} other {这台电脑}}上停止 Psyche？",
  "desktop.dialog.stopDetail":
    "在你切换回来之前，它的自动化和计划任务会停止。让它继续运行即可保持任务进行。",
  "desktop.dialog.stopButton":
    "在{os, select, macos {这台 Mac} windows {这台 PC} other {这台电脑}}上停止 Psyche",
  "desktop.dialog.keepRunning": "保持运行",
  "desktop.dialog.forgetTitle": "忘记 {name}？",
  "desktop.dialog.forgetDetail":
    "{origin}\n\n这将删除此电脑对它的密钥，以及 Psyche 为它在此保存的所有内容。在对方那边有人移除此电脑之前，{name} 仍会列出这台电脑。",
  "desktop.dialog.forgetButton": "忘记",
  "desktop.dialog.repairTitle": "重新与 {name} 配对？",
  "desktop.dialog.repairDetail":
    "{origin}\n\n这将忘记 Psyche 为它固定的身份以及此电脑的密钥，因此下一次连接会固定该地址上响应的任何对象，并请求以新电脑的身份配对。只有在你清楚它的身份为何改变时才这样做。",
  "desktop.dialog.repairButton": "重新配对",
  "desktop.dialog.claimTitle": "在 {origin} 上设置 Psyche 服务器？",
  "desktop.dialog.claimDetail":
    "Psyche 会先确认服务器知道你输入的设置代码，再信任它；服务器也会先确认此电脑知道该代码，再将其设为管理员。只有当你刚刚亲自安装了该服务器时才继续。",
  "desktop.dialog.setUp": "设置",
  "desktop.dialog.addLanTitle": "{origin} 是这个网络上的 Psyche 吗？",
  "desktop.dialog.addLanDetail":
    "名称：{name}\n\n这个网络上的 Psyche 使用自己的证书，Psyche 会固定该证书，而不是信任系统的证书：它在首次连接时检查证书和网关的密钥，之后拒绝任何其他证书。只有对于使用普通证书的服务器（例如带有你自己 CA 的反向代理），才选择“普通 https”。在其所有者于那里批准此电脑之前，不会共享任何内容。",
  "desktop.dialog.psycheOnNetwork": "这个网络上的 Psyche",
  "desktop.dialog.plainHttps": "普通 https",
  "desktop.dialog.addLinkTitleLan": "在这个网络上将 Psyche 连接到 {origin}？",
  "desktop.dialog.addLinkTitle": "将 Psyche 连接到 {origin}？",
  "desktop.dialog.addLinkDetail":
    "{external, select, yes {此链接是由其他应用或网站打开的，而不是你粘贴的。只有当它是你在运行 Psyche 的{os, select, macos {那台 Mac} windows {那台 PC} other {那台电脑}}上亲自创建的，才继续。\n\n} other {}}只有当该网关证明了以下身份时，Psyche 才会连接：\n{fingerprint}\n\n{lan, select, yes {它使用自己的证书，而不是系统信任的证书。Psyche 会在发送任何内容之前，将其固定为此链接所指的证书（{pin}…），并拒绝其他证书。只有当链接来自你在这个网络上的{os, select, macos {Mac} windows {PC} other {电脑}}时才继续。\n\n} other {}}链接中的一次性代码随后会让该网关无需再次询问即可批准此电脑，其权限由创建它的所有者选定。",
  "desktop.dialog.addDetailKey":
    "名称：{name}\n其宣告的密钥：{key}…\n\n此电脑将请求该网关配对。在其所有者于那里批准此电脑之前，不会共享任何内容；Psyche 会在首次连接时固定该网关的身份。",
  "desktop.dialog.addDetailPlain":
    "名称：{name}\n\n此电脑将请求该网关配对。在其所有者于那里批准此电脑之前，不会共享任何内容；Psyche 会在首次连接时固定该网关的身份。",
  "desktop.dialog.addGatewayButton": "添加网关",
};
