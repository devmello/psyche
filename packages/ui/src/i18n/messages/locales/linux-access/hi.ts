import type { Catalogue } from "../../index.ts";

/** Linux access in Settings → Computer use (hi); merged into `../hi.ts`. */
export const linuxAccess: Partial<Catalogue> = {
  "settings.computerUse.linux.screen.name": "स्क्रीन और इनपुट की पहुँच",
  "settings.computerUse.linux.screen.allowed": "आपके रद्द करने तक अनुमत",
  "settings.computerUse.linux.screen.asks": "पहली बार इस्तेमाल करने पर पूछा जाता है",
  "settings.computerUse.linux.screen.notNeeded": "X11 पर ज़रूरी नहीं",
  "settings.computerUse.linux.screen.unavailable": "उपलब्ध नहीं",
  "settings.computerUse.linux.screen.why":
    "आपके डेस्कटॉप के अनुमति संवाद के ज़रिए {persona} को स्क्रीन देखने और माउस-कीबोर्ड इस्तेमाल करने की अनुमति मिलती है। यह अनुमति आप एक ही बार देते हैं।",
  "settings.computerUse.linux.revoke": "रद्द करें",
  "settings.computerUse.linux.revokeLabel": "स्क्रीन और इनपुट की पहुँच रद्द करें",
  "settings.computerUse.linux.warning.x11":
    "X11 पर कोई भी ऐप आपकी स्क्रीन और कीस्ट्रोक पढ़ सकता है, जिनमें कुछ मंज़ूर करते समय आपका डाला गया पासवर्ड भी शामिल है।",
  "settings.computerUse.linux.warning.wlroots":
    "इस डेस्कटॉप पर कोई भी ऐप बिना पूछे आपकी स्क्रीन पढ़ सकता है और आपकी ओर से टाइप कर सकता है। Psyche सहमति का कोई चरण नहीं जोड़ सकता।",
  "settings.computerUse.linux.accessibility":
    "अब से खोले जाने वाले ऐप अपनी संरचना Psyche को दिखाएँगे। पहले से खुले ऐप को दोबारा शुरू करना पड़ सकता है।",
  "settings.computerUse.linux.headless":
    "इस कंप्यूटर पर ग्राफ़िकल सत्र चाहिए। डेस्कटॉप में लॉग इन करके फिर कोशिश करें।",
};
