import type { Catalogue } from "../../index.ts";

/** Memory map strings (ar); merged into `../ar.ts`. */
export const memoryMap: Partial<Catalogue> = {
  "memory.page.view.map": "خريطة",
  "memory.map.title": "خريطة الذاكرة",
  "memory.map.canvasLabel":
    "خريطة تضم {nodes, plural, zero {لا عناصر} one {عنصرًا واحدًا} two {عنصرين} few {# عناصر} many {# عنصرًا} other {# عنصر}} و{links, plural, zero {لا روابط} one {رابطًا واحدًا} two {رابطين} few {# روابط} many {# رابطًا} other {# رابط}}. اسحب للتحريك، ومرّر أو اقرص للتكبير، واستخدم مفاتيح الأسهم للتنقل.",
  "memory.map.loading": "جارٍ تحميل الخريطة",
  "memory.map.loadFailed": "تعذّر تحميل خريطة الذاكرة.",
  "memory.map.empty":
    "لا شيء لعرضه بعد. كلما تعرّف Psyche على الأشخاص والمشاريع والموضوعات في حياتك ظهرت هنا مترابطة.",
  "memory.map.sparse":
    "الروابط قليلة حتى الآن. ستظهر المزيد عندما يشاركك الأشخاص مشاريع واجتماعات ومحادثات.",
  "memory.map.truncated": "يتم عرض أهم {shown} من أصل {total}.",
  "memory.map.search": "البحث في الخريطة",
  "memory.map.search.placeholder": "ابحث عن شخص أو مشروع أو موضوع",
  "memory.map.search.results": "النتائج",
  "memory.map.search.none": "لا شيء في الخريطة يطابق «{q}».",
  "memory.map.filters": "إظهار على الخريطة",
  "memory.map.group.people": "الأشخاص",
  "memory.map.group.projects": "المشاريع",
  "memory.map.group.events": "الأحداث",
  "memory.map.group.topics": "الموضوعات",
  "memory.map.group.other": "الأماكن والمؤسسات",
  "memory.map.quiet":
    "{n, plural, zero {لا أحد انقطع التواصل معه} one {شخص انقطع التواصل معه} two {شخصان انقطع التواصل معهما} few {# أشخاص انقطع التواصل معهم} many {# شخصًا انقطع التواصل معهم} other {# شخص انقطع التواصل معهم}}",
  "memory.map.kind.person": "شخص",
  "memory.map.kind.org": "مؤسسة",
  "memory.map.kind.project": "مشروع",
  "memory.map.kind.place": "مكان",
  "memory.map.kind.event": "حدث",
  "memory.map.kind.topic": "موضوع",
  "memory.map.kind.assignment": "عنصر عمل",
  "memory.map.edge.works_on": "يعمل على",
  "memory.map.edge.met_in": "التقيا في",
  "memory.map.edge.co_mentioned": "ذُكرا معًا",
  "memory.map.edge.related": "ذو صلة",
  "memory.map.legend": "الروابط",
  "memory.map.zoomIn": "تكبير",
  "memory.map.zoomOut": "تصغير",
  "memory.map.fit": "ملاءمة العرض",
  "memory.map.focus.showing":
    "{name} و{n, plural, =0 {لا اتصالات} zero {لا اتصالات} one {اتصال واحد} two {اتصالان} few {# اتصالات} many {# اتصالًا} other {# اتصال}}",
  "memory.map.focus.clear": "إظهار الكل",
  "memory.map.card.connections":
    "{n, plural, =0 {لا روابط} zero {لا روابط} one {رابط واحد} two {رابطان} few {# روابط} many {# رابطًا} other {# رابط}}",
  "memory.map.card.quiet": "انقطع التواصل",
  "memory.map.card.private": "خاص",
  "memory.map.card.open": "فتح",
  "memory.map.card.focus": "التركيز هنا",
  "memory.map.card.hint": "انقر للفتح. انقر مع Shift للتركيز هنا.",
  "memory.map.list.label": "عناصر الخريطة، الأهم أولًا",
};
