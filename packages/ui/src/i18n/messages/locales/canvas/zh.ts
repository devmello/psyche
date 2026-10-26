import type { Catalogue } from "../../index.ts";

/** Output canvas strings (zh); merged into `../zh.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.label": "画布：{title}",
  "canvas.recents": "最近的输出",
  "canvas.loading": "正在加载…",
  "canvas.missing": "Psyche 无法加载此输出。",
  "canvas.untrusted": "来自不受信任的内容",
  "canvas.version": "版本",
  "canvas.versionOption":
    "v{version} · {author, select, user {你} specialist {专员} other {Psyche}} · {time}",
  "canvas.copy": "复制",
  "canvas.copied": "已复制",
  "canvas.download": "下载",
  "canvas.restore": "恢复为新版本",
  "canvas.oldVersion": "正在查看版本 {version}（只读）。",
  "canvas.conflict": "你编辑时内容已更改，因此未保存你的编辑。请在最新版本上重试。",
  "canvas.saveFailed": "无法保存：{message}",
};
