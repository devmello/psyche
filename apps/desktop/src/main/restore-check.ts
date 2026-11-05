import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * "I put my data back myself" (the start-up screen, after a restore of the pre-update data that
 * the Gateway could not finish). The button forgets that restore and lets the Gateway start, and
 * a Gateway that finds no main database starts a new empty one. So before anything is cleared,
 * check that the owner's data is really there, then ask in a native dialog the page cannot
 * click or draw.
 */

const SIDE_FILES: ReadonlySet<string> = new Set([
  "config.json",
  "vault/slots.json",
  "state/memory.key.json",
  "state/memory.key.escrow.json",
  "state/search.key.json",
]);

export type RestoreCheck =
  | { ok: true }
  | { ok: false; reason: "no_note" | "no_marker" | "unreadable" | "missing"; missing: string[] };

/** Whether the data an unfinished restore was putting back is all in place now. */
export function checkRestoredByHand(home: string): RestoreCheck {
  const read = (rel: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(home, rel), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return null;
    }
  };
  const note = read("run/update-failed.json") as { key?: unknown } | undefined | null;
  if (note === undefined || note === null || note.key !== "restore-interrupted")
    return { ok: false, reason: "no_note", missing: [] };
  const marker = read("run/restore-in-progress.json") as
    | { snapshot?: unknown; onlyDatabases?: unknown }
    | undefined
    | null;
  if (marker === undefined) return { ok: false, reason: "no_marker", missing: [] };
  if (marker === null || typeof marker.snapshot !== "string")
    return { ok: false, reason: "unreadable", missing: [] };
  const root = resolve(home, "backups", "pre-update");
  const inside = relative(root, resolve(marker.snapshot));
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside))
    return { ok: false, reason: "unreadable", missing: [] };
  let manifest: { entries?: { rel?: unknown; abs?: unknown }[] };
  try {
    manifest = JSON.parse(readFileSync(join(marker.snapshot, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, reason: "unreadable", missing: [] };
  }
  if (!Array.isArray(manifest.entries)) return { ok: false, reason: "unreadable", missing: [] };
  const missing: string[] = [];
  for (const e of manifest.entries) {
    if (typeof e.rel !== "string") return { ok: false, reason: "unreadable", missing: [] };
    const abs = typeof e.abs === "string" ? e.abs : undefined;
    if (marker.onlyDatabases === true && abs === undefined && SIDE_FILES.has(e.rel)) continue;
    if (!existsSync(abs ?? join(home, e.rel))) missing.push(e.rel);
  }
  return missing.length > 0 ? { ok: false, reason: "missing", missing } : { ok: true };
}

export interface RestoreDialogStrings {
  refuseTitle: string;
  /** `{files}` is the list of what is missing. */
  refuseMissing: string;
  refuseNothing: string;
  confirmTitle: string;
  confirmBody: string;
  confirmButton: string;
  cancel: string;
}

/** The dialog's words in every language Psyche ships (the main process has no UI catalogue). */
export const RESTORE_DIALOG: Record<string, RestoreDialogStrings> = {
  en: {
    refuseTitle: "Your data isn't all back yet",
    refuseMissing:
      "These files are still missing: {files}. Put them back from backups/pre-update in Psyche's data folder, then try again.",
    refuseNothing:
      "Psyche isn't waiting for you to restore anything, so there is nothing to confirm.",
    confirmTitle: "Start Psyche with the files that are there now?",
    confirmBody:
      "Psyche will start with exactly what is in its data folder right now. Only go on if you have put your data back yourself.",
    confirmButton: "Start with my files",
    cancel: "Cancel",
  },
  ar: {
    refuseTitle: "لم تعد بياناتك كلها بعد",
    refuseMissing:
      "ما زالت هذه الملفات مفقودة: {files}. أعدها من backups/pre-update في مجلد بيانات Psyche، ثم حاول مرة أخرى.",
    refuseNothing: "Psyche لا ينتظر منك استعادة أي شيء، فلا يوجد ما يلزم تأكيده.",
    confirmTitle: "هل تريد تشغيل Psyche بالملفات الموجودة الآن؟",
    confirmBody:
      "سيبدأ Psyche بما هو موجود الآن في مجلد بياناته بالضبط. تابع فقط إن كنت قد أعدت بياناتك بنفسك.",
    confirmButton: "ابدأ بملفاتي",
    cancel: "إلغاء",
  },
  de: {
    refuseTitle: "Deine Daten sind noch nicht vollständig zurück",
    refuseMissing:
      "Diese Dateien fehlen noch: {files}. Spiele sie aus backups/pre-update im Datenordner von Psyche zurück und versuche es dann erneut.",
    refuseNothing:
      "Psyche wartet nicht darauf, dass du etwas wiederherstellst, es gibt also nichts zu bestätigen.",
    confirmTitle: "Psyche mit den Dateien starten, die jetzt da sind?",
    confirmBody:
      "Psyche startet mit genau dem, was jetzt in seinem Datenordner liegt. Mach nur weiter, wenn du deine Daten selbst zurückgespielt hast.",
    confirmButton: "Mit meinen Dateien starten",
    cancel: "Abbrechen",
  },
  es: {
    refuseTitle: "Tus datos aún no están completos",
    refuseMissing:
      "Aún faltan estos archivos: {files}. Devuélvelos desde backups/pre-update en la carpeta de datos de Psyche y vuelve a intentarlo.",
    refuseNothing:
      "Psyche no está esperando a que restaures nada, así que no hay nada que confirmar.",
    confirmTitle: "¿Iniciar Psyche con los archivos que hay ahora?",
    confirmBody:
      "Psyche se iniciará exactamente con lo que hay ahora en su carpeta de datos. Continúa solo si has devuelto tus datos tú mismo.",
    confirmButton: "Iniciar con mis archivos",
    cancel: "Cancelar",
  },
  fr: {
    refuseTitle: "Vos données ne sont pas encore toutes revenues",
    refuseMissing:
      "Ces fichiers manquent encore : {files}. Remettez-les depuis backups/pre-update dans le dossier de données de Psyche, puis réessayez.",
    refuseNothing:
      "Psyche n’attend pas que vous restauriez quoi que ce soit : il n’y a rien à confirmer.",
    confirmTitle: "Démarrer Psyche avec les fichiers présents maintenant ?",
    confirmBody:
      "Psyche démarrera avec exactement ce qui se trouve maintenant dans son dossier de données. Continuez seulement si vous avez remis vos données vous-même.",
    confirmButton: "Démarrer avec mes fichiers",
    cancel: "Annuler",
  },
  hi: {
    refuseTitle: "आपका डेटा अभी पूरा वापस नहीं आया है",
    refuseMissing:
      "ये फ़ाइलें अभी भी गायब हैं: {files}। इन्हें Psyche के डेटा फ़ोल्डर में backups/pre-update से वापस रखें, फिर दोबारा कोशिश करें।",
    refuseNothing: "Psyche आपसे कुछ भी वापस रखने की प्रतीक्षा नहीं कर रहा, इसलिए पुष्टि करने को कुछ नहीं है।",
    confirmTitle: "जो फ़ाइलें अभी मौजूद हैं, उनके साथ Psyche शुरू करें?",
    confirmBody:
      "Psyche ठीक वही लेकर शुरू होगा जो अभी उसके डेटा फ़ोल्डर में है। तभी आगे बढ़ें जब आपने अपना डेटा खुद वापस रख दिया हो।",
    confirmButton: "मेरी फ़ाइलों के साथ शुरू करें",
    cancel: "रद्द करें",
  },
  it: {
    refuseTitle: "I tuoi dati non sono ancora tornati tutti",
    refuseMissing:
      "Questi file mancano ancora: {files}. Rimettili da backups/pre-update nella cartella dei dati di Psyche, poi riprova.",
    refuseNothing:
      "Psyche non sta aspettando che tu ripristini qualcosa, quindi non c’è nulla da confermare.",
    confirmTitle: "Avviare Psyche con i file che ci sono ora?",
    confirmBody:
      "Psyche partirà esattamente con ciò che si trova ora nella sua cartella dei dati. Procedi solo se hai rimesso i dati a posto da solo.",
    confirmButton: "Avvia con i miei file",
    cancel: "Annulla",
  },
  ja: {
    refuseTitle: "データがまだすべて戻っていません",
    refuseMissing:
      "次のファイルがまだありません: {files}。Psycheのデータフォルダ内のbackups/pre-updateから戻してから、もう一度お試しください。",
    refuseNothing: "Psycheは復元を待っていないため、確認することはありません。",
    confirmTitle: "今あるファイルでPsycheを開始しますか?",
    confirmBody:
      "Psycheは、今データフォルダにあるものだけで開始します。ご自身でデータを戻した場合にのみ続けてください。",
    confirmButton: "このファイルで開始",
    cancel: "キャンセル",
  },
  ko: {
    refuseTitle: "데이터가 아직 모두 돌아오지 않았습니다",
    refuseMissing:
      "다음 파일이 아직 없습니다: {files}. Psyche 데이터 폴더의 backups/pre-update에서 되돌려 놓은 다음 다시 시도하십시오.",
    refuseNothing: "Psyche는 복원을 기다리고 있지 않으므로 확인할 것이 없습니다.",
    confirmTitle: "지금 있는 파일로 Psyche를 시작하시겠습니까?",
    confirmBody:
      "Psyche는 지금 데이터 폴더에 있는 것만으로 시작합니다. 직접 데이터를 되돌려 놓으신 경우에만 계속하십시오.",
    confirmButton: "내 파일로 시작",
    cancel: "취소",
  },
  pt: {
    refuseTitle: "Seus dados ainda não voltaram por completo",
    refuseMissing:
      "Estes arquivos ainda estão faltando: {files}. Coloque-os de volta a partir de backups/pre-update na pasta de dados do Psyche e tente novamente.",
    refuseNothing:
      "O Psyche não está esperando que você restaure nada, então não há nada a confirmar.",
    confirmTitle: "Iniciar o Psyche com os arquivos que estão lá agora?",
    confirmBody:
      "O Psyche vai iniciar exatamente com o que está agora na pasta de dados. Continue só se você mesmo colocou seus dados de volta.",
    confirmButton: "Iniciar com meus arquivos",
    cancel: "Cancelar",
  },
  zh: {
    refuseTitle: "你的数据还没有全部恢复",
    refuseMissing:
      "这些文件仍然缺失：{files}。请从 Psyche 数据文件夹中的 backups/pre-update 放回它们，然后再试一次。",
    refuseNothing: "Psyche 并没有在等你恢复任何东西，因此没有什么需要确认的。",
    confirmTitle: "用现在已有的文件启动 Psyche 吗？",
    confirmBody: "Psyche 将完全使用其数据文件夹中现有的内容启动。只有在你已自行放回数据时才继续。",
    confirmButton: "用我的文件启动",
    cancel: "取消",
  },
};

export function restoreDialogStrings(locale: string): RestoreDialogStrings {
  const lang = locale.toLowerCase().split(/[-_]/)[0] ?? "en";
  return RESTORE_DIALOG[lang] ?? (RESTORE_DIALOG.en as RestoreDialogStrings);
}

export interface RestoreGuardUi {
  /** A message with one button. */
  refuse(title: string, body: string): Promise<void>;
  /** The native confirmation; true when the owner chose to go on. */
  confirm(s: RestoreDialogStrings): Promise<boolean>;
}

/**
 * Whether "I put my data back myself" may go ahead: only when the unfinished restore is really
 * there, every file it was putting back exists, and the owner confirms in a native dialog.
 * Refusals say which files are missing.
 */
export async function guardRestoredByHand(
  home: string,
  ui: RestoreGuardUi,
  locale: string,
): Promise<boolean> {
  const s = restoreDialogStrings(locale);
  const check = checkRestoredByHand(home);
  if (!check.ok) {
    await ui.refuse(
      s.refuseTitle,
      check.reason === "missing"
        ? s.refuseMissing.replace("{files}", check.missing.slice(0, 6).join(", "))
        : s.refuseNothing,
    );
    return false;
  }
  return ui.confirm(s);
}
