import type { Catalogue } from "../../index.ts";

/** Notices the Gateway authors (hi); merged into `../hi.ts`. */
export const notices: Partial<Catalogue> = {
  "notice.security.changed.title": "Psyche ने ऐप के बाहर किया गया सुरक्षा बदलाव पलट दिया",
  "notice.security.changed.body":
    "इस Mac पर किसी प्रोग्राम ने Psyche से गुज़रे बिना {count, plural, =1 {# सुरक्षा रिकॉर्ड} other {# सुरक्षा रिकॉर्ड}} (डिवाइस, कुंजियाँ, अनुमतियाँ या सेटिंग) बदल दिए{times, plural, =0 {} =1 {} other {, अब तक # बार}}। Psyche ने उन्हें वापस ठीक कर दिया। अगर यह आपने नहीं किया, तो Mac में अनचाहे सॉफ़्टवेयर की जाँच करें।",
  "notice.security.untrusted.title": "Psyche अपने सुरक्षा रिकॉर्ड पर भरोसा नहीं कर सकता",
  "notice.security.untrusted.body":
    "Psyche के सुरक्षा रिकॉर्ड की जाँच विफल रही, इसलिए सुरक्षा बदलाव, नए डिवाइस और Touch ID से मंज़ूरियाँ रोक दी गई हैं। अपने डिवाइस देखें, फिर Mac पर `psyched security reseal` चलाएँ (यह 24 घंटे बाद लागू होता है)।",
  "notice.security.firstSeal.title": "Psyche अब अपने सुरक्षा रिकॉर्ड की जाँच करता है",
  "notice.security.firstSeal.body":
    "Psyche ने {devices, plural, =1 {# पेयर किया गया डिवाइस} other {# पेयर किए गए डिवाइस}} और अपनी सुरक्षा सेटिंग सील कर दीं। अब से Psyche के बाहर किया गया कोई भी बदलाव पलट दिया जाएगा और यहाँ दिखेगा। अपने डिवाइस एक बार देख लें।",
  "notice.security.resealed.title":
    "{restored, select, yes {रिस्टोर के बाद सुरक्षा रिकॉर्ड सील किए गए} other {सुरक्षा रिकॉर्ड फिर से सील किए गए}}",
  "notice.security.resealed.body":
    "{restored, select, yes {Psyche रिस्टोर किए गए बैकअप से शुरू हुआ और उसने सुरक्षा रिकॉर्ड जैसे हैं वैसे ही सील कर दिए। अगर आपने बैकअप रिस्टोर नहीं किया, तो अपने डिवाइस देखें।} other {प्रतीक्षा अवधि के बाद Psyche ने अपने सुरक्षा रिकॉर्ड फिर से सील कर दिए।}}",
  "notice.security.firstAdmin.title": "इस Mac पर एक कमांड ने पहला एडमिन डिवाइस बनाया",
  "notice.security.firstAdmin.body":
    "{device}{key, select, none {} other { (कुंजी {key})}} इस Mac पर {via, select, desktop {Psyche ऐप से} other {`psyched` के ज़रिए}} पहला एडमिन डिवाइस बन गया। अगर यह आपने नहीं किया, तो इसे सेटिंग → डिवाइस में रद्द करें।",
  "notice.security.recovery.title":
    "{state, select, requested {इस Mac पर एक कमांड ने सुरक्षा बदलाव माँगा} applied {इस Mac से आया सुरक्षा बदलाव लागू हो गया} cancelled {इस Mac से आया सुरक्षा बदलाव रद्द कर दिया गया} other {इस Mac से आया सुरक्षा बदलाव लागू नहीं हो सका}}",
  "notice.security.recovery.body":
    "{op, select, approve {डिवाइस {device}{key, select, none {} other { (कुंजी {key})}} को {scopes} के साथ मंज़ूरी दें।} grant {{device}{key, select, none {} other { (कुंजी {key})}} को {scopes} दें।} presence {नई कुंजी रजिस्टर होने तक सुरक्षा बदलावों के लिए Touch ID और पासकी की ज़रूरत बंद करें।} seal {मौजूदा सुरक्षा रिकॉर्ड जैसे हैं वैसे ही स्वीकार करें।} other {एक सुरक्षा बदलाव।}}{state, select, requested { यह {when, select, none {24 घंटे में} other {{when} को}} लागू होगा, जब तक आप इसे Psyche में रद्द न करें।} failed {{reason, select, none {} other { {reason}}}} other {}}",
  "notice.browser.chrome.title": "Psyche आपका Chrome चला रहा है",
  "notice.browser.chrome.body":
    "एक टास्क Psyche के Chrome प्रोफ़ाइल का उपयोग कर रहा है, जिसमें आप साइन इन हैं। उसकी विंडो के शीर्षक में “Psyche is driving this window” लिखा है। टास्क पूरा होने पर वह बंद हो जाता है; आप Chrome को खुद भी बंद कर सकते हैं।",
  "notice.browser.takeover.title": "Psyche को ब्राउज़र में आपकी ज़रूरत है",
  "notice.browser.takeover.body":
    "{host} पर एजेंट पूछ रहा है: {reason}। ब्राउज़र पेन में नियंत्रण अपने हाथ में लें, फिर उसे वापस सौंप दें।",
  "notice.connector.consent.title": "Google का कनेक्शन पूरा करें",
  "notice.connector.consent.body":
    "पहुँच देने के लिए यह लिंक उस कंप्यूटर पर खोलें जिस पर Psyche चल रहा है: {url}",
  "notice.connector.changed.title": "एक कनेक्शन बदल गया",
  "notice.connector.changed.body":
    "{reason, select, account_changed {एक कनेक्टर अब किसी दूसरे खाते में साइन इन करता है। पुराने खाते से जुड़ा काम रोक दिया गया।} disconnected {एक कनेक्टर डिस्कनेक्ट हो गया। जिस काम को उसकी ज़रूरत थी वह रोक दिया गया।} scope_changed {एक कनेक्टर अब केवल पढ़ने के लिए है। उसके ज़रिए लंबित कार्रवाइयाँ रोक दी गईं।} other {एक कनेक्टर की पहुँच रद्द कर दी गई। उसका उपयोग जारी रखने के लिए फिर से साइन इन करें।}}",
  "notice.connector.reconnect.title": "फिर से कनेक्ट करना होगा",
  "notice.connector.reconnect.body": "एक कनेक्टर की पहुँच खत्म हो गई है; आपको फिर से साइन इन करना होगा।",
  "notice.attention.paused.title": "एक टास्क आपका इंतज़ार कर रहा है",
  "notice.attention.paused.body":
    "किसी संवेदनशील ऐप या साइट पर {tool} से पहले रोक दिया गया, जब तक आप Psyche में वापस नहीं आते।",
  "notice.apiKey.changed.title":
    "{kind, select, brave {{provider} कुंजी {action, select, changed {बदली गई} other {हटाई गई}}} other {{provider} API कुंजी {action, select, changed {बदली गई} other {हटाई गई}}}}",
  "notice.apiKey.changed.body":
    '{action, select, changed {बदलाव} other {हटाना}} इस डिवाइस से हुआ: {device, select, none {एक डिवाइस} other {"{device}" ({platform}{paired, select, none {} other {, पेयर किया गया {paired}}})}}। अगर यह आपने नहीं किया, तो सेटिंग → डिवाइस में उस डिवाइस को रद्द करें।',
  "notice.approvals.digest.title":
    "{count, plural, =1 {आपके स्वचालनों की # कार्रवाई इंतज़ार कर रही है} other {आपके स्वचालनों की # कार्रवाइयाँ इंतज़ार कर रही हैं}}",
  "notice.approvals.digest.body": "उन्हें मंज़ूर या अस्वीकार करने के लिए मंज़ूरियाँ खोलें",
  "notice.approvals.resumeMissed.title":
    "{automation, select, none {स्वचालन की मंज़ूर की गई कार्रवाई नहीं हुई} other {{automation}: मंज़ूर की गई कार्रवाई नहीं हुई}}",
  "notice.approvals.resumeMissed.body":
    "{why, select, expired {स्वचालन के कार्रवाई तक पहुँचने से पहले मंज़ूरी की अवधि खत्म हो गई, इसलिए कुछ नहीं हुआ।} paused {स्वचालन रुका हुआ है या हटा दिया गया, इसलिए वह फिर से नहीं चला और कुछ नहीं हुआ।} restart {स्वचालन के फिर से चलने से पहले Psyche फिर से शुरू हो गया, इसलिए कुछ नहीं हुआ।} other {स्वचालन फिर से चला, लेकिन उसी कार्रवाई तक नहीं पहुँचा, इसलिए कुछ नहीं हुआ।}} अगर उसे अब भी इसकी ज़रूरत है, तो वह फिर से पूछेगा।",
  "notice.specialist.result.title":
    "{outcome, select, done {{who} ने {title} पूरा किया} partial {{who} ने {title} पर जल्दी रोक दिया} cancelled {{who} को {title} पर रोका गया} other {{who} {title} पूरा नहीं कर सका}}",
  "notice.specialist.result.body":
    "{outcome, select, done {पूरा} partial {आंशिक} cancelled {रद्द} other {विफल}}{findings, plural, =0 {} other { · # निष्कर्ष}}{cost, select, none {} other { · {cost}}} · {minutes, plural, =0 {1 मिनट से कम} other {# मिनट}}",
  "notice.mcp.changed.title": "MCP सर्वर {server} ने अपने टूल बदले",
  "notice.mcp.suspicious.title": "MCP सर्वर {server} में संदिग्ध टूल विवरण हैं",
  "notice.mcp.review.body": "इस सर्वर का उपयोग करने से पहले देखें: {details}",
};
