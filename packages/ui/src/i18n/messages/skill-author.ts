/** Skills the agent wrote itself: the approval card rows and the Settings → Skills badge. */
export const skillAuthor = {
  "blocks.details.skillAction": "Action",
  "blocks.details.skillActionValue":
    "{action, select, update {Change a skill made by {persona}} delete {Delete a skill made by {persona}} other {Add a new skill written by {persona}}}",
  "blocks.details.name": "Name",
  "blocks.details.skillText": "Instructions",
  "blocks.details.skillTextView": "View full text",
  "settings.skills.madeByAgent": "Made by {persona}",
  "settings.skills.history": "{n, plural, one {# earlier version} other {# earlier versions}}",
  "settings.skills.historyItem":
    "v{version} · approved {approved} · {retiredBy, select, delete {deleted} other {replaced}} {retired}",
  "settings.skills.historyHint": "Kept for reference. These versions never load.",
} as const;
