import type { Catalogue } from "../../index.ts";

/** Password presence on Linux (ar); merged into `../ar.ts`. */
export const passwordPresence: Partial<Catalogue> = {
  "blocks.approval.password.needsAuth": "يتطلب كلمة المرور أو مفتاح مرور للموافقة.",
  "blocks.approval.password.waiting": "اكتب كلمة المرور في مربع حوار النظام للموافقة على {code}",
  "blocks.approval.password.waitingShort": "في انتظار كلمة المرور…",
  "blocks.approval.password.onceOnly": "الموافقات بكلمة المرور من هذه النافذة تُمنح مرة واحدة فقط.",
  "blocks.approval.status.allowedOncePassword":
    "سُمح مرة واحدة (الموافقات بكلمة المرور من هذه النافذة تُمنح مرة واحدة فقط)",
  "blocks.approval.password.noUnsandboxed":
    "لا يمكن الموافقة على تشغيل أمر بدون صندوق الحماية بكلمة المرور من هذه النافذة. أعدّ صندوق الحماية بدلاً من ذلك",
  "blocks.approval.password.failed":
    "لم تُقبل كلمة المرور، لذا لم تتم الموافقة على شيء. حاول مرة أخرى.",
  "blocks.approval.password.unavailableHere": "وافق من هذا الكمبيوتر، أو بمفتاح مرور من جهاز آخر.",
  "blocks.approval.password.agentMissing":
    "لا يتوفر مربع حوار لكلمة المرور على سطح المكتب هذا. ثبّت وكيل polkit مثل polkit-gnome أو lxpolkit، أو استخدم مفتاح مرور.",
  "blocks.approval.password.policyMissing":
    "لم تُثبَّت سياسة كلمة المرور الخاصة بـ Psyche على هذا الكمبيوتر. شغّل الإعداد لمرة واحدة لـ Psyche، أو استخدم مفتاح مرور.",
  "blocks.approval.password.notEnforced":
    "توجد قاعدة polkit على هذا الكمبيوتر تسمح لـ Psyche بدون كلمة مرور، لذا لا يمكنه التأكد أنك أنت. أزل القاعدة، أو استخدم مفتاح مرور.",
  "blocks.approval.password.unreachable":
    "خدمة كلمات المرور في النظام غير متاحة. حاول مرة أخرى، أو استخدم مفتاح مرور.",
  "settings.devices.password.title": "الموافقات بكلمة المرور",
  "settings.devices.password.description":
    "قبل الموافقة على إجراء حساس، يطلب Psyche كلمة المرور في مربع حوار النظام نفسه. لا تصل كلمة المرور إلى Psyche أبدًا.",
  "settings.devices.password.state.ready": "جاهز",
  "settings.devices.password.state.policyMissing": "السياسة غير مثبتة",
  "settings.devices.password.state.notEnforced": "متوقف",
  "settings.devices.password.state.noSession": "لا توجد جلسة سطح مكتب",
  "settings.devices.password.state.agentMissing": "لا يوجد مربع حوار لكلمة المرور",
  "settings.devices.password.state.unavailable": "غير متاح",
  "settings.devices.password.detail.ready":
    "يطلب Psyche كلمة المرور في مربع حوار النظام عند الموافقة على إجراء حساس.",
  "settings.devices.password.detail.policyMissing":
    "لم تُثبَّت سياسة كلمة المرور الخاصة بـ Psyche على هذا الكمبيوتر. شغّل الإعداد لمرة واحدة لـ Psyche.",
  "settings.devices.password.detail.notEnforced":
    "توجد قاعدة polkit على هذا الكمبيوتر تسمح لـ Psyche بدون كلمة مرور. الموافقات بكلمة المرور متوقفة إلى أن تُزال.",
  "settings.devices.password.detail.noSession":
    "تحتاج الموافقات بكلمة المرور إلى جلسة سطح مكتب نشطة على هذا الكمبيوتر. افتح Psyche هناك.",
  "settings.devices.password.detail.agentMissing":
    "لا يتوفر مربع حوار لكلمة المرور على سطح المكتب هذا. ثبّت وكيل polkit مثل polkit-gnome أو lxpolkit.",
  "settings.devices.password.detail.unavailable":
    "تعذّر على Psyche الوصول إلى خدمة كلمات المرور في النظام.",
  "settings.devices.password.x11Warning":
    "هذه جلسة X11. يمكن لبرامج أخرى قراءة ما تكتبه هنا، لذا فكلمة المرور مجرد عائق بسيط وليست حدًا أمنيًا. جلسة Wayland أكثر أمانًا.",
};
