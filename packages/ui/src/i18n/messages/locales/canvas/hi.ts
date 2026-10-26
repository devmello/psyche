import type { Catalogue } from "../../index.ts";

/** Output canvas strings (hi); merged into `../hi.ts`. */
export const canvas: Partial<Catalogue> = {
  "canvas.chart": "चार्ट",
  "canvas.htmlOff":
    "यह अविश्वसनीय सामग्री से आया है, इसलिए पूर्वावलोकन बंद है। केवल तभी चलाएँ जब आप इस पर भरोसा करते हों। यह बिना नेटवर्क वाले सैंडबॉक्स में चलता है।",
  "canvas.htmlRun": "चलाएँ",
  "canvas.htmlNoPreview": "यह होस्ट HTML का पूर्वावलोकन नहीं कर सकता; स्रोत दिखाया गया है।",
  "canvas.label": "कैनवास: {title}",
  "canvas.recents": "हाल के आउटपुट",
  "canvas.loading": "लोड हो रहा है…",
  "canvas.missing": "Psyche यह आउटपुट लोड नहीं कर सका।",
  "canvas.untrusted": "अविश्वसनीय सामग्री से बना",
  "canvas.version": "संस्करण",
  "canvas.versionOption":
    "v{version} · {author, select, user {आप} specialist {विशेषज्ञ} other {Psyche}} · {time}",
  "canvas.copy": "कॉपी करें",
  "canvas.copied": "कॉपी हो गया",
  "canvas.download": "डाउनलोड करें",
  "canvas.restore": "नए संस्करण के रूप में पुनर्स्थापित करें",
  "canvas.oldVersion": "संस्करण {version} (केवल पढ़ने के लिए)।",
  "canvas.conflict":
    "आपके संपादन के दौरान यह बदल गया, इसलिए आपका संपादन सहेजा नहीं गया। नवीनतम संस्करण पर फिर से कोशिश करें।",
  "canvas.saveFailed": "सहेजा नहीं जा सका: {message}",
  "canvas.map": "मानचित्र",
  "map.label": "मानचित्र: {title}",
  "map.untitled": "मानचित्र",
  "map.list": "स्थान",
  "map.openLink": "लिंक खोलें",
  "map.empty": "दिखाने के लिए कोई स्थान नहीं।",
  "map.tilesOff": "सेटिंग में मानचित्र टाइल बंद हैं। सूची दिखाई जा रही है।",
  "map.tilesFailed": "मानचित्र लोड नहीं हो सका। सूची दिखाई जा रही है।",
  "map.showMap": "मानचित्र दिखाएँ",
  "map.showList": "सूची दिखाएँ",
  "map.card": "मानचित्र: {title}",
  "map.meta": "{count, plural, one {# स्थान} other {# स्थान}} · {date}",
  "map.openCanvas": "कैनवास में खोलें",
  "map.invalid": "यह मानचित्र पढ़ा नहीं जा सका।",
  "map.gesture.windows": "मानचित्र ज़ूम करने के लिए Ctrl + स्क्रॉल करें",
  "map.gesture.mac": "मानचित्र ज़ूम करने के लिए ⌘ + स्क्रॉल करें",
  "map.gesture.mobile": "मानचित्र हिलाने के लिए दो उँगलियों का उपयोग करें",
  "settings.map.title": "मानचित्र",
  "settings.map.privacy":
    "मानचित्र दिखाने पर टाइल सर्वर से आपके देखे जा रहे क्षेत्र का अनुरोध होता है, इसलिए वह सर्वर मोटे तौर पर जान सकता है कि आप कहाँ देख रहे हैं। स्थान केवल सूची में देखने के लिए टाइल बंद करें, या अपना टाइल सर्वर इस्तेमाल करें।",
  "settings.map.tiles": "मानचित्र टाइल दिखाएँ",
  "settings.map.tilesHint": "बंद करने पर स्थान बिना मानचित्र अनुरोध के सूची में दिखते हैं।",
  "settings.map.style": "टाइल सर्वर स्टाइल URL",
  "settings.map.styleHint":
    "MapLibre स्टाइल JSON का URL, जैसे आपका अपना सर्वर। खाली होने पर मुफ़्त OpenFreeMap टाइल इस्तेमाल होते हैं (केवल https; localhost के लिए http)।",
  "settings.map.styleDark": "स्टाइल URL (डार्क)",
  "settings.map.styleDarkHint":
    "वैकल्पिक। खाली होने पर डार्क मोड में भी ऊपर की स्टाइल, या OpenFreeMap की डार्क स्टाइल इस्तेमाल होती है।",
};
