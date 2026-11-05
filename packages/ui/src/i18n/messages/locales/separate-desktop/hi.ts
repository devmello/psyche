import type { Catalogue } from "../../index.ts";

/** Settings > Computer use > Separate desktop (hi); merged into `../hi.ts`. */
export const separateDesktop: Partial<Catalogue> = {
  "settings.separateDesktop.title": "अलग डेस्कटॉप",
  "settings.separateDesktop.description":
    "कंटेनर में एक निजी डेस्कटॉप, जिसके अपने ऐप और फ़ाइलें हैं। यह सिर्फ़ वे फ़ोल्डर देखता है जो आप किसी कार्य के लिए साझा करते हैं, उस कार्य के लिए अनुमति दिए बिना इसमें इंटरनेट नहीं होता, और कार्य ख़त्म होने पर यह रुक जाता है।",
  "settings.separateDesktop.state.off": "चल नहीं रहा",
  "settings.separateDesktop.state.starting": "शुरू हो रहा है",
  "settings.separateDesktop.state.running": "चल रहा है",
  "settings.separateDesktop.state.stopping": "रुक रहा है",
  "settings.separateDesktop.state.failed": "शुरू नहीं हो सका",
  "settings.separateDesktop.engine": "कंटेनर इंजन: {engine}",
  "settings.separateDesktop.rootful":
    "यह कंटेनर इंजन root के रूप में चलता है। अलग डेस्कटॉप के लिए rootless Podman इस्तेमाल करें।",
  "settings.separateDesktop.memory": "मेमोरी सीमा",
  "settings.separateDesktop.memoryHint":
    "अलग डेस्कटॉप के चलते समय वह अधिकतम कितनी मेमोरी इस्तेमाल कर सकता है।",
  "settings.separateDesktop.memoryOption": "{gb} GB",
  "settings.separateDesktop.shares": "साझा किए गए फ़ोल्डर: {names}",
  "settings.separateDesktop.internet": "इस कार्य के लिए इंटरनेट चालू है",
  "settings.separateDesktop.reset": "अलग डेस्कटॉप रीसेट करें",
  "settings.separateDesktop.resetHint":
    "इसका कंटेनर और उसमें सहेजा सब कुछ हटा देता है। आपके साझा किए फ़ोल्डरों को छुआ नहीं जाता।",
  "blocks.folder.sd.explain.ro": "{persona} अलग डेस्कटॉप को किसी फ़ोल्डर की फ़ाइलें पढ़ने देना चाहता है।",
  "blocks.folder.sd.explain.rw":
    "{persona} अलग डेस्कटॉप को किसी फ़ोल्डर की फ़ाइलें पढ़ने और बदलने देना चाहता है।",
  "blocks.folder.sd.scope":
    "अलग डेस्कटॉप यह फ़ोल्डर सिर्फ़ इस कार्य के दौरान देखता है। इस कंप्यूटर पर और कुछ साझा नहीं होता, और इस कंप्यूटर का कोई दूसरा टूल यह फ़ोल्डर नहीं पाता।",
  "blocks.folder.sd.scope.once": "सिर्फ़ यह कार्य",
  "settings.separateDesktop.limitMemory": "इस सिस्टम पर मेमोरी सीमा लागू नहीं है",
  "settings.separateDesktop.limitPids": "इस सिस्टम पर प्रक्रिया सीमा लागू नहीं है",
  "blocks.details.sdUnverified":
    "अलग डेस्कटॉप पुष्टि नहीं कर सकता कि यह पेज सच में {origin} है। तभी आगे बढ़ें जब आप उस जगह पर भरोसा करते हों जहाँ कार्य आपको ले गया।",
};
