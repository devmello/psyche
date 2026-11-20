/**
 * Keep-awake and retry strings: the Settings toggle that holds this computer awake while scheduled
 * work runs, and the Scheduled run status for a transient model error (retry, final failure).
 */
export const keepAwake = {
  "settings.daily.group.keepAwake": "Keep this computer awake",
  "settings.daily.keepAwake.hint":
    "While a scheduled run is going, this computer won't sleep until it finishes. The display can still turn off.",
  "settings.key.scheduled.keepAwake": "Keep this computer awake while scheduled work runs",
  "scheduled.history.retryingAt": "Retrying at {time}",
  "scheduled.history.retry": "Retry {n} of 3",
  "scheduled.history.failedAfterRetries": "Failed after {n} retries",
};
