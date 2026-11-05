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
};
