import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (ja); merged into `../ja.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "このコンピュータをスリープさせない",
  "settings.daily.keepAwake.hint":
    "予定された処理の実行中は、完了までこのコンピュータがスリープしません。ディスプレイは消えることがあります。",
  "settings.key.scheduled.keepAwake": "予定された処理の実行中、このコンピュータをスリープさせない",
  "scheduled.history.retryingAt": "{time} に再試行します",
  "scheduled.history.retry": "再試行 {n}/3",
  "scheduled.history.failedAfterRetries": "{n} 回再試行しましたが失敗しました",
};
