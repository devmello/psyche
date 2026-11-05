import type { Catalogue } from "../../index.ts";

/** The Linux helper check in Settings → Devices (hi); merged into `../hi.ts`. */
export const helperCheck: Partial<Catalogue> = {
  "settings.devices.helperCheck.title": "Linux हेल्पर की जाँच",
  "settings.devices.helperCheck.description":
    "जब Linux हेल्पर जुड़ता है, तो Psyche जाँचता है कि वह असल में कौन-सा प्रोग्राम है।",
  "settings.devices.helperCheck.state.verified": "सत्यापित: सिस्टम में इंस्टॉल किया हुआ हेल्पर",
  "settings.devices.helperCheck.state.userOwned": "असत्यापित: आपके होम फ़ोल्डर का हेल्पर",
  "settings.devices.helperCheck.state.unverified": "असत्यापित: Psyche हेल्पर की जाँच नहीं कर सका",
  "settings.devices.helperCheck.detail.verified":
    "यह Psyche के साथ इंस्टॉल हुआ हेल्पर है। इसे केवल सिस्टम बदल सकता है।",
  "settings.devices.helperCheck.detail.userOwned":
    "यह आपकी अपनी फ़ाइलों से चलता है, जैसे AppImage या आपके होम फ़ोल्डर में बना बिल्ड। Psyche इसे स्वीकार करता है, लेकिन यह नकार नहीं सकता कि आपके किसी और प्रोग्राम ने इसे बदल दिया हो।",
  "settings.devices.helperCheck.detail.unverified":
    "फ़िलहाल Psyche इसे स्वीकार करता है, लेकिन यह पता नहीं लगा सका कि यह कौन-सा प्रोग्राम है।",
  "settings.devices.helperCheck.refused": "अस्वीकृत: {reason}",
  "settings.devices.helperCheck.reason.unclear": "Psyche हेल्पर को सत्यापित नहीं कर सका",
  "settings.devices.helperCheck.reason.notHelper": "यह प्रोग्राम Psyche का हेल्पर नहीं है",
  "settings.devices.helperCheck.reason.userCopy":
    "यह सिस्टम इंस्टॉलेशन के बाहर की प्रति है, और इंस्टॉल किया हुआ हेल्पर ज़रूरी है",
  "settings.devices.helperCheck.reason.loaderEnv":
    "इसे लाइब्रेरी पथ या पहले से लोड की गई लाइब्रेरी के साथ शुरू किया गया था",
  "settings.devices.helperCheck.reason.foreignCode": "इसमें सिस्टम के बाहर से लोड किया गया कोड है",
  "settings.devices.helperCheck.reason.severalPrograms": "एक से ज़्यादा प्रोग्राम इसका कनेक्शन साझा करते हैं",
  "settings.devices.helperCheck.reason.handedOver": "इसका कनेक्शन किसी और प्रोग्राम ने इसे सौंपा था",
  "settings.devices.helperCheck.reason.stillStarting": "यह अभी शुरू ही हो रहा था",
  "settings.devices.helperCheck.reason.debugged": "यह रुका हुआ है या डीबग किया जा रहा है",
  "settings.devices.helperCheck.reason.restartNeeded":
    "शुरू होने के बाद इसे बदला गया या कोई सिस्टम लाइब्रेरी अपडेट हुई; हेल्पर को फिर से शुरू करें",
  "settings.devices.helperCheck.reason.filesNotLocked": "इसकी फ़ाइलें सिस्टम के अलावा कोई और बदल सकता है",
  "settings.devices.helperCheck.reason.otherNamespace": "यह इस कंप्यूटर के अलग सैंडबॉक्स में चलता है",
  "settings.devices.helperCheck.reason.busy":
    "Psyche दूसरे कनेक्शन जाँचने में व्यस्त था; हेल्पर फिर कोशिश करेगा",
  "settings.devices.nodeKind.hostHelper": "इस कंप्यूटर का हेल्पर",
  "settings.devices.nodeKind.guest": "अलग डेस्कटॉप",
};
