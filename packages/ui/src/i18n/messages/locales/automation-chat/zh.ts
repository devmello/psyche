import type { Catalogue } from "../../index.ts";

/** automation-chat strings (zh); merged into `../zh.ts`. */
export const automationChat: Partial<Catalogue> = {
  "automationChat.label": "{title}的运行记录",
  "automationChat.runs": "{n, plural, other {# 次运行}}",
  "automationChat.runs.aria": "{title}，{n, plural, other {# 次运行}}，上次运行{status}",
  "automationChat.schedule": "计划任务",
  "automationChat.runNow": "立即运行",
  "automationChat.empty": "还没有运行记录。此自动化每次运行都会显示在这里。",
  "automationChat.loading": "正在载入运行记录",
  "automationChat.failed": "Psyche 无法载入运行记录",
  "automationChat.more": "显示更早的运行",
  "automationChat.status.needsYou": "需要你处理",
  "automationChat.status.running": "运行中",
  "automationChat.trigger.manual": "立即运行",
  "automationChat.trigger.event": "由事件触发",
  "automationChat.coalesced": "{n} 次错过的运行合并为一次",
  "automationChat.noResult": "没有写入结果",
  "automationChat.noSteps": "这次运行没有记录任何步骤。",
  "automationChat.stepsLoading": "正在载入步骤",
  "automationChat.timeline": "在时间线中打开",
  "automationChat.approvals": "打开审批",
  "automationChat.waiting": "这次运行正在等你处理。",
  "automationChat.result": "结果",
  "automationChat.openScheduled": "在“计划任务”中打开",
  "automationChat.row.runs": "{n, plural, other {# 次运行}}",
  "automationChat.row.last": "上次运行：{status}",
};
