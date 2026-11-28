import type { Catalogue } from "../../index.ts";

/** The security-records banner and review panel (zh); merged into `../zh.ts`. */
export const securityState: Partial<Catalogue> = {
  "web.security.banner.changed": "Psyche 撤销了在应用之外对其安全记录所做的更改。",
  "web.security.banner.untrusted": "Psyche 的安全记录检查失败。扩大访问权限的更改已被阻止。",
  "web.security.banner.recovery":
    "{count, plural, other {在这台 Mac 上请求的 # 项安全更改正在等待。除非你取消，下一项将于 {when} 生效。}}",
  "web.security.banner.notice": "{count, plural, other {有 # 条安全通知需要查看。}}",
  "web.security.review": "查看",
  "web.security.hide": "隐藏",
  "web.security.panel.label": "安全记录",
  "web.security.alert.changed":
    "这台 Mac 上的某个程序绕过 Psyche 更改了 {count} 条安全记录。Psyche 已将其恢复。如果不是你做的，请检查这台 Mac 上是否有不需要的软件。",
  "web.security.alert.untrusted":
    "Psyche 的安全记录检查失败。新设备、安全设置和 Touch ID 批准都已被阻止。请检查你的设备，然后在 Mac 上的 Psyche 中点按“重新封存”（24 小时后生效）。",
  "web.security.alert.firstSeal":
    "Psyche 现在会检查其安全记录（{devices} 台已配对设备）。在 Psyche 之外所做的更改会被撤销并显示在这里。请检查一次你的设备。",
  "web.security.alert.resealed": "Psyche 已重新封存其安全记录。",
  "web.security.alert.restored":
    "Psyche 从恢复的备份启动，并按原样封存了安全记录。如果你没有恢复备份，请检查你的设备。",
  "web.security.alert.firstAdmin":
    "这台 Mac 上的一条命令将 {name} 设为第一台管理员设备。如果不是你做的，请在“设备”中撤销它。",
  "web.security.alert.requested": "在这台 Mac 上请求：{action} 将于 {when} 生效。",
  "web.security.alert.applied": "已生效：{action}",
  "web.security.alert.cancelled": "已取消：{action}",
  "web.security.alert.failed": "无法生效：{action}",
  "web.security.op.devicesApprove": "批准设备 {name}。",
  "web.security.op.devicesGrant": "更改 {name} 可以做的事。",
  "web.security.op.presenceReset": "清除保护付款的密钥，直到注册新密钥为止。",
  "web.security.op.sealReset": "按原样接受当前的安全记录。",
  "web.security.device": "一台设备",
  "web.security.deviceKey": "{name}（密钥 {fingerprint}）",
  "web.security.change":
    "{change, select, added {已添加} modified {已更改} other {已移除}}：{what}",
  "web.security.more": "{count, plural, other {及另外 # 项}}",
  "web.security.ack": "标记为已查看",
  "web.security.approveNow": "立即批准",
  "web.security.cancel": "取消请求",
  "web.security.reseal": "重新封存",
  "web.security.resealHelp": "在你检查过设备后接受当前记录。除非你取消，否则 24 小时后生效。",
  "web.security.needsApprovalPresence": "请用触控 ID 或通行密钥批准卡片，然后再次按下按钮。",
  "web.security.needsApproval": "批准卡片，然后再次按下按钮。",
  "web.security.failed": "操作失败：{message}",
  "settings.security.title": "安全记录",
  "settings.security.description":
    "显示 Psyche 的安全记录是否完好、有哪些未经你操作的改动，以及等待生效的请求。",
  "settings.security.status.sealed": "完好",
  "settings.security.status.untrusted": "不可信",
  "settings.security.empty": "没有需要查看的内容。没有提醒，也没有等待中的请求。",
  "settings.security.approvalLabel": "安全变更",
  "settings.security.approve.title": "现在应用此变更？",
  "settings.security.approve.body": "此请求将立即应用，而不是在 {when}：{action}",
  "settings.security.approve.confirm": "立即应用",
  "settings.security.cancel.title": "取消此请求？",
  "settings.security.cancel.body": "变更不会执行，请求将被丢弃：{action}",
  "settings.security.keep": "保留",
};
