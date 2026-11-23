import type { Catalogue } from "../../index.ts";

/** App update strings (zh); merged into `../zh.ts`. */
export const update: Partial<Catalogue> = {
  "shell.update.ready": "Psyche {version} 已就绪",
  "shell.update.readyRequired": "Psyche {version} 已就绪。此更新为必需更新。",
  "shell.update.restart": "重新启动以更新",
  "shell.update.dismiss": "关闭更新提示",
  "settings.updates.status": "状态",
  "settings.updates.checking": "正在检查更新…",
  "settings.updates.upToDate": "已是最新版本",
  "settings.updates.ready": "Psyche {version} 已就绪",
  "settings.updates.readyRequired": "Psyche {version} 已就绪（必需）",
  "settings.updates.refused": "更新被拒绝：{reason}",
};
