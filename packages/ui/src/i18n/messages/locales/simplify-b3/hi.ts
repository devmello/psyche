import type { Catalogue } from "../../index.ts";

/** Onboarding finish, recovery key and searchable switch (hi); merged into `../hi.ts`. */
export const simplifyB3: Partial<Catalogue> = {
  "onboarding.done.start": "चैट शुरू करें",
  "onboarding.done.psycheLabel": "Psyche",
  "onboarding.done.psycheWait": "अभी Psyche से संपर्क नहीं हो पा रहा। यह विंडो अपने आप फिर से जुड़ जाएगी।",
  "onboarding.done.helperWait":
    "Psyche Helper अभी जुड़ा नहीं है। जुड़ते ही कंप्यूटर का उपयोग और सूचनाएँ शुरू हो जाएँगी।",
  "onboarding.connectors.searchable": "इन्हें खोजने योग्य बनाएँ",
  "onboarding.connectors.searchableHint":
    "{name} खोज में इन खातों के मेल, इवेंट और नोट ढूँढ सकता है। आप सेटिंग में किसी को भी बंद कर सकते हैं।",
  "home.recoveryKey.title": "अपनी रिकवरी कुंजी सहेजें",
  "home.recoveryKey.body":
    "रिस्टोर के बाद या कुंजी खो जाने पर यही आपकी वॉल्ट में वापस जाने का एकमात्र तरीका है। इसे दिखाएँ, एक प्रति सुरक्षित जगह रखें, फिर पुष्टि करें।",
  "settings.credentials.vault.recoveryKey.show": "रिकवरी कुंजी दिखाएँ",
  "settings.credentials.vault.recoveryKey.hide": "छिपाएँ",
  "settings.credentials.vault.recoveryKey.gone":
    "इस वॉल्ट की रिकवरी कुंजी सिर्फ़ बनाते समय दिखाई गई थी, इसलिए इसे दोबारा नहीं दिखाया जा सकता।",
  "settings.credentials.vault.recoveryKey.failed": "रिकवरी कुंजी नहीं दिखाई जा सकी: {reason}",
  "settings.credentials.vault.recoveryKey.title": "रिकवरी कुंजी",
  "settings.credentials.vault.recoveryKey.body":
    "रिस्टोर के बाद या कुंजी खो जाने पर वॉल्ट में वापस जाने का एकमात्र तरीका। एक प्रति सुरक्षित जगह रखें।",
};
