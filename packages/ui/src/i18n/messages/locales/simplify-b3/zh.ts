import type { Catalogue } from "../../index.ts";

/** Onboarding finish, recovery key and searchable switch (zh); merged into `../zh.ts`. */
export const simplifyB3: Partial<Catalogue> = {
  "onboarding.done.start": "开始聊天",
  "onboarding.done.psycheLabel": "Psyche",
  "onboarding.done.psycheWait": "暂时无法连接 Psyche。此窗口会自动重新连接。",
  "onboarding.done.helperWait": "Psyche Helper 尚未连接。连接后，电脑操作和通知才会启动。",
  "onboarding.connectors.searchable": "让这些内容可被搜索",
  "onboarding.connectors.searchableHint":
    "{name}可以在搜索中找到这些账户里的邮件、日程和备忘录。你可以随时在设置中关闭。",
  "home.recoveryKey.title": "保存你的恢复密钥",
  "home.recoveryKey.body":
    "在还原后或丢失密钥时，它是重新进入保险库的唯一方式。请先显示它，把副本保存在安全的地方，然后确认。",
  "settings.credentials.vault.recoveryKey.show": "显示恢复密钥",
  "settings.credentials.vault.recoveryKey.hide": "隐藏",
  "settings.credentials.vault.recoveryKey.gone":
    "此保险库的恢复密钥只在创建时显示过一次，无法再次显示。",
  "settings.credentials.vault.recoveryKey.failed": "无法显示恢复密钥：{reason}",
  "settings.credentials.vault.recoveryKey.title": "恢复密钥",
  "settings.credentials.vault.recoveryKey.body":
    "在还原后或丢失密钥时，重新进入保险库的唯一方式。请把副本保存在安全的地方。",
};
