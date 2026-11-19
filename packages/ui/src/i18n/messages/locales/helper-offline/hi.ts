import type { Catalogue } from "../../index.ts";

/** The helper-offline banner in the desktop app (hi); merged into `../hi.ts`. */
export const helperOffline: Partial<Catalogue> = {
  "platform.helper.offline.title": "Psyche Helper कनेक्ट नहीं है",
  "platform.helper.offline.text":
    "मेल, नोट्स, कैलेंडर, रिमाइंडर और इन पर निर्भर काम तब तक रुके रहेंगे जब तक यह फिर से कनेक्ट नहीं होता।",
  "platform.helper.offline.reconnect": "फिर से कनेक्ट करें",
  "platform.helper.contactsPermission": "संपर्कों के लिए सिस्टम सेटिंग्स में Psyche Helper को अनुमति चाहिए।",
  "platform.helper.offline.dismiss": "बंद करें",
  "platform.helper.choose.title": "दो Psyche Helper जुड़े हैं",
  "platform.helper.choose.text":
    "Psyche अंदाज़ा नहीं लगाएगा कि इस कंप्यूटर पर कौन-सा चल रहा है, इसलिए Mail, Notes, Calendar और Reminders रुके हैं। जिसे इस्तेमाल करना है उसे चुनें।",
  "platform.helper.choose.use": "{name} इस्तेमाल करें",
  "platform.helper.choose.failed": "हेल्पर चुना नहीं जा सका: {reason}",
};
