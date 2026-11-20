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
  "scheduled.history.cancelRetry": "Cancel retry",
  "scheduled.history.cancelRetry.aria": "Cancel the retry of the run from {when}",
  "scheduled.history.cancelRetry.failed": "Couldn't cancel the retry ({reason}).",
  "settings.updates.group": "Updates",
  "settings.updates.hint": "Psyche checks for signed updates and installs them when you quit.",
  "settings.updates.channel": "Release channel",
  "settings.updates.channel.stable": "Stable",
  "settings.updates.channel.note":
    "Stable is the only channel for now. Beta will show up here once beta builds are published. Every update is checked against Psyche's release key either way.",
  "settings.updates.saveFailed": "Couldn't save the release channel ({reason}).",
  "settings.storage.title": "Storage",
  "settings.storage.hint": "Disk space Psyche uses in its data folder on this computer.",
  "settings.storage.total": "Total",
  "settings.storage.clear": "Clear…",
  "settings.storage.cleared": "Cleared. {size} freed.",
  "settings.storage.clearFailed": "Couldn't clear storage ({reason}).",
  "settings.storage.failed": "Couldn't read storage use ({reason}).",
  "settings.storage.confirm.title": "Clear caches and old recordings?",
  "settings.storage.confirm.body":
    "This deletes up to {size} of caches and browser recordings older than 7 days. Psyche rebuilds caches when it needs them. Your chats, memory, Library, vault and settings aren't touched.",
  "settings.storage.confirm.clear": "Clear",
  "settings.storage.cat.database": "Database",
  "settings.storage.cat.memoryIndex": "Memory index",
  "settings.storage.cat.library": "Attachments and Library",
  "settings.storage.cat.browserProfiles": "Browser profiles",
  "settings.storage.cat.recordings": "Recordings",
  "settings.storage.cat.logs": "Logs",
  "settings.storage.cat.caches": "Caches",
  "settings.storage.cat.other": "Everything else",
};
