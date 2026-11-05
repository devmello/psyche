import type { Catalogue } from "../../index.ts";

/** `personData.*` strings (hi); merged into `../hi.ts`. */
export const personDataRest: Partial<Catalogue> = {
  "personData.export": "सब कुछ एक्सपोर्ट करें…",
  "personData.said": "जो इन्होंने कहा उसे भूल जाएँ…",
  "personData.exclude": "इनके बारे में न सीखें…",
  "personData.excludeForget": "इनके बारे में न सीखें, और भूल जाएँ…",
  "personData.title.said": "{name} ने जो कहा उसे भूल जाएँ?",
  "personData.title.exclude": "{name} के बारे में सीखना बंद करें?",
  "personData.title.exclude_forget": "{name} के बारे में सीखना बंद करें और भूल जाएँ?",
  "personData.counts": "इनके संदेशों से सीखे गए {facts, number} तथ्य और {quotes, number} उद्धरण, और {held, number} रोके गए आइटम हटा दिए जाते हैं।",
  "personData.excludeOnly": "इनके संदेश नहीं पढ़े जाएँगे और इनके बारे में कुछ नहीं सीखा जाएगा। जो पहले से ज्ञात है वह तब तक रहेगा जब तक आप उसे भूल नहीं जाते।",
  "personData.after.said": "व्यक्ति, उनके संदेश और जो कुछ आपने खुद जोड़ा है, वह रहता है।",
  "personData.after.exclude": "आप इन्हें सेटिंग्ज़ → मेमोरी → गोपनीयता में फिर से अनुमति दे सकते हैं।",
  "personData.after.exclude_forget": "आप इन्हें सेटिंग्ज़ → मेमोरी → गोपनीयता में फिर से अनुमति दे सकते हैं, लेकिन जो हटाया गया वह वापस नहीं आता।",
  "personData.confirm.said": "जो कहा उसे भूल जाएँ",
  "personData.confirm.exclude": "सीखना बंद करें",
  "personData.confirm.exclude_forget": "बंद करें और भूल जाएँ",
  "personData.done.said": "{name} ने जो कहा था वह भुला दिया गया।",
  "personData.done.exclude": "{name} के बारे में अब नहीं सीखा जा रहा।",
  "personData.done.exclude_forget": "{name} के बारे में अब नहीं सीखा जा रहा, और जो उन्होंने कहा था वह भुला दिया गया।",
};
