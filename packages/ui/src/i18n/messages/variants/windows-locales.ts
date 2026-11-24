import type { MessageId } from "../index.ts";

/**
 * Translations of the Windows variants (`./windows.ts`), by message locale. A message missing here
 * shows the English variant on Windows.
 */
export const WINDOWS_LOCALES: Readonly<
  Record<string, Readonly<Partial<Record<MessageId, string>>>>
> = {
  ar: {
    "notice.security.changed.body":
      "غيّر برنامج على هذا الكمبيوتر {count, plural, =1 {سجل أمان واحدًا} other {# سجل أمان}} (الأجهزة والمفاتيح والصلاحيات أو الإعدادات) دون المرور عبر Psyche{times, plural, =0 {} =1 {} other {، # مرة حتى الآن}}. أعاد Psyche ما تغيّر كما كان. إن لم تكن أنت من فعل ذلك، فافحص الكمبيوتر بحثًا عن برامج غير مرغوب فيها.",
    "notice.security.untrusted.body":
      "فشل فحص سجلات الأمان في Psyche، لذلك تُحظر تغييرات الأمان والأجهزة الجديدة وموافقات Windows Hello. راجع أجهزتك ثم شغّل psyched security reseal على الكمبيوتر؛ يُطبَّق ذلك بعد 24 ساعة.",
    "notice.security.firstAdmin.title": "أمر على هذا الكمبيوتر جعل أول جهاز مسؤول",
    "notice.security.firstAdmin.body":
      "{device}{key, select, none {} other { (المفتاح {key})}} أصبح أول جهاز مسؤول {via, select, desktop {من تطبيق Psyche} other {عبر `psyched`}} على هذا الكمبيوتر. إن لم تكن أنت من فعل ذلك، فألغِه من الإعدادات ← الأجهزة.",
    "notice.security.recovery.title":
      "{state, select, requested {طلب أمر على هذا الكمبيوتر تغييرًا أمنيًا} applied {طُبّق تغيير أمني من هذا الكمبيوتر} cancelled {أُلغي تغيير أمني من هذا الكمبيوتر} other {تعذّر تطبيق تغيير أمني من هذا الكمبيوتر}}",
    "notice.security.recovery.body":
      "{op, select, approve {وافِق على الجهاز {device}{key, select, none {} other { (المفتاح {key})}} مع {scopes}.} grant {امنح {device}{key, select, none {} other { (المفتاح {key})}} {scopes}.} presence {أوقِف طلب Windows Hello أو مفتاح المرور لتغييرات الأمان حتى يُسجَّل مفتاح جديد.} seal {اقبل سجلات الأمان الحالية كما هي.} other {تغيير أمني.}}{state, select, requested { يُطبَّق {when, select, none {بعد 24 ساعة} other {في {when}}} ما لم تلغِه في Psyche.} failed {{reason, select, none {} other { {reason}}}} other {}}",
    "screens.library.reveal": "إظهار في المجلد",
    "web.security.banner.recovery":
      "{count, plural, one {تغيير أمان طُلب على هذا الكمبيوتر سيُطبَّق في {when} ما لم تلغه.} two {تغييرا أمان طُلبا على هذا الكمبيوتر ينتظران. التالي يُطبَّق في {when}.} few {# تغييرات أمان طُلبت على هذا الكمبيوتر تنتظر. التالي يُطبَّق في {when}.} many {# تغيير أمان طُلب على هذا الكمبيوتر ينتظر. التالي يُطبَّق في {when}.} other {# تغيير أمان طُلب على هذا الكمبيوتر ينتظر. التالي يُطبَّق في {when}.}}",
    "web.security.alert.changed":
      "غيّر برنامج على هذا الكمبيوتر {count, plural, one {سجل أمان واحدًا} two {سجلَّي أمان} few {# سجلات أمان} many {# سجل أمان} other {# سجل أمان}} دون المرور عبر Psyche. أعاد Psyche ما تغيّر كما كان. إن لم تكن أنت من فعل ذلك، فافحص الكمبيوتر بحثًا عن برامج غير مرغوب فيها.",
    "web.security.alert.untrusted":
      "فشل فحص سجلات الأمان في Psyche. الأجهزة الجديدة وإعدادات الأمان والموافقات بـ Windows Hello محظورة. راجع أجهزتك ثم شغّل psyched security reseal على الكمبيوتر؛ يُطبَّق ذلك بعد 24 ساعة.",
    "web.security.alert.firstAdmin":
      "جعل أمر على هذا الكمبيوتر الجهاز {name} أول جهاز مسؤول. إن لم تكن أنت، فألغِه من الأجهزة.",
    "web.security.alert.requested": "طُلب على هذا الكمبيوتر: {action} يُطبَّق في {when}.",
    "web.security.op.presenceReset":
      "التوقف عن طلب Windows Hello أو مفتاح المرور لتغييرات الأمان حتى يُسجَّل مفتاح جديد.",
    "web.security.needsApprovalPresence":
      "وافق على البطاقة بـ Windows Hello أو مفتاح مرور، ثم اضغط الزر مرة أخرى.",
    "web.security.needsApproval":
      "وافق على البطاقة بـ Windows Hello أو مفتاح مرور، ثم اضغط الزر مرة أخرى.",
  },
  de: {
    "notice.security.changed.body":
      "Ein Programm auf diesem PC hat {count, plural, =1 {# Sicherheitseintrag} other {# Sicherheitseinträge}} (Geräte, Schlüssel, Freigaben oder Einstellungen) an Psyche vorbei geändert{times, plural, =0 {} =1 {} other {, bisher # Mal}}. Psyche hat {count, plural, =1 {ihn} other {sie}} wiederhergestellt. Wenn du das nicht warst, prüfe den PC auf unerwünschte Software.",
    "notice.security.untrusted.body":
      "Die Prüfung von Psyches Sicherheitsdaten ist fehlgeschlagen, daher sind Sicherheitsänderungen, neue Geräte und Windows-Hello-Freigaben gesperrt. Prüfe deine Geräte und führe dann auf diesem PC psyched security reseal aus; das gilt nach 24 Stunden.",
    "notice.security.firstAdmin.title":
      "Ein Befehl auf diesem PC hat das erste Admin-Gerät gemacht",
    "notice.security.firstAdmin.body":
      "{device}{key, select, none {} other { (Schlüssel {key})}} wurde {via, select, desktop {über die Psyche-App} other {über `psyched`}} auf diesem PC zum ersten Admin-Gerät. Wenn du das nicht warst, widerrufe es unter Einstellungen → Geräte.",
    "notice.security.recovery.title":
      "{state, select, requested {Ein Befehl auf diesem PC hat eine Sicherheitsänderung angefordert} applied {Eine Sicherheitsänderung von diesem PC wurde angewendet} cancelled {Eine Sicherheitsänderung von diesem PC wurde abgebrochen} other {Eine Sicherheitsänderung von diesem PC konnte nicht angewendet werden}}",
    "notice.security.recovery.body":
      "{op, select, approve {Genehmige das Gerät {device}{key, select, none {} other { (Schlüssel {key})}} mit {scopes}.} grant {Gib {device}{key, select, none {} other { (Schlüssel {key})}} {scopes}.} presence {Verlange für Sicherheitsänderungen kein Windows Hello und keinen Passkey mehr, bis ein neuer Schlüssel registriert ist.} seal {Akzeptiere die aktuellen Sicherheitsdaten so, wie sie sind.} other {Eine Sicherheitsänderung.}}{state, select, requested { Sie gilt {when, select, none {in 24 Stunden} other {ab {when}}}, sofern du sie nicht in Psyche abbrichst.} failed {{reason, select, none {} other { {reason}}}} other {}}",
    "screens.library.reveal": "Im Ordner zeigen",
    "web.security.banner.recovery":
      "{count, plural, one {Eine auf diesem PC angeforderte Sicherheitsänderung gilt ab {when}, wenn du sie nicht abbrichst.} other {# auf diesem PC angeforderte Sicherheitsänderungen warten. Die nächste gilt ab {when}.}}",
    "web.security.alert.changed":
      "Ein Programm auf diesem PC hat {count, plural, one {1 Sicherheitseintrag} other {# Sicherheitseinträge}} an Psyche vorbei geändert. Psyche hat {count, plural, one {ihn} other {sie}} wiederhergestellt. Wenn du das nicht warst, prüfe den PC auf unerwünschte Software.",
    "web.security.alert.untrusted":
      "Die Prüfung von Psyches Sicherheitsdaten ist fehlgeschlagen. Neue Geräte, Sicherheitseinstellungen und Windows-Hello-Freigaben sind gesperrt. Prüfe deine Geräte und führe dann auf dem PC psyched security reseal aus; das gilt nach 24 Stunden.",
    "web.security.alert.firstAdmin":
      "Ein Befehl auf diesem PC hat {name} zum ersten Admin-Gerät gemacht. Wenn du das nicht warst, widerrufe es unter Geräte.",
    "web.security.alert.requested": "Auf diesem PC angefordert: {action} Gilt ab {when}.",
    "web.security.op.presenceReset":
      "für Sicherheitsänderungen kein Windows Hello und keinen Passkey mehr verlangen, bis ein neuer Schlüssel registriert ist.",
    "web.security.needsApprovalPresence":
      "Bestätige die Karte mit Windows Hello oder einem Passkey und tippe dann erneut auf die Taste.",
    "web.security.needsApproval":
      "Bestätige die Karte mit Windows Hello oder einem Passkey und tippe dann erneut auf die Taste.",
  },
  es: {
    "notice.security.changed.body":
      "Un programa de este PC cambió {count, plural, =1 {# registro de seguridad} other {# registros de seguridad}} (dispositivos, claves, permisos o ajustes) sin pasar por Psyche{times, plural, =0 {} =1 {} other {, # veces hasta ahora}}. Psyche {count, plural, =1 {lo restauró} other {los restauró}}. Si no fuiste tú, revisa el PC en busca de software no deseado.",
    "notice.security.untrusted.body":
      "La comprobación de los registros de seguridad de Psyche falló, así que los cambios de seguridad, los dispositivos nuevos y las aprobaciones con Windows Hello están bloqueados. Revisa tus dispositivos y luego ejecuta psyched security reseal en este PC; se aplica a las 24 horas.",
    "notice.security.firstAdmin.title":
      "Un comando en este PC creó el primer dispositivo administrador",
    "notice.security.firstAdmin.body":
      "{device}{key, select, none {} other { (clave {key})}} pasó a ser el primer dispositivo administrador {via, select, desktop {desde la app de Psyche} other {mediante `psyched`}} en este PC. Si no fuiste tú, revócalo en Configuración → Dispositivos.",
    "notice.security.recovery.title":
      "{state, select, requested {Un comando en este PC pidió un cambio de seguridad} applied {Se aplicó un cambio de seguridad desde este PC} cancelled {Se canceló un cambio de seguridad desde este PC} other {No se pudo aplicar un cambio de seguridad desde este PC}}",
    "notice.security.recovery.body":
      "{op, select, approve {Aprueba el dispositivo {device}{key, select, none {} other { (clave {key})}} con {scopes}.} grant {Da a {device}{key, select, none {} other { (clave {key})}} {scopes}.} presence {Deja de exigir Windows Hello o una llave de acceso para los cambios de seguridad hasta que se registre una clave nueva.} seal {Acepta los registros de seguridad actuales tal como están.} other {Un cambio de seguridad.}}{state, select, requested { Se aplica {when, select, none {en 24 horas} other {el {when}}} salvo que lo canceles en Psyche.} failed {{reason, select, none {} other { {reason}}}} other {}}",
    "screens.library.reveal": "Mostrar en la carpeta",
    "web.security.banner.recovery":
      "{count, plural, one {Un cambio de seguridad pedido en este PC se aplica el {when} salvo que lo canceles.} other {# cambios de seguridad pedidos en este PC están en espera. El siguiente se aplica el {when}.}}",
    "web.security.alert.changed":
      "Un programa de este PC cambió {count, plural, one {1 registro de seguridad} other {# registros de seguridad}} sin pasar por Psyche. Psyche {count, plural, one {lo restauró} other {los restauró}}. Si no fuiste tú, revisa el PC en busca de software no deseado.",
    "web.security.alert.untrusted":
      "La comprobación de los registros de seguridad de Psyche falló. Los dispositivos nuevos, los ajustes de seguridad y las aprobaciones con Windows Hello están bloqueados. Revisa tus dispositivos y luego ejecuta psyched security reseal en el PC; se aplica a las 24 horas.",
    "web.security.alert.firstAdmin":
      "Un comando en este PC convirtió {name} en el primer dispositivo administrador. Si no fuiste tú, revócalo en Dispositivos.",
    "web.security.alert.requested": "Pedido en este PC: {action} Se aplica el {when}.",
    "web.security.op.presenceReset":
      "dejar de pedir Windows Hello o una llave de acceso para los cambios de seguridad hasta que se registre una clave nueva.",
    "web.security.needsApprovalPresence":
      "Aprueba la tarjeta con Windows Hello o una llave de acceso y vuelve a pulsar el botón.",
    "web.security.needsApproval":
      "Aprueba la tarjeta con Windows Hello o una llave de acceso y vuelve a pulsar el botón.",
  },
  fr: {
    "notice.security.changed.body":
      "Un programme de ce PC a modifié {count, plural, =1 {# donnée de sécurité} other {# données de sécurité}} (appareils, clés, autorisations ou réglages) sans passer par Psyche{times, plural, =0 {} =1 {} other {, # fois jusqu’ici}}. Psyche {count, plural, =1 {l’a rétablie} other {les a rétablies}}. Si ce n’était pas vous, recherchez un logiciel indésirable sur ce PC.",
    "notice.security.untrusted.body":
      "La vérification des données de sécurité de Psyche a échoué, donc les modifications de sécurité, les nouveaux appareils et les approbations Windows Hello sont bloqués. Vérifiez vos appareils, puis exécutez psyched security reseal sur ce PC ; cela s’applique après 24 heures.",
    "notice.security.firstAdmin.title":
      "Une commande sur ce PC a créé le premier appareil administrateur",
    "notice.security.firstAdmin.body":
      "{device}{key, select, none {} other { (clé {key})}} est devenu le premier appareil administrateur {via, select, desktop {depuis l’application Psyche} other {via `psyched`}} sur ce PC. Si ce n’était pas vous, révoquez-le dans Paramètres → Appareils.",
    "notice.security.recovery.title":
      "{state, select, requested {Une commande sur ce PC a demandé une modification de sécurité} applied {Une modification de sécurité venant de ce PC a été appliquée} cancelled {Une modification de sécurité venant de ce PC a été annulée} other {Une modification de sécurité venant de ce PC n’a pas pu être appliquée}}",
    "notice.security.recovery.body":
      "{op, select, approve {Approuvez l’appareil {device}{key, select, none {} other { (clé {key})}} avec {scopes}.} grant {Donnez {scopes} à {device}{key, select, none {} other { (clé {key})}}.} presence {Ne plus exiger Windows Hello ni une clé d’accès pour les modifications de sécurité jusqu’à l’enregistrement d’une nouvelle clé.} seal {Acceptez les données de sécurité actuelles telles quelles.} other {Une modification de sécurité.}}{state, select, requested { Elle s’applique {when, select, none {dans 24 heures} other {le {when}}} sauf si vous l’annulez dans Psyche.} failed {{reason, select, none {} other { {reason}}}} other {}}",
    "screens.library.reveal": "Afficher dans le dossier",
    "web.security.banner.recovery":
      "{count, plural, one {Une modification de sécurité demandée sur ce PC s’applique le {when}, sauf si vous l’annulez.} other {# modifications de sécurité demandées sur ce PC sont en attente. La prochaine s’applique le {when}.}}",
    "web.security.alert.changed":
      "Un programme de ce PC a modifié {count, plural, one {1 donnée de sécurité} other {# données de sécurité}} sans passer par Psyche. Psyche {count, plural, one {l’a rétablie} other {les a rétablies}}. Si ce n’était pas vous, recherchez un logiciel indésirable sur ce PC.",
    "web.security.alert.untrusted":
      "La vérification des données de sécurité de Psyche a échoué. Les nouveaux appareils, les réglages de sécurité et les approbations Windows Hello sont bloqués. Vérifiez vos appareils, puis exécutez psyched security reseal sur le PC ; cela s’applique après 24 heures.",
    "web.security.alert.firstAdmin":
      "Une commande sur ce PC a fait de {name} le premier appareil administrateur. Si ce n’était pas vous, révoquez-le dans Appareils.",
    "web.security.alert.requested": "Demandé sur ce PC : {action} S’applique le {when}.",
    "web.security.op.presenceReset":
      "ne plus exiger Windows Hello ni de clé d’accès pour les modifications de sécurité jusqu’à l’enregistrement d’une nouvelle clé.",
    "web.security.needsApprovalPresence":
      "Approuvez la carte avec Windows Hello ou une clé d’accès, puis appuyez de nouveau sur le bouton.",
    "web.security.needsApproval":
      "Approuvez la carte avec Windows Hello ou une clé d’accès, puis appuyez de nouveau sur le bouton.",
  },
  hi: {
    "notice.security.changed.body":
      "इस PC पर एक प्रोग्राम ने Psyche के बिना {count, plural, =1 {# सुरक्षा रिकॉर्ड} other {# सुरक्षा रिकॉर्ड}} बदल दिए (डिवाइस, कुंजियाँ, अनुमतियाँ या सेटिंग्स){times, plural, =0 {} =1 {} other {, अब तक # बार}}। Psyche ने {count, plural, =1 {उसे} other {उन्हें}} वापस पहले जैसा कर दिया। अगर यह आपने नहीं किया, तो PC में अनचाहे सॉफ़्टवेयर की जाँच करें।",
    "notice.security.untrusted.body":
      "Psyche के सुरक्षा रिकॉर्ड की जाँच विफल रही, इसलिए सुरक्षा बदलाव, नए डिवाइस और Windows Hello से मंज़ूरी रोक दी गई हैं। अपने डिवाइस देखें, फिर इस PC पर psyched security reseal चलाएँ; यह 24 घंटे बाद लागू होता है।",
    "notice.security.firstAdmin.title": "इस PC पर एक कमांड ने पहला एडमिन डिवाइस बना दिया",
    "notice.security.firstAdmin.body":
      "{device}{key, select, none {} other { (कुंजी {key})}} {via, select, desktop {Psyche ऐप से} other {`psyched` के जरिए}} इस PC पर पहला एडमिन डिवाइस बन गया। अगर यह आपने नहीं किया, तो सेटिंग्स → डिवाइस में उसे रद्द करें।",
    "notice.security.recovery.title":
      "{state, select, requested {इस PC पर एक कमांड ने सुरक्षा बदलाव माँगा} applied {इस PC से एक सुरक्षा बदलाव लागू किया गया} cancelled {इस PC से एक सुरक्षा बदलाव रद्द किया गया} other {इस PC से एक सुरक्षा बदलाव लागू नहीं हो सका}}",
    "notice.security.recovery.body":
      "{op, select, approve {डिवाइस {device}{key, select, none {} other { (कुंजी {key})}} को {scopes} के साथ मंज़ूरी दें।} grant {{device}{key, select, none {} other { (कुंजी {key})}} को {scopes} दें।} presence {नई कुंजी दर्ज होने तक सुरक्षा बदलावों के लिए Windows Hello या पासकी न माँगें।} seal {मौजूदा सुरक्षा रिकॉर्ड जैसे हैं वैसे ही स्वीकार करें।} other {एक सुरक्षा बदलाव।}}{state, select, requested { यह {when, select, none {24 घंटे बाद} other {{when} को}} लागू होगा, जब तक आप इसे Psyche में रद्द न करें।} failed {{reason, select, none {} other { {reason}}}} other {}}",
    "screens.library.reveal": "फ़ोल्डर में दिखाएँ",
    "web.security.banner.recovery":
      "{count, plural, one {इस PC पर माँगा गया एक सुरक्षा बदलाव {when} को लागू होगा, जब तक आप इसे रद्द न करें।} other {इस PC पर माँगे गए # सुरक्षा बदलाव प्रतीक्षा में हैं। अगला {when} को लागू होगा।}}",
    "web.security.alert.changed":
      "इस PC पर एक प्रोग्राम ने Psyche के बिना {count, plural, one {1 सुरक्षा रिकॉर्ड} other {# सुरक्षा रिकॉर्ड}} बदल दिए। Psyche ने {count, plural, one {उसे} other {उन्हें}} वापस पहले जैसा कर दिया। अगर यह आपने नहीं किया, तो PC में अनचाहे सॉफ़्टवेयर की जाँच करें।",
    "web.security.alert.untrusted":
      "Psyche के सुरक्षा रिकॉर्ड की जाँच विफल रही। नए डिवाइस, सुरक्षा सेटिंग्स और Windows Hello से मंज़ूरी रोक दी गई हैं। अपने डिवाइस देखें, फिर PC पर psyched security reseal चलाएँ; यह 24 घंटे बाद लागू होता है।",
    "web.security.alert.firstAdmin":
      "इस PC पर एक कमांड ने {name} को पहला एडमिन डिवाइस बना दिया। अगर यह आपने नहीं किया, तो उसे डिवाइस में रद्द करें।",
    "web.security.alert.requested": "इस PC पर माँगा गया: {action} {when} को लागू होगा।",
    "web.security.op.presenceReset":
      "नई कुंजी दर्ज होने तक सुरक्षा बदलावों के लिए Windows Hello या पासकी न माँगना।",
    "web.security.needsApprovalPresence":
      "Windows Hello या पासकी से कार्ड को मंज़ूरी दें, फिर बटन दोबारा दबाएँ।",
    "web.security.needsApproval": "Windows Hello या पासकी से कार्ड को मंज़ूरी दें, फिर बटन दोबारा दबाएँ।",
  },
  it: {
    "notice.security.changed.body":
      "Un programma su questo PC ha modificato {count, plural, =1 {# dato di sicurezza} other {# dati di sicurezza}} (dispositivi, chiavi, autorizzazioni o impostazioni) senza passare da Psyche{times, plural, =0 {} =1 {} other {, # volte finora}}. Psyche {count, plural, =1 {l’ha ripristinato} other {li ha ripristinati}}. Se non sei stato tu, controlla il PC per software indesiderato.",
    "notice.security.untrusted.body":
      "Il controllo dei dati di sicurezza di Psyche non è riuscito, quindi le modifiche di sicurezza, i nuovi dispositivi e le approvazioni con Windows Hello sono bloccati. Controlla i tuoi dispositivi, poi esegui psyched security reseal su questo PC; si applica dopo 24 ore.",
    "notice.security.firstAdmin.title":
      "Un comando su questo PC ha creato il primo dispositivo amministratore",
    "notice.security.firstAdmin.body":
      "{device}{key, select, none {} other { (chiave {key})}} è diventato il primo dispositivo amministratore {via, select, desktop {dall’app Psyche} other {tramite `psyched`}} su questo PC. Se non sei stato tu, revocalo in Impostazioni → Dispositivi.",
    "notice.security.recovery.title":
      "{state, select, requested {Un comando su questo PC ha chiesto una modifica di sicurezza} applied {È stata applicata una modifica di sicurezza da questo PC} cancelled {È stata annullata una modifica di sicurezza da questo PC} other {Non è stato possibile applicare una modifica di sicurezza da questo PC}}",
    "notice.security.recovery.body":
      "{op, select, approve {Approva il dispositivo {device}{key, select, none {} other { (chiave {key})}} con {scopes}.} grant {Concedi a {device}{key, select, none {} other { (chiave {key})}} {scopes}.} presence {Non chiedere più Windows Hello o una passkey per le modifiche di sicurezza finché non viene registrata una nuova chiave.} seal {Accetta i dati di sicurezza attuali così come sono.} other {Una modifica di sicurezza.}}{state, select, requested { Si applica {when, select, none {dopo 24 ore} other {il {when}}}, a meno che tu non la annulli in Psyche.} failed {{reason, select, none {} other { {reason}}}} other {}}",
    "screens.library.reveal": "Mostra nella cartella",
    "web.security.banner.recovery":
      "{count, plural, one {Una modifica di sicurezza richiesta su questo PC si applica il {when}, a meno che tu non la annulli.} other {# modifiche di sicurezza richieste su questo PC sono in attesa. La prossima si applica il {when}.}}",
    "web.security.alert.changed":
      "Un programma su questo PC ha modificato {count, plural, one {1 dato di sicurezza} other {# dati di sicurezza}} senza passare da Psyche. Psyche {count, plural, one {l’ha ripristinato} other {li ha ripristinati}}. Se non sei stato tu, controlla il PC per software indesiderato.",
    "web.security.alert.untrusted":
      "Il controllo dei dati di sicurezza di Psyche non è riuscito. Nuovi dispositivi, impostazioni di sicurezza e approvazioni con Windows Hello sono bloccati. Controlla i tuoi dispositivi, poi esegui psyched security reseal sul PC; si applica dopo 24 ore.",
    "web.security.alert.firstAdmin":
      "Un comando su questo PC ha reso {name} il primo dispositivo amministratore. Se non sei stato tu, revocalo in Dispositivi.",
    "web.security.alert.requested": "Richiesto su questo PC: {action} Si applica il {when}.",
    "web.security.op.presenceReset":
      "non chiedere più Windows Hello o una passkey per le modifiche di sicurezza finché non viene registrata una nuova chiave.",
    "web.security.needsApprovalPresence":
      "Approva la scheda con Windows Hello o una passkey, poi premi di nuovo il pulsante.",
    "web.security.needsApproval":
      "Approva la scheda con Windows Hello o una passkey, poi premi di nuovo il pulsante.",
  },
  ja: {
    "notice.security.changed.body":
      "この PC 上のプログラムが Psyche を通さずに、セキュリティ記録（デバイス、キー、権限または設定）を {count, plural, other {# 件}}変更しました{times, plural, =0 {} =1 {} other {（これまでに # 回）}}。Psyche は元に戻しました。心当たりがない場合は、PC に不要なソフトウェアがないか確認してください。",
    "notice.security.untrusted.body":
      "Psyche のセキュリティ記録の確認に失敗したため、セキュリティ変更、新しいデバイス、Windows Hello による承認はブロックされています。デバイスを確認してから、この PC で psyched security reseal を実行してください。24 時間後に適用されます。",
    "notice.security.firstAdmin.title":
      "この PC のコマンドにより、最初の管理者デバイスが作成されました",
    "notice.security.firstAdmin.body":
      "{device}{key, select, none {} other {（キー {key}）}}は、{via, select, desktop {Psyche アプリから} other {`psyched` を通じて}}この PC で最初の管理者デバイスになりました。心当たりがない場合は、設定 → デバイスで取り消してください。",
    "notice.security.recovery.title":
      "{state, select, requested {この PC のコマンドがセキュリティ変更を要求しました} applied {この PC からのセキュリティ変更が適用されました} cancelled {この PC からのセキュリティ変更が取り消されました} other {この PC からのセキュリティ変更は適用できませんでした}}",
    "notice.security.recovery.body":
      "{op, select, approve {デバイス {device}{key, select, none {} other {（キー {key}）}} を {scopes} で承認してください。} grant {{device}{key, select, none {} other {（キー {key}）}} に {scopes} を付与してください。} presence {新しいキーが登録されるまで、セキュリティ変更に Windows Hello やパスキーを求めないようにします。} seal {現在のセキュリティ記録をそのまま受け入れてください。} other {セキュリティ変更。}}{state, select, requested { {when, select, none {24 時間後} other {{when}}}に適用されます。Psyche で取り消すこともできます。} failed {{reason, select, none {} other { {reason}}}} other {}}",
    "screens.library.reveal": "フォルダーで表示",
    "web.security.banner.recovery":
      "{count, plural, other {この PC で要求されたセキュリティ変更が # 件待機中です。次の変更はキャンセルしない限り {when} に適用されます。}}",
    "web.security.alert.changed":
      "この PC 上のプログラムが Psyche を通さずにセキュリティ記録を {count} 件変更しました。Psyche は元に戻しました。心当たりがない場合は、PC に不要なソフトウェアがないか確認してください。",
    "web.security.alert.untrusted":
      "Psyche のセキュリティ記録の確認に失敗しました。新しいデバイス、セキュリティ設定、Windows Hello による承認はブロックされています。デバイスを確認してから、PC で psyched security reseal を実行してください。24 時間後に適用されます。",
    "web.security.alert.firstAdmin":
      "この PC のコマンドにより、{name} が最初の管理者デバイスになりました。心当たりがない場合は、デバイスで取り消してください。",
    "web.security.alert.requested": "この PC で要求: {action} {when} に適用されます。",
    "web.security.op.presenceReset":
      "新しいキーが登録されるまで、セキュリティ変更に Windows Hello やパスキーを求めない。",
    "web.security.needsApprovalPresence":
      "Windows Hello またはパスキーでカードを承認してから、もう一度ボタンを押してください。",
    "web.security.needsApproval":
      "Windows Hello またはパスキーでカードを承認してから、もう一度ボタンを押してください。",
  },
  ko: {
    "notice.security.changed.body":
      "이 PC의 프로그램이 Psyche를 거치지 않고 보안 기록(기기, 키, 권한 또는 설정) {count}건을 변경했습니다{times, plural, =0 {} =1 {} other {(지금까지 #회)}}. Psyche가 원래대로 되돌렸습니다. 본인이 한 일이 아니라면 PC에 원치 않는 소프트웨어가 있는지 확인하세요.",
    "notice.security.untrusted.body":
      "Psyche 보안 기록 확인에 실패해 보안 변경, 새 기기, Windows Hello 승인이 차단됩니다. 기기를 확인한 다음 이 PC에서 psyched security reseal을 실행하세요. 24시간 후에 적용됩니다.",
    "notice.security.firstAdmin.title": "이 PC의 명령으로 첫 관리자 기기가 만들어졌습니다",
    "notice.security.firstAdmin.body":
      "{device}{key, select, none {} other { (키 {key})}}이(가) {via, select, desktop {Psyche 앱에서} other {`psyched`를 통해}} 이 PC의 첫 관리자 기기가 되었습니다. 본인이 한 일이 아니라면 설정 → 기기에서 취소하세요.",
    "notice.security.recovery.title":
      "{state, select, requested {이 PC의 명령으로 보안 변경이 요청되었습니다} applied {이 PC에서 요청한 보안 변경이 적용되었습니다} cancelled {이 PC에서 요청한 보안 변경이 취소되었습니다} other {이 PC에서 요청한 보안 변경을 적용하지 못했습니다}}",
    "notice.security.recovery.body":
      "{op, select, approve {{device}{key, select, none {} other { (키 {key})}} 기기를 {scopes} 조건으로 승인하세요.} grant {{device}{key, select, none {} other { (키 {key})}}에 {scopes}을(를) 부여하세요.} presence {새 키가 등록될 때까지 보안 변경에 Windows Hello나 패스키를 요구하지 않습니다.} seal {현재 보안 기록을 그대로 받아들이세요.} other {보안 변경.}}{state, select, requested { {when, select, none {24시간 후} other {{when}}}에 적용되며, Psyche에서 취소할 수 있습니다.} failed {{reason, select, none {} other { {reason}}}} other {}}",
    "screens.library.reveal": "폴더에서 보기",
    "web.security.banner.recovery":
      "{count, plural, other {이 PC에서 요청된 보안 변경 #건이 대기 중입니다. 다음 변경은 취소하지 않으면 {when}에 적용됩니다.}}",
    "web.security.alert.changed":
      "이 PC의 프로그램이 Psyche를 거치지 않고 보안 기록 {count}건을 변경했습니다. Psyche가 원래대로 되돌렸습니다. 본인이 한 일이 아니라면 PC에 원치 않는 소프트웨어가 있는지 확인하세요.",
    "web.security.alert.untrusted":
      "Psyche 보안 기록 확인에 실패했습니다. 새 기기, 보안 설정, Windows Hello 승인이 차단됩니다. 기기를 확인한 다음 PC에서 psyched security reseal을 실행하세요. 24시간 후에 적용됩니다.",
    "web.security.alert.firstAdmin":
      "이 PC의 명령으로 {name}이(가) 첫 관리자 기기가 되었습니다. 본인이 한 일이 아니라면 기기에서 취소하세요.",
    "web.security.alert.requested": "이 PC에서 요청됨: {action} {when}에 적용됩니다.",
    "web.security.op.presenceReset":
      "새 키가 등록될 때까지 보안 변경에 Windows Hello나 패스키를 요구하지 않음.",
    "web.security.needsApprovalPresence":
      "Windows Hello나 패스키로 카드를 승인한 다음 버튼을 다시 누르세요.",
    "web.security.needsApproval":
      "Windows Hello나 패스키로 카드를 승인한 다음 버튼을 다시 누르세요.",
  },
  pt: {
    "notice.security.changed.body":
      "Um programa neste PC alterou {count, plural, =1 {# registro de segurança} other {# registros de segurança}} (dispositivos, chaves, permissões ou configurações) sem passar pelo Psyche{times, plural, =0 {} =1 {} other {, # vezes até agora}}. O Psyche os restaurou. Se não foi você, verifique se há software indesejado no PC.",
    "notice.security.untrusted.body":
      "A verificação dos registros de segurança do Psyche falhou, então alterações de segurança, novos dispositivos e aprovações com Windows Hello estão bloqueados. Revise seus dispositivos e depois execute psyched security reseal neste PC; isso é aplicado após 24 horas.",
    "notice.security.firstAdmin.title":
      "Um comando neste PC criou o primeiro dispositivo administrador",
    "notice.security.firstAdmin.body":
      "{device}{key, select, none {} other { (chave {key})}} tornou-se o primeiro dispositivo administrador {via, select, desktop {pelo app Psyche} other {por meio do `psyched`}} neste PC. Se não foi você, revogue-o em Configurações → Dispositivos.",
    "notice.security.recovery.title":
      "{state, select, requested {Um comando neste PC pediu uma alteração de segurança} applied {Uma alteração de segurança deste PC foi aplicada} cancelled {Uma alteração de segurança deste PC foi cancelada} other {Uma alteração de segurança deste PC não pôde ser aplicada}}",
    "notice.security.recovery.body":
      "{op, select, approve {Aprove o dispositivo {device}{key, select, none {} other { (chave {key})}} com {scopes}.} grant {Conceda {scopes} a {device}{key, select, none {} other { (chave {key})}}.} presence {Deixar de exigir Windows Hello ou uma chave de acesso para alterações de segurança até que uma nova chave seja registrada.} seal {Aceite os registros de segurança atuais como estão.} other {Uma alteração de segurança.}}{state, select, requested { Será aplicada {when, select, none {em 24 horas} other {em {when}}}, a menos que você a cancele no Psyche.} failed {{reason, select, none {} other { {reason}}}} other {}}",
    "screens.library.reveal": "Mostrar na pasta",
    "web.security.banner.recovery":
      "{count, plural, one {Uma alteração de segurança pedida neste PC será aplicada em {when}, a menos que você a cancele.} other {# alterações de segurança pedidas neste PC estão aguardando. A próxima será aplicada em {when}.}}",
    "web.security.alert.changed":
      "Um programa neste PC alterou {count, plural, one {1 registro de segurança} other {# registros de segurança}} sem passar pelo Psyche. O Psyche {count, plural, one {o restaurou} other {os restaurou}}. Se não foi você, verifique se há software indesejado no PC.",
    "web.security.alert.untrusted":
      "A verificação dos registros de segurança do Psyche falhou. Novos dispositivos, ajustes de segurança e aprovações com Windows Hello estão bloqueados. Revise seus dispositivos e depois execute psyched security reseal no PC; isso é aplicado após 24 horas.",
    "web.security.alert.firstAdmin":
      "Um comando neste PC tornou {name} o primeiro dispositivo administrador. Se não foi você, revogue-o em Dispositivos.",
    "web.security.alert.requested": "Pedido neste PC: {action} Será aplicado em {when}.",
    "web.security.op.presenceReset":
      "deixar de exigir Windows Hello ou uma chave de acesso para alterações de segurança até que uma nova chave seja registrada.",
    "web.security.needsApprovalPresence":
      "Aprove o cartão com Windows Hello ou uma chave de acesso e toque no botão de novo.",
    "web.security.needsApproval":
      "Aprove o cartão com Windows Hello ou uma chave de acesso e toque no botão de novo.",
  },
  zh: {
    "notice.security.changed.body":
      "这台 PC 上的某个程序绕过 Psyche 更改了 {count} 条安全记录（设备、密钥、授权或设置）{times, plural, =0 {} =1 {} other {，累计 # 次}}。Psyche 已将其恢复。如果不是你做的，请检查这台 PC 上是否有不需要的软件。",
    "notice.security.untrusted.body":
      "Psyche 的安全记录检查失败，因此安全更改、新设备和 Windows Hello 批准已被阻止。请检查你的设备，然后在这台 PC 上运行 psyched security reseal；它将在 24 小时后生效。",
    "notice.security.firstAdmin.title": "这台 PC 上的一条命令创建了第一台管理员设备",
    "notice.security.firstAdmin.body":
      "{device}{key, select, none {} other {（密钥 {key}）}}{via, select, desktop {通过 Psyche 应用} other {通过 `psyched`}}在这台 PC 上成为了第一台管理员设备。如果不是你做的，请在“设置 → 设备”中撤销它。",
    "notice.security.recovery.title":
      "{state, select, requested {这台 PC 上的一条命令请求了安全更改} applied {这台 PC 发起的安全更改已应用} cancelled {这台 PC 发起的安全更改已取消} other {这台 PC 发起的安全更改无法应用}}",
    "notice.security.recovery.body":
      "{op, select, approve {使用 {scopes} 批准设备 {device}{key, select, none {} other {（密钥 {key}）}}。} grant {向 {device}{key, select, none {} other {（密钥 {key}）}} 授予 {scopes}。} presence {在注册新密钥之前，安全更改不再需要 Windows Hello 或通行密钥。} seal {按原样接受当前的安全记录。} other {一项安全更改。}}{state, select, requested {将于 {when, select, none {24 小时后} other {{when}}} 生效，除非你在 Psyche 中取消。} failed {{reason, select, none {} other { {reason}}}} other {}}",
    "screens.library.reveal": "在文件夹中显示",
    "web.security.banner.recovery":
      "{count, plural, other {在这台 PC 上请求的 # 项安全更改正在等待。除非你取消，下一项将于 {when} 生效。}}",
    "web.security.alert.changed":
      "这台 PC 上的某个程序绕过 Psyche 更改了 {count} 条安全记录。Psyche 已将其恢复。如果不是你做的，请检查这台 PC 上是否有不需要的软件。",
    "web.security.alert.untrusted":
      "Psyche 的安全记录检查失败。新设备、安全设置和Windows Hello 批准已被阻止。请检查你的设备，然后在 PC 上运行 psyched security reseal；它将在 24 小时后生效。",
    "web.security.alert.firstAdmin":
      "这台 PC 上的一条命令将 {name} 设为第一台管理员设备。如果不是你做的，请在“设备”中撤销它。",
    "web.security.alert.requested": "在这台 PC 上请求：{action} 将于 {when} 生效。",
    "web.security.op.presenceReset": "在注册新密钥之前，安全更改不再需要Windows Hello 或通行密钥。",
    "web.security.needsApprovalPresence":
      "请用Windows Hello 或通行密钥批准卡片，然后再次按下按钮。",
    "web.security.needsApproval": "请用Windows Hello 或通行密钥批准卡片，然后再次按下按钮。",
  },
};
