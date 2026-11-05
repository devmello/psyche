import type { Catalogue } from "../../index.ts";

/** agent-notes strings (zh); merged into `../zh.ts`. */
export const agentNotes: Partial<Catalogue> = {
  "agent.notes.title": "{name}记下的内容",
  "agent.notes.hint":
    "{name}为日后使用而保存的内容：哪些做法有效、工具的怪癖、你喜欢怎么做。不想保留的可以删除。",
  "agent.notes.empty": "还没有记录。",
  "agent.notes.updated": "更新于 {date}",
  "agent.notes.delete": "删除备注 {file}",
  "agent.notes.deleteTitle": "删除这条备注？",
  "agent.notes.deleteBody": "{file} 将从{name}的记忆中移除，此操作无法撤销。",
  "agent.notes.source.agent": "由代理记录",
  "agent.notes.source.untrusted": "来自不可信内容，从不使用",
  "agent.notes.source.owner": "由你编辑",
  "agent.notes.source.system": "系统",
};
