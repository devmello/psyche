import type { Catalogue } from "../../index.ts";

/** skill-author strings (ar); merged into `../ar.ts`. */
export const skillAuthor: Partial<Catalogue> = {
  "blocks.details.skillAction": "الإجراء",
  "blocks.details.skillActionValue":
    "{action, select, update {تغيير مهارة صنعها {persona}} delete {حذف مهارة صنعها {persona}} other {إضافة مهارة جديدة كتبها {persona}}}",
  "blocks.details.name": "الاسم",
  "blocks.details.skillText": "التعليمات",
  "blocks.details.skillTextView": "عرض النص الكامل",
  "settings.skills.madeByAgent": "صنعها {persona}",
  "settings.skills.history":
    "{n, plural, zero {لا إصدارات سابقة} one {إصدار سابق واحد} two {إصداران سابقان} few {# إصدارات سابقة} many {# إصدارًا سابقًا} other {# إصدار سابق}}",
  "settings.skills.historyItem":
    "v{version} · وُوفق عليه {approved} · {retiredBy, select, delete {حُذف} other {استُبدل}} {retired}",
  "settings.skills.historyHint": "محفوظة للرجوع إليها. لا تُحمَّل هذه الإصدارات أبدًا.",
};
