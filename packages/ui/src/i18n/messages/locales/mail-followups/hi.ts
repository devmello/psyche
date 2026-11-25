import type { Catalogue } from "../../index.ts";

/** Follow-ups on quiet email threads (hi); merged into `../hi.ts`. */
export const mailFollowups: Partial<Catalogue> = {
  "home.quietThreads": "शांत पड़े ईमेल थ्रेड",
  "home.quietThreads.hint": "ऐसे ईमेल जो आपके या उनके जवाब का इंतज़ार कर रहे हैं",
  "mailFollowups.someone": "कोई",
  "mailFollowups.line.noReply": "{who} ने {days, plural, one {# दिन} other {# दिन}} से जवाब नहीं दिया",
  "mailFollowups.line.question":
    "{who} ने {days, plural, one {# दिन} other {# दिन}} पहले आपसे कुछ पूछा था",
  "mailFollowups.draft": "फ़ॉलो-अप का ड्राफ़्ट बनाएँ",
  "mailFollowups.snooze": "बाद में याद दिलाएँ",
  "mailFollowups.dismiss": "हटाएँ",
  "mailFollowups.failed": "यह नहीं हो सका: {reason}",
  "mailFollowups.prefill": "इस थ्रेड के लिए फ़ॉलो-अप का ड्राफ़्ट बनाइए।",
  "mailFollowups.thread.title": "ईमेल फ़ॉलो-अप",
  "chat.composer.placeholderMail": "इस थ्रेड के बारे में पूछें",
  "daily.section.quiet_threads": "शांत पड़े ईमेल थ्रेड",
  "daily.section.promises": "वादे",
  "screens.inbox.kind.promise_due": "वादा देय",
};
