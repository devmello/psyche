/** The chat's context meter, compaction markers and per-chat limits (`chat/context`). */
export const context = {
  "context.breakdown.system": "System prompt",
  "context.breakdown.tools": "Tools",
  "context.breakdown.context": "Memory and context",
  "context.breakdown.history": "Conversation so far",
  "context.breakdown.current": "Current message",
  "context.summary.facts": "Facts",
  "context.summary.decisions": "Decisions",
  "context.summary.openTasks": "Open tasks",
  "context.summary.pinnedInstructions": "Standing instructions",
  "context.limitFrom.thread": "this chat's own limit",
  "context.limitFrom.settings": "the limit in Settings",
  "context.limitFrom.model": "the model's context window",

  "context.meter.label":
    "Context: {used, number} of {limit, number} tokens, {pct, number}%{estimate, select, true {, estimate} other {}}{tone, select, near {, near the compaction threshold} over {, past the compaction threshold} other {}}",
  "context.meter.estimateBadge": "estimate",
  "context.meter.title": "Context",
  "context.meter.usage": "{used, number} of {limit, number} tokens ({pct, number}%).",
  "context.meter.exact": "Counted by the provider.",
  "context.meter.estimated": "An estimate until the provider counts it.",
  "context.meter.limitFrom": "The limit is {from}.",
  "context.meter.breakdownTable": "Where the tokens go",
  "context.meter.past":
    "Past the compaction threshold ({at, number} tokens): earlier turns are summarised before the next reply.",
  "context.meter.threshold":
    "Earlier turns are summarised at {at, number} tokens ({pct, number}% of the limit).",
  "context.meter.compactNow": "Compact now",
  "context.meter.compacting": "Compacting…",
  "context.meter.editLimits": "Limits for this chat…",

  "context.marker.region": "Compacted turns",
  "context.marker.toggle":
    "{turns, plural, one {An earlier turn was} other {# earlier turns were}} compacted{manual, select, true { on request} other {}}, {before} → {after} tokens",
  "context.marker.readsInstead": "The summary the agent reads instead:",
  "context.marker.empty": "Nothing worth keeping was found.",
  "context.marker.showReplaced": "Show what was replaced",
  "context.marker.replacedList": "Replaced turns",
  "context.marker.notLoaded": "The replaced turns aren't loaded here.",
  "context.marker.speaker": "{name}:",

  "context.compact.nothing": "Nothing to compact yet: every turn is still kept verbatim.",
  "context.compact.done":
    "Compacted {turns, plural, one {# earlier turn} other {# earlier turns}}, {before} → {after} tokens.",
  "context.compact.busy": "Can't compact while the agent is working or waiting on an approval.",
  "context.compact.failed": "Couldn't compact: {reason}",

  "context.limits.menu": "Context limits…",
  "context.limits.title": "Context limits for this chat",
  "context.limits.now":
    "Now {max, number} tokens, from {from}{window, select, none {} other {; the model reads up to {window}}}. Leave a field blank to follow Settings.",
  "context.limits.blankFollows": "Leave a field blank to follow Settings.",
  "context.limits.maxTokens": "Context limit",
  "context.limits.maxTokensHint": "The most tokens a turn in this chat may send.",
  "context.limits.compactAt": "Compact at",
  "context.limits.compactAtHint":
    "Earlier turns are summarised when a turn reaches this share of the limit.",
  "context.limits.keep": "Recent turns kept verbatim",
  "context.limits.keepHint": "These are never summarised.",
  "context.limits.tokens": "tokens",
  "context.limits.percentOfLimit": "% of the limit",
  "context.limits.turns": "turns",
  "context.limits.followSettings": "Follow Settings",
  "context.limits.followingSettings": "This chat follows Settings again.",
  "context.limits.saved": "Saved this chat's limits.",
  "context.limits.errorRange": "Enter a whole number from {min, number} to {max, number}.",
  "context.limits.errorWindow":
    "Enter a whole number from {min, number} to {max, number} (the model's window).",
  "context.limits.errorMin": "Enter a whole number of at least {min, number}.",
} as const;
