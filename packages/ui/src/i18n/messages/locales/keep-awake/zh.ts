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
  "scheduled.history.cancelRetry": "取消重试",
  "scheduled.history.cancelRetry.aria": "取消 {when} 那次运行的重试",
  "scheduled.history.cancelRetry.failed": "无法取消重试（{reason}）。",
  "settings.updates.group": "更新",
  "settings.updates.hint": "Psyche 会检查已签名的更新，并在你退出时安装。",
  "settings.updates.channel": "发布渠道",
  "settings.updates.channel.stable": "稳定版",
  "settings.updates.channel.note":
    "目前只有稳定版渠道。发布测试版后，测试版会显示在这里。无论哪个渠道，每次更新都会用 Psyche 的发布密钥验证。",
  "settings.storage.title": "存储",
  "settings.storage.hint": "Psyche 在这台电脑的数据文件夹中占用的磁盘空间。",
  "settings.storage.total": "总计",
  "settings.storage.clear": "清除…",
  "settings.storage.cleared": "已清除，释放了 {size}。",
  "settings.storage.clearFailed": "无法清除存储（{reason}）。",
  "settings.storage.compact.title": "压缩数据库",
  "settings.storage.compact.hint":
    "数据库 {size}，最多可回收 {reclaimable}。运行期间 Psyche 会短暂暂停。",
  "settings.storage.compact.button": "压缩",
  "settings.storage.compact.running": "正在压缩…",
  "settings.storage.compact.done": "已在 {seconds} 秒内完成压缩，节省 {size}。",
  "settings.storage.compact.failed": "无法压缩数据库（{reason}）。",
  "settings.storage.compact.busy": "Psyche 正在处理任务，请在完成后重试。",
  "settings.storage.failed": "无法读取存储用量（{reason}）。",
  "settings.storage.confirm.title": "清除缓存和旧录制？",
  "settings.storage.confirm.body":
    "这将删除共 {size} 的缓存和超过 7 天的浏览器录制，以及这些录制在资料库中的条目。需要时 Psyche 会重新生成缓存。你的聊天、记忆、其他资料库文件、保险库和设置不会受到影响。",
  "settings.storage.confirm.clear": "清除",
  "settings.storage.cat.database": "数据库",
  "settings.storage.cat.memoryIndex": "记忆索引",
  "settings.storage.cat.library": "附件和资料库",
  "settings.storage.cat.browserProfiles": "浏览器配置文件",
  "settings.storage.cat.recordings": "录制",
  "settings.storage.cat.logs": "日志",
  "settings.storage.cat.caches": "缓存",
  "settings.storage.cat.other": "其他所有内容",
};
