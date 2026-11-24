import type { Catalogue } from "../../index.ts";

/** Approval-friction and person-interaction strings (hi); merged into `../hi.ts`. */
export const friction: Partial<Catalogue> = {
  "friction.title": "मंज़ूरी में रुकावट",
  "friction.hint":
    "Psyche कार्य से पहले कितनी बार रुककर पूछता है, और आप कैसे जवाब देते हैं। केवल गिनती, ऑडिट लॉग से।",
  "friction.window": "समय सीमा",
  "friction.window.days": "पिछले {days} दिन",
  "friction.loading": "मंज़ूरी गिनी जा रही है…",
  "friction.error": "मंज़ूरी की रुकावट लोड नहीं हो सकी: {reason}",
  "friction.retry": "फिर से कोशिश करें",
  "friction.empty": "इस समय सीमा में Psyche ने कोई कार्य नहीं जाँचा, इसलिए दिखाने के लिए कुछ नहीं है।",
  "friction.since": "{date} से",
  "friction.asked":
    "{decisions, plural, one {# कार्य} other {# कार्यों}} में से {asks, plural, one {# कार्य} other {# कार्यों}} के बारे में पूछा ({rate}%)।",
  "friction.perRun": "जिन रनों में कम से कम एक बार पूछा गया, उनमें औसतन {n} सवाल प्रति रन पूछे गए।",
  "friction.answered": "समाप्त हुए सवालों में से {rate}% का जवाब समय सीमा से पहले दिया गया।",
  "friction.approved": "समाप्त हुए सवालों में से {rate}% को मंज़ूरी दी गई।",
  "friction.noTimes":
    "इस समय सीमा में किसी सवाल का जवाब नहीं दिया गया, इसलिए जवाब का समय उपलब्ध नहीं है।",
  "friction.times": "जवाब देने में मध्यिका {p50} लगा। सबसे धीमे दसवें हिस्से में {p90} या उससे अधिक लगा।",
  "friction.expired":
    "{n, plural, =0 {कोई सवाल बिना जवाब के समाप्त नहीं हुआ।} one {# सवाल बिना जवाब के समाप्त हुआ।} other {# सवाल बिना जवाब के समाप्त हुए।}}",
  "friction.rejected":
    "{n, plural, =0 {कोई जवाब अस्वीकार नहीं हुआ।} one {# जवाब अमान्य मानकर अस्वीकार हुआ।} other {# जवाब अमान्य मानकर अस्वीकार हुए।}}",
  "friction.saved":
    "{n, plural, =0 {कोई कार्य स्थायी अनुमति के तहत बिना कार्ड के नहीं चला।} one {# कार्य स्थायी अनुमति के तहत बिना कार्ड के चला।} other {# कार्य स्थायी अनुमति के तहत बिना कार्ड के चले।}}",
  "friction.grantsCreated":
    "{n, plural, =0 {कोई स्थायी अनुमति नहीं बनाई गई।} one {# स्थायी अनुमति बनाई गई।} other {# स्थायी अनुमतियाँ बनाई गईं।}}",
  "friction.kinds": "सवाल कहाँ से आए",
  "friction.kind.row": "{kind}: पूछा {asks}, मंज़ूर {approved}, अस्वीकार {declined}, समाप्त {expired}",
  "friction.rules": "सवाल पूछने के सबसे आम कारण",
  "friction.rule.row": "{label}: {count}",
  "friction.rule.mode": "आपकी मोड सेटिंग",
  "friction.rule.taint": "बाहर से आई सामग्री",
  "friction.rule.policy": "आपकी नीति",
  "friction.rule.designated": "एक सुरक्षित स्थान",
  "friction.rule.site": "एक साइट नियम",
  "friction.rule.other": "एक अन्य नियम",
  "friction.modes": "मोड के अनुसार",
  "friction.mode.row": "{mode}: {decisions} में से {asks} पर पूछा",

  "people.interactions.title": "हाल की बातचीत",
  "people.interactions.empty": "{name} के साथ अभी कोई बातचीत नहीं है।",
  "people.interactions.error": "बातचीत लोड नहीं हो सकी: {reason}",
  "people.interactions.more": "और दिखाएँ",
  "people.interactions.loadingMore": "लोड हो रहा है…",
};
