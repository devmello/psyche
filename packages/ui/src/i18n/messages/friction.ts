/**
 * Approval friction (the Activity card: how often Psyche asks, how you answer, what expires and
 * what grants save) and the person page's Recent interactions list.
 */
export const friction = {
  "friction.title": "Approval friction",
  "friction.hint":
    "How often Psyche stops to ask before it acts, and how you answer. Counts only, from the audit log.",
  "friction.window": "Time window",
  "friction.window.days": "Last {days} days",
  "friction.loading": "Counting approvals…",
  "friction.error": "Could not load approval friction: {reason}",
  "friction.retry": "Try again",
  "friction.empty": "Psyche checked no actions in this window, so there is no friction to show.",
  "friction.since": "Since {date}",
  "friction.asked":
    "Asked about {asks, plural, one {# action} other {# actions}} out of {decisions, plural, one {# action} other {# actions}} checked ({rate}%).",
  "friction.perRun": "Runs that asked at least once averaged {n} asks each.",
  "friction.answered": "Of the asks that ended, {rate}% were answered before they expired.",
  "friction.approved": "Of the asks that ended, {rate}% were approved.",
  "friction.noTimes": "No asks were answered in this window, so there is no answer time.",
  "friction.times": "Answering took a median of {p50}. The slowest tenth took {p90} or more.",
  "friction.expired":
    "{n, plural, =0 {No asks expired unanswered.} one {# ask expired unanswered.} other {# asks expired unanswered.}}",
  "friction.rejected":
    "{n, plural, =0 {No answers were rejected.} one {# answer was rejected as invalid.} other {# answers were rejected as invalid.}}",
  "friction.saved":
    "{n, plural, =0 {No action went through on a standing grant.} one {# action went through on a standing grant with no card.} other {# actions went through on a standing grant with no card.}}",
  "friction.grantsCreated":
    "{n, plural, =0 {No standing grants were created.} one {# standing grant was created.} other {# standing grants were created.}}",
  "friction.kinds": "Where the asks came from",
  "friction.kind.row":
    "{kind}: asked {asks}, approved {approved}, declined {declined}, expired {expired}",
  "friction.rules": "Most common reasons to ask",
  "friction.rule.row": "{label}: {count}",
  "friction.rule.mode": "Your mode setting",
  "friction.rule.taint": "Content from outside",
  "friction.rule.policy": "Your policy",
  "friction.rule.designated": "A protected place",
  "friction.rule.site": "A site rule",
  "friction.rule.other": "Another rule",
  "friction.modes": "By mode",
  "friction.mode.row": "{mode}: asked {asks} of {decisions}",

  "people.interactions.title": "Recent interactions",
  "people.interactions.empty": "No interactions with {name} yet.",
  "people.interactions.error": "Could not load interactions: {reason}",
  "people.interactions.more": "Show more",
  "people.interactions.loadingMore": "Loading…",
};
