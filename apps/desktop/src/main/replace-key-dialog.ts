/**
 * The native confirmation before main forwards `confirmReplacesKeyId` (security §10): a renderer
 * click alone must not replace a registered Touch ID key, and `confirmReplacesKeyId` is only an
 * accident guard any admin caller can satisfy. This box comes from main, outside the renderer, and
 * names both key ids. Main has no message catalogue (packages/ui owns it), so the ten languages the
 * app ships live here, picked by the OS locale.
 */
export interface ReplaceKeyText {
  title: string;
  /** `{previous}` and `{next}` are replaced with the short key ids. */
  message: string;
  replace: string;
  cancel: string;
}

const EN: ReplaceKeyText = {
  title: "Replace the Touch ID key?",
  message:
    "This replaces the Touch ID key {previous} registered for this Mac with the new key {next}. Only continue if you reset the key yourself.",
  replace: "Replace key",
  cancel: "Cancel",
};

export const REPLACE_KEY_TEXT: Record<string, ReplaceKeyText> = {
  en: EN,
  zh: {
    title: "要替换 Touch ID 密钥吗？",
    message:
      "这将用新密钥 {next} 替换已为这台 Mac 注册的 Touch ID 密钥 {previous}。仅当你自己重置了密钥时才继续。",
    replace: "替换密钥",
    cancel: "取消",
  },
  ar: {
    title: "استبدال مفتاح Touch ID؟",
    message:
      "سيستبدل هذا مفتاح Touch ID ‏{previous} المسجَّل لهذا الـ Mac بالمفتاح الجديد {next}. تابع فقط إذا أعدت تعيين المفتاح بنفسك.",
    replace: "استبدال المفتاح",
    cancel: "إلغاء",
  },
  fr: {
    title: "Remplacer la clé Touch ID ?",
    message:
      "Cela remplace la clé Touch ID {previous} enregistrée pour ce Mac par la nouvelle clé {next}. Ne continuez que si vous avez réinitialisé la clé vous-même.",
    replace: "Remplacer la clé",
    cancel: "Annuler",
  },
  it: {
    title: "Sostituire la chiave Touch ID?",
    message:
      "Questo sostituisce la chiave Touch ID {previous} registrata per questo Mac con la nuova chiave {next}. Continua solo se hai reimpostato tu la chiave.",
    replace: "Sostituisci la chiave",
    cancel: "Annulla",
  },
  ja: {
    title: "Touch IDキーを置き換えますか？",
    message:
      "このMacに登録されているTouch IDキー {previous} を新しいキー {next} に置き換えます。自分でキーをリセットした場合にだけ続けてください。",
    replace: "キーを置き換える",
    cancel: "キャンセル",
  },
  de: {
    title: "Touch-ID-Schlüssel ersetzen?",
    message:
      "Dies ersetzt den für diesen Mac registrierten Touch-ID-Schlüssel {previous} durch den neuen Schlüssel {next}. Fahre nur fort, wenn du den Schlüssel selbst zurückgesetzt hast.",
    replace: "Schlüssel ersetzen",
    cancel: "Abbrechen",
  },
  hi: {
    title: "Touch ID कुंजी बदलें?",
    message:
      "यह इस Mac के लिए पंजीकृत Touch ID कुंजी {previous} को नई कुंजी {next} से बदल देगा। केवल तभी आगे बढ़ें जब आपने कुंजी खुद रीसेट की हो।",
    replace: "कुंजी बदलें",
    cancel: "रद्द करें",
  },
  ko: {
    title: "Touch ID 키를 바꿀까요?",
    message:
      "이 Mac에 등록된 Touch ID 키 {previous}을(를) 새 키 {next}(으)로 바꿉니다. 직접 키를 초기화한 경우에만 계속하세요.",
    replace: "키 바꾸기",
    cancel: "취소",
  },
  pt: {
    title: "Substituir a chave do Touch ID?",
    message:
      "Isto substitui a chave do Touch ID {previous} registrada para este Mac pela nova chave {next}. Continue somente se você mesmo redefiniu a chave.",
    replace: "Substituir a chave",
    cancel: "Cancelar",
  },
  es: {
    title: "¿Reemplazar la clave de Touch ID?",
    message:
      "Esto reemplaza la clave de Touch ID {previous} registrada para este Mac por la clave nueva {next}. Continúa solo si restableciste la clave tú.",
    replace: "Reemplazar la clave",
    cancel: "Cancelar",
  },
};

export function replaceKeyText(locale: string): ReplaceKeyText {
  const lang = locale.toLowerCase().split(/[-_]/)[0] ?? "en";
  return REPLACE_KEY_TEXT[lang] ?? EN;
}

/** `0123 4567 89ab cdef …`, so the owner can compare it with the Settings page. */
function shortId(id: string): string {
  return `${(id.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ")} …`;
}

export type MessageBoxLike = (options: {
  type: "warning";
  buttons: string[];
  defaultId: number;
  cancelId: number;
  message: string;
  detail: string;
}) => Promise<{ response: number }>;

/** Asks the owner natively; true only when they chose Replace. */
export async function confirmReplaceKey(
  show: MessageBoxLike,
  locale: string,
  previousKeyId: string,
  nextKeyId: string,
): Promise<boolean> {
  const text = replaceKeyText(locale);
  const box = await show({
    type: "warning",
    buttons: [text.cancel, text.replace],
    defaultId: 0,
    cancelId: 0,
    message: text.title,
    detail: text.message
      .replace("{previous}", shortId(previousKeyId))
      .replace("{next}", shortId(nextKeyId)),
  });
  return box.response === 1;
}
