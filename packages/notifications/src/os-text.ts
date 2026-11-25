/**
 * The words of the notifications the Gateway sends straight to the OS (the Mac helper, the
 * desktop's own banner, a paired device), in every shipped UI language. The Gateway has no React
 * catalogue, so a small one lives here (like `outboundText` in @psyche/permissions), keyed by the
 * owner's `ui.language`. Missing or unknown languages read English.
 *
 * Callers keep writing the English sentence. `localizeOsText` recognises the fixed sentences below
 * by their English template and answers the translation; dynamic parts (`{title}`, a device name)
 * are inserted unchanged, and any text that matches no template is returned as it was.
 */

/** The shipped UI languages (the same list as `MESSAGE_LOCALES` in @psyche/ui). */
export const OS_TEXT_LANGUAGES = [
  "en",
  "ar",
  "de",
  "es",
  "fr",
  "hi",
  "it",
  "ja",
  "ko",
  "pt",
  "zh",
] as const;
export type OsTextLanguage = (typeof OS_TEXT_LANGUAGES)[number];

export type OsTextKey =
  | "approvalPending"
  | "reviewOnDevice"
  | "needsInput"
  | "runFailedTitle"
  | "runFailedBody"
  | "awaitingApprovalTitle"
  | "awaitingApprovalBody"
  | "injectionTitle"
  | "injectionBody"
  | "approve"
  | "deny"
  | "kindPay"
  | "kindSendEmail"
  | "kindSendMessage"
  | "kindSubmitForm"
  | "kindFillCredential"
  | "kindUseApp"
  | "kindPermission";

type Table = Record<OsTextKey, string>;

export const OS_TEXT: Readonly<Record<OsTextLanguage, Table>> = {
  en: {
    approvalPending: "Approval pending",
    reviewOnDevice: "Open Psyche on {device} to review.",
    needsInput: "The task needs your input",
    runFailedTitle: "{title} failed",
    runFailedBody: "The automation run failed",
    awaitingApprovalTitle: "{title} is waiting for your approval",
    awaitingApprovalBody:
      "It stopped because the approval ran out. Open Approvals to see what it needs, then run it again.",
    injectionTitle: "Task paused: possible injection",
    injectionBody: "Two actions were labeled prohibited. Review the task before resuming it.",
    approve: "Approve",
    deny: "Deny",
    kindPay: "Pay",
    kindSendEmail: "Send email",
    kindSendMessage: "Send message",
    kindSubmitForm: "Submit form",
    kindFillCredential: "Fill credential",
    kindUseApp: "Use app",
    kindPermission: "Permission needed",
  },
  ar: {
    approvalPending: "الموافقة معلّقة",
    reviewOnDevice: "افتح Psyche على {device} للمراجعة.",
    needsInput: "تحتاج المهمة إلى ردّك",
    runFailedTitle: "فشل {title}",
    runFailedBody: "فشل تشغيل الأتمتة",
    awaitingApprovalTitle: "{title} بانتظار موافقتك",
    awaitingApprovalBody:
      "توقفت لأن مهلة الموافقة انتهت. افتح الموافقات لترى ما تحتاجه، ثم شغّلها مرة أخرى.",
    injectionTitle: "توقفت المهمة مؤقتًا: حقن محتمل",
    injectionBody: "تم وسم إجراءين بأنهما محظوران. راجع المهمة قبل استئنافها.",
    approve: "موافقة",
    deny: "رفض",
    kindPay: "دفع",
    kindSendEmail: "إرسال بريد",
    kindSendMessage: "إرسال رسالة",
    kindSubmitForm: "إرسال نموذج",
    kindFillCredential: "تعبئة بيانات اعتماد",
    kindUseApp: "استخدام تطبيق",
    kindPermission: "مطلوب إذن",
  },
  de: {
    approvalPending: "Freigabe ausstehend",
    reviewOnDevice: "Öffne Psyche auf {device}, um es zu prüfen.",
    needsInput: "Die Aufgabe braucht deine Eingabe",
    runFailedTitle: "{title} ist fehlgeschlagen",
    runFailedBody: "Der Automations-Lauf ist fehlgeschlagen",
    awaitingApprovalTitle: "{title} wartet auf deine Freigabe",
    awaitingApprovalBody:
      "Sie wurde gestoppt, weil die Freigabe abgelaufen ist. Öffne Freigaben, um zu sehen, was sie braucht, und starte sie dann erneut.",
    injectionTitle: "Aufgabe pausiert: mögliche Injection",
    injectionBody:
      "Zwei Aktionen wurden als verboten eingestuft. Prüfe die Aufgabe, bevor du sie fortsetzt.",
    approve: "Freigeben",
    deny: "Ablehnen",
    kindPay: "Bezahlen",
    kindSendEmail: "E-Mail senden",
    kindSendMessage: "Nachricht senden",
    kindSubmitForm: "Formular absenden",
    kindFillCredential: "Zugangsdaten eintragen",
    kindUseApp: "App verwenden",
    kindPermission: "Berechtigung nötig",
  },
  es: {
    approvalPending: "Aprobación pendiente",
    reviewOnDevice: "Abre Psyche en {device} para revisarlo.",
    needsInput: "La tarea necesita tu respuesta",
    runFailedTitle: "{title} falló",
    runFailedBody: "La ejecución de la automatización falló",
    awaitingApprovalTitle: "{title} espera tu aprobación",
    awaitingApprovalBody:
      "Se detuvo porque la aprobación caducó. Abre Aprobaciones para ver qué necesita y vuelve a ejecutarla.",
    injectionTitle: "Tarea en pausa: posible inyección",
    injectionBody: "Dos acciones se marcaron como prohibidas. Revisa la tarea antes de reanudarla.",
    approve: "Aprobar",
    deny: "Denegar",
    kindPay: "Pagar",
    kindSendEmail: "Enviar correo",
    kindSendMessage: "Enviar mensaje",
    kindSubmitForm: "Enviar formulario",
    kindFillCredential: "Rellenar credencial",
    kindUseApp: "Usar app",
    kindPermission: "Se necesita permiso",
  },
  fr: {
    approvalPending: "Approbation en attente",
    reviewOnDevice: "Ouvrez Psyche sur {device} pour l’examiner.",
    needsInput: "La tâche a besoin de votre réponse",
    runFailedTitle: "{title} a échoué",
    runFailedBody: "L’exécution de l’automatisation a échoué",
    awaitingApprovalTitle: "{title} attend votre approbation",
    awaitingApprovalBody:
      "Elle s’est arrêtée car l’approbation a expiré. Ouvrez Approbations pour voir ce qu’il faut, puis relancez-la.",
    injectionTitle: "Tâche en pause : injection possible",
    injectionBody:
      "Deux actions ont été jugées interdites. Examinez la tâche avant de la reprendre.",
    approve: "Approuver",
    deny: "Refuser",
    kindPay: "Payer",
    kindSendEmail: "Envoyer un e-mail",
    kindSendMessage: "Envoyer un message",
    kindSubmitForm: "Envoyer le formulaire",
    kindFillCredential: "Saisir un identifiant",
    kindUseApp: "Utiliser une app",
    kindPermission: "Autorisation requise",
  },
  hi: {
    approvalPending: "मंज़ूरी लंबित है",
    reviewOnDevice: "समीक्षा के लिए {device} पर Psyche खोलें।",
    needsInput: "कार्य को आपके जवाब की ज़रूरत है",
    runFailedTitle: "{title} विफल रहा",
    runFailedBody: "ऑटोमेशन रन विफल रहा",
    awaitingApprovalTitle: "{title} आपकी मंज़ूरी का इंतज़ार कर रहा है",
    awaitingApprovalBody:
      "मंज़ूरी की समय-सीमा खत्म होने से यह रुक गया। ज़रूरत देखने के लिए मंज़ूरियाँ खोलें, फिर इसे दोबारा चलाएँ।",
    injectionTitle: "कार्य रोका गया: संभावित इंजेक्शन",
    injectionBody: "दो कार्रवाइयों को निषिद्ध चिह्नित किया गया। फिर से शुरू करने से पहले कार्य की समीक्षा करें।",
    approve: "मंज़ूर करें",
    deny: "अस्वीकार करें",
    kindPay: "भुगतान करें",
    kindSendEmail: "ईमेल भेजें",
    kindSendMessage: "संदेश भेजें",
    kindSubmitForm: "फ़ॉर्म जमा करें",
    kindFillCredential: "क्रेडेंशियल भरें",
    kindUseApp: "ऐप इस्तेमाल करें",
    kindPermission: "अनुमति चाहिए",
  },
  it: {
    approvalPending: "Approvazione in attesa",
    reviewOnDevice: "Apri Psyche su {device} per rivederlo.",
    needsInput: "L’attività ha bisogno di una tua risposta",
    runFailedTitle: "{title} non è riuscito",
    runFailedBody: "L’esecuzione dell’automazione non è riuscita",
    awaitingApprovalTitle: "{title} attende la tua approvazione",
    awaitingApprovalBody:
      "Si è fermata perché l’approvazione è scaduta. Apri Approvazioni per vedere cosa serve, poi eseguila di nuovo.",
    injectionTitle: "Attività in pausa: possibile injection",
    injectionBody:
      "Due azioni sono state etichettate come vietate. Controlla l’attività prima di riprenderla.",
    approve: "Approva",
    deny: "Nega",
    kindPay: "Paga",
    kindSendEmail: "Invia e-mail",
    kindSendMessage: "Invia messaggio",
    kindSubmitForm: "Invia modulo",
    kindFillCredential: "Inserisci credenziale",
    kindUseApp: "Usa app",
    kindPermission: "Serve un permesso",
  },
  ja: {
    approvalPending: "承認待ち",
    reviewOnDevice: "確認するには {device} で Psyche を開いてください。",
    needsInput: "タスクにあなたの返答が必要です",
    runFailedTitle: "{title} に失敗しました",
    runFailedBody: "オートメーションの実行に失敗しました",
    awaitingApprovalTitle: "{title} があなたの承認を待っています",
    awaitingApprovalBody:
      "承認の期限が切れたため停止しました。承認を開いて必要なことを確認し、もう一度実行してください。",
    injectionTitle: "タスクを一時停止: インジェクションの可能性",
    injectionBody: "2つの操作が禁止と判定されました。再開する前にタスクを確認してください。",
    approve: "承認",
    deny: "拒否",
    kindPay: "支払い",
    kindSendEmail: "メールを送信",
    kindSendMessage: "メッセージを送信",
    kindSubmitForm: "フォームを送信",
    kindFillCredential: "認証情報を入力",
    kindUseApp: "アプリを使用",
    kindPermission: "許可が必要です",
  },
  ko: {
    approvalPending: "승인 대기 중",
    reviewOnDevice: "검토하려면 {device}에서 Psyche를 여세요.",
    needsInput: "작업에 답변이 필요합니다",
    runFailedTitle: "{title} 실패",
    runFailedBody: "자동화 실행에 실패했습니다",
    awaitingApprovalTitle: "{title}이(가) 승인을 기다리고 있습니다",
    awaitingApprovalBody:
      "승인 시간이 만료되어 멈췄습니다. 승인을 열어 필요한 내용을 확인한 뒤 다시 실행하세요.",
    injectionTitle: "작업 일시중지: 인젝션 가능성",
    injectionBody: "두 작업이 금지로 분류되었습니다. 재개하기 전에 작업을 검토하세요.",
    approve: "승인",
    deny: "거부",
    kindPay: "결제",
    kindSendEmail: "이메일 보내기",
    kindSendMessage: "메시지 보내기",
    kindSubmitForm: "양식 제출",
    kindFillCredential: "자격 증명 입력",
    kindUseApp: "앱 사용",
    kindPermission: "권한 필요",
  },
  pt: {
    approvalPending: "Aprovação pendente",
    reviewOnDevice: "Abra o Psyche em {device} para revisar.",
    needsInput: "A tarefa precisa da sua resposta",
    runFailedTitle: "{title} falhou",
    runFailedBody: "A execução da automação falhou",
    awaitingApprovalTitle: "{title} aguarda a sua aprovação",
    awaitingApprovalBody:
      "Parou porque a aprovação expirou. Abra Aprovações para ver o que precisa e execute de novo.",
    injectionTitle: "Tarefa pausada: possível injeção",
    injectionBody: "Duas ações foram marcadas como proibidas. Revise a tarefa antes de retomá-la.",
    approve: "Aprovar",
    deny: "Negar",
    kindPay: "Pagar",
    kindSendEmail: "Enviar e-mail",
    kindSendMessage: "Enviar mensagem",
    kindSubmitForm: "Enviar formulário",
    kindFillCredential: "Preencher credencial",
    kindUseApp: "Usar app",
    kindPermission: "Permissão necessária",
  },
  zh: {
    approvalPending: "等待批准",
    reviewOnDevice: "请在 {device} 上打开 Psyche 查看。",
    needsInput: "任务需要你的回复",
    runFailedTitle: "{title} 失败",
    runFailedBody: "自动化运行失败",
    awaitingApprovalTitle: "{title} 正在等待你的批准",
    awaitingApprovalBody: "批准已过期，任务已停止。打开“批准”查看所需内容，然后重新运行。",
    injectionTitle: "任务已暂停：可能存在注入",
    injectionBody: "有两个操作被标记为禁止。请先检查任务再继续。",
    approve: "批准",
    deny: "拒绝",
    kindPay: "付款",
    kindSendEmail: "发送邮件",
    kindSendMessage: "发送消息",
    kindSubmitForm: "提交表单",
    kindFillCredential: "填写凭据",
    kindUseApp: "使用应用",
    kindPermission: "需要权限",
  },
};

/**
 * The language of the OS text: `ui.language` when it names a shipped language; "system" reads the
 * Mac's language (`systemLocale`, when given); missing or unknown is English.
 */
export function osTextLanguage(setting: unknown, systemLocale?: string): OsTextLanguage {
  const pick = (tag: unknown): OsTextLanguage | undefined => {
    if (typeof tag !== "string") return undefined;
    const base = tag.split(/[-_]/)[0]?.toLowerCase();
    return (OS_TEXT_LANGUAGES as readonly string[]).includes(base ?? "")
      ? (base as OsTextLanguage)
      : undefined;
  };
  if (setting === "system") return pick(systemLocale) ?? "en";
  return pick(setting) ?? "en";
}

const PARAM = /\{(\w+)\}/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One recognisable English sentence: its regex captures the `{params}` in order. */
const PHRASES: { key: OsTextKey; names: string[]; re: RegExp }[] = (
  Object.keys(OS_TEXT.en) as OsTextKey[]
).map((key) => {
  const template = OS_TEXT.en[key];
  const names = [...template.matchAll(PARAM)].map((m) => m[1] as string);
  const source = template
    .split(PARAM)
    .map((part, i) => (i % 2 === 1 ? "([\\s\\S]+)" : escapeRe(part)))
    .join("");
  return { key, names, re: new RegExp(`^${source}$`) };
});

const KIND_KEYS: Partial<Record<string, OsTextKey>> = {
  [OS_TEXT.en.kindPay]: "kindPay",
  [OS_TEXT.en.kindSendEmail]: "kindSendEmail",
  [OS_TEXT.en.kindSendMessage]: "kindSendMessage",
  [OS_TEXT.en.kindSubmitForm]: "kindSubmitForm",
  [OS_TEXT.en.kindFillCredential]: "kindFillCredential",
  [OS_TEXT.en.kindUseApp]: "kindUseApp",
  [OS_TEXT.en.kindPermission]: "kindPermission",
};

function fill(template: string, values: Record<string, string>): string {
  return template.replace(PARAM, (_, name: string) => values[name] ?? "");
}

/** `text` in `language` when it is one of the fixed sentences; otherwise `text` unchanged. */
export function localizeOsText(text: string, language: OsTextLanguage): string {
  if (language === "en") return text;
  const table = OS_TEXT[language];
  for (const p of PHRASES) {
    // Kind titles are matched as an approval header's first part below, and button labels go
    // through `osLabel`: neither is ever matched as a whole title or body.
    if (p.key.startsWith("kind") || p.key === "approve" || p.key === "deny") continue;
    const m = p.re.exec(text);
    if (m === null) continue;
    const values: Record<string, string> = {};
    p.names.forEach((name, i) => {
      values[name] = m[i + 1] ?? "";
    });
    return fill(table[p.key], values);
  }
  // An approval header: "<kind title> · <side effect>[ · after reading untrusted content]".
  const sep = text.indexOf(" · ");
  if (sep > 0) {
    const key = KIND_KEYS[text.slice(0, sep)];
    if (key !== undefined) return `${table[key]}${text.slice(sep)}`;
  }
  return text;
}

/** A notification button's label ("Approve", "Deny") in `language`. */
export function osLabel(key: "approve" | "deny", language: OsTextLanguage): string {
  return OS_TEXT[language][key];
}
