import type { Catalogue } from "../../index.ts";

/** Computers Psyche can use (hi); merged into `../hi.ts`. */
export const machines: Partial<Catalogue> = {
  "machines.title": "वे कंप्यूटर जिन्हें Psyche इस्तेमाल कर सकता है",
  "machines.description":
    "आपके पेयर किए हुए Linux कंप्यूटर, ताकि आप इस कंप्यूटर को इस्तेमाल करते रहें और Psyche वहाँ ऐप, कमांड और फ़ाइलें इस्तेमाल कर सके।",
  "machines.empty":
    "Psyche को काम करने के लिए एक Linux कंप्यूटर दें, ताकि आप इस कंप्यूटर को इस्तेमाल करते रहें और वह वहाँ ऐप, कमांड और फ़ाइलें इस्तेमाल कर सके।",
  "machines.add": "Linux कंप्यूटर जोड़ें",
  "machines.add.description":
    "आप इस कंप्यूटर को इस्तेमाल करते रहते हैं, और Psyche उस कंप्यूटर पर काम करता है। वहाँ की कार्रवाइयाँ आपकी मंज़ूरी की सेटिंग के अनुसार चलती हैं।",
  "machines.add.account": "Psyche को वहाँ कौन-सा खाता इस्तेमाल करना चाहिए?",
  "machines.add.account.own": "आपका खाता (सुझाया गया)",
  "machines.add.account.ownHint":
    "Psyche वहाँ आपकी फ़ाइलें, ऐप और लॉगिन आपकी तरह इस्तेमाल कर सकता है। उसे root कभी नहीं मिलता।",
  "machines.add.account.dedicated": "अलग psyche खाता",
  "machines.add.account.dedicatedHint":
    "Psyche को सिर्फ़ उस खाते की फ़ाइलें और ऐप दिखते हैं। उसके पास न sudo है, न पासवर्ड।",
  "machines.add.needsNetwork":
    "दूसरे कंप्यूटर अभी इस कंप्यूटर तक नहीं पहुँच सकते। पहले सेटिंग → सर्वर और रिमोट एक्सेस में रिमोट एक्सेस या स्थानीय नेटवर्क एक्सेस चालू करें।",
  "machines.add.make": "कमांड दिखाएँ",
  "machines.add.again": "नए कमांड बनाएँ",
  "machines.add.commands": "Linux कंप्यूटर के लिए कमांड",
  "machines.add.installStep": "1. Linux कंप्यूटर पर सहायक इंस्टॉल करें",
  "machines.add.pairStep": "2. वहाँ पेयरिंग शुरू करें",
  "machines.add.expires": "लिंक एक बार ही चलता है और {when} समाप्त हो जाएगा।",
  "machines.add.waiting": "कंप्यूटर के पेयर होने का इंतज़ार है…",
  "machines.add.paired": "{name} पेयर हो गया। Psyche अब इसे इस्तेमाल कर सकता है।",
  "machines.add.pairedToast": "{name} जोड़ा गया",
  "machines.add.done": "हो गया",
  "machines.copy": "कॉपी करें",
  "machines.status.online": "ऑनलाइन",
  "machines.status.offline": "ऑफ़लाइन",
  "machines.status.degraded": "ध्यान चाहिए",
  "machines.display.headless": "निजी स्क्रीन",
  "machines.display.desktopSession": "अपना डेस्कटॉप",
  "machines.display.container": "कंटेनर",
  "machines.thisComputer": "यह कंप्यूटर",
  "machines.watch": "देखें",
  "machines.watchNamed": "{name} देखें",
  "machines.apps": "ऐप एक्सेस",
  "machines.appsNamed": "{name} पर ऐप एक्सेस",
  "machines.folders": "फ़ोल्डर",
  "machines.foldersNamed": "{name} पर फ़ोल्डर",
  "machines.rename.action": "नाम बदलें",
  "machines.rename.named": "{name} का नाम बदलें",
  "machines.rename.label": "{name} का नया नाम",
  "machines.rename.save": "सहेजें",
  "machines.rename.cancel": "रद्द करें",
  "machines.remove": "हटाएँ",
  "machines.removeTitle": "{name} हटाएँ?",
  "machines.removeDescription":
    "Psyche {name} का इस्तेमाल तुरंत बंद कर देता है और उसका पेयरिंग रद्द हो जाता है। दोबारा इस्तेमाल करने के लिए उसे फिर से पेयर करें।",
  "machines.err.nameTaken": "इस नाम का कोई और कंप्यूटर पहले से है, या यह नाम आरक्षित है। कोई और नाम चुनें।",
  "machines.err.nameInvalid":
    "यह नाम इस्तेमाल नहीं हो सकता। सामान्य अक्षर, अंक और विराम चिह्न इस्तेमाल करें, अधिकतम 64 अक्षर, और एक जैसे दिखने वाले अक्षर न मिलाएँ।",
  "machines.err.forbidden": "नाम बदलने के लिए एडमिन डिवाइस चाहिए। किसी एडमिन डिवाइस से फिर कोशिश करें।",
  "machines.err.failed": "यह नहीं हो पाया ({reason})। कुछ नहीं बदला।",
  "machines.account.own":
    "{name} पर आपके अपने खाते से चलता है। Psyche वहाँ आपकी फ़ाइलें, ऐप और लॉगिन आपकी तरह इस्तेमाल कर सकता है। अगर आपका Psyche कभी compromise हुआ, तो हमलावर भी यही कर सकता है, सिवाय root के, जो Psyche को कभी नहीं मिलता।",
  "machines.account.dedicated":
    "{name} पर अलग खाते से चलता है। Psyche को सिर्फ़ उस खाते की फ़ाइलें और ऐप दिखते हैं।",
  "machines.account.useSeparate": "इसके बजाय अलग खाता इस्तेमाल करें…",
  "machines.account.useSeparateHint":
    "{name} पर अलग खाते के विकल्प के साथ इंस्टॉलर फिर चलाएँ, और फिर उसे दोबारा पेयर करें:",
  "machines.shell.contained": "कमांड अलग किए गए शेल में चलते हैं",
  "machines.shell.full": "कमांड खाते के पूरे शेल में चलते हैं",
  "machines.shell.off": "कमांड बंद हैं",
  "machines.limits.folders":
    "{count, plural, =0 {कोई फ़ोल्डर नहीं दिया गया} one {# फ़ोल्डर दिया गया} other {# फ़ोल्डर दिए गए}}",
  "machines.helperVersion": "सहायक {version}",
  "machines.helperVersionUnknown": "सहायक का संस्करण अज्ञात",
  "machines.update": "सहायक का नया संस्करण उपलब्ध है। {name} पर सहायक अपडेट करें:",
  "machines.warnings": "{name} के लिए चेतावनियाँ",
  "machines.warn.fullShell":
    "खाते का पूरा शेल। कमांड अलग नहीं किए गए हैं, इसलिए वे वह सब छू सकते हैं जो यह खाता छू सकता है।",
  "machines.warn.userLimits":
    "सीमाएँ उपयोगकर्ता की हैं। इस खाते से चलने वाला कोई भी प्रोग्राम बदल सकता है कि Psyche {name} पर क्या कर सकता है।",
  "machines.warn.sudo":
    "इस खाते में बिना पासवर्ड का sudo है। Psyche यहाँ sudo इस्तेमाल नहीं कर सकता, पर इस खाते से चलाए गए दूसरे प्रोग्राम कर सकते हैं।",
  "machines.paired": "{when} पेयर किया गया",
  "machines.line": "“{name}” पर · Linux · {place}",
  "machines.place.screen": "निजी स्क्रीन",
  "machines.place.desktop": "उसका डेस्कटॉप",
  "machines.place.command": "कमांड",
  "machines.place.files": "फ़ाइलें",
  "machines.step.on": "{name} पर {label}",
  "machines.picker.title": "कंप्यूटर",
  "machines.picker.description":
    "चुनें कि ये सेटिंग किस कंप्यूटर के लिए हैं, और जब आप किसी ख़ास कंप्यूटर को नहीं देख रहे हों तब Psyche कहाँ काम करे।",
  "machines.picker.show": "इसके लिए ऐप एक्सेस दिखाएँ",
  "machines.picker.default": "बैकग्राउंड काम के लिए डिफ़ॉल्ट कंप्यूटर",
  "machines.picker.defaultHint":
    "टास्क और ऑटोमेशन वहीं चलते हैं, जब तक वे किसी कंप्यूटर का नाम न लें। कोई Linux कंप्यूटर चुनें, ताकि आप यहाँ काम करें और Psyche वहाँ।",
  "machines.picker.appsOn": "{name} पर ऐप",
  "machines.picker.appsHint":
    "Psyche इन्हें {name} से सिंक करता है और उस कंप्यूटर की अपनी सीमाओं से आगे कभी नहीं जाता।",
  "machines.picker.noApps": "Psyche ने अभी {name} पर कोई ऐप नहीं देखा। देखते ही वे यहाँ दिखेंगे।",
  "machines.picker.offline": "{name} ऑफ़लाइन है। दोबारा कनेक्ट होने पर बदलाव उस तक पहुँचेंगे।",
  "computerWatch.titleMachine": "{name} · निजी स्क्रीन",
  "computerWatch.machineOffline": "{name} तक नहीं पहुँच सके। फिर कोशिश हो रही है…",
  "computerWatch.empty.bodyMachine": "जब एजेंट को {name} पर स्क्रीन चाहिए होगी, आप उसे यहाँ देख सकेंगे।",
  "notice.machine.working.title": "Psyche {name} पर काम कर रहा है",
  "notice.machine.working.body":
    "वह उस कंप्यूटर की स्क्रीन, ऐप या फ़ाइलें इस्तेमाल कर रहा है। उसे सेटिंग → डिवाइस से देखें।",
  "notice.machine.offline.title": "{name} ऑफ़लाइन हो गया",
  "notice.machine.offline.body":
    "दोबारा कनेक्ट होने तक Psyche इसे इस्तेमाल नहीं कर सकता। जिन टास्क को इसकी ज़रूरत है, वे आपका इंतज़ार करेंगे।",
  "machines.add.linkStep": "3. जब वह लिंक माँगे, तो यह चिपकाएँ",
  "machines.add.installSource": "{url} से सहायक का पैकेज लें, उसे खोलें, और Linux कंप्यूटर पर यह चलाएँ।",
  "machines.reports": "{name} बताता है:",
  "computerWatch.machineLoading": "कंप्यूटर लोड हो रहा है…",
  "computerWatch.machineMissing": "वह कंप्यूटर उपलब्ध नहीं है।",
  "settings.key.computerUse.defaultMachine": "बैकग्राउंड काम के लिए डिफ़ॉल्ट कंप्यूटर",
  "settings.key.computerUse.machineApps": "Linux कंप्यूटर पर ऐप एक्सेस",
  "machines.card.folder": "फ़ोल्डर",
  "machines.card.runsContained":
    "अलग रखा गया, सिर्फ़ दिए गए फ़ोल्डर में: कोई कुंजी, ब्राउज़र प्रोफ़ाइल या दूसरा फ़ोल्डर नहीं",
  "machines.card.runsFullAccount": "पूरे खाते पर: वह खाता जो कुछ कर सकता है, यह भी कर सकता है",
  "machines.card.networkOff": "बंद",
  "machines.card.networkOn": "चालू",
  "machines.card.folderReadOnly": "{path}, सिर्फ़ पढ़ने के लिए",
  "machines.card.folderReadWrite": "{path}, पढ़ने और लिखने के लिए",
  "machines.card.folderNotEnforced": "{path}, पूरे खाते पर सिर्फ़-पढ़ना लागू नहीं होता",
};
