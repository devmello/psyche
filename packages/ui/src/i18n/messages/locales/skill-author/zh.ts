import type { Catalogue } from "../../index.ts";

/** skill-author strings (zh); merged into `../zh.ts`. */
export const skillAuthor: Partial<Catalogue> = {
  "blocks.details.skillAction": "操作",
  "blocks.details.skillActionValue":
    "{action, select, update {更改{persona}制作的技能} delete {删除{persona}制作的技能} other {添加{persona}编写的新技能}}",
  "blocks.details.name": "名称",
  "blocks.details.skillText": "指令",
  "blocks.details.skillTextView": "查看全文",
  "settings.skills.madeByAgent": "由{persona}制作",
  "settings.skills.history": "{n, plural, other {# 个早期版本}}",
  "settings.skills.historyItem":
    "v{version} · {approved}批准 · {retiredBy, select, delete {已删除} other {已替换}}于{retired}",
  "settings.skills.historyHint": "仅供参考保留，这些版本绝不会载入。",
};
