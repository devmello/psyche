/**
 * The fixed lines of chat approval cards and their replies, in every shipped UI language, keyed by
 * the owner's `ui.language` (the pattern of `os-text.ts` in @psyche/notifications: the Gateway has
 * no React catalogue). Callers keep writing the English sentence; `localizeCardText` recognises the
 * fixed lines by their whole-line English template and answers the translation. Values that come
 * from the request (a target, a summary, a ref) are inserted unchanged, and a line that matches no
 * template stays as it was. Missing or unknown languages read English.
 */

export const CHANNEL_TEXT_LANGUAGES = [
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
export type ChannelTextLanguage = (typeof CHANNEL_TEXT_LANGUAGES)[number];

/** One row per phrase: English first, then ar de es fr hi it ja ko pt zh. */
type Row = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

const DEVICE_WORDS: Record<string, Row> = {
  "your Mac": [
    "your Mac",
    "جهاز Mac الخاص بك",
    "deinem Mac",
    "tu Mac",
    "ton Mac",
    "आपके Mac",
    "il tuo Mac",
    "お使いの Mac",
    "사용 중인 Mac",
    "seu Mac",
    "你的 Mac",
  ],
  "your PC": [
    "your PC",
    "جهاز الكمبيوتر الخاص بك",
    "deinem PC",
    "tu PC",
    "ton PC",
    "आपके PC",
    "il tuo PC",
    "お使いの PC",
    "사용 중인 PC",
    "seu PC",
    "你的电脑",
  ],
  "your computer": [
    "your computer",
    "جهاز الكمبيوتر الخاص بك",
    "deinem Computer",
    "tu ordenador",
    "ton ordinateur",
    "आपके कंप्यूटर",
    "il tuo computer",
    "お使いのコンピュータ",
    "사용 중인 컴퓨터",
    "seu computador",
    "你的电脑",
  ],
  "this Mac": [
    "this Mac",
    "جهاز Mac هذا",
    "diesem Mac",
    "este Mac",
    "ce Mac",
    "इस Mac",
    "questo Mac",
    "この Mac",
    "이 Mac",
    "este Mac",
    "这台 Mac",
  ],
  "this PC": [
    "this PC",
    "هذا الكمبيوتر",
    "diesem PC",
    "este PC",
    "ce PC",
    "इस PC",
    "questo PC",
    "この PC",
    "이 PC",
    "este PC",
    "这台电脑",
  ],
  "this computer": [
    "this computer",
    "هذا الكمبيوتر",
    "diesem Computer",
    "este ordenador",
    "cet ordinateur",
    "इस कंप्यूटर",
    "questo computer",
    "このコンピュータ",
    "이 컴퓨터",
    "este computador",
    "这台电脑",
  ],
};

const FIXED: Record<string, Row> = {
  devicePointer: [
    "Answer this on {device}.",
    "أجب عن هذا على {device}.",
    "Beantworte das auf {device}.",
    "Responde esto en {device}.",
    "Réponds à ceci sur {device}.",
    "इसका जवाब {device} पर दें।",
    "Rispondi a questo su {device}.",
    "これには {device} で答えてください。",
    "이 요청은 {device}에서 답해 주세요.",
    "Responda a isto em {device}.",
    "请在{device}上回复此请求。",
  ],
  openOnDevice: [
    "Open on {device} to review.",
    "افتحه على {device} للمراجعة.",
    "Öffne es zur Prüfung auf {device}.",
    "Ábrelo en {device} para revisarlo.",
    "Ouvre-le sur {device} pour le vérifier.",
    "समीक्षा के लिए इसे {device} पर खोलें।",
    "Aprilo su {device} per controllarlo.",
    "確認するには {device} で開いてください。",
    "확인하려면 {device}에서 여세요.",
    "Abra em {device} para revisar.",
    "请在{device}上打开查看。",
  ],
  expiresIn: [
    "Expires in {n} min · ref {ref}",
    "تنتهي خلال {n} دقيقة · المرجع {ref}",
    "Läuft in {n} Min. ab · Ref {ref}",
    "Caduca en {n} min · ref {ref}",
    "Expire dans {n} min · réf {ref}",
    "{n} मिनट में समाप्त · रेफ़ {ref}",
    "Scade tra {n} min · rif {ref}",
    "{n} 分後に期限切れ · 参照 {ref}",
    "{n}분 후 만료 · 참조 {ref}",
    "Expira em {n} min · ref {ref}",
    "{n} 分钟后过期 · 编号 {ref}",
  ],
  replyCommands: [
    'Reply "/approve {ref} approve" or "/approve {ref} deny".',
    'ردّ بـ "/approve {ref} approve" أو "/approve {ref} deny".',
    'Antworte mit "/approve {ref} approve" oder "/approve {ref} deny".',
    'Responde "/approve {ref} approve" o "/approve {ref} deny".',
    'Réponds "/approve {ref} approve" ou "/approve {ref} deny".',
    '"/approve {ref} approve" या "/approve {ref} deny" भेजकर जवाब दें।',
    'Rispondi "/approve {ref} approve" oppure "/approve {ref} deny".',
    '"/approve {ref} approve" または "/approve {ref} deny" と返信してください。',
    '"/approve {ref} approve" 또는 "/approve {ref} deny"로 답해 주세요.',
    'Responda "/approve {ref} approve" ou "/approve {ref} deny".',
    '回复 "/approve {ref} approve" 或 "/approve {ref} deny"。',
  ],
  denyHint: [
    'To deny, reply "/deny {ref}".',
    'للرفض، ردّ بـ "/deny {ref}".',
    'Zum Ablehnen antworte mit "/deny {ref}".',
    'Para denegar, responde "/deny {ref}".',
    'Pour refuser, réponds "/deny {ref}".',
    'अस्वीकार करने के लिए "/deny {ref}" भेजें।',
    'Per negare, rispondi "/deny {ref}".',
    '拒否するには "/deny {ref}" と返信してください。',
    '거부하려면 "/deny {ref}"로 답해 주세요.',
    'Para negar, responda "/deny {ref}".',
    '要拒绝,请回复 "/deny {ref}"。',
  ],
  tapbackHint: [
    "Or tap 👍 to approve or 👎 to deny.",
    "أو اضغط 👍 للموافقة أو 👎 للرفض.",
    "Oder tippe auf 👍 zum Genehmigen oder 👎 zum Ablehnen.",
    "O toca 👍 para aprobar o 👎 para denegar.",
    "Ou touche 👍 pour approuver ou 👎 pour refuser.",
    "या मंज़ूरी के लिए 👍 या अस्वीकार के लिए 👎 दबाएँ।",
    "Oppure tocca 👍 per approvare o 👎 per negare.",
    "または 👍 で承認、👎 で拒否できます。",
    "또는 👍로 승인하고 👎로 거부하세요.",
    "Ou toque em 👍 para aprovar ou 👎 para negar.",
    "也可以点 👍 批准,点 👎 拒绝。",
  ],
  target: [
    "Target: “{v}”",
    "الهدف: “{v}”",
    "Ziel: “{v}”",
    "Destino: “{v}”",
    "Cible : “{v}”",
    "लक्ष्य: “{v}”",
    "Destinazione: “{v}”",
    "対象: “{v}”",
    "대상: “{v}”",
    "Destino: “{v}”",
    "目标:“{v}”",
  ],
  summary: [
    "Summary: “{v}”",
    "الملخص: “{v}”",
    "Zusammenfassung: “{v}”",
    "Resumen: “{v}”",
    "Résumé : “{v}”",
    "सारांश: “{v}”",
    "Riepilogo: “{v}”",
    "概要: “{v}”",
    "요약: “{v}”",
    "Resumo: “{v}”",
    "摘要:“{v}”",
  ],
  untrusted: [
    "after reading untrusted content",
    "بعد قراءة محتوى غير موثوق",
    "nach dem Lesen nicht vertrauenswürdiger Inhalte",
    "tras leer contenido no fiable",
    "après lecture d'un contenu non fiable",
    "अविश्वसनीय सामग्री पढ़ने के बाद",
    "dopo aver letto contenuti non attendibili",
    "信頼できない内容を読んだ後",
    "신뢰할 수 없는 콘텐츠를 읽은 뒤",
    "após ler conteúdo não confiável",
    "读取了不可信内容之后",
  ],
  approved: [
    "Approved: {what}.",
    "تمت الموافقة: {what}.",
    "Genehmigt: {what}.",
    "Aprobado: {what}.",
    "Approuvé : {what}.",
    "मंज़ूर: {what}।",
    "Approvato: {what}.",
    "承認しました: {what}。",
    "승인됨: {what}.",
    "Aprovado: {what}.",
    "已批准:{what}。",
  ],
  denied: [
    "Denied: {what}.",
    "تم الرفض: {what}.",
    "Abgelehnt: {what}.",
    "Denegado: {what}.",
    "Refusé : {what}.",
    "अस्वीकृत: {what}।",
    "Negato: {what}.",
    "拒否しました: {what}。",
    "거부됨: {what}.",
    "Negado: {what}.",
    "已拒绝:{what}。",
  ],
  ackApproved: [
    "Approved.",
    "تمت الموافقة.",
    "Genehmigt.",
    "Aprobado.",
    "Approuvé.",
    "मंज़ूर किया।",
    "Approvato.",
    "承認しました。",
    "승인했습니다.",
    "Aprovado.",
    "已批准。",
  ],
  ackDenied: [
    "Denied.",
    "تم الرفض.",
    "Abgelehnt.",
    "Denegado.",
    "Refusé.",
    "अस्वीकार किया।",
    "Negato.",
    "拒否しました。",
    "거부했습니다.",
    "Negado.",
    "已拒绝。",
  ],
  retireApprovedOn: [
    "Approved on {device}.",
    "تمت الموافقة على {device}.",
    "Auf {device} genehmigt.",
    "Aprobado en {device}.",
    "Approuvé sur {device}.",
    "{device} पर मंज़ूर किया गया।",
    "Approvato su {device}.",
    "{device} で承認されました。",
    "{device}에서 승인됨.",
    "Aprovado em {device}.",
    "已在{device}上批准。",
  ],
  retireDeniedOn: [
    "Denied on {device}.",
    "تم الرفض على {device}.",
    "Auf {device} abgelehnt.",
    "Denegado en {device}.",
    "Refusé sur {device}.",
    "{device} पर अस्वीकार किया गया।",
    "Negato su {device}.",
    "{device} で拒否されました。",
    "{device}에서 거부됨.",
    "Negado em {device}.",
    "已在{device}上拒绝。",
  ],
  retireApprovedElsewhere: [
    "Approved on another device.",
    "تمت الموافقة على جهاز آخر.",
    "Auf einem anderen Gerät genehmigt.",
    "Aprobado en otro dispositivo.",
    "Approuvé sur un autre appareil.",
    "किसी दूसरे डिवाइस पर मंज़ूर किया गया।",
    "Approvato su un altro dispositivo.",
    "別のデバイスで承認されました。",
    "다른 기기에서 승인됨.",
    "Aprovado em outro dispositivo.",
    "已在另一台设备上批准。",
  ],
  retireDeniedElsewhere: [
    "Denied on another device.",
    "تم الرفض على جهاز آخر.",
    "Auf einem anderen Gerät abgelehnt.",
    "Denegado en otro dispositivo.",
    "Refusé sur un autre appareil.",
    "किसी दूसरे डिवाइस पर अस्वीकार किया गया।",
    "Negato su un altro dispositivo.",
    "別のデバイスで拒否されました。",
    "다른 기기에서 거부됨.",
    "Negado em outro dispositivo.",
    "已在另一台设备上拒绝。",
  ],
  retireApprovedChat: [
    "Approved in chat.",
    "تمت الموافقة في الدردشة.",
    "Im Chat genehmigt.",
    "Aprobado en el chat.",
    "Approuvé dans le chat.",
    "चैट में मंज़ूर किया गया।",
    "Approvato in chat.",
    "チャットで承認されました。",
    "채팅에서 승인됨.",
    "Aprovado no chat.",
    "已在聊天中批准。",
  ],
  retireDeniedChat: [
    "Denied in chat.",
    "تم الرفض في الدردشة.",
    "Im Chat abgelehnt.",
    "Denegado en el chat.",
    "Refusé dans le chat.",
    "चैट में अस्वीकार किया गया।",
    "Negato in chat.",
    "チャットで拒否されました。",
    "채팅에서 거부됨.",
    "Negado no chat.",
    "已在聊天中拒绝。",
  ],
  retireExpired: [
    "Expired. Nothing was done.",
    "انتهت المهلة. لم يُنفَّذ أي شيء.",
    "Abgelaufen. Es wurde nichts ausgeführt.",
    "Caducó. No se hizo nada.",
    "Expiré. Rien n'a été fait.",
    "समय समाप्त। कुछ नहीं किया गया।",
    "Scaduto. Non è stato fatto nulla.",
    "期限切れです。何も実行されていません。",
    "만료되었습니다. 아무 작업도 하지 않았습니다.",
    "Expirou. Nada foi feito.",
    "已过期,未执行任何操作。",
  ],
  retireStopped: [
    "Stopped with the task. Nothing was done.",
    "توقفت مع المهمة. لم يُنفَّذ أي شيء.",
    "Mit der Aufgabe gestoppt. Es wurde nichts ausgeführt.",
    "Se detuvo con la tarea. No se hizo nada.",
    "Arrêté avec la tâche. Rien n'a été fait.",
    "कार्य के साथ रोक दिया गया। कुछ नहीं किया गया।",
    "Interrotto insieme all'attività. Non è stato fatto nulla.",
    "タスクと共に停止しました。何も実行されていません。",
    "작업과 함께 중단되었습니다. 아무 작업도 하지 않았습니다.",
    "Parou junto com a tarefa. Nada foi feito.",
    "已随任务停止,未执行任何操作。",
  ],
  retireReplaced: [
    "Replaced by a newer card. Nothing was done.",
    "استُبدلت ببطاقة أحدث. لم يُنفَّذ أي شيء.",
    "Durch eine neuere Karte ersetzt. Es wurde nichts ausgeführt.",
    "Sustituida por una tarjeta más reciente. No se hizo nada.",
    "Remplacée par une carte plus récente. Rien n'a été fait.",
    "नए कार्ड से बदल दिया गया। कुछ नहीं किया गया।",
    "Sostituita da una scheda più recente. Non è stato fatto nulla.",
    "新しいカードに置き換えられました。何も実行されていません。",
    "더 새로운 카드로 대체되었습니다. 아무 작업도 하지 않았습니다.",
    "Substituído por um cartão mais recente. Nada foi feito.",
    "已被更新的卡片取代,未执行任何操作。",
  ],
  whichOne: [
    "Which one? Reply with the ref.",
    "أيّها؟ ردّ بالمرجع.",
    "Welche? Antworte mit der Ref.",
    "¿Cuál? Responde con la ref.",
    "Laquelle ? Réponds avec la réf.",
    "कौन सा? रेफ़ के साथ जवाब दें।",
    "Quale? Rispondi con il rif.",
    "どれですか?参照番号で返信してください。",
    "어느 것인가요? 참조 번호로 답해 주세요.",
    "Qual? Responda com a ref.",
    "是哪一个?请回复编号。",
  ],
  needsDevice: [
    "This one needs your Mac or iPhone.",
    "هذا الطلب يحتاج إلى جهاز Mac أو iPhone الخاص بك.",
    "Das geht nur an deinem Mac oder iPhone.",
    "Esto necesita tu Mac o tu iPhone.",
    "Celle-ci nécessite ton Mac ou ton iPhone.",
    "इसके लिए आपका Mac या iPhone चाहिए।",
    "Questa richiede il tuo Mac o il tuo iPhone.",
    "これには Mac か iPhone が必要です。",
    "이 요청은 Mac이나 iPhone이 필요합니다.",
    "Esta precisa do seu Mac ou iPhone.",
    "这个需要在你的 Mac 或 iPhone 上处理。",
  ],
  approve: [
    "Approve",
    "موافقة",
    "Genehmigen",
    "Aprobar",
    "Approuver",
    "मंज़ूर करें",
    "Approva",
    "承認",
    "승인",
    "Aprovar",
    "批准",
  ],
  deny: [
    "Deny",
    "رفض",
    "Ablehnen",
    "Denegar",
    "Refuser",
    "अस्वीकार करें",
    "Nega",
    "拒否",
    "거부",
    "Negar",
    "拒绝",
  ],
  stale: [
    "That approval is no longer valid.",
    "هذه الموافقة لم تعد صالحة.",
    "Diese Genehmigung ist nicht mehr gültig.",
    "Esa aprobación ya no es válida.",
    "Cette approbation n'est plus valide.",
    "यह मंज़ूरी अब मान्य नहीं है।",
    "Questa approvazione non è più valida.",
    "この承認はもう有効ではありません。",
    "이 승인은 더 이상 유효하지 않습니다.",
    "Essa aprovação não é mais válida.",
    "此批准已失效。",
  ],
};

/** Kind titles as `cards.ts` writes them in the header's first part. */
const KIND_TITLE_ROWS: Record<string, Row> = {
  "Run command in sandbox": [
    "Run command in sandbox",
    "تشغيل أمر في البيئة المعزولة",
    "Befehl in der Sandbox ausführen",
    "Ejecutar comando en el entorno aislado",
    "Exécuter une commande dans le bac à sable",
    "सैंडबॉक्स में कमांड चलाएँ",
    "Esegui comando nella sandbox",
    "サンドボックスでコマンドを実行",
    "샌드박스에서 명령 실행",
    "Executar comando no sandbox",
    "在沙盒中运行命令",
  ],
  "Send email": [
    "Send email",
    "إرسال بريد إلكتروني",
    "E-Mail senden",
    "Enviar correo",
    "Envoyer un e-mail",
    "ईमेल भेजें",
    "Invia email",
    "メールを送信",
    "이메일 보내기",
    "Enviar e-mail",
    "发送邮件",
  ],
  "Change calendar": [
    "Change calendar",
    "تغيير التقويم",
    "Kalender ändern",
    "Cambiar calendario",
    "Modifier l'agenda",
    "कैलेंडर बदलें",
    "Modifica calendario",
    "カレンダーを変更",
    "캘린더 변경",
    "Alterar calendário",
    "更改日历",
  ],
  "Send message": [
    "Send message",
    "إرسال رسالة",
    "Nachricht senden",
    "Enviar mensaje",
    "Envoyer un message",
    "संदेश भेजें",
    "Invia messaggio",
    "メッセージを送信",
    "메시지 보내기",
    "Enviar mensagem",
    "发送消息",
  ],
  "Submit form": [
    "Submit form",
    "إرسال نموذج",
    "Formular absenden",
    "Enviar formulario",
    "Envoyer le formulaire",
    "फ़ॉर्म जमा करें",
    "Invia modulo",
    "フォームを送信",
    "양식 제출",
    "Enviar formulário",
    "提交表单",
  ],
  "Fill credential": [
    "Fill credential",
    "تعبئة بيانات اعتماد",
    "Zugangsdaten eintragen",
    "Rellenar credencial",
    "Remplir un identifiant",
    "क्रेडेंशियल भरें",
    "Compila credenziale",
    "認証情報を入力",
    "자격 증명 입력",
    "Preencher credencial",
    "填写凭据",
  ],
  Pay: [
    "Pay",
    "دفع",
    "Bezahlen",
    "Pagar",
    "Payer",
    "भुगतान करें",
    "Paga",
    "支払う",
    "결제",
    "Pagar",
    "付款",
  ],
  "Write file": [
    "Write file",
    "كتابة ملف",
    "Datei schreiben",
    "Escribir archivo",
    "Écrire un fichier",
    "फ़ाइल लिखें",
    "Scrivi file",
    "ファイルを書き込む",
    "파일 쓰기",
    "Gravar arquivo",
    "写入文件",
  ],
  "Connector action": [
    "Connector action",
    "إجراء موصّل",
    "Connector-Aktion",
    "Acción de conector",
    "Action de connecteur",
    "कनेक्टर क्रिया",
    "Azione del connettore",
    "コネクタの操作",
    "커넥터 작업",
    "Ação do conector",
    "连接器操作",
  ],
  "Use app": [
    "Use app",
    "استخدام تطبيق",
    "App verwenden",
    "Usar app",
    "Utiliser une app",
    "ऐप इस्तेमाल करें",
    "Usa app",
    "アプリを操作",
    "앱 사용",
    "Usar app",
    "使用应用",
  ],
  "Open site": [
    "Open site",
    "فتح موقع",
    "Website öffnen",
    "Abrir sitio",
    "Ouvrir un site",
    "साइट खोलें",
    "Apri sito",
    "サイトを開く",
    "사이트 열기",
    "Abrir site",
    "打开网站",
  ],
  "Start the plan": [
    "Start the plan",
    "بدء الخطة",
    "Plan starten",
    "Empezar el plan",
    "Lancer le plan",
    "योजना शुरू करें",
    "Avvia il piano",
    "計画を開始",
    "계획 시작",
    "Iniciar o plano",
    "开始执行计划",
  ],
  "Install skill": [
    "Install skill",
    "تثبيت مهارة",
    "Skill installieren",
    "Instalar habilidad",
    "Installer une compétence",
    "स्किल इंस्टॉल करें",
    "Installa skill",
    "スキルをインストール",
    "스킬 설치",
    "Instalar habilidade",
    "安装技能",
  ],
  "MCP tool": [
    "MCP tool",
    "أداة MCP",
    "MCP-Tool",
    "Herramienta MCP",
    "Outil MCP",
    "MCP टूल",
    "Strumento MCP",
    "MCP ツール",
    "MCP 도구",
    "Ferramenta MCP",
    "MCP 工具",
  ],
  "Archive thread": [
    "Archive thread",
    "أرشفة المحادثة",
    "Unterhaltung archivieren",
    "Archivar conversación",
    "Archiver la conversation",
    "थ्रेड संग्रहित करें",
    "Archivia conversazione",
    "スレッドをアーカイブ",
    "스레드 보관",
    "Arquivar conversa",
    "归档对话",
  ],
  "Edit protected memory": [
    "Edit protected memory",
    "تعديل ذاكرة محمية",
    "Geschützten Speicher ändern",
    "Editar memoria protegida",
    "Modifier la mémoire protégée",
    "सुरक्षित मेमोरी संपादित करें",
    "Modifica memoria protetta",
    "保護されたメモリを編集",
    "보호된 메모리 편집",
    "Editar memória protegida",
    "编辑受保护的记忆",
  ],
  "Pair device": [
    "Pair device",
    "إقران جهاز",
    "Gerät koppeln",
    "Vincular dispositivo",
    "Associer un appareil",
    "डिवाइस जोड़ें",
    "Associa dispositivo",
    "デバイスをペアリング",
    "기기 페어링",
    "Parear dispositivo",
    "配对设备",
  ],
  "Change permissions": [
    "Change permissions",
    "تغيير الأذونات",
    "Berechtigungen ändern",
    "Cambiar permisos",
    "Modifier les autorisations",
    "अनुमतियाँ बदलें",
    "Modifica autorizzazioni",
    "権限を変更",
    "권한 변경",
    "Alterar permissões",
    "更改权限",
  ],
  "Start background task": [
    "Start background task",
    "بدء مهمة في الخلفية",
    "Hintergrundaufgabe starten",
    "Iniciar tarea en segundo plano",
    "Lancer une tâche en arrière-plan",
    "बैकग्राउंड कार्य शुरू करें",
    "Avvia attività in background",
    "バックグラウンドタスクを開始",
    "백그라운드 작업 시작",
    "Iniciar tarefa em segundo plano",
    "启动后台任务",
  ],
  "Run AppleScript": [
    "Run AppleScript",
    "تشغيل AppleScript",
    "AppleScript ausführen",
    "Ejecutar AppleScript",
    "Exécuter un AppleScript",
    "AppleScript चलाएँ",
    "Esegui AppleScript",
    "AppleScript を実行",
    "AppleScript 실행",
    "Executar AppleScript",
    "运行 AppleScript",
  ],
  "Run Shortcut": [
    "Run Shortcut",
    "تشغيل اختصار",
    "Kurzbefehl ausführen",
    "Ejecutar atajo",
    "Exécuter un raccourci",
    "शॉर्टकट चलाएँ",
    "Esegui comando rapido",
    "ショートカットを実行",
    "단축어 실행",
    "Executar atalho",
    "运行快捷指令",
  ],
  "Change git repository": [
    "Change git repository",
    "تغيير مستودع git",
    "Git-Repository ändern",
    "Cambiar repositorio git",
    "Modifier le dépôt git",
    "git रिपॉज़िटरी बदलें",
    "Modifica repository git",
    "git リポジトリを変更",
    "git 저장소 변경",
    "Alterar repositório git",
    "更改 git 仓库",
  ],
  "Push to git remote": [
    "Push to git remote",
    "الدفع إلى مستودع git بعيد",
    "An Git-Remote pushen",
    "Enviar a remoto git",
    "Pousser vers un dépôt git distant",
    "git रिमोट पर पुश करें",
    "Push su remoto git",
    "git リモートにプッシュ",
    "git 원격에 푸시",
    "Enviar para remoto git",
    "推送到 git 远程",
  ],
  "Open a folder": [
    "Open a folder",
    "فتح مجلد",
    "Ordner öffnen",
    "Abrir una carpeta",
    "Ouvrir un dossier",
    "फ़ोल्डर खोलें",
    "Apri una cartella",
    "フォルダを開く",
    "폴더 열기",
    "Abrir uma pasta",
    "打开文件夹",
  ],
  "Share a folder with the separate desktop": [
    "Share a folder with the separate desktop",
    "مشاركة مجلد مع سطح المكتب المنفصل",
    "Ordner mit dem separaten Desktop teilen",
    "Compartir una carpeta con el escritorio independiente",
    "Partager un dossier avec le bureau séparé",
    "अलग डेस्कटॉप के साथ फ़ोल्डर साझा करें",
    "Condividi una cartella con il desktop separato",
    "別のデスクトップとフォルダを共有",
    "별도 데스크톱과 폴더 공유",
    "Compartilhar uma pasta com a área de trabalho separada",
    "与独立桌面共享文件夹",
  ],
  "Permission needed": [
    "Permission needed",
    "الإذن مطلوب",
    "Berechtigung erforderlich",
    "Se necesita permiso",
    "Autorisation requise",
    "अनुमति चाहिए",
    "Permesso necessario",
    "許可が必要です",
    "권한 필요",
    "Permissão necessária",
    "需要权限",
  ],
};

/** `Run command on {device}`: the title of an `exec_host` card. */
const EXEC_HOST: Row = [
  "Run command on {device}",
  "تشغيل أمر على {device}",
  "Befehl auf {device} ausführen",
  "Ejecutar comando en {device}",
  "Exécuter une commande sur {device}",
  "{device} पर कमांड चलाएँ",
  "Esegui comando su {device}",
  "{device} でコマンドを実行",
  "{device}에서 명령 실행",
  "Executar comando em {device}",
  "在{device}上运行命令",
];

/** Side-effect words after the title: `Send email · write`. */
const EFFECT_WORDS: Record<string, Row> = {
  none: [
    "none",
    "لا شيء",
    "keine",
    "ninguno",
    "aucun",
    "कोई नहीं",
    "nessuno",
    "なし",
    "없음",
    "nenhum",
    "无",
  ],
  read: [
    "read",
    "قراءة",
    "lesen",
    "lectura",
    "lecture",
    "पढ़ना",
    "lettura",
    "読み取り",
    "읽기",
    "leitura",
    "读取",
  ],
  write: [
    "write",
    "كتابة",
    "schreiben",
    "escritura",
    "écriture",
    "लिखना",
    "scrittura",
    "書き込み",
    "쓰기",
    "escrita",
    "写入",
  ],
  destructive: [
    "destructive",
    "مدمّر",
    "destruktiv",
    "destructivo",
    "destructif",
    "विनाशकारी",
    "distruttivo",
    "破壊的",
    "파괴적",
    "destrutivo",
    "破坏性",
  ],
  financial: [
    "financial",
    "مالي",
    "finanziell",
    "financiero",
    "financier",
    "वित्तीय",
    "finanziario",
    "金銭",
    "금융",
    "financeiro",
    "资金相关",
  ],
  unknown: [
    "unknown",
    "غير معروف",
    "unbekannt",
    "desconocido",
    "inconnu",
    "अज्ञात",
    "sconosciuto",
    "不明",
    "알 수 없음",
    "desconhecido",
    "未知",
  ],
};

export type ChannelTextKey = keyof typeof FIXED;

const COLUMN: Record<ChannelTextLanguage, number> = {
  en: 0,
  ar: 1,
  de: 2,
  es: 3,
  fr: 4,
  hi: 5,
  it: 6,
  ja: 7,
  ko: 8,
  pt: 9,
  zh: 10,
};

/** `ui.language` ("system", "fr", "pt-BR", …) as a shipped language; unknown reads English. */
export function channelTextLanguage(setting: unknown, systemLocale?: string): ChannelTextLanguage {
  const pick = (tag: unknown): ChannelTextLanguage | undefined => {
    if (typeof tag !== "string") return undefined;
    const base = tag.split(/[-_]/)[0]?.toLowerCase();
    return (CHANNEL_TEXT_LANGUAGES as readonly string[]).includes(base ?? "")
      ? (base as ChannelTextLanguage)
      : undefined;
  };
  if (setting === "system") return pick(systemLocale) ?? "en";
  return pick(setting) ?? "en";
}

/** The language the Gateway's chat text is written in now; set by the channel service. */
let current: () => unknown = () => "en";
export function setChannelTextLanguage(source: (() => unknown) | undefined): void {
  current = source ?? (() => "en");
}
export function currentChannelLanguage(): ChannelTextLanguage {
  try {
    return channelTextLanguage(current());
  } catch {
    return "en";
  }
}

function cell(row: Row | undefined, language: ChannelTextLanguage): string {
  return row?.[COLUMN[language]] ?? row?.[0] ?? "";
}

const PARAM = /\{(\w+)\}/g;
function fill(template: string, values: Record<string, string>): string {
  return template.replace(PARAM, (_m, name: string) => values[name] ?? "");
}

/** One fixed line (a template with `{params}`) in `language`. */
export function channelText(
  key: ChannelTextKey,
  values: Record<string, string | number> = {},
  language: ChannelTextLanguage = currentChannelLanguage(),
): string {
  const row = FIXED[key] as Row;
  const strings: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) strings[k] = String(v);
  if (strings.device !== undefined) strings.device = localizeDevice(strings.device, language);
  return fill(cell(row, language), strings);
}

function localizeDevice(device: string, language: ChannelTextLanguage): string {
  const row = DEVICE_WORDS[device];
  return row === undefined ? device : cell(row, language);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whole-line matchers. Each captured value is restricted to what the fixed line can really carry
 * (a number, a hex ref, a known device word), so request text that merely looks like a fixed line
 * is never rewritten, except the value slots of `Target:` and `Summary:`, which are inserted as
 * they were.
 */
const CAPTURE: Record<string, string> = {
  n: "(\\d{1,4})",
  ref: "([0-9a-z_-]{8})",
  device: `(${Object.keys(DEVICE_WORDS).map(escapeRe).join("|")})`,
  v: "([^\\n]*)",
  what: "([^\\n]+?)",
};

const LINE_KEYS = [
  "devicePointer",
  "openOnDevice",
  "expiresIn",
  "replyCommands",
  "denyHint",
  "tapbackHint",
  "target",
  "summary",
] as const;

const LINES = LINE_KEYS.map((key) => {
  const template = (FIXED[key] as Row)[0];
  const names: string[] = [];
  const source = template
    .split(PARAM)
    .map((part, i) => {
      if (i % 2 === 0) return escapeRe(part);
      names.push(part);
      return CAPTURE[part] ?? "([^\\n]*)";
    })
    .join("");
  return { key, names, re: new RegExp(`^${source}$`) };
});

const TITLES = Object.keys(KIND_TITLE_ROWS);
const EXEC_HOST_RE = new RegExp(`^Run command on ${CAPTURE.device}$`);

function localizeTitle(title: string, language: ChannelTextLanguage): string {
  const row = KIND_TITLE_ROWS[title];
  if (row !== undefined) return cell(row, language);
  const m = EXEC_HOST_RE.exec(title);
  if (m !== null)
    return fill(cell(EXEC_HOST, language), { device: localizeDevice(m[1] ?? "", language) });
  return title;
}

/** `<title> · <effect>[ · after reading untrusted content]`: only when every part is known. */
function localizeHeader(line: string, language: ChannelTextLanguage): string | undefined {
  const parts = line.split(" · ");
  if (parts.length < 2 || parts.length > 3) return undefined;
  const [title, effect, tail] = parts as [string, string, string | undefined];
  const known = title in KIND_TITLE_ROWS || EXEC_HOST_RE.test(title);
  const effectRow = EFFECT_WORDS[effect];
  if (!known || effectRow === undefined) return undefined;
  if (tail !== undefined && tail !== (FIXED.untrusted as Row)[0]) return undefined;
  const out = [localizeTitle(title, language), cell(effectRow, language)];
  if (tail !== undefined) out.push(cell(FIXED.untrusted as Row, language));
  return out.join(" · ");
}

/**
 * `text` (an English card, pointer or reply) with its fixed lines in `language`. Lines that are not
 * fixed lines stay as they were.
 */
export function localizeCardText(
  text: string,
  language: ChannelTextLanguage = currentChannelLanguage(),
): string {
  if (language === "en") return text;
  return text
    .split("\n")
    .map((line) => {
      const header = localizeHeader(line, language);
      if (header !== undefined) return header;
      for (const p of LINES) {
        const m = p.re.exec(line);
        if (m === null) continue;
        const values: Record<string, string> = {};
        p.names.forEach((name, i) => {
          values[name] = m[i + 1] ?? "";
        });
        return channelText(p.key, values, language);
      }
      return line;
    })
    .join("\n");
}

/**
 * Discord renders markdown in everything it shows: a target such as `[x](https://evil)` would
 * become a masked link on an approval card. Escapes it, and breaks `@` mentions.
 */
export function escapeDiscordText(text: string): string {
  return text.replace(/[\\*_~`|>[\]()<]/g, "\\$&").replace(/@/g, "@\u200b");
}

/** A kind title (`Send email`) for a confirmation line, in `language`. */
export function localizeKindTitle(
  title: string,
  language: ChannelTextLanguage = currentChannelLanguage(),
): string {
  return localizeTitle(title, language);
}
