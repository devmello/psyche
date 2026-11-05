import type { Catalogue } from "../../index.ts";

/** device-access strings (zh); merged into `../zh.ts`. */
export const deviceAccess: Partial<Catalogue> = {
  "settings.deviceAccess.files.title": "这台 Mac 上的文件",
  "settings.deviceAccess.files.hint":
    "{persona}可以读取的文件夹，以及你允许时可以编辑的文件夹。你在“权限 → 访问”中共享它们。",
  "settings.deviceAccess.files.more": "{count, plural, other {以及另外 # 个}}",
  "settings.deviceAccess.open": "打开访问",
  "settings.deviceAccess.terminal.title": "终端",
  "settings.deviceAccess.terminal.hint":
    "“权限 → 访问”中开启“在这台 Mac 上运行命令”后，{persona}可以在这台 Mac 上运行终端命令。",
  "settings.deviceAccess.terminal.where":
    "命令在你的 Mac 上、在你共享的文件夹中运行，并且只能写入你以读写方式共享的文件夹。",
  "settings.deviceAccess.terminal.asks":
    "可能更改文件的命令会先询问，除非你选择始终允许那条确切的命令。ls、cat 或 wc 等基本的只读命令无需询问即可运行，除非你将其关闭。",
  "settings.deviceAccess.terminal.sandbox":
    "命令在沙盒中运行。只有当你在卡片上输入 UNSANDBOXED 时，才会有一次获批的运行不使用沙盒。",
  "settings.deviceAccess.terminal.on": "运行命令已开启",
  "settings.deviceAccess.terminal.off": "运行命令已关闭",
  "settings.deviceAccess.terminal.folders":
    "{count, plural, =0 {尚未共享任何文件夹：命令无处可运行。} other {已共享 # 个文件夹。}}",
  "settings.mcp.needs.title": "这需要你的 Mac 具备什么",
  "settings.mcp.needs.srt": "沙盒（srt）",
  "settings.mcp.needs.srt.fix": "让服务器远离 Psyche 的私有数据。",
  "settings.mcp.needs.node": "Node.js 工具（npm）",
  "settings.mcp.needs.node.fix":
    "在 Psyche 自带的 Node 上运行；这台 Mac 上需要 npm。请从 nodejs.org 安装 Node.js，或运行 brew install node。",
  "settings.mcp.needs.uv": "uv（uvx）",
  "settings.mcp.needs.uv.fix":
    "这是 Python 服务器。请用 brew install uv 或从 docs.astral.sh/uv 安装 uv。",
  "settings.mcp.needs.network": "网络",
  "settings.mcp.needs.network.fix": "访问服务器自己的地址。",
  "settings.mcp.needs.networkHosts": "仅访问 {hosts} 来下载并运行服务器。",
  "settings.mcp.needs.missing": "缺失",
  "settings.mcp.needs.ready": "就绪",
  "settings.mcp.needs.checked": "在“检查服务器”时检查",
  "settings.mcp.fail.no_srt": "沙盒尚未安装。请在下方设置，然后再次检查服务器。",
  "settings.mcp.fail.node_missing":
    "请安装 Node.js（nodejs.org，或 brew install node），让这台 Mac 上有 npm，然后重新检查。",
  "settings.mcp.fail.uv_missing":
    "请安装 uv（brew install uv，或 docs.astral.sh/uv），然后再次检查服务器。",
  "settings.mcp.fail.command_not_found":
    "这里没有安装该服务器的命令。请检查命令，或安装它所指的工具。",
  "settings.mcp.fail.network_blocked":
    "服务器无法下载或访问所需内容。请检查你的网络连接，以及它的主机是否被允许。",
  "settings.mcp.fail.timeout": "耗时过长。首次运行会下载软件包；请检查网络连接后重试。",
  "settings.mcp.fail.exited": "服务器在启动后立即停止。下面是它最后的输出。",
  "settings.mcp.fail.failed": "请查看下方的服务器输出，然后重试。",
  "settings.mcp.fail.exitCode": "退出代码 {code}。",
  "settings.mcp.fail.output": "服务器输出",
};
