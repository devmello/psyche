import type { Catalogue } from "../../index.ts";

/** Simplify B9 strings (hi); merged into `../hi.ts`. */
export const simplifyB9: Partial<Catalogue> = {
  "simplify.b9.approval.expiresAt": "{time} पर समाप्त होगा",
  "simplify.b9.execHost.sandboxed": "यह सैंडबॉक्स में चलेगा।",
  "simplify.b9.execHost.noSandbox":
    "सैंडबॉक्स सेट अप नहीं है, इसलिए यह कमांड केवल उसके बिना चल सकता है। उसे सेट अप करें, या इस बार सैंडबॉक्स के बिना चलाएँ।",
  "simplify.b9.execHost.noHostSandbox":
    "इस कंप्यूटर पर कमांड के लिए सैंडबॉक्स नहीं है, इसलिए यह कमांड केवल उसके बिना चल सकता है। आप इसे सिर्फ़ इस बार चला सकते हैं।",
  "simplify.b9.execHost.runOnce": "एक बार सैंडबॉक्स के बिना चलाएँ",
  "simplify.b9.library.madeBy": "{name} द्वारा बनाया गया",
  "simplify.b9.library.task": "कार्य",
  "simplify.b9.library.more": "और फ़िल्टर",
};
