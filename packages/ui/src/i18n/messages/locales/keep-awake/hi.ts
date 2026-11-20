import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (hi); merged into `../hi.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "इस कंप्यूटर को जागा रखें",
  "settings.daily.keepAwake.hint":
    "शेड्यूल किया गया काम चलते समय यह कंप्यूटर खत्म होने तक नहीं सोएगा। स्क्रीन फिर भी बंद हो सकती है।",
  "settings.key.scheduled.keepAwake": "शेड्यूल किया गया काम चलते समय इस कंप्यूटर को जागा रखें",
  "scheduled.history.retryingAt": "{time} पर फिर से कोशिश होगी",
  "scheduled.history.retry": "कोशिश {n} / 3",
  "scheduled.history.failedAfterRetries": "{n} बार दोबारा कोशिश के बाद विफल",
};
