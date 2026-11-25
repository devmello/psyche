import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (hi); merged into `../hi.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "इस कंप्यूटर को जागा रखें",
  "settings.daily.keepAwake.hint":
    "शेड्यूल किया गया काम चलते समय यह कंप्यूटर खत्म होने तक नहीं सोएगा। स्क्रीन फिर भी बंद हो सकती है।",
  "settings.key.scheduled.keepAwake": "शेड्यूल किया गया काम चलते समय इस कंप्यूटर को जागा रखें",
  "scheduled.history.retryingAt": "{time} पर फिर से कोशिश होगी",
  "scheduled.history.retry": "कोशिश {n} / 3",
  "scheduled.history.failedAfterRetries": "{n} बार दोबारा कोशिश के बाद विफल",
  "scheduled.history.cancelRetry": "पुनः प्रयास रद्द करें",
  "scheduled.history.cancelRetry.aria": "{when} के रन का पुनः प्रयास रद्द करें",
  "scheduled.history.cancelRetry.failed": "पुनः प्रयास रद्द नहीं किया जा सका ({reason})।",
  "settings.updates.group": "अपडेट",
  "settings.updates.hint": "Psyche हस्ताक्षरित अपडेट खोजता है और आपके बाहर निकलने पर उन्हें इंस्टॉल करता है।",
  "settings.updates.channel": "रिलीज़ चैनल",
  "settings.updates.channel.stable": "स्टेबल",
  "settings.updates.channel.note":
    "फ़िलहाल स्टेबल ही एकमात्र चैनल है। बीटा बिल्ड प्रकाशित होने पर बीटा यहाँ दिखेगा। हर अपडेट की जाँच हर हाल में Psyche की रिलीज़ कुंजी से होती है।",
  "settings.storage.title": "स्टोरेज",
  "settings.storage.hint": "इस कंप्यूटर पर Psyche अपने डेटा फ़ोल्डर में जितनी डिस्क जगह इस्तेमाल करता है।",
  "settings.storage.total": "कुल",
  "settings.storage.clear": "साफ़ करें…",
  "settings.storage.cleared": "साफ़ हो गया। {size} खाली हुआ।",
  "settings.storage.clearFailed": "स्टोरेज साफ़ नहीं किया जा सका ({reason})।",
  "settings.storage.compact.title": "डेटाबेस संक्षिप्त करें",
  "settings.storage.compact.hint":
    "डेटाबेस {size} है, {reclaimable} तक वापस मिल सकता है। इस दौरान Psyche कुछ देर रुकता है।",
  "settings.storage.compact.button": "संक्षिप्त करें",
  "settings.storage.compact.running": "संक्षिप्त किया जा रहा है…",
  "settings.storage.compact.done": "{seconds} सेकंड में संक्षिप्त हुआ, {size} बचे।",
  "settings.storage.compact.failed": "डेटाबेस संक्षिप्त नहीं हो सका ({reason})।",
  "settings.storage.compact.busy": "Psyche अभी किसी काम में व्यस्त है। उसके खत्म होने पर फिर कोशिश करें।",
  "settings.storage.failed": "स्टोरेज का उपयोग पढ़ा नहीं जा सका ({reason})।",
  "settings.storage.confirm.title": "कैश और पुरानी रिकॉर्डिंग साफ़ करें?",
  "settings.storage.confirm.body":
    "इससे कैश और 7 दिन से पुरानी ब्राउज़र रिकॉर्डिंग मिलाकर {size} हट जाएगा, साथ ही उन रिकॉर्डिंग की लाइब्रेरी प्रविष्टियाँ भी। ज़रूरत पड़ने पर Psyche कैश दोबारा बना लेता है। आपकी चैट, मेमोरी, लाइब्रेरी की अन्य फ़ाइलें, वॉल्ट और सेटिंग्स को छुआ नहीं जाता।",
  "settings.storage.confirm.clear": "साफ़ करें",
  "settings.storage.cat.database": "डेटाबेस",
  "settings.storage.cat.memoryIndex": "मेमोरी इंडेक्स",
  "settings.storage.cat.library": "अटैचमेंट और लाइब्रेरी",
  "settings.storage.cat.browserProfiles": "ब्राउज़र प्रोफ़ाइल",
  "settings.storage.cat.recordings": "रिकॉर्डिंग",
  "settings.storage.cat.logs": "लॉग",
  "settings.storage.cat.caches": "कैश",
  "settings.storage.cat.other": "बाकी सब कुछ",
};
