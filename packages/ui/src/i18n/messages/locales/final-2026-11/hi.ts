import type { Catalogue } from "../../index.ts";

/** Signed connector bundles and teach-by-showing in Mac apps (hi); merged into `../hi.ts`. */
export const final202611: Partial<Catalogue> = {
  "settings.connectorBundle.title": "साझा किया गया कनेक्टर {name}",
  "settings.connectorBundle.intro":
    "किसी ने यह कनेक्टर फ़ाइल के रूप में साझा किया है। अभी कुछ भी इंस्टॉल नहीं हुआ है। देखें कि इसे किसने बनाया और यह क्या माँगता है, फिर तय करें।",
  "settings.connectorBundle.update": "यह आपके पास मौजूद कनेक्टर का अपडेट है।",
  "settings.connectorBundle.signer.title": "इसे किसने बनाया",
  "settings.connectorBundle.signer.unsigned":
    "यह फ़ाइल हस्ताक्षरित नहीं है, इसलिए यह जानने का कोई तरीका नहीं कि इसे किसने बनाया।",
  "settings.connectorBundle.signer.dropped": "इंस्टॉल किया संस्करण हस्ताक्षरित था। यह नहीं है।",
  "settings.connectorBundle.signer.new": "{name} द्वारा हस्ताक्षरित। आपने यह कुंजी पहले नहीं देखी।",
  "settings.connectorBundle.signer.seen":
    "{name} द्वारा हस्ताक्षरित, ऐसी कुंजी से जो आपने पहले देखी है लेकिन जिस पर भरोसा नहीं किया।",
  "settings.connectorBundle.signer.trusted":
    "{name} द्वारा हस्ताक्षरित, एक लेखक जिस पर आप भरोसा करते हैं।",
  "settings.connectorBundle.signer.own": "आपके द्वारा हस्ताक्षरित।",
  "settings.connectorBundle.signer.changed":
    "{name} द्वारा हस्ताक्षरित, लेकिन पहले देखी कुंजी से नहीं। जाँच लें कि यह वही व्यक्ति है।",
  "settings.connectorBundle.signer.impersonates":
    "आपके नाम जैसे दिखने वाले नाम से हस्ताक्षरित, ऐसी कुंजी से जो आपकी नहीं है।",
  "settings.connectorBundle.signer.nameChanged":
    "जिस कुंजी पर आप भरोसा करते हैं, वह ऐसे नाम से हस्ताक्षर कर रही है जो उसने पहले कभी इस्तेमाल नहीं किया: {name}।",
  "settings.connectorBundle.signer.revoked": "ऐसी कुंजी से हस्ताक्षरित जिसे आपने रद्द कर दिया था।",
  "settings.connectorBundle.signer.rotated":
    "{name} द्वारा हस्ताक्षरित: वही लेखक, नई कुंजी (पुरानी कुंजी से हस्ताक्षरित)। नई कुंजी पर तब तक भरोसा नहीं किया जाता जब तक आप खुद उस पर भरोसा न करें।",
  "settings.connectorBundle.signer.claim": "नाम लेखक का अपना दावा है। उसे केवल कुंजी पहचानती है।",
  "settings.connectorBundle.signer.key": "लेखक की कुंजी",
  "settings.connectorBundle.signer.trust": "{name} को भरोसेमंद लेखक मानें",
  "settings.connectorBundle.signer.trustHint":
    "इससे केवल बाद की फ़ाइलों का लेबल और चेतावनियाँ बदलती हैं। यह इस कार्ड को कभी नहीं छोड़ता।",
  "settings.connectorBundle.command": "यह जो कमांड चलाता है",
  "settings.connectorBundle.commandHint":
    "पहले प्रोग्राम, फिर हर आर्ग्युमेंट अलग लाइन में। इसे शेल के ज़रिए नहीं चलाया जाता।",
  "settings.connectorBundle.network": "यह जो नेटवर्क माँगता है",
  "settings.connectorBundle.noNetwork": "कोई नेटवर्क नहीं",
  "settings.connectorBundle.networkHint":
    "इसे केवल सैंडबॉक्स लागू कर सकता है। यह सूची वही है जो लेखक बताता है।",
  "settings.connectorBundle.env": "यह जो वेरिएबल पढ़ता है",
  "settings.connectorBundle.noEnv": "कोई नहीं",
  "settings.connectorBundle.envHint": "केवल नाम। इंस्टॉल करने के बाद आप इन्हें मान देते हैं।",
  "settings.connectorBundle.secrets": "इसे जिन सीक्रेट की ज़रूरत है",
  "settings.connectorBundle.noSecrets": "कोई नहीं",
  "settings.connectorBundle.secretsHint":
    "केवल नाम। फ़ाइल में कोई सीक्रेट नहीं होता। इंस्टॉल करने के बाद आप हर एक को मान देते हैं, और वह आपके वॉल्ट में रखा जाता है।",
  "settings.connectorBundle.tools": "लेखक के अनुसार इसमें सूचीबद्ध टूल",
  "settings.connectorBundle.toolsCount": "{n, plural, one {# टूल} other {# टूल}}",
  "settings.connectorBundle.toolsHint":
    "Psyche इसे सैंडबॉक्स में शुरू करता है और जो यह सचमुच देता है उसकी सूची बनाता है। वही टूल मायने रखते हैं।",
  "settings.connectorBundle.toolsUndeclared":
    "सर्वर ने ऐसे टूल सूचीबद्ध किए जो फ़ाइल में घोषित नहीं थे: {names}",
  "settings.connectorBundle.toolsMissing": "फ़ाइल में ऐसे टूल घोषित थे जो सर्वर ने सूचीबद्ध नहीं किए: {names}",
  "settings.connectorBundle.files": "इसके साथ आने वाली स्क्रिप्ट ({n})",
  "settings.connectorBundle.file": "{path} · {bytes} B",
  "settings.connectorBundle.fileBinary": "यह टेक्स्ट नहीं है, इसलिए यहाँ नहीं दिखाया जा सकता।",
  "settings.connectorBundle.findings": "जाँच में क्या मिला",
  "settings.connectorBundle.finding.high": "इंस्टॉल होने से रोकता है: {message}",
  "settings.connectorBundle.finding.warn": "जाँचें: {message}",
  "settings.connectorBundle.finding.info": "{message}",
  "settings.connectorBundle.sandbox.srt":
    "पहली बार यह सैंडबॉक्स में चलता है। Psyche इसके टूल की सूची बनाने के लिए इसे वहीं शुरू करता है, और यह वहीं चलता रहता है।",
  "settings.connectorBundle.sandbox.container":
    "पहली बार यह सैंडबॉक्स कंटेनर में चलता है। Psyche इसके टूल की सूची बनाने के लिए इसे वहीं शुरू करता है, और यह वहीं चलता रहता है।",
  "settings.connectorBundle.sandbox.none":
    "इस Mac में कमांड कनेक्टर के लिए कोई सैंडबॉक्स नहीं है, और Psyche कभी इन्हें उसके बाहर नहीं चलाता। यह कनेक्टर यहाँ इंस्टॉल नहीं हो सकता। कुछ भी शुरू या सहेजा नहीं गया।",
  "settings.connectorBundle.blocker.scan":
    "जाँच में कुछ ऐसा मिला जो इसे इंस्टॉल होने से रोकता है। कुछ भी शुरू या सहेजा नहीं गया।",
  "settings.connectorBundle.blocker.probe_failed":
    "बिना नेटवर्क और बिना सीक्रेट के पहली बार चलाने पर यह शुरू नहीं हो सका। कुछ भी सहेजा नहीं गया।",
  "settings.connectorBundle.signer.ownRetired":
    "आपकी ऐसी कुंजी से हस्ताक्षरित जिसे आपने बदल दिया था। अब इसे आपकी नहीं माना जाता।",
  "settings.connectorBundle.signer.retired":
    "{name} द्वारा हस्ताक्षरित, ऐसी कुंजी से जिसे उस रोटेशन में बदला गया जो आपने देखा है। इससे आई नई फ़ाइल संदिग्ध है।",
  "settings.connectorBundle.carry.kept": "आपके दिए जो मान बने रहेंगे: {names}",
  "settings.connectorBundle.carry.cleared":
    "आपके दिए जो मान आगे नहीं ले जाए जाते, क्योंकि हस्ताक्षरकर्ता या कमांड बदल गया है। इन्हें फिर से दर्ज करें: {names}",
  "settings.connectorBundle.carry.vault":
    "आपने पहले जो सीक्रेट रखे थे वे आपके वॉल्ट में रहते हैं, लेकिन इस संस्करण को नहीं दिए जाते।",
  "settings.connectorBundle.reset.title": "अगर साझा कनेक्टर का रिकॉर्ड क्षतिग्रस्त हो",
  "settings.connectorBundle.reset.hint":
    "फ़ाइल से आए कनेक्टर तब तक बंद रहते हैं जब तक उनका रिकॉर्ड पढ़ा न जा सके। इससे क्षतिग्रस्त रिकॉर्ड अलग रख दिया जाता है (अगर कोई अच्छी कॉपी है तो उसे बहाल किया जाता है); वे कनेक्टर तब तक बंद रहते हैं जब तक आप उन्हें हटा न दें या दोबारा इंपोर्ट न करें।",
  "settings.connectorBundle.reset.go": "रिकॉर्ड रीसेट करें…",
  "settings.connectorBundle.reset.confirm": "हाँ, रीसेट करें",
  "settings.connectorBundle.reset.done":
    "रिकॉर्ड रीसेट हो गया। {restored, select, true {आखिरी अच्छी कॉपी बहाल कर दी गई।} other {यह खाली शुरू होता है।}}",
  "settings.connectorBundle.reset.failed": "रिकॉर्ड रीसेट नहीं हो सका: {reason}",
  "settings.connectorBundle.hash": "बंडल आईडी",
  "settings.connectorBundle.close": "बंद करें",
  "settings.connectorBundle.widened.title": "आपके पास मौजूद संस्करण से ज़्यादा माँगता है",
  "settings.connectorBundle.widened.hint":
    "इस कार्ड को मंज़ूरी देने से इसे ये सब मिल जाता है। संकरे संस्करण के लिए बना कार्ड इन्हें कवर नहीं करता।",
  "settings.connectorBundle.widened.command": "एक अलग कमांड",
  "settings.connectorBundle.widened.commandValue": "अब {now}। पहले: {before}",
  "settings.connectorBundle.widened.env": "ज़्यादा वेरिएबल",
  "settings.connectorBundle.widened.secrets": "ज़्यादा सीक्रेट",
  "settings.connectorBundle.widened.network": "ज़्यादा नेटवर्क",
  "settings.connectorBundle.widened.tools": "ज़्यादा टूल, या ऐसे टूल जो ज़्यादा कर सकते हैं",
  "settings.connectorBundle.widened.payload": "अलग स्क्रिप्ट",
  "settings.connectorBundle.widened.payloadValue": "साथ आई फ़ाइलें बदल गई हैं",
  "settings.connectorBundle.diff": "क्या बदला",
  "settings.connectorBundle.noChanges": "और कुछ नहीं बदला।",
  "settings.connectorBundle.import.title": "साझा कनेक्टर",
  "settings.connectorBundle.import.hint":
    "किसी ने आपको फ़ाइल या लिंक के रूप में जो कनेक्टर भेजा है उसे इंपोर्ट करें। कुछ भी इंस्टॉल होने से पहले आप देखते हैं कि वह क्या-क्या माँगता है।",
  "settings.connectorBundle.import.file": "कनेक्टर फ़ाइल इंपोर्ट करें",
  "settings.connectorBundle.import.linkLabel": "या उसका लिंक पेस्ट करें",
  "settings.connectorBundle.import.linkPlaceholder": "https://example.com/notes.psyche-connector",
  "settings.connectorBundle.import.review": "समीक्षा करें",
  "settings.connectorBundle.import.checking": "जाँच हो रही है…",
  "settings.connectorBundle.import.failed": "कनेक्टर इंपोर्ट नहीं हो सका: {reason}",
  "settings.connectorBundle.import.tooBig": "यह फ़ाइल कनेक्टर होने के लिए बहुत बड़ी है।",
  "settings.connectorBundle.import.denied": "{name} इंस्टॉल नहीं किया गया।",
  "settings.connectorBundle.import.lapsed":
    "{expired, select, true {{name} का कार्ड समाप्त हो गया।} other {{name} का कार्ड अब लागू नहीं है।}} समीक्षा के लिए इसे दोबारा इंपोर्ट करें।",
  "settings.connectorBundle.import.added":
    "{name} जोड़ा गया। इसे नीचे वे सीक्रेट दें जिनकी इसे ज़रूरत है, फिर यह उनका उपयोग कर सकता है।",
  "settings.connectorBundle.import.addedNoSecrets": "{name} जोड़ा गया।",
  "settings.connectorBundle.import.addFailed": "{name} जोड़ा नहीं जा सका: {reason}",
  "settings.connectorBundle.import.secretsTitle": "{name} के सीक्रेट",
  "settings.connectorBundle.share.title": "यह कनेक्टर साझा करें",
  "settings.connectorBundle.share.hint":
    "कमांड, उसके वेरिएबल और सीक्रेट के नाम, वह जिस नेटवर्क तक पहुँचता है और उसके टूल के साथ एक हस्ताक्षरित फ़ाइल बनाता है। इसमें कभी कोई मान शामिल नहीं होता। उसमें क्या जाएगा, यह पहले आप पक्का करते हैं।",
  "settings.connectorBundle.share.go": "साझा करें…",
  "settings.connectorBundle.share.nameLabel": "साझा कनेक्टर पर आपका नाम",
  "settings.connectorBundle.share.nameHint":
    "आपकी फ़ाइल इंपोर्ट करने वाला हर व्यक्ति यह नाम देखता है। यह एक बार पूछा जाता है; आपकी हस्ताक्षर कुंजी अभी बनाई जाती है।",
  "settings.connectorBundle.share.make": "फ़ाइल बनाएँ",
  "settings.connectorBundle.share.label": "{name} साझा करें",
  "settings.connectorBundle.share.done":
    "{file} सहेजी गई, {author} के रूप में हस्ताक्षरित। इसमें केवल नाम हैं: कोई वेरिएबल या सीक्रेट मान नहीं।",
  "settings.connectorBundle.share.failed": "कनेक्टर साझा नहीं हो सका: {reason}",
  "settings.connectorBundle.share.unavailable":
    "कनेक्टर पर हस्ताक्षर केवल उसी Mac पर चल रहा Psyche कर सकता है जो उसे चलाता है।",
  "settings.skills.signer.ownRetired":
    "आपकी ऐसी कुंजी से हस्ताक्षरित जिसे आपने बदल दिया था। अब इसे आपकी नहीं माना जाता।",
  "settings.skills.signer.retired":
    "{name} द्वारा हस्ताक्षरित, ऐसी कुंजी से जिसे उस रोटेशन में बदला गया जो आपने देखा है। इससे आई नई फ़ाइल संदिग्ध है।",
  "settings.skills.signer.rotated":
    "{name} द्वारा हस्ताक्षरित: वही लेखक, नई कुंजी (पुरानी कुंजी से हस्ताक्षरित)। नई कुंजी पर तब तक भरोसा नहीं किया जाता जब तक आप खुद उस पर भरोसा न करें।",
  "settings.skills.author.state.seen": "देखी हुई, भरोसा नहीं",
  "settings.skills.author.state.trusted": "भरोसेमंद",
  "settings.skills.author.state.revoked": "रद्द",
  "settings.skills.keys.title": "आपकी लेखक कुंजी और नोटिस",
  "settings.skills.keys.hint":
    "वह कुंजी जो आपके साझा किए स्किल और कनेक्टर पर हस्ताक्षर करती है। आप इसे बदल सकते हैं, और जब किसी कुंजी या फ़ाइल पर भरोसा नहीं रखना चाहिए तब नोटिस प्रकाशित कर सकते हैं।",
  "settings.skills.keys.none":
    "आपने अभी तक कुछ भी हस्ताक्षरित नहीं किया है। आपकी कुंजी तब बनती है जब आप पहली बार कोई स्किल या कनेक्टर साझा करते हैं।",
  "settings.skills.keys.own": "{name} के रूप में हस्ताक्षर",
  "settings.skills.keys.fingerprint": "कुंजी",
  "settings.skills.keys.rotate": "मेरी कुंजी बदलें…",
  "settings.skills.keys.rotateHint":
    "उसी नाम से एक नई कुंजी बनाता है। पुरानी कुंजी एक कथन पर हस्ताक्षर करती है जिसमें नई कुंजी का नाम होता है, ताकि जिन्होंने आप पर भरोसा किया था वे वही लेखक नई कुंजी के साथ देखें। उन्हें फिर भी उस पर खुद भरोसा करना होगा। पहले आप पुष्टि करते हैं।",
  "settings.skills.keys.rotateLabel": "अपनी लेखक कुंजी बदलें",
  "settings.skills.keys.rotated": "आपकी कुंजी बदल दी गई। नई कुंजी {key} है।",
  "settings.skills.keys.rotateFailed": "कुंजी बदली नहीं जा सकी: {reason}",
  "settings.skills.keys.notice.title": "नोटिस प्रकाशित करें",
  "settings.skills.keys.notice.hint":
    "नोटिस एक छोटी हस्ताक्षरित फ़ाइल है। इसे भेजें या होस्ट करें, और जिसने आपकी कुंजी देखी है वह इसे इंपोर्ट करके किसी कुंजी या एक फ़ाइल को ब्लॉक कर सकता है।",
  "settings.skills.keys.notice.kindKey": "मेरी कुंजी (मौजूदा)",
  "settings.skills.keys.notice.kindBundle": "मेरी साझा की हुई एक फ़ाइल, उसकी बंडल आईडी से",
  "settings.skills.keys.notice.kind": "क्या गड़बड़ है",
  "settings.skills.keys.notice.hash": "बंडल आईडी (sha256:…)",
  "settings.skills.keys.notice.reason": "क्यों (इसे इंपोर्ट करने वाला हर व्यक्ति यह देखता है)",
  "settings.skills.keys.notice.make": "नोटिस बनाएँ",
  "settings.skills.keys.notice.label": "रद्दीकरण नोटिस पर हस्ताक्षर करें",
  "settings.skills.keys.notice.done": "{file} सहेजी गई। इसे जैसे चाहें प्रकाशित करें।",
  "settings.skills.keys.notice.failed": "नोटिस बनाया नहीं जा सका: {reason}",
  "settings.skills.keys.import.title": "रद्दीकरण नोटिस इंपोर्ट करें",
  "settings.skills.keys.import.hint":
    "यह तभी लागू होता है जब इस पर ऐसे लेखक के हस्ताक्षर हों जिनसे आप मिल चुके हैं। यह केवल ब्लॉक कर सकता है: यह कभी किसी पर भरोसा नहीं करता।",
  "settings.skills.keys.import.file": "नोटिस फ़ाइल इंपोर्ट करें",
  "settings.skills.keys.import.linkLabel": "या लिंक पेस्ट करें",
  "settings.skills.keys.import.linkPlaceholder": "https://example.com/revoke.psyche-notice",
  "settings.skills.keys.import.go": "इंपोर्ट करें",
  "settings.skills.keys.import.key": "कुंजी {key} ब्लॉक की गई। दिया गया कारण: {reason}",
  "settings.skills.keys.import.bundle": "फ़ाइल {hash} ब्लॉक की गई। दिया गया कारण: {reason}",
  "settings.skills.keys.import.previewKey":
    "इससे कुंजी {key}{names, select, none {} other { ({names} नाम से जानी जाती है)}} रद्द हो जाएगी। हस्ताक्षरकर्ता का बताया कारण: {reason}",
  "settings.skills.keys.import.previewBundle":
    "इससे फ़ाइल {hash} ब्लॉक हो जाएगी। हस्ताक्षरकर्ता का बताया कारण: {reason}",
  "settings.skills.keys.import.already": "यह पहले से लागू है।",
  "settings.skills.keys.import.apply": "लागू करें",
  "settings.skills.keys.import.signedBy": "{name} द्वारा हस्ताक्षरित।",
  "settings.skills.keys.import.failed": "नोटिस का उपयोग नहीं हो सका: {reason}",
  "web.teach.app.record": "किसी ऐप में रिकॉर्ड करें",
  "web.teach.app.recordHint":
    "Psyche को दिखाएँ कि आपके पहले से अनुमति दिए गए किसी Mac ऐप में कोई काम कैसे करना है",
  "web.teach.app.pickTitle": "किस ऐप में रिकॉर्ड करें?",
  "web.teach.app.pickLabel": "ऐप",
  "web.teach.app.pickHint":
    "केवल वे ऐप सूचीबद्ध हैं जिन्हें आपने कंप्यूटर उपयोग के लिए अनुमति दी है। पहले ऐप खोलें। पासवर्ड, कार्ड नंबर और कोड कभी रिकॉर्ड नहीं होते, और न ही Psyche की अपनी विंडो या साइन-इन और सुरक्षा संबंधी संकेत।",
  "web.teach.app.none":
    "रिकॉर्ड करने के लिए कोई ऐप तैयार नहीं है। सेटिंग्ज़ में कंप्यूटर उपयोग चालू करें और पहले किसी ऐप को क्लिक या इंटरैक्ट का स्तर दें।",
  "web.teach.app.start": "रिकॉर्डिंग शुरू करें",
  "web.teach.app.cancelPick": "अभी नहीं",
  "web.teach.app.startFailed":
    "Psyche उस ऐप की रिकॉर्डिंग शुरू नहीं कर सका। पहले उसे खोलें, और जाँचें कि Psyche के पास ऐक्सेसिबिलिटी की अनुमति है।",
  "web.teach.app.bar.title": "{app} रिकॉर्ड हो रहा है",
  "web.teach.app.bar.body":
    "Psyche केवल {app} में आपके क्लिक, मेनू के चुनाव और टाइपिंग नोट करता है। सुरक्षित फ़ील्ड कभी रिकॉर्ड नहीं होते, कोई स्क्रीनशॉट नहीं लिया जाता, और आपके सहेजने तक कुछ भी इस Mac से बाहर नहीं जाता। मेन्यू बार में भी एक रोकें बटन है।",
  "web.teach.app.bar.endedLimit": "रिकॉर्डिंग 200 चरणों की सीमा पर रुक गई। देखें कि उसमें क्या दर्ज हुआ।",
  "web.teach.app.bar.endedTimeout": "रिकॉर्डिंग अपनी समय-सीमा पर रुक गई। देखें कि उसमें क्या दर्ज हुआ।",
  "web.teach.app.bar.endedInterrupted":
    "ऐप बंद हो जाने से रिकॉर्डिंग जल्दी खत्म हो गई। देखें कि उसमें क्या दर्ज हुआ।",
  "web.teach.app.stopFailed": "Psyche रिकॉर्डिंग पूरी नहीं कर सका।",
  "web.teach.app.skipped":
    "{count, plural, one {# चीज़ छोड़ दी गई: एक सुरक्षित फ़ील्ड, या ऐसा कंट्रोल जिसका कोई नाम नहीं जिससे उसे ढूँढा जा सके।} other {# चीज़ें छोड़ दी गईं: सुरक्षित फ़ील्ड, या ऐसे कंट्रोल जिनका कोई नाम नहीं जिससे उन्हें ढूँढा जा सके।}}",
  "web.teach.app.privacy":
    "इन चरणों का टेक्स्ट ऐप की विंडो और मेनू से आया है। इसे डेटा माना जाता है, निर्देश कभी नहीं। सहेजते समय स्किल को चलने से पहले आपसे मंज़ूरी माँगी जाती है।",
  "web.teach.app.sensitive": "रिकॉर्ड नहीं हुआ। Psyche आपसे यह हिस्सा खुद करने को कहेगा।",
  "web.teach.app.runHint":
    "संदेश बॉक्स को स्किल से भर देता है। भेजें दबाएँ, फिर ऐप को देखें: हर क्लिक और एंट्री हमेशा की तरह मंज़ूरी माँगती है, और अगर कुछ अपनी जगह पर नहीं है तो यह रुककर पूछता है।",
  "web.teach.step.app.click": "{app} में ‘{name}’ पर क्लिक करें",
  "web.teach.step.app.clickRole": "{app} में {role} पर क्लिक करें",
  "web.teach.step.app.menu": "{app} में {path} चुनें",
  "web.teach.step.app.type": "{app} में ‘{name}’ में टाइप करें",
  "web.teach.step.app.typeKept": "{app} में ‘{name}’ में {value} टाइप करें",
  "web.teach.step.app.typeInput": "{app} में ‘{name}’ में {input} टाइप करें",
  "web.teach.step.app.typeAsk": "{app} में ‘{name}’ में वह टाइप करें जो आप बताएँगे",
  "web.teach.step.app.typeSensitive": "{app} में ‘{name}’ में आप खुद टाइप करते हैं",
  "app.integrity.title": "Psyche की फ़ाइलें बदल दी गई हैं",
  "app.integrity.detail":
    "Psyche की यह कॉपी अब उस हस्ताक्षर से मेल नहीं खाती जिसके साथ इसे जारी किया गया था, इसलिए हो सकता है किसी ने इसे बदल दिया हो। जब तक आप इसे आधिकारिक डाउनलोड से दोबारा इंस्टॉल नहीं करते, Psyche माइक्रोफ़ोन, स्क्रीन, Apple Events, संपर्क और कैलेंडर की सुविधाएँ बंद रखेगा। Psyche की बैकग्राउंड सेवा (Gateway) चलती रहेगी।",
  "app.integrity.blocked":
    "बंद: Psyche की यह कॉपी बदली गई है। इसे आधिकारिक डाउनलोड से दोबारा इंस्टॉल करें।",
  "app.integrity.ok": "ठीक है",
};
