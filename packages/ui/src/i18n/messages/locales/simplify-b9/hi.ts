import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (hi); merged into `../hi.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplifyB9.approval.expiresAt": "{time} पर समाप्त होगा",
  "simplifyB9.execHost.sandboxed": "यह सैंडबॉक्स में चलेगा।",
  "simplifyB9.execHost.noSandbox":
    "सैंडबॉक्स सेट अप नहीं है, इसलिए यह कमांड केवल उसके बिना चल सकता है। उसे सेट अप करें, या इस बार सैंडबॉक्स के बिना चलाएँ।",
  "simplifyB9.execHost.noHostSandbox":
    "इस कंप्यूटर पर कमांड के लिए सैंडबॉक्स नहीं है, इसलिए यह कमांड केवल उसके बिना चल सकता है। आप इसे सिर्फ़ इस बार चला सकते हैं।",
  "simplifyB9.execHost.runOnce": "एक बार सैंडबॉक्स के बिना चलाएँ",
  "simplifyB9.library.madeBy": "{name} द्वारा बनाया गया",
  "simplifyB9.library.task": "कार्य",
  "simplifyB9.library.more": "और फ़िल्टर",
};
