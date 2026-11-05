import type { Catalogue } from "../../index.ts";

/** device-access strings (ar); merged into `../ar.ts`. */
export const deviceAccess: Partial<Catalogue> = {
  "settings.deviceAccess.files.title": "الملفات على هذا الـ Mac",
  "settings.deviceAccess.files.hint":
    "المجلدات التي يجوز لـ {persona} قراءتها، وتعديلها حيثما تسمح. تشاركها من الأذونات ← الوصول.",
  "settings.deviceAccess.files.more":
    "{count, plural, zero {} one {وواحد آخر} two {واثنان آخران} few {و# آخرين} many {و# آخر} other {و# آخر}}",
  "settings.deviceAccess.open": "فتح الوصول",
  "settings.deviceAccess.terminal.title": "Terminal",
  "settings.deviceAccess.terminal.hint":
    "يستطيع {persona} تشغيل أوامر Terminal على هذا الـ Mac عندما يكون «تشغيل الأوامر على هذا الـ Mac» مفعّلًا في الأذونات ← الوصول.",
  "settings.deviceAccess.terminal.where":
    "تعمل الأوامر على جهاز Mac لديك، في المجلدات التي شاركتها، ولا تكتب إلا في مجلد شاركته للقراءة والكتابة.",
  "settings.deviceAccess.terminal.asks":
    "الأوامر التي قد تغيّر الملفات تسأل أولًا، ما لم تختر السماح دائمًا بذلك الأمر بعينه. أما أوامر القراءة الأساسية مثل ls وcat وwc فتعمل دون سؤال ما لم توقف ذلك.",
  "settings.deviceAccess.terminal.sandbox":
    "تعمل الأوامر داخل البيئة المعزولة. يُنفَّذ تشغيل واحد موافَق عليه بدونها فقط إذا كتبت UNSANDBOXED على بطاقته.",
  "settings.deviceAccess.terminal.on": "تشغيل الأوامر مفعّل",
  "settings.deviceAccess.terminal.off": "تشغيل الأوامر متوقف",
  "settings.deviceAccess.terminal.folders":
    "{count, plural, zero {لم تُشارك مجلدات بعد: لا مكان لتعمل فيه الأوامر.} one {شُورك مجلد واحد.} two {شُورك مجلدان.} few {شُوركت # مجلدات.} many {شُورك # مجلدًا.} other {شُورك # مجلد.}}",
  "settings.mcp.needs.title": "ما يحتاج إليه هذا على جهاز Mac لديك",
  "settings.mcp.needs.srt": "البيئة المعزولة (srt)",
  "settings.mcp.needs.srt.fix": "يُبعد الخادم عن بيانات Psyche الخاصة.",
  "settings.mcp.needs.node": "أدوات Node.js (npm)",
  "settings.mcp.needs.node.fix":
    "يعمل على Node الخاص بـ Psyche؛ ويحتاج إلى npm على هذا الـ Mac. ثبّت Node.js من nodejs.org، أو شغّل brew install node.",
  "settings.mcp.needs.uv": "uv (uvx)",
  "settings.mcp.needs.uv.fix":
    "خادم Python. ثبّت uv بالأمر brew install uv أو من docs.astral.sh/uv.",
  "settings.mcp.needs.network": "الشبكة",
  "settings.mcp.needs.network.fix": "يصل إلى عنوان الخادم نفسه.",
  "settings.mcp.needs.networkHosts": "يصل إلى {hosts} فقط لتنزيل الخادم وتشغيله.",
  "settings.mcp.needs.missing": "مفقود",
  "settings.mcp.needs.ready": "جاهز",
  "settings.mcp.needs.checked": "يُفحص عند «فحص الخادم»",
  "settings.mcp.fail.no_srt": "البيئة المعزولة غير مثبّتة. أعدّها أدناه ثم افحص الخادم مجددًا.",
  "settings.mcp.fail.node_missing":
    "ثبّت Node.js (nodejs.org، أو brew install node) ليتوفر npm على هذا الـ Mac، ثم تحقق مجددًا.",
  "settings.mcp.fail.uv_missing":
    "ثبّت uv (brew install uv، أو docs.astral.sh/uv) ثم افحص الخادم مجددًا.",
  "settings.mcp.fail.command_not_found":
    "أمر الخادم غير مثبّت هنا. تحقق من الأمر، أو ثبّت الأداة التي يسميها.",
  "settings.mcp.fail.network_blocked":
    "تعذّر على الخادم تنزيل ما يحتاج إليه أو الوصول إليه. تحقق من اتصالك ومن السماح بمضيفيه.",
  "settings.mcp.fail.timeout":
    "استغرق وقتًا طويلًا. التشغيل الأول ينزّل الحزمة؛ تحقق من اتصالك وحاول مجددًا.",
  "settings.mcp.fail.exited": "توقف الخادم فور بدئه. آخر مخرجاته أدناه.",
  "settings.mcp.fail.failed": "تحقق من مخرجات الخادم أدناه ثم حاول مجددًا.",
  "settings.mcp.fail.exitCode": "رمز الخروج {code}.",
  "settings.mcp.fail.output": "مخرجات الخادم",
};
