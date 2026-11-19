import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (zh); merged into `../zh.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "Psyche Helper 未连接",
  "platform.helper.offline.text":
    "邮件、备忘录、日历、提醒事项以及依赖它们的工作，将等待其重新连接。",
  "platform.helper.offline.reconnect": "重新连接",
  "platform.helper.contactsPermission": "通讯录需要在系统设置中允许 Psyche Helper 访问。",
  "platform.helper.offline.dismiss": "关闭",
  "platform.helper.choose.title": "已连接多个 Psyche Helper",
  "platform.helper.choose.text":
    "Psyche 不会替你选择，因此邮件、备忘录、日历和提醒事项已暂停。请选择在它们都连接期间使用哪一个。",
  "platform.helper.choose.use": "使用 {when} 配对的助手（…{id}）",
  "platform.helper.choose.useNoTime": "使用此助手（…{id}）",
  "platform.helper.choose.name": "自称：{name}",
  "platform.helper.choose.failed": "无法选择助手：{reason}",
};
