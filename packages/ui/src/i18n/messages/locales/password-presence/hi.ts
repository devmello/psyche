import type { Catalogue } from "../../index.ts";

/** Password presence on Linux (hi); merged into `../hi.ts`. */
export const passwordPresence: Partial<Catalogue> = {
  "blocks.approval.password.needsAuth": "मंज़ूरी के लिए आपका पासवर्ड या पासकी चाहिए।",
  "blocks.approval.password.waiting": "{code} को मंज़ूर करने के लिए सिस्टम संवाद में अपना पासवर्ड लिखें",
  "blocks.approval.password.waitingShort": "आपके पासवर्ड की प्रतीक्षा है…",
  "blocks.approval.password.onceOnly": "इस विंडो से पासवर्ड द्वारा दी गई मंज़ूरी केवल एक बार के लिए होती है।",
  "blocks.approval.status.allowedOncePassword":
    "एक बार अनुमति दी गई (इस विंडो से पासवर्ड द्वारा दी गई मंज़ूरी केवल एक बार के लिए होती है)",
  "blocks.approval.password.noUnsandboxed":
    "सैंडबॉक्स के बिना कमांड चलाने को इस विंडो से पासवर्ड द्वारा मंज़ूर नहीं किया जा सकता। इसके बजाय सैंडबॉक्स सेट करें",
  "blocks.approval.password.failed":
    "पासवर्ड स्वीकार नहीं हुआ, इसलिए कुछ भी मंज़ूर नहीं हुआ। फिर से कोशिश करें।",
  "blocks.approval.password.unavailableHere":
    "इसी कंप्यूटर पर मंज़ूर करें, या किसी दूसरे डिवाइस से पासकी के साथ।",
  "blocks.approval.password.agentMissing":
    "इस डेस्कटॉप पर पासवर्ड संवाद उपलब्ध नहीं है। polkit-gnome या lxpolkit जैसा polkit एजेंट इंस्टॉल करें, या पासकी का उपयोग करें।",
  "blocks.approval.password.policyMissing":
    "Psyche की पासवर्ड नीति इस कंप्यूटर पर इंस्टॉल नहीं है। Psyche का एक-बार वाला सेटअप चलाएँ, या पासकी का उपयोग करें।",
  "blocks.approval.password.notEnforced":
    "इस कंप्यूटर का एक polkit नियम Psyche को बिना पासवर्ड के मंज़ूरी देता है, इसलिए यह पुष्टि नहीं हो सकती कि यह आप ही थे। नियम हटाएँ, या पासकी का उपयोग करें।",
  "blocks.approval.password.unreachable":
    "सिस्टम की पासवर्ड सेवा उपलब्ध नहीं है। फिर से कोशिश करें, या पासकी का उपयोग करें।",
  "settings.devices.password.title": "पासवर्ड से मंज़ूरी",
  "settings.devices.password.description":
    "किसी संवेदनशील कार्रवाई को मंज़ूर करने से पहले, Psyche सिस्टम के अपने संवाद में आपका पासवर्ड माँगता है। पासवर्ड कभी Psyche तक नहीं पहुँचता।",
  "settings.devices.password.state.ready": "तैयार",
  "settings.devices.password.state.policyMissing": "नीति इंस्टॉल नहीं है",
  "settings.devices.password.state.notEnforced": "बंद",
  "settings.devices.password.state.noSession": "कोई डेस्कटॉप सत्र नहीं",
  "settings.devices.password.state.agentMissing": "पासवर्ड संवाद नहीं",
  "settings.devices.password.state.unavailable": "उपलब्ध नहीं",
  "settings.devices.password.detail.ready":
    "किसी संवेदनशील कार्रवाई को मंज़ूर करते समय Psyche सिस्टम संवाद में आपका पासवर्ड माँगता है।",
  "settings.devices.password.detail.policyMissing":
    "Psyche की पासवर्ड नीति इस कंप्यूटर पर इंस्टॉल नहीं है। Psyche का एक-बार वाला सेटअप चलाएँ।",
  "settings.devices.password.detail.notEnforced":
    "इस कंप्यूटर का एक polkit नियम Psyche को बिना पासवर्ड के मंज़ूरी देता है। जब तक उसे हटाया नहीं जाता, पासवर्ड से मंज़ूरी बंद है।",
  "settings.devices.password.detail.noSession":
    "पासवर्ड से मंज़ूरी के लिए इस कंप्यूटर पर सक्रिय डेस्कटॉप सत्र चाहिए। Psyche को वहीं खोलें।",
  "settings.devices.password.detail.agentMissing":
    "इस डेस्कटॉप पर पासवर्ड संवाद उपलब्ध नहीं है। polkit-gnome या lxpolkit जैसा polkit एजेंट इंस्टॉल करें।",
  "settings.devices.password.detail.unavailable": "Psyche सिस्टम की पासवर्ड सेवा तक नहीं पहुँच सका।",
  "settings.devices.password.x11Warning":
    "यह X11 सत्र है। अन्य प्रोग्राम यहाँ आपका टाइप किया हुआ पढ़ सकते हैं, इसलिए पासवर्ड केवल एक रुकावट है, सुरक्षा की सीमा नहीं। Wayland सत्र अधिक सुरक्षित है।",
};
