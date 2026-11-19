import type { Catalogue } from "../../index.ts";

/** Password presence on Linux (zh); merged into `../zh.ts`. */
export const passwordPresence: Partial<Catalogue> = {
  "blocks.approval.password.needsAuth": "需要您的密码或通行密钥才能批准。",
  "blocks.approval.password.waiting": "请在系统对话框中输入密码以批准 {code}",
  "blocks.approval.password.waitingShort": "正在等待您输入密码…",
  "blocks.approval.password.onceOnly": "从此窗口用密码批准仅限一次。",
  "blocks.approval.status.allowedOncePassword": "已允许一次（从此窗口用密码批准仅限一次）",
  "blocks.approval.password.noUnsandboxed":
    "不使用沙盒运行命令，无法在此窗口用密码批准。请改为设置沙盒",
  "blocks.approval.password.failed": "密码未被接受，因此没有批准任何内容。请重试。",
  "blocks.approval.password.unavailableHere": "请在此电脑上批准，或使用另一台设备上的通行密钥。",
  "blocks.approval.password.agentMissing":
    "此桌面没有可用的密码对话框。请安装 polkit-gnome 或 lxpolkit 等 polkit 代理，或使用通行密钥。",
  "blocks.approval.password.policyMissing":
    "此电脑上未安装 Psyche 的密码策略。请运行 Psyche 的一次性设置，或使用通行密钥。",
  "blocks.approval.password.notEnforced":
    "此电脑上的 polkit 规则无需密码就批准 Psyche，因此无法确认是您本人。请删除该规则，或使用通行密钥。",
  "blocks.approval.password.unreachable": "系统的密码服务不可用。请重试，或使用通行密钥。",
  "settings.devices.password.title": "密码批准",
  "settings.devices.password.description":
    "批准敏感操作之前，Psyche 会在系统自己的对话框中请求您的密码。密码绝不会传给 Psyche。",
  "settings.devices.password.state.ready": "就绪",
  "settings.devices.password.state.policyMissing": "策略未安装",
  "settings.devices.password.state.notEnforced": "已关闭",
  "settings.devices.password.state.noSession": "没有桌面会话",
  "settings.devices.password.state.agentMissing": "没有密码对话框",
  "settings.devices.password.state.unavailable": "不可用",
  "settings.devices.password.detail.ready": "批准敏感操作时，Psyche 会在系统对话框中请求您的密码。",
  "settings.devices.password.detail.policyMissing":
    "此电脑上未安装 Psyche 的密码策略。请运行 Psyche 的一次性设置。",
  "settings.devices.password.detail.notEnforced":
    "此电脑上的 polkit 规则无需密码就批准 Psyche。在删除该规则之前，密码批准处于关闭状态。",
  "settings.devices.password.detail.noSession":
    "密码批准需要此电脑上有活动的桌面会话。请在那里打开 Psyche。",
  "settings.devices.password.detail.agentMissing":
    "此桌面没有可用的密码对话框。请安装 polkit-gnome 或 lxpolkit 等 polkit 代理。",
  "settings.devices.password.detail.unavailable": "Psyche 无法连接系统的密码服务。",
  "settings.devices.password.x11Warning":
    "这是 X11 会话。其他程序可以读取您在这里输入的内容，因此密码只是减速带，而不是屏障。Wayland 会话更安全。",
};
