import type { Catalogue } from "../../index.ts";

/** Failure messages for user actions (zh); merged into `../zh.ts`. */
export const actionErrors: Partial<Catalogue> = {
  "actionError.exportPerson": "无法导出此人的数据（{reason}）。",
  "actionError.revokeGrant": "无法撤销此授权（{reason}）。它仍然有效。",
  "actionError.reindex": "无法重建搜索索引（{reason}）。",
  "actionError.rerun": "无法重新运行此自动化（{reason}）。",
  "actionError.stopResearch": "无法停止研究（{reason}）。它仍在运行。",
  "actionError.unmute": "无法重新开启提醒（{reason}）。",
  "actionError.language": "无法更改语言（{reason}）。",
  "actionError.transcriptMode": "无法更改转录详细程度（{reason}）。",
  "actionError.screenAskDestination": "无法更改屏幕提问的发送位置（{reason}）。",
  "actionError.takeOver": "无法接管虚拟屏幕（{reason}）。",
};
