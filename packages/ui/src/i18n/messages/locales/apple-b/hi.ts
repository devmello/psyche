import type { Catalogue } from "../../index.ts";

/** Apple-design batch B (hi): plain approval cards and tool rows; merged into `../hi.ts`. */
export const appleB: Partial<Catalogue> = {
  "approvals.plain.run":
    "{who} `{command}`{hasFolder, select, true { में {folder}} other {}} चलाना चाहता है।",
  "approvals.plain.save":
    "{who} {file}{hasFolder, select, true { में {folder}} other {}} {mode, select, create {सहेजना} other {बदलना}} चाहता है।",
  "approvals.plainWhy.commands": "आपने कहा था कि कमांड चलने से पहले आपकी मंज़ूरी ली जाए।",
  "approvals.plainWhy.yourRule": "आपने पहले पूछने का नियम बनाया है।",
  "approvals.plainWhy.noSandbox": "सुरक्षित सैंडबॉक्स अभी सेट नहीं है।",
  "approvals.plainWhy.protectedFiles": "ये फ़ाइलें सुरक्षित हैं, इसलिए Psyche हमेशा पूछता है।",
  "approvals.plainWhy.push": "आपके काम को प्रकाशित करने के लिए हमेशा आपकी मंज़ूरी चाहिए।",
  "approvals.plainWhy.machineFiles": "दूसरे कंप्यूटर पर फ़ाइलें बदलने के लिए हमेशा आपकी मंज़ूरी चाहिए।",
  "approvals.plainWhy.unknownTool": "यह टूल ऐसे कनेक्टर से है जिसे आपने अभी मंज़ूर नहीं किया है।",
  "approvals.plainWhy.connector": "यह कनेक्टर कुछ करने से पहले पूछता है।",
  "approvals.plainWhy.outsideNew": "Psyche ने बाहर से कुछ पढ़ा है, और यह उसके लिए नया है।",
  "approvals.plainWhy.outsideCommand":
    "Psyche ने बाहर से कुछ पढ़ा है, और यह कमांड अपने फ़ोल्डर के बाहर तक पहुँच सकता है।",
  "blocks.toolRun.familyName":
    "{kind, select, command {कमांड} file {फ़ाइलें} web {वेब} mail {ईमेल} calendar {कैलेंडर} drive {Drive} memory {मेमोरी} task {कार्य} other {{name}}}",
  "blocks.toolRun.spoken":
    "{kind, select, command {कमांड चलाया} write {फ़ाइल सहेजी} edit {फ़ाइल बदली} read {फ़ाइल पढ़ी} web {वेब पर खोजा} mail {ईमेल इस्तेमाल किया} calendar {कैलेंडर इस्तेमाल किया} memory {मेमोरी इस्तेमाल की} other {टूल इस्तेमाल किया}}",
  "blocks.toolRun.line.save": "{file}{hasFolder, select, true { में {folder}} other {}} सहेजें",
};
