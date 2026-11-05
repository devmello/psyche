import type { Catalogue } from "../../index.ts";

/** self-connectors strings (zh); merged into `../zh.ts`. */
export const selfConnectors: Partial<Catalogue> = {
  "settings.mcp.madeBy": "由 Psyche 制作",
  "settings.mcp.madeByHint":
    "此连接器的代码由 Psyche 编写。它只在沙盒中运行，只运行你批准过的代码，而且它的工具在更改任何内容之前都会询问。",
  "settings.mcp.code.title": "代码",
  "settings.mcp.code.view": "查看代码",
  "settings.mcp.code.hide": "隐藏代码",
  "settings.mcp.code.loading": "正在载入代码…",
  "settings.mcp.code.version": "版本 {version} · {runtime} · 入口 {entry}",
  "settings.mcp.code.modified":
    "磁盘上的代码不是你批准过的版本，因此此连接器已停止，直到你批准这项更改。",
  "settings.mcp.code.file": "{path} · {bytes} B",
  "settings.mcp.code.edit": "编辑 {file}",
  "settings.mcp.code.editing": "正在编辑 {file}",
  "settings.mcp.code.save": "存储以待审阅",
  "settings.mcp.code.saving": "正在存储…",
  "settings.mcp.code.cancel": "取消编辑",
  "settings.mcp.code.provided": "由 Psyche 提供，所有连接器相同",
  "settings.mcp.code.approved": "{name}已更新。",
  "settings.mcp.code.denied": "对{name}的更改未获批准。在你批准之前它保持停止。",
  "blocks.details.connector.runtime": "运行方式",
  "blocks.details.connector.runtimeValue": "{persona}编写了此连接器（版本 {version}）",
  "blocks.details.connector.command": "命令",
  "blocks.details.connector.network": "请求访问",
  "blocks.details.connector.networkNone": "无网络",
  "blocks.details.connector.tools": "工具",
  "blocks.details.connector.files": "代码（{n} 个文件）",
  "blocks.details.connector.file": "{path}（{bytes} 字节）",
  "blocks.details.connector.provided": "由 Psyche 提供",
  "blocks.details.connector.diff": "自版本 {version} 以来的更改",
  "blocks.details.connector.suggested": "{persona}从注册表中推荐了此连接器",
};
