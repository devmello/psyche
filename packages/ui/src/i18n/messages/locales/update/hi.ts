import type { Catalogue } from "../../index.ts";

/** App update strings (hi); merged into `../hi.ts`. */
export const update: Partial<Catalogue> = {
  "shell.update.ready": "Psyche {version} तैयार है",
  "shell.update.readyRequired": "Psyche {version} तैयार है। यह अपडेट ज़रूरी है।",
  "shell.update.restart": "अपडेट के लिए फिर से शुरू करें",
  "shell.update.dismiss": "अपडेट की सूचना बंद करें",
  "settings.updates.status": "स्थिति",
  "settings.updates.checking": "अपडेट जाँचे जा रहे हैं…",
  "settings.updates.upToDate": "नवीनतम संस्करण है",
  "settings.updates.ready": "Psyche {version} तैयार है",
  "settings.updates.readyRequired": "Psyche {version} तैयार है (ज़रूरी)",
  "settings.updates.refused": "अपडेट अस्वीकार हुआ: {reason}",
  "settings.updates.installFailed": "Psyche अपडेट इंस्टॉल नहीं कर सका। बाद में फिर से कोशिश करें।",
};
