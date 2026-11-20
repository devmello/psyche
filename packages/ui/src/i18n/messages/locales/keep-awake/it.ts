import type { Catalogue } from "../../index.ts";

/** keep-awake and retry strings (it); merged into `../it.ts`. */
export const keepAwake: Partial<Catalogue> = {
  "settings.daily.group.keepAwake": "Tieni sveglio questo computer",
  "settings.daily.keepAwake.hint":
    "Mentre un'attività programmata è in corso, questo computer non va in stop finché non finisce. Lo schermo può comunque spegnersi.",
  "settings.key.scheduled.keepAwake":
    "Tieni sveglio questo computer mentre girano le attività programmate",
  "scheduled.history.retryingAt": "Nuovo tentativo alle {time}",
  "scheduled.history.retry": "Tentativo {n} di 3",
  "scheduled.history.failedAfterRetries": "Non riuscito dopo {n} nuovi tentativi",
};
