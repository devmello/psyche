/** Record meeting (docs/workflows/mail-and-meetings-2026.md §4.6): the consent dialog and the recording pill. */
export const meetingRecord = {
  "meetingRecord.palette": "Record meeting…",
  "meetingRecord.title": "Record this meeting?",
  "meetingRecord.intro":
    "Tell everyone before you start. Say this out loud or paste it in the chat. Psyche never joins a call and only records after you confirm.",
  "meetingRecord.copy": "Copy",
  "meetingRecord.copied": "Copied",
  "meetingRecord.confirm": "I've told everyone",
  "meetingRecord.cancel": "Cancel",
  "meetingRecord.privacy":
    "The audio stays in your Psyche, is turned into notes there, and is never uploaded elsewhere or used for training.",
  "meetingRecord.unavailable":
    "Recording needs a way to turn audio into notes (the Mac helper), and it is not connected.",
  "meetingRecord.micDenied": "Psyche can't use the microphone. Allow it in System Settings.",
  "meetingRecord.failed": "Psyche couldn't record this meeting.",
  "meetingRecord.pill": "Recording meeting · {time}",
  "meetingRecord.stop": "Stop",
  "meetingRecord.stopping": "Saving…",
  "meetingRecord.notes.processing": "Writing notes…",
  "meetingRecord.notes.done": "Notes are ready in your Feed.",
  "meetingRecord.notes.needs_permission": "Notes are waiting for your OK to use a cloud model.",
  "meetingRecord.notes.failed": "Psyche couldn't write notes from this recording.",
} as const;
