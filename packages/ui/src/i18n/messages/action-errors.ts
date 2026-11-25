/** Failure messages for user actions that used to fail silently (action-errors). */
export const actionErrors = {
  "actionError.exportPerson": "Couldn't export this person's data ({reason}).",
  "actionError.revokeGrant": "Couldn't revoke this approval ({reason}). It's still in place.",
  "actionError.reindex": "Couldn't rebuild the search index ({reason}).",
  "actionError.rerun": "Couldn't re-run this automation ({reason}).",
  "actionError.stopResearch": "Couldn't stop the research ({reason}). It's still running.",
  "actionError.unmute": "Couldn't turn nudges back on ({reason}).",
  "actionError.language": "Couldn't change the language ({reason}).",
  "actionError.transcriptMode": "Couldn't change the transcript detail ({reason}).",
  "actionError.screenAskDestination": "Couldn't change where screen questions go ({reason}).",
  "actionError.stopVirtualScreen":
    "Couldn't stop the virtual screen ({reason}). It may still be running.",
  "actionError.takeOver": "Couldn't take over the virtual screen ({reason}).",
} as const;
