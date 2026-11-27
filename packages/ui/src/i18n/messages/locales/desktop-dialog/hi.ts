import type { Catalogue } from "../../index.ts";

/** Native dialogs and notifications (hi); merged into `../hi.ts`. */
export const desktopDialog: Partial<Catalogue> = {
  "desktop.dialog.notificationsOn": "सूचनाएँ चालू हैं।",
  "desktop.dialog.anotherCopyTitle": "Psyche की एक और प्रति पहले से चल रही है",
  "desktop.dialog.anotherCopyDetail":
    "यह {path} से चल रही है। इस प्रति का उपयोग करने से Psyche इस ऐप पर स्विच हो जाएगा; फिर दूसरी प्रति इसी से जुड़ेगी।",
  "desktop.dialog.keepOtherCopy": "दूसरी प्रति रहने दें",
  "desktop.dialog.useThisCopy": "यह प्रति उपयोग करें",
  "desktop.dialog.cancel": "रद्द करें",
  "desktop.dialog.ok": "ठीक है",
  "desktop.dialog.shareFolderTitle": "Psyche के साथ एक फ़ोल्डर साझा करें",
  "desktop.dialog.share": "साझा करें",
  "desktop.dialog.gatewaysFileTitle": "Psyche सहेजे गए गेटवे नहीं पढ़ पा रहा",
  "desktop.dialog.gatewaysFileDetail":
    "{problem}। Psyche {os, select, macos {इस Mac} windows {इस PC} other {इस कंप्यूटर}} पर शुरू होता है और फ़ाइल को जैसी है वैसी छोड़ देता है, ताकि कोई पिन की गई पहचान न खोए। किसी और कंप्यूटर का गेटवे उपयोग करने के लिए Psyche के डेटा फ़ोल्डर में फ़ाइल ठीक करें या हटाएँ।",
  "desktop.dialog.stillRunningTitle": "Psyche अब भी चल रहा है",
  "desktop.dialog.stillRunningBody":
    "कार्य और स्वचालन चलते रहते हैं। सूचना क्षेत्र में उसके आइकन से Psyche खोलें; बंद करने के लिए उस पर राइट-क्लिक करें।",
  "desktop.dialog.manualStepsTitle": "Psyche को पूरी तरह हटाने के लिए एक और चरण",
  "desktop.dialog.uninstallTitle": "Psyche अनइंस्टॉल करें?",
  "desktop.dialog.uninstall": "अनइंस्टॉल करें",
  "desktop.dialog.uninstallAndDelete": "डेटा मिटाएँ और अनइंस्टॉल करें",
  "desktop.dialog.uninstallItems":
    "{count, plural, one {# आइटम} other {# आइटम}} ट्रैश में ले जाए जाएँगे, जिसमें Psyche.app भी शामिल है।",
  "desktop.dialog.uninstallDataFolder": "आपका डेटा फ़ोल्डर {folder} भी ट्रैश में ले जाया जाएगा।",
  "desktop.dialog.uninstallDataKept": "आपका डेटा फ़ोल्डर रखा जाएगा।",
  "desktop.dialog.uninstallKeychain": "Psyche के रखे कीचेन आइटम हटा दिए जाएँगे।",
  "desktop.dialog.uninstallKeychainKept":
    "कीचेन आइटम वैसे ही रहेंगे; चाहें तो Keychain Access में हटा सकते हैं।",
  "desktop.dialog.stopTitle":
    "{os, select, macos {इस Mac} windows {इस PC} other {इस कंप्यूटर}} पर Psyche बंद करें?",
  "desktop.dialog.stopDetail":
    "आप वापस स्विच करने तक इसके स्वचालन और निर्धारित कार्य रुक जाएँगे। उन्हें चालू रखने के लिए इसे चलता रहने दें।",
  "desktop.dialog.stopButton":
    "{os, select, macos {इस Mac} windows {इस PC} other {इस कंप्यूटर}} पर Psyche बंद करें",
  "desktop.dialog.keepRunning": "चलता रहने दें",
  "desktop.dialog.forgetTitle": "{name} को भूल जाएँ?",
  "desktop.dialog.forgetDetail":
    "{origin}\n\nइससे उसके लिए इस कंप्यूटर की कुंजी और Psyche ने यहाँ उसके लिए जो कुछ सहेजा था, वह हट जाएगा। जब तक वहाँ से कोई इस कंप्यूटर को नहीं हटाता, {name} इसे सूची में दिखाता रहेगा।",
  "desktop.dialog.forgetButton": "भूल जाएँ",
  "desktop.dialog.repairTitle": "{name} के साथ फिर से पेयर करें?",
  "desktop.dialog.repairDetail":
    "{origin}\n\nइससे Psyche द्वारा उसके लिए पिन की गई पहचान और इस कंप्यूटर की कुंजी भूल जाती है, इसलिए अगला कनेक्शन उस पते पर जो भी जवाब दे उसे पिन करेगा और नए कंप्यूटर की तरह पेयर होने के लिए पूछेगा। ऐसा तभी करें जब आपको पता हो कि उसकी पहचान क्यों बदली।",
  "desktop.dialog.repairButton": "फिर से पेयर करें",
  "desktop.dialog.claimTitle": "{origin} पर Psyche सर्वर सेट करें?",
  "desktop.dialog.claimDetail":
    "Psyche भरोसा करने से पहले जाँचता है कि सर्वर वह सेटअप कोड जानता है जो आपने टाइप किया, और सर्वर इसे व्यवस्थापक बनाने से पहले जाँचता है कि यह कंप्यूटर वह कोड जानता है। केवल तभी आगे बढ़ें जब वह सर्वर आपने अभी खुद इंस्टॉल किया हो।",
  "desktop.dialog.setUp": "सेट करें",
  "desktop.dialog.addLanTitle": "क्या {origin} इस नेटवर्क पर एक Psyche है?",
  "desktop.dialog.addLanDetail":
    "नाम: {name}\n\nइस नेटवर्क पर का Psyche अपना प्रमाणपत्र उपयोग करता है, जिसे Psyche सिस्टम के प्रमाणपत्र पर भरोसा करने के बजाय पिन करता है: यह पहले कनेक्शन पर प्रमाणपत्र और गेटवे की कुंजी जाँचता है और बाद में किसी भी अन्य को अस्वीकार करता है। «सादा https» केवल सामान्य प्रमाणपत्र वाले सर्वर के लिए चुनें (जैसे अपने CA वाला रिवर्स प्रॉक्सी)। मालिक के वहाँ इस कंप्यूटर को मंज़ूरी देने तक कुछ भी साझा नहीं होता।",
  "desktop.dialog.psycheOnNetwork": "इस नेटवर्क पर Psyche",
  "desktop.dialog.plainHttps": "सादा https",
  "desktop.dialog.addLinkTitleLan": "इस नेटवर्क पर {origin} से Psyche कनेक्ट करें?",
  "desktop.dialog.addLinkTitle": "{origin} से Psyche कनेक्ट करें?",
  "desktop.dialog.addLinkDetail":
    "{external, select, yes {यह लिंक किसी दूसरे ऐप या वेबसाइट ने खोला है, आपने इसे पेस्ट नहीं किया। केवल तभी आगे बढ़ें जब आपने इसे खुद उस {os, select, macos {Mac} windows {PC} other {कंप्यूटर}} पर बनाया हो जिस पर Psyche चलता है।\n\n} other {}}Psyche केवल तभी कनेक्ट होगा जब वह गेटवे यह पहचान साबित करे:\n{fingerprint}\n\n{lan, select, yes {यह अपना प्रमाणपत्र उपयोग करता है, सिस्टम पर भरोसेमंद कोई प्रमाणपत्र नहीं। भेजने से पहले Psyche इसे इस लिंक में दिए गए प्रमाणपत्र ({pin}…) पर पिन रखता है, और बाकी सब अस्वीकार करता है। केवल तभी आगे बढ़ें जब लिंक इस नेटवर्क पर आपके अपने {os, select, macos {Mac} windows {PC} other {कंप्यूटर}} से आया हो।\n\n} other {}}लिंक का एक-बार वाला कोड फिर उस गेटवे को बिना दोबारा पूछे इस कंप्यूटर को मंज़ूरी देने देता है, उस पहुँच के साथ जो उसके मालिक ने बनाते समय चुनी थी।",
  "desktop.dialog.addDetailKey":
    "नाम: {name}\nघोषित कुंजी: {key}…\n\nयह कंप्यूटर उस गेटवे से पेयर होने के लिए कहेगा। जब तक उसका मालिक वहाँ इस कंप्यूटर को मंज़ूरी न दे, कुछ भी साझा नहीं होता, और Psyche पहले कनेक्शन पर गेटवे की पहचान पिन करता है।",
  "desktop.dialog.addDetailPlain":
    "नाम: {name}\n\nयह कंप्यूटर उस गेटवे से पेयर होने के लिए कहेगा। जब तक उसका मालिक वहाँ इस कंप्यूटर को मंज़ूरी न दे, कुछ भी साझा नहीं होता, और Psyche पहले कनेक्शन पर गेटवे की पहचान पिन करता है।",
  "desktop.dialog.addGatewayButton": "गेटवे जोड़ें",
};
