import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (zh); merged into `../zh.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "独立桌面",
  "settings.separateDesktop.description":
    "容器中的专用桌面，有自己的应用和文件。它只能看到你为某项任务共享的文件夹，除非你为该任务允许，否则无法上网，任务结束时会停止。",
  "settings.separateDesktop.state.off": "未运行",
  "settings.separateDesktop.state.starting": "正在启动",
  "settings.separateDesktop.state.running": "运行中",
  "settings.separateDesktop.state.stopping": "正在停止",
  "settings.separateDesktop.state.failed": "无法启动",
  "settings.separateDesktop.engine": "容器引擎：{engine}",
  "settings.separateDesktop.rootful":
    "此容器引擎以 root 身份运行。请为独立桌面使用无 root 的 Podman。",
  "settings.separateDesktop.memory": "内存上限",
  "settings.separateDesktop.memoryHint": "独立桌面运行时最多可使用的内存。",
  "settings.separateDesktop.memoryOption": "{gb} GB",
  "settings.separateDesktop.shares": "共享的文件夹：{names}",
  "settings.separateDesktop.internet": "此任务已开启互联网",
  "settings.separateDesktop.reset": "重置独立桌面",
  "settings.separateDesktop.resetHint":
    "删除其容器及其中保存的所有内容。你共享的文件夹不会受影响。",
  "blocks.folder.sd.explain.ro": "{persona} 想让独立桌面读取某个文件夹中的文件。",
  "blocks.folder.sd.explain.rw":
    "{persona} 想让独立桌面读取并修改某个文件夹中的文件。独立桌面里的程序可以修改那里的文件，包括会在这台电脑上运行程序的文件，例如 git 设置和脚本，这些改动会出现在这台电脑上。",
  "blocks.folder.sd.scope":
    "独立桌面只在这项任务期间看到此文件夹。这台电脑上的其他内容不会被共享，这台电脑上的其他工具也不会获得此文件夹。",
  "blocks.folder.sd.scope.once": "仅限这项任务",
  "settings.separateDesktop.limitMemory": "此系统未强制执行内存上限",
  "settings.separateDesktop.limitPids": "此系统未强制执行进程数上限",
  "blocks.details.sdUnverified":
    "独立桌面无法确认此页面确实是 {origin}。只有在你信任任务打开的地址时才继续。",
  "blocks.details.sdFiles": "文件",
  "blocks.details.sdAlsoChanges": "这项任务还可以修改 {folder}，并从中发送文件。",
};
