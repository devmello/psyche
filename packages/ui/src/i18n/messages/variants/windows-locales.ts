import type { MessageId } from "../index.ts";

/**
 * Translations of the Windows variants (`./windows.ts`), by message locale. A message missing here
 * shows the English variant on Windows.
 */
export const WINDOWS_LOCALES: Readonly<
  Record<string, Readonly<Partial<Record<MessageId, string>>>>
> = {
  ar: {
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
    "web.security.needsApproval":
      "وافق على البطاقة بـ Windows Hello أو مفتاح مرور، ثم اضغط الزر مرة أخرى.",
  },
  de: {
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
    "web.security.needsApproval":
      "Bestätige die Karte mit Windows Hello oder einem Passkey und tippe dann erneut auf die Taste.",
  },
  es: {
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
    "web.security.needsApproval":
      "Aprueba la tarjeta con Windows Hello o una llave de acceso y vuelve a pulsar el botón.",
  },
  fr: {
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
    "web.security.needsApproval":
      "Approuvez la carte avec Windows Hello ou une clé d’accès, puis appuyez de nouveau sur le bouton.",
  },
  hi: {
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
    "web.security.needsApproval": "Windows Hello या पासकी से कार्ड को मंज़ूरी दें, फिर बटन दोबारा दबाएँ।",
  },
  it: {
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
    "web.security.needsApproval":
      "Approva la scheda con Windows Hello o una passkey, poi premi di nuovo il pulsante.",
  },
  ja: {
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
    "web.security.needsApproval":
      "Windows Hello またはパスキーでカードを承認してから、もう一度ボタンを押してください。",
  },
  ko: {
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
    "web.security.needsApproval":
      "Windows Hello나 패스키로 카드를 승인한 다음 버튼을 다시 누르세요.",
  },
  pt: {
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
    "web.security.needsApproval":
      "Aprove o cartão com Windows Hello ou uma chave de acesso e toque no botão de novo.",
  },
  zh: {
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
    "web.security.needsApproval": "请用Windows Hello 或通行密钥批准卡片，然后再次按下按钮。",
  },
};
