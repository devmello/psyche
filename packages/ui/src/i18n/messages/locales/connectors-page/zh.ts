import type { Catalogue } from "../../index.ts";

/** connectors-page strings (zh); merged into `../zh.ts`. */
export const connectorsPage: Partial<Catalogue> = {
  "settings.connectors.page.description":
    "{persona}可以使用的 App 和工具。除非你另有说明，每一个在行动前都会询问。",
  "settings.connectors.page.needsYou": "需要你处理",
  "settings.connectors.page.connected": "已连接",
  "settings.connectors.page.onThisMac": "在这台 Mac 上",
  "settings.connectors.page.addMore": "添加更多",
  "settings.connectors.page.addMore.hint":
    "邮件、日历、备忘录和现成的工具。每一个在行动前都会询问。",
  "settings.connectors.page.addMore.browse": "浏览全部",
  "settings.connectors.page.status.paused": "已暂停",
  "settings.connectors.page.status.notWorking": "无法工作",
  "settings.connectors.page.status.signInExpired": "登录已过期",
  "settings.connectors.page.status.on": "开",
  "settings.connectors.page.status.off": "关",
  "settings.connectors.page.paused": "已暂停",
  "settings.connectors.page.open": "打开{name}",
  "settings.connectors.page.manage": "管理",
  "settings.connectors.page.fix.seeWhy": "查看原因",
  "settings.connectors.page.row.never": "尚未使用",
  "settings.connectors.page.row.lastUsed": "{when}使用过",
  "settings.connectors.page.row.unverified": "未验证",
  "settings.connectors.page.row.local": "在这台 Mac 上运行",
  "settings.connectors.page.row.remote": "通过网络连接",
  "settings.connectors.page.row.files":
    "{count, plural, =0 {未共享文件夹} other {已共享 # 个文件夹}}",
  "settings.connectors.page.row.terminal.on": "可以运行命令",
  "settings.connectors.page.row.terminal.off": "命令已关闭",
  "settings.connectors.page.detail.label": "{name}详情",
  "settings.connectors.page.detail.about": "关于",
  "settings.connectors.page.detail.access": "访问",
  "settings.connectors.page.detail.source": "来源",
  "settings.connectors.page.detail.technical": "技术详情",
  "settings.connectors.page.detail.manage": "暂停或移除",
  "settings.connectors.page.detail.type": "类型",
  "settings.connectors.page.detail.removeHint":
    "“断开连接”会暂停它并保留其设置。“移除”会将其删除。",
  "settings.connectors.page.source.builtIn": "内置于 Psyche",
  "settings.connectors.page.source.verified": "已验证的发布者",
  "settings.connectors.page.source.unverified": "尚未经任何人检查",
  "settings.connectors.page.attention.signIn":
    "你在{name}的登录已过期。请重新登录，它才能继续工作。",
  "settings.connectors.page.attention.error":
    "{name}目前无法正常工作。请尝试重新登录；若仍然失败，请移除后重新添加。",
  "settings.connectors.page.attention.errorReason": "它的反馈：{reason}",
  "settings.connectors.page.attention.server": "{name}没有启动，因此它的工具不可用。",
  "settings.connectors.page.attention.serverHint":
    "请检查下方的命令或地址以及任何密钥，然后将其关闭再重新开启。",
  "settings.connectors.page.server.local": "在这台 Mac 的沙盒中运行的工具",
  "settings.connectors.page.server.remote": "通过网址访问的工具",
  "settings.connectors.page.server.network": "可访问网络",
  "settings.connectors.page.server.noNetwork": "无网络",
  "settings.connectors.page.advanced": "高级",
  "settings.connectors.page.advanced.hint": "你自己的工具服务器，以及对公共注册表的搜索。",
  "settings.connectors.page.advanced.custom": "你自己的工具服务器",
  "settings.connectors.page.advanced.customHint":
    "在沙盒中运行任何 MCP 服务器，或通过网址连接一个。",
  "settings.connectors.page.advanced.customAction": "添加服务器",
  "settings.connectors.page.advanced.find": "在线查找服务器",
  "settings.connectors.page.gallery.title": "添加连接器",
  "settings.connectors.page.gallery.intro":
    "选一个试试。每一个在执行任何操作前都会询问，你可以随时移除。",
  "settings.connectors.page.gallery.noMatch": "没有匹配的结果。换个词试试。",
  "settings.connectors.page.gallery.back": "返回图库",
  "settings.connectors.page.gallery.community": "社区",
};
