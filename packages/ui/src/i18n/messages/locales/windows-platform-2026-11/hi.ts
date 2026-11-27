import type { Catalogue } from "../../index.ts";

/** Windows variants of the sandbox PC, voice keys and platform terms, and Mac wording (hi); merged into `../hi.ts`. */
export const windowsPlatform202611: Partial<Catalogue> = {
  "blocks.details.runsNoHostSandbox": "इस कंप्यूटर पर, सैंडबॉक्स के बिना: यहाँ कमांड के लिए कोई सैंडबॉक्स नहीं है",
  "blocks.execHost.noHostSandbox":
    "इस कंप्यूटर पर कमांड के लिए कोई सैंडबॉक्स नहीं है, इसलिए यह कमांड बिना सैंडबॉक्स के ही चल सकता है। इस बार के लिए इसे चलाने के लिए {word} टाइप करें।",
  "blocks.execHost.mustTypeOnly": "इसकी अनुमति देने के लिए {word} टाइप करें।",
  "settings.uninstall.stopSandboxPc":
    "सैंडबॉक्स PC सेवा हटा दी जाएगी। Windows एक बार एडमिनिस्ट्रेटर की मंज़ूरी माँगेगा।",
  "settings.computerUse.tcc.microphone.name": "माइक्रोफ़ोन",
  "settings.computerUse.tcc.microphone.why": "डिक्टेशन और मीटिंग नोट्स के लिए Psyche आपकी आवाज़ सुन सके",
  "settings.sandbox.restart.reopen": "Psyche बंद करके उसे फिर से खोलें।",
  "settings.sandbox.pc.title": "सैंडबॉक्स PC चालू करें",
  "settings.sandbox.pc.body":
    "srt, कमांड के लिए Psyche का हल्का सैंडबॉक्स, Windows पर नहीं चलता। इसके बजाय Psyche द्वारा बनाए गए स्क्रिप्ट, कमांड सर्वर और कनेक्टर गोपनीयता और सुरक्षा → कंप्यूटर उपयोग → VM मोड में चलते हैं: एक छोटा अलग Linux कंप्यूटर, जिसकी आपकी फ़ाइलों तक पहुँच नहीं है। इसे सेटिंग्स → सैंडबॉक्स PC में चालू करें, फिर दोबारा जाँचें।",
  "settings.sandbox.pc.notReady.title": "सैंडबॉक्स PC अभी तैयार नहीं है",
  "settings.sandbox.pc.notReady.body":
    "यह चालू है, पर अभी चल नहीं रहा, या इसके अंदर का Psyche पुराना है। सेटिंग्स → गोपनीयता और सुरक्षा → कंप्यूटर उपयोग → VM मोड में इसे शुरू या अपडेट करें, फिर दोबारा जाँचें।",
  "settings.sandbox.pc.ready":
    "सैंडबॉक्स PC चालू है: Psyche द्वारा बनाए गए स्क्रिप्ट, कमांड सर्वर और कनेक्टर इसी में चलते हैं।",
  "settings.sandbox.pc.open": "सैंडबॉक्स PC सेटिंग्स खोलें",
  "settings.sandbox.pc.where": "यह सेटिंग्स → गोपनीयता और सुरक्षा → कंप्यूटर उपयोग → VM मोड में है।",
  "settings.devices.platform.windows": "Windows PC",
  "settings.devices.nodeKind.winHelper": "Windows हेल्पर",
  "settings.devices.thisPcAdmin":
    "यह PC एडमिन डिवाइस है। कोई दूसरा एडमिन डिवाइस यहाँ से इसे रद्द कर सकता है।",
  "settings.devices.presenceKey.windowsHello":
    "Windows Hello कुंजी ({algorithm}), हेल्पर की रिपोर्ट के अनुसार",
  "settings.devices.presenceKey.windowsHelloNoAlgorithm":
    "Windows Hello कुंजी, हेल्पर की रिपोर्ट के अनुसार",
  "settings.shortcut.reserved.windowsKey": "Windows (Windows कुंजी वाले शॉर्टकट)",
  "settings.shortcut.reserved.windowMenu": "विंडो मेन्यू",
  "settings.shortcut.reserved.closeApp": "ऐप बंद करना",
  "settings.shortcut.reserved.taskManager": "टास्क मैनेजर",
  "settings.shortcut.reserved.startMenu": "स्टार्ट मेन्यू",
  "settings.shortcut.reserved.securityScreen": "Windows सुरक्षा स्क्रीन",
  "settings.shortcut.key.Super": "Windows कुंजी",
  "settings.shortcut.useDefault": "डिफ़ॉल्ट इस्तेमाल करें",
  "settings.quickEntry.title": "क्विक एंट्री",
  "settings.key.quickEntry.shortcut": "शॉर्टकट",
  "settings.quickEntry.shortcutHint":
    "किसी भी ऐप से पॉप-अप चैट खोलता है। जब तक आप दूसरी कुंजियाँ न चुनें, Psyche {keys} इस्तेमाल करता है, या जब कोई दूसरा ऐप इसे रोके हो तो {fallback}।",
  "settings.voice.key.rightCtrl": "दायाँ Ctrl",
  "settings.voice.key.rightAlt": "दायाँ Alt",
  "settings.voice.key.rightShift": "दायाँ Shift",
  "settings.voice.key.rightWin": "दायाँ Windows कुंजी",
  "settings.voice.key.capsLock": "Caps Lock",
  "settings.voice.key.scrollLock": "Scroll Lock",
  "settings.voice.key.pause": "Pause",
  "settings.voice.key.menu": "Menu कुंजी",
  "settings.voice.key.insert": "Insert",
  "settings.voice.key.numLock": "Num Lock",
  "settings.voice.key.other": "कोई दूसरी कुंजी",
  "settings.voice.key.press": "एक कुंजी दबाएँ",
  "settings.voice.key.pressNow": "बात करने के लिए दबाए रखने वाली कुंजी दबाएँ…",
  "settings.voice.key.cantUse":
    "वह कुंजी टेक्स्ट टाइप करती है, इसलिए बात करने के लिए उसे दबाए नहीं रखा जा सकता। दायाँ Ctrl, Caps Lock, Pause, Menu कुंजी या F13 से F24 आज़माएँ।",
  "settings.voice.key.capsLockHint":
    "Caps Lock अपनी चालू या बंद स्थिति रखता है: बात करने के लिए उसे दबाए रखने से वह नहीं बदलता, और एक हल्का टैप अब भी उसे बदलता है।",
  "settings.voice.key.altGrWarning":
    "आपके कीबोर्ड लेआउट पर दायाँ Alt AltGr है, जो @ या € जैसे अक्षर टाइप करता है। बात करने के लिए उसे दबाए रखने से इन अक्षरों को टाइप करने में दिक्कत हो सकती है; दायाँ Ctrl ज़्यादा सुरक्षित कुंजी है।",
  "settings.voice.access.windowsWhy":
    "आपकी दबाई हुई कुंजी देखता है और फ़ोकस वाले ऐप में टाइप करता है। Windows को इसके लिए अनुमति नहीं चाहिए; एडमिनिस्ट्रेटर के रूप में चल रहे ऐप्स को डिक्टेट किया गया टेक्स्ट नहीं मिलता।",
  "settings.voice.model.title": "स्पीच मॉडल",
  "settings.voice.model.usingHelper":
    "डिक्टेशन हेल्पर की स्पीच रिकग्निशन का इस्तेमाल करता है। स्पीच मॉडल बेहतर ट्रांसक्राइब करता है और इस Mac पर चलता है।",
  "settings.voice.model.download": "बेहतर डिक्टेशन के लिए स्पीच मॉडल ({mb} MB) डाउनलोड करें",
  "settings.voice.model.downloadHint":
    "whisper.cpp प्रोजेक्ट से एक बार का डाउनलोड, इस्तेमाल से पहले जाँचा जाता है। ऑडियो कभी इस Mac से बाहर नहीं जाता।",
  "settings.voice.model.downloading": "स्पीच मॉडल डाउनलोड हो रहा है: {total} MB में से {received} MB",
  "settings.voice.model.ready": "इस Mac पर Whisper ({model})",
  "settings.voice.model.readyHint":
    "डिक्टेशन और रिकॉर्डिंग यहीं ट्रांसक्राइब होती हैं; ऑडियो Mac से बाहर नहीं जाता।",
  "settings.voice.model.readyNotFirst":
    "इंस्टॉल हो गया है। आपके इंजन क्रम में कोई और इंजन पहले है, इसलिए डिक्टेशन अभी इसका इस्तेमाल नहीं करता।",
  "settings.voice.model.failed": "डाउनलोड नहीं हो सका: {reason}",
  "settings.voice.model.retry": "फिर से कोशिश करें",
  "settings.voice.model.vcredist":
    "स्पीच मॉडल को Microsoft Visual C++ Redistributable चाहिए। उसे इंस्टॉल करें, फिर दोबारा डिक्टेट करें।",
  "settings.voice.model.crashed":
    "स्पीच इंजन अचानक रुक गया; दोबारा शुरू होने तक डिक्टेशन हेल्पर का इस्तेमाल करता है।",
  "settings.sandboxPc.title": "सैंडबॉक्स PC चालू करें",
  "settings.sandboxPc.explain":
    "{persona} को Windows के अंदर चलने वाला एक छोटा निजी Linux PC मिलता है। कार्य आपके PC के बजाय वहीं चलते हैं, और उन्हें सिर्फ़ वही फ़ोल्डर दिखते हैं जो आप साझा करते हैं।",
  "settings.sandboxPc.oneTime":
    "एक बार का सेटअप: PC चलाने वाली बैकग्राउंड सेवा जोड़ने के लिए Windows एक बार एडमिनिस्ट्रेटर की मंज़ूरी माँगेगा। फिर Psyche PC इमेज डाउनलोड करेगा ({download}, डिस्क पर {disk})। किसी और चीज़ को एडमिनिस्ट्रेटर की ज़रूरत नहीं है।",
  "settings.sandboxPc.oneTimeNoSize":
    "एक बार का सेटअप: PC चलाने वाली बैकग्राउंड सेवा जोड़ने के लिए Windows एक बार एडमिनिस्ट्रेटर की मंज़ूरी माँगेगा। फिर Psyche PC इमेज डाउनलोड करेगा। किसी और चीज़ को एडमिनिस्ट्रेटर की ज़रूरत नहीं है।",
  "settings.sandboxPc.turnOn": "सैंडबॉक्स PC चालू करें",
  "settings.sandboxPc.cancelDownload": "डाउनलोड रद्द करें",
  "settings.sandboxPc.waitingAdmin": "एडमिनिस्ट्रेटर प्रॉम्प्ट का इंतज़ार हो रहा है…",
  "settings.sandboxPc.restarting": "सेटअप पूरा हो रहा है…",
  "settings.sandboxPc.downloading": "PC इमेज डाउनलोड हो रही है: {total} में से {received}",
  "settings.sandboxPc.progressLabel": "PC इमेज डाउनलोड",
  "settings.sandboxPc.ready": "सेट अप हो गया",
  "settings.sandboxPc.readyText": "सैंडबॉक्स PC सेट अप हो गया है। वर्शन {version}।",
  "settings.sandboxPc.unsupported": "सैंडबॉक्स PC यहाँ उपलब्ध नहीं है: {reason}।",
  "settings.sandboxPc.failed": "सैंडबॉक्स PC चालू नहीं हो सका: {reason}",
  "settings.sandboxPc.failedDid": "कुछ और नहीं बदला गया है। आप दोबारा कोशिश कर सकते हैं।",
  "settings.sandboxPc.gb": "{value, number} GB",
  "settings.sandboxPc.mb": "{value, number} MB",
  "settings.sandboxPc.loadLabel": "सैंडबॉक्स PC",
  "settings.sandboxPc.onboarding": "सैंडबॉक्स PC",
  "settings.sandboxPc.onboardingHint":
    "वैकल्पिक: उन कार्यों के लिए एक निजी Linux PC जो आपकी फ़ाइलों को न छुएँ। आप इसे बाद में सेटिंग्स में सेट कर सकते हैं।",
  "settings.sandboxPc.update.title": "सैंडबॉक्स PC सेवा अपडेट करें",
  "settings.sandboxPc.update.explainCompatible":
    "Psyche के इस वर्शन में इंस्टॉल की गई सेवा से नई सैंडबॉक्स PC सेवा है। सैंडबॉक्स PC जैसा है वैसे ही चलता रहेगा।",
  "settings.sandboxPc.update.explainRequired":
    "Psyche का यह वर्शन इंस्टॉल की गई सैंडबॉक्स PC सेवा का इस्तेमाल नहीं कर सकता। अपडेट करने तक सैंडबॉक्स PC बंद रहेगा।",
  "settings.sandboxPc.update.available": "अपडेट उपलब्ध है",
  "settings.sandboxPc.update.required": "अपडेट ज़रूरी है",
  "settings.sandboxPc.update.versions":
    "इंस्टॉल किया गया: {installed}। इस वर्शन का Psyche: {bundled}।",
  "settings.sandboxPc.update.oneStep":
    "Windows एक बार एडमिनिस्ट्रेटर की मंज़ूरी माँगेगा। सेवा बदले जाने के दौरान चल रहा सैंडबॉक्स PC रुक जाएगा।",
  "settings.sandboxPc.update.button": "सैंडबॉक्स PC सेवा अपडेट करें",
  "settings.sandboxPc.update.failed": "सैंडबॉक्स PC सेवा अपडेट नहीं हुई: {reason}",
  "settings.sandboxPc.update.failedDid": "कुछ और नहीं बदला गया है। आप दोबारा कोशिश कर सकते हैं।",
  "settings.sandboxPc.controls.title": "सैंडबॉक्स PC",
  "settings.sandboxPc.controls.hint": "एक बार बनाएँ, फिर यहीं से शुरू और बंद करें।",
  "settings.sandboxPc.controls.create": "सैंडबॉक्स PC बनाएँ",
  "settings.sandboxPc.controls.start": "शुरू करें",
  "settings.sandboxPc.controls.stop": "रोकें",
  "settings.sandboxPc.controls.resume": "फिर से शुरू करें",
  "settings.sandboxPc.controls.working": "काम हो रहा है…",
  "settings.sandboxPc.controls.helperOffline":
    "Windows हेल्पर नहीं चल रहा है या अभी उसके पास सैंडबॉक्स PC नहीं है, इसलिए इसे नियंत्रित नहीं किया जा सकता। सेटिंग्स → डिवाइस में हेल्पर को रीस्टार्ट करें।",
  "settings.sandboxPc.controls.failed": "यह काम नहीं किया: {reason}",
  "settings.sandboxPc.controls.waitForImage": "पहले ऊपर इसे चालू करने का काम पूरा करें।",
  "settings.sandboxPc.snapshots.title": "स्नैपशॉट",
  "settings.sandboxPc.snapshots.hint":
    "सैंडबॉक्स PC की डिस्क सेव करें ताकि बाद में वापस आ सकें। सेव या रिस्टोर करने के लिए इसे रुका होना चाहिए।",
  "settings.sandboxPc.snapshots.none": "अभी कोई स्नैपशॉट नहीं है।",
  "settings.sandboxPc.snapshots.save": "स्नैपशॉट सेव करें",
  "settings.sandboxPc.snapshots.saveFresh": "नए PC के रूप में सेव करें",
  "settings.sandboxPc.snapshots.reset": "नए PC पर रीसेट करें",
  "settings.sandboxPc.snapshots.restore": "रिस्टोर करें",
  "settings.sandboxPc.snapshots.delete": "हटाएँ",
  "settings.sandboxPc.snapshots.fresh": "नया PC",
  "settings.sandboxPc.snapshots.item": "{label}, {when}",
  "settings.sandboxPc.snapshots.stopFirst": "पहले सैंडबॉक्स PC रोकें।",
  "onboarding.connectors.windowsHint":
    "Windows पर {name} Microsoft, Google या IMAP खाते के ज़रिए आपके मेल, कैलेंडर और संपर्क पढ़ता है।",
  "web.about.windowsArm": "Arm64",
  "web.about.windowsX64": "x64",
  "web.about.windowsBuild": "build {build}",
  "platform.term.os": "macOS",
  "platform.term.device": "Mac",
  "platform.term.thisDevice": "यह Mac",
  "platform.term.thisDeviceLower": "यह Mac",
  "platform.term.presence": "Touch ID",
  "platform.term.secretStore": "Keychain",
  "platform.term.systemSettings": "System Settings",
  "platform.term.fileManager": "Finder",
  "platform.term.trayArea": "menu bar",
  "platform.term.taskbar": "Dock",
  "platform.term.systemSearch": "Spotlight",
  "platform.term.helper": "Mac हेल्पर",
  "platform.term.terminal": "Terminal",
  "platform.term.alt": "Option",
  "platform.term.mod": "Command",
  "platform.macOnly": "केवल macOS पर उपलब्ध",
  "platform.macOnlyHint": "{name} के लिए Mac चाहिए। macOS पर Psyche इसका इस्तेमाल कर सकता है।",
  "platform.windows.access.title": "Windows की अनुमतियाँ",
  "platform.windows.access.hint": "Windows Psyche को क्या करने देता है, और आपसे क्या माँगता है।",
  "platform.windows.access.noPermission": "किसी अनुमति की ज़रूरत नहीं",
  "platform.windows.access.uiAutomation.name": "ऐप्स का इस्तेमाल",
  "platform.windows.access.uiAutomation.why":
    "{persona} Windows UI Automation के ज़रिए ऐप विंडो पढ़ता और इस्तेमाल करता है। Windows उसे एडमिनिस्ट्रेटर के रूप में चल रहे ऐप्स को नियंत्रित नहीं करने देता।",
  "platform.windows.access.screen.name": "स्क्रीन कैप्चर",
  "platform.windows.access.screen.why":
    "Windows को स्क्रीन कैप्चर के लिए अनुमति की ज़रूरत नहीं है। Psyche की अपनी विंडो और पासवर्ड फ़ील्ड कैप्चर में छिपे रहते हैं।",
  "platform.windows.access.microphone.name": "माइक्रोफ़ोन",
  "platform.windows.access.microphone.why":
    "डिक्टेशन और मीटिंग नोट्स के लिए। Windows इसे सेटिंग्स → प्राइवेसी और सुरक्षा → माइक्रोफ़ोन में माँगता है, जिसमें “डेस्कटॉप ऐप्स को माइक्रोफ़ोन एक्सेस करने दें” चालू हो।",
  "platform.windows.access.openSettings": "सेटिंग्स खोलें",
  "platform.windows.access.openSettingsFor": "{name} के लिए Windows सेटिंग्स खोलें",
  "platform.windows.access.state.granted": "चालू",
  "platform.windows.access.state.denied": "Windows सेटिंग्स में बंद",
  "platform.windows.access.state.not_determined": "अभी जाँचा नहीं गया",
  "platform.helper.restart": "हेल्पर रीस्टार्ट करें",
  "platform.helper.restarting": "रीस्टार्ट हो रहा है…",
  "platform.helper.restartFailed": "हेल्पर शुरू नहीं हुआ ({reason})।",
};
