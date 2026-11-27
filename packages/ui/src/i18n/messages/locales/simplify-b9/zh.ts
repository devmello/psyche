import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (zh); merged into `../zh.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplify.b9.approval.expiresAt": "{time} 过期",
  "simplify.b9.execHost.sandboxed": "将在沙盒中运行。",
  "simplify.b9.execHost.noSandbox":
    "沙盒尚未设置,因此此命令只能在没有沙盒的情况下运行。请先设置沙盒,或仅此一次不使用沙盒运行。",
  "simplify.b9.execHost.noHostSandbox":
    "此电脑上没有用于命令的沙盒,因此此命令只能在没有沙盒的情况下运行。你可以仅此一次运行它。",
  "simplify.b9.execHost.runOnce": "仅此一次不使用沙盒运行",
  "simplify.b9.library.madeBy": "由 {name} 制作",
  "simplify.b9.library.task": "任务",
  "simplify.b9.library.more": "更多筛选",
};
