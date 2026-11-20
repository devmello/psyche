import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (zh); merged into `../zh.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.security.changed.title": "Psyche 撤销了在应用之外进行的安全更改",
  "notice.security.changed.body":
    "这台 Mac 上有程序绕过 Psyche 更改了 {count, plural, =1 {# 条安全记录} other {# 条安全记录}}（设备、密钥、授权或设置）{times, plural, =0 {} =1 {} other {，目前已发生 # 次}}。Psyche 已将它们恢复。如果不是你做的，请检查 Mac 上是否有不明软件。",
  "notice.security.untrusted.title": "Psyche 无法信任它的安全记录",
  "notice.security.untrusted.body":
    "Psyche 对安全记录的检查未通过，因此安全更改、新设备和 Touch ID 批准都已被阻止。请检查你的设备，然后在 Mac 上运行 `psyched security reseal`（24 小时后生效）。",
  "notice.security.firstSeal.title": "Psyche 现在会检查它的安全记录",
  "notice.security.firstSeal.body":
    "Psyche 已封存 {devices, plural, =1 {# 台已配对设备} other {# 台已配对设备}}及其安全设置。从现在起，在 Psyche 之外所做的更改会被撤销并显示在这里。请检查一次你的设备。",
  "notice.security.resealed.title":
    "{restored, select, yes {恢复后已封存安全记录} other {已重新封存安全记录}}",
  "notice.security.resealed.body":
    "{restored, select, yes {Psyche 从恢复的备份启动，并按现状封存了安全记录。如果你没有恢复过备份，请检查你的设备。} other {等待期结束后，Psyche 已重新封存安全记录。}}",
  "notice.security.firstAdmin.title": "这台 Mac 上的命令创建了第一台管理员设备",
  "notice.security.firstAdmin.body":
    "{device}{key, select, none {} other {（密钥 {key}）}}已在这台 Mac 上{via, select, desktop {通过 Psyche 应用} other {通过 `psyched`}}成为第一台管理员设备。如果不是你做的，请在“设置 → 设备”中撤销。",
  "notice.security.recovery.title":
    "{state, select, requested {这台 Mac 上的命令请求了一项安全更改} applied {来自这台 Mac 的安全更改已应用} cancelled {来自这台 Mac 的安全更改已取消} other {来自这台 Mac 的安全更改无法应用}}",
  "notice.security.recovery.body":
    "{op, select, approve {以 {scopes} 权限批准设备 {device}{key, select, none {} other {（密钥 {key}）}}。} grant {授予 {device}{key, select, none {} other {（密钥 {key}）}} {scopes} 权限。} presence {在注册新密钥之前，关闭安全更改对 Touch ID 和通行密钥的要求。} seal {按现状接受当前的安全记录。} other {一项安全更改。}}{state, select, requested {将{when, select, none {在 24 小时后} other {于 {when}}}生效，除非你在 Psyche 中取消。} failed {{reason, select, none {} other { {reason}}}} other {}}",
  "notice.browser.chrome.title": "Psyche 正在操作你的 Chrome",
  "notice.browser.chrome.body":
    "有任务正在使用你已登录的 Psyche Chrome 配置文件。窗口标题为“Psyche is driving this window”。任务完成后会关闭，你也可以退出 Chrome。",
  "notice.browser.takeover.title": "Psyche 需要你在浏览器中协助",
  "notice.browser.takeover.body":
    "在 {host} 上，智能体询问：{reason}。请在浏览器窗格中接管操作，完成后再交还。",
  "notice.connector.consent.title": "完成 Google 连接",
  "notice.connector.consent.body": "请在运行 Psyche 的电脑上打开此链接以授予访问权限：{url}",
  "notice.connector.changed.title": "连接已更改",
  "notice.connector.changed.body":
    "{reason, select, account_changed {某个连接器现在登录的是另一个账户。与旧账户绑定的工作已停止。} disconnected {某个连接器已断开。需要它的工作已停止。} scope_changed {某个连接器现在为只读。通过它待处理的操作已停止。} other {某个连接器的访问权限已被撤销。请重新登录以继续使用。}}",
  "notice.connector.reconnect.title": "需要重新连接",
  "notice.connector.reconnect.body": "某个连接器失去了访问权限，需要你重新登录。",
  "notice.attention.paused.title": "有任务在等你",
  "notice.attention.paused.body": "在敏感的应用或网站上，已在 {tool} 之前暂停，等你回到 Psyche。",
  "notice.apiKey.changed.title":
    "{kind, select, brave {{provider} 密钥已{action, select, changed {更改} other {移除}}} other {{provider} API 密钥已{action, select, changed {更改} other {移除}}}}",
  "notice.apiKey.changed.body":
    '{action, select, changed {更改} other {移除}}来自：{device, select, none {某台设备} other {"{device}" ({platform}{paired, select, none {} other {，配对于 {paired}}})}}。如果不是你做的，请在“设置 → 设备”中撤销该设备。',
  "notice.approvals.digest.title": "{count, plural, other {有 # 项自动化操作在等待}}",
  "notice.approvals.digest.body": "打开“审批”来批准或拒绝它们",
  "notice.approvals.resumeMissed.title":
    "{automation, select, none {已批准的自动化操作未执行} other {{automation}：已批准的操作未执行}}",
  "notice.approvals.resumeMissed.body":
    "{why, select, expired {在自动化到达该操作之前，批准已过期，因此什么也没做。如果仍然需要，它会再次请求。} paused {自动化已暂停或已被删除，因此没有再次运行，什么也没做。如果仍然需要，它会再次请求。} restart {在自动化能够再次运行之前，Psyche 已重启，因此什么也没做。如果仍然需要，它会再次请求。} restart_kept {在自动化能够再次运行之前，Psyche 已重启。你给出的权限仍然有效，因此它下次运行时会直接执行此操作而不再询问。如需收回，请在“审批”的长期权限中撤销。} failed {自动化再次执行了该操作，但失败了。请在“活动”中查看出了什么问题。如果仍然需要，它会再次请求。} failed_kept {自动化再次执行了该操作，但失败了。请在“活动”中查看出了什么问题。你给出的权限仍然有效，因此它下次运行时会直接重试而不再询问。如需收回，请在“审批”的长期权限中撤销。} unknown {自动化再次执行了该操作，但 Psyche 无法判断是否成功。请在“活动”中查看。} not_reached_kept {自动化已再次运行，但没有到达相同的操作，因此什么也没做。你给出的权限仍然有效，因此它下次运行时会直接执行此操作而不再询问。如需收回，请在“审批”的长期权限中撤销。} other {自动化已再次运行，但没有到达相同的操作，因此什么也没做。如果仍然需要，它会再次请求。}}",
  "notice.specialist.result.title":
    "{outcome, select, done {{who}完成了{title}} partial {{who}在{title}上提前停止了} cancelled {{who}在{title}上被停止了} other {{who}未能完成{title}}}",
  "notice.specialist.result.body":
    "{outcome, select, done {已完成} partial {部分完成} cancelled {已取消} other {失败}}{findings, plural, =0 {} other { · # 项发现}}{cost, select, none {} other { · {cost}}} · {minutes, plural, =0 {不到 1 分钟} other {# 分钟}}",
  "notice.mcp.changed.title": "MCP 服务器 {server} 的工具已变更",
  "notice.mcp.suspicious.title": "MCP 服务器 {server} 的工具描述可疑",
  "notice.mcp.review.body": "使用此服务器前请先检查：{details}",
  "notice.security.tightened.title":
    "安全设置已从{device, select, none {某台设备} other {{device}}}收紧",
  "notice.security.tightened.body":
    "这只减少了 Psyche 可以做的事，因此无需批准。如果不是你本人操作，请在“设置 → 设备”中撤销该设备。",
  "notice.codeRun.held.title": "Psyche 扣下了 {repo} 中一次代码运行创建的启动配置",
  "notice.codeRun.held.body":
    "沙盒中的命令创建了 {paths}。应用或你的下一条命令可能会从中运行代码，所以 Psyche 把它移到一旁，没有删除。如果是你或你的工具创建的，请轻点“保留”。",
  "notice.codeRun.changed.title": "{repo} 中的启动配置在代码运行期间发生了变化",
  "notice.codeRun.changed.body":
    "沙盒中运行命令时 {paths} 发生了变化。如果不是你或你的编辑器所为，请在打开该文件夹前检查一下。",
  "notice.codeRun.partial.title": "{repo} 太大，无法完整检查",
  "notice.codeRun.partial.body": "Psyche 只检查了顶层文件夹中由代码运行创建的启动配置。",
  "notice.codeRun.recreated.title": "{repo} 的沙盒已重新创建",
  "notice.codeRun.recreated.body":
    "它的只读文件夹发生了变化，因此正在运行的服务器以及仓库外安装的内容都已丢失。请重新启动你需要的内容。",
  "notice.action.keepIt": "保留",
  "notice.codeRun.incident.title": "Psyche 扣下了一些可能并非来自 {repo} 中代码运行的内容",
  "notice.codeRun.incident.body":
    "在移开 {paths} 时，途经的一个文件夹发生了变化，因此被移走的内容可能来自别处。它保存在 {place}。轻点“保留”之前请先检查，“保留”会把它放回 {repo} 中的 {paths}。",
  "notice.codeRun.unmoved.title": "{repo} 中一次代码运行创建的启动配置仍在原处",
  "notice.codeRun.unmoved.body":
    "沙盒中的命令创建了 {paths}，但 Psyche 未能把它移到一旁，所以它没有被扣下。应用或你的下一条命令可能会从中运行代码。打开该文件夹或在其中运行任何内容之前，请先检查或删除它。",
};
