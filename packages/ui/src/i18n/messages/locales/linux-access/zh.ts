import type { Catalogue } from "../../index.ts";

/** Linux access in Settings → Computer use (zh); merged into `../zh.ts`. */
export const linuxAccess: Partial<Catalogue> = {
  "settings.computerUse.linux.screen.name": "屏幕与输入访问",
  "settings.computerUse.linux.screen.allowed": "允许，直到你撤销",
  "settings.computerUse.linux.screen.asks": "首次使用时询问",
  "settings.computerUse.linux.screen.notNeeded": "X11 上无需此项",
  "settings.computerUse.linux.screen.unavailable": "不可用",
  "settings.computerUse.linux.screen.why":
    "{persona} 通过桌面的权限对话框查看你的屏幕，并使用鼠标和键盘。你只需批准一次。",
  "settings.computerUse.linux.revoke": "撤销",
  "settings.computerUse.linux.revokeLabel": "撤销屏幕与输入访问",
  "settings.computerUse.linux.warning.x11":
    "在 X11 上，任何应用都可以读取你的屏幕和按键，包括你批准某项操作时输入的密码。",
  "settings.computerUse.linux.warning.wlroots":
    "在此桌面上，任何应用都可以不经询问读取你的屏幕并替你输入。Psyche 无法增加确认步骤。",
  "settings.computerUse.linux.accessibility":
    "从现在起打开的应用会向 Psyche 公开其结构。已经打开的应用可能需要重启。",
  "settings.computerUse.linux.headless": "此电脑需要图形会话。请登录桌面后重试。",
};
