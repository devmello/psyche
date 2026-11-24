import type { Catalogue } from "../../index.ts";

/** Failure messages for user actions (hi); merged into `../hi.ts`. */
export const actionErrors: Partial<Catalogue> = {
  "actionError.exportPerson": "इस व्यक्ति का डेटा निर्यात नहीं हो सका ({reason})।",
  "actionError.revokeGrant": "यह अनुमति रद्द नहीं हो सकी ({reason})। यह अब भी लागू है।",
  "actionError.reindex": "खोज इंडेक्स फिर से नहीं बनाया जा सका ({reason})।",
  "actionError.rerun": "यह ऑटोमेशन फिर से नहीं चल सका ({reason})।",
  "actionError.stopResearch": "शोध रोका नहीं जा सका ({reason})। यह अब भी चल रहा है।",
  "actionError.unmute": "सुझाव फिर से चालू नहीं हो सके ({reason})।",
  "actionError.language": "भाषा नहीं बदली जा सकी ({reason})।",
  "actionError.transcriptMode": "ट्रांसक्रिप्ट का विवरण नहीं बदला जा सका ({reason})।",
  "actionError.screenAskDestination": "स्क्रीन प्रश्नों का गंतव्य नहीं बदला जा सका ({reason})।",
  "actionError.takeOver": "वर्चुअल स्क्रीन का नियंत्रण नहीं लिया जा सका ({reason})।",
};
