import type { Catalogue } from "../../index.ts";

/** The security-records banner and review panel (hi); merged into `../hi.ts`. */
export const securityState: Partial<Catalogue> = {
  "web.security.banner.changed":
    "Psyche ने ऐप के बाहर उसके सुरक्षा रिकॉर्ड में किया गया एक बदलाव वापस ले लिया।",
  "web.security.banner.untrusted":
    "Psyche के सुरक्षा रिकॉर्ड की जाँच विफल रही। पहुँच बढ़ाने वाले बदलाव रोक दिए गए हैं।",
  "web.security.banner.recovery":
    "{count, plural, one {इस Mac पर माँगा गया एक सुरक्षा बदलाव {when} को लागू होगा, जब तक आप इसे रद्द न करें।} other {इस Mac पर माँगे गए # सुरक्षा बदलाव प्रतीक्षा में हैं। अगला {when} को लागू होगा।}}",
  "web.security.banner.notice":
    "{count, plural, one {देखने के लिए 1 सुरक्षा सूचना।} other {देखने के लिए # सुरक्षा सूचनाएँ।}}",
  "web.security.review": "देखें",
  "web.security.hide": "छिपाएँ",
  "web.security.panel.label": "सुरक्षा रिकॉर्ड",
  "web.security.alert.changed":
    "इस Mac पर एक प्रोग्राम ने Psyche के बिना {count, plural, one {1 सुरक्षा रिकॉर्ड} other {# सुरक्षा रिकॉर्ड}} बदल दिए। Psyche ने {count, plural, one {उसे} other {उन्हें}} वापस पहले जैसा कर दिया। अगर यह आपने नहीं किया, तो Mac में अनचाहे सॉफ़्टवेयर की जाँच करें।",
  "web.security.alert.untrusted":
    "Psyche के सुरक्षा रिकॉर्ड की जाँच विफल रही। नए डिवाइस, सुरक्षा सेटिंग्स और Touch ID से मंज़ूरी रोक दी गई हैं। अपने डिवाइस देखें, फिर Mac पर psyched security reseal चलाएँ; यह 24 घंटे बाद लागू होता है।",
  "web.security.alert.firstSeal":
    "Psyche अब अपने सुरक्षा रिकॉर्ड जाँचता है ({devices, plural, one {1 जोड़ा गया डिवाइस} other {# जोड़े गए डिवाइस}})। Psyche के बाहर किया गया बदलाव वापस लिया जाता है और यहाँ दिखाया जाता है। एक बार अपने डिवाइस देख लें।",
  "web.security.alert.resealed": "Psyche ने अपने सुरक्षा रिकॉर्ड फिर से सील कर दिए।",
  "web.security.alert.restored":
    "Psyche एक बहाल किए गए बैकअप से शुरू हुआ और उसने सुरक्षा रिकॉर्ड जैसे हैं वैसे ही सील कर दिए। अगर आपने बैकअप बहाल नहीं किया, तो अपने डिवाइस देखें।",
  "web.security.alert.firstAdmin":
    "इस Mac पर एक कमांड ने {name} को पहला एडमिन डिवाइस बना दिया। अगर यह आपने नहीं किया, तो उसे डिवाइस में रद्द करें।",
  "web.security.alert.requested": "इस Mac पर माँगा गया: {action} {when} को लागू होगा।",
  "web.security.alert.applied": "लागू किया गया: {action}",
  "web.security.alert.cancelled": "रद्द किया गया: {action}",
  "web.security.alert.failed": "लागू नहीं हो सका: {action}",
  "web.security.op.devicesApprove": "डिवाइस {name} को मंज़ूरी देना।",
  "web.security.op.devicesGrant": "{name} क्या कर सकता है, यह बदलना।",
  "web.security.op.presenceReset":
    "नई कुंजी दर्ज होने तक सुरक्षा बदलावों के लिए Touch ID या पासकी न माँगना।",
  "web.security.op.sealReset": "मौजूदा सुरक्षा रिकॉर्ड जैसे हैं वैसे ही स्वीकार करना।",
  "web.security.device": "एक डिवाइस",
  "web.security.deviceKey": "{name} (कुंजी {fingerprint})",
  "web.security.change":
    "{change, select, added {जोड़ा गया} modified {बदला गया} other {हटाया गया}}: {what}",
  "web.security.more": "{count, plural, one {और 1} other {और #}}",
  "web.security.ack": "देखा गया चिह्नित करें",
  "web.security.approveNow": "अभी मंज़ूरी दें",
  "web.security.cancel": "अनुरोध रद्द करें",
  "web.security.needsApproval": "Touch ID या पासकी से कार्ड को मंज़ूरी दें, फिर बटन दोबारा दबाएँ।",
  "web.security.failed": "यह काम नहीं किया: {message}",
};
