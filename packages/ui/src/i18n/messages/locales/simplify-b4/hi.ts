import type { Catalogue } from "../../index.ts";

/** Simplify batch B4: devices and pairing (hi); merged into `../hi.ts`. */
export const simplifyB4: Partial<Catalogue> = {
  "simplifyB4.devices.title": "डिवाइस",
  "simplifyB4.devices.description": "वे कंप्यूटर और iPhone जो Psyche का उपयोग कर सकते हैं।",
  "simplifyB4.devices.details": "विवरण",
  "simplifyB4.devices.canDo": "यह क्या कर सकता है",
  "simplifyB4.devices.canDoOf": "{name} क्या कर सकता है",
  "simplifyB4.devices.hostKey": "इस कंप्यूटर की कुंजी: {fingerprint}",
  "simplifyB4.devices.helpers": "सहायक",
  "simplifyB4.devices.helpersHint": "छोटे ऐप जिनसे Psyche किसी कंप्यूटर पर काम कर पाता है।",
  "simplifyB4.devices.noHelpers": "अभी कोई सहायक नहीं है। कंप्यूटर पर Psyche चलने पर सहायक यहाँ दिखेगा।",
  "simplifyB4.server.title": "नेटवर्क और रिमोट एक्सेस",
  "simplifyB4.server.description":
    "दूसरे डिवाइस इस कंप्यूटर तक कैसे पहुँचते हैं, और घर से बाहर Psyche कैसे इस्तेमाल करें।",
  "simplifyB4.server.away": "घर से बाहर इस्तेमाल करें",
  "simplifyB4.pairIphone.title": "iPhone जोड़ें",
  "simplifyB4.pairIphone.description":
    "अपने iPhone पर Psyche से एक कोड स्कैन करें। iPhone और यह कंप्यूटर एक ही Wi-Fi पर होने चाहिए।",
  "simplifyB4.pairIphone.button": "iPhone जोड़ें",
  "simplifyB4.pairIphone.scan":
    "अपने iPhone पर Psyche खोलें और यह कोड स्कैन करें। यह सिर्फ़ एक बार काम करता है।",
  "simplifyB4.pairIphone.lanOn":
    "जोड़ने के लिए नेटवर्क एक्सेस चालू किया गया, ताकि आपका iPhone इस कंप्यूटर को ढूँढ सके।",
  "simplifyB4.pairIphone.lanOff": "नेटवर्क एक्सेस फिर से बंद है।",
  "simplifyB4.pairIphone.turnOff": "नेटवर्क एक्सेस बंद करें",
  "simplifyB4.pairIphone.enableFailed": "नेटवर्क एक्सेस चालू नहीं हो सका: {reason}",
  "simplifyB4.pairIphone.turnOffFailed": "नेटवर्क एक्सेस बंद नहीं हो सका: {reason}",
  "simplifyB4.pairIphone.noNetwork":
    "अभी आपके नेटवर्क पर यह कंप्यूटर नहीं मिल रहा। जाँचें कि Wi-Fi चालू है, फिर दोबारा कोशिश करें।",
};
