import type { Catalogue } from "../../index.ts";

/** `automationChat.*` strings (hi); merged into `../hi.ts`. */
export const automationChatRest: Partial<Catalogue> = {
  "automationChat.label": "{title} के रन",
  "automationChat.runs": "{n, plural, one {# रन} other {# रन}}",
  "automationChat.runs.aria": "{title}, {n, plural, one {# रन} other {# रन}}, आखिरी रन {status}",
  "automationChat.schedule": "शेड्यूल्ड",
  "automationChat.runNow": "अभी चलाएँ",
  "automationChat.empty": "अभी कोई रन नहीं। यह ऑटोमेशन जब भी चलता है, यहाँ दिखता है।",
  "automationChat.loading": "रन लोड हो रहे हैं",
  "automationChat.failed": "Psyche रन लोड नहीं कर सका",
  "automationChat.more": "पुराने रन दिखाएँ",
  "automationChat.status.needsYou": "आपकी ज़रूरत है",
  "automationChat.status.running": "चल रहा है",
  "automationChat.trigger.manual": "अभी चलाएँ",
  "automationChat.trigger.event": "किसी इवेंट पर",
  "automationChat.coalesced": "{n} छूटे रन एक में",
  "automationChat.noResult": "कोई नतीजा नहीं लिखा गया",
  "automationChat.noSteps": "इस रन के लिए कोई चरण दर्ज नहीं हुआ।",
  "automationChat.stepsLoading": "चरण लोड हो रहे हैं",
  "automationChat.timeline": "टाइमलाइन में खोलें",
  "automationChat.approvals": "स्वीकृतियाँ खोलें",
  "automationChat.waiting": "यह रन आपकी प्रतीक्षा में है।",
  "automationChat.result": "नतीजा",
  "automationChat.openScheduled": "शेड्यूल्ड में खोलें",
  "automationChat.row.runs": "{n, plural, one {# रन} other {# रन}}",
  "automationChat.row.last": "आखिरी रन: {status}",
};
