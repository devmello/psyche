import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (zh); merged into `../zh.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "保持这台电脑唤醒",
  "settings.daily.keepAwake.hint":
    "计划任务运行期间，这台电脑会保持唤醒直到任务完成。显示器仍可关闭。",
  "settings.key.scheduled.keepAwake": "计划任务运行时保持这台电脑唤醒",
  "scheduled.history.retryingAt": "将于 {time} 重试",
  "scheduled.history.retry": "第 {n} 次重试，共 3 次",
  "scheduled.history.failedAfterRetries": "重试 {n} 次后仍失败",
};
