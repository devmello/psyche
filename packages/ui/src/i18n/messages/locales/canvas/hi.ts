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
};
