import type { Catalogue } from "../../index.ts";

/** self-connectors strings (ar); merged into `../ar.ts`. */
export const selfConnectors: Partial<Catalogue> = {
  "settings.mcp.madeBy": "صنعه Psyche",
  "settings.mcp.madeByHint":
    "كتب Psyche شيفرة هذا الموصّل. ويعمل داخل البيئة المعزولة فقط، وبالشيفرة التي وافقت عليها فقط، وتسأل أدواته قبل تغيير أي شيء.",
  "settings.mcp.code.title": "الشيفرة",
  "settings.mcp.code.view": "عرض الشيفرة",
  "settings.mcp.code.hide": "إخفاء الشيفرة",
  "settings.mcp.code.loading": "جارٍ تحميل الشيفرة…",
  "settings.mcp.code.version": "الإصدار {version} · {runtime} · يبدأ من {entry}",
  "settings.mcp.code.modified":
    "الشيفرة على القرص ليست الإصدار الذي وافقت عليه، لذا توقف هذا الموصّل حتى توافق على التغيير.",
  "settings.mcp.code.file": "{path} · {bytes} بايت",
  "settings.mcp.code.edit": "تعديل {file}",
  "settings.mcp.code.editing": "جارٍ تعديل {file}",
  "settings.mcp.code.save": "حفظ للمراجعة",
  "settings.mcp.code.saving": "جارٍ الحفظ…",
  "settings.mcp.code.cancel": "إلغاء التعديل",
  "settings.mcp.code.provided": "يوفّرها Psyche، وهي نفسها لكل موصّل",
  "settings.mcp.code.approved": "تم تحديث {name}.",
  "settings.mcp.code.denied":
    "لم تتم الموافقة على التغيير في {name}. يبقى متوقفًا حتى توافق على تغيير.",
  "blocks.details.connector.runtime": "يعمل",
  "blocks.details.connector.runtimeValue": "كتب {persona} هذا الموصّل (الإصدار {version})",
  "blocks.details.connector.command": "الأمر",
  "blocks.details.connector.network": "يطلب الوصول إلى",
  "blocks.details.connector.networkNone": "بلا شبكة",
  "blocks.details.connector.tools": "الأدوات",
  "blocks.details.connector.files": "الشيفرة ({n} ملفات)",
  "blocks.details.connector.file": "{path} ({bytes} بايت)",
  "blocks.details.connector.provided": "يوفّرها Psyche",
  "blocks.details.connector.diff": "التغييرات منذ الإصدار {version}",
  "blocks.details.connector.suggested": "يقترح {persona} هذا الموصّل من السجل",
};
