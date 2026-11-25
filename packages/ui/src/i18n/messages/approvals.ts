/**
 * Approvals wave W3 (desktop): the card's second choice, its plain header line, the sentences for
 * a voided or expired card, Undo, the Agent sheet row for this chat, the Inbox Allow menu and
 * Settings → Permissions → Allowed.
 */
export const approvals = {
  "approvals.choice.session": "For the rest of this chat",
  "approvals.choice.task": "For this task",
  "approvals.choice.site": "For this site ({site})",
  "approvals.choice.alwaysTool": "Always allow {tool}, with any arguments",
  "approvals.choice.alwaysToolFor": "Always allow {tool} for {target}",
  "approvals.choice.alwaysExec": "Always allow this exact command",
  "approvals.choice.alwaysWrite": "Always allow this change to {target}",
  "approvals.choice.alwaysSame": "Always allow this same kind of action",
  "approvals.more": "More options…",

  "approvals.effect.files": "Changes files",
  "approvals.effect.sends": "Sends to someone",
  "approvals.effect.irreversible": "Can't be undone",
  "approvals.effect.money": "Moves money",
  "approvals.effect.write": "Changes something",
  "approvals.effect.read": "Reads information",
  "approvals.effect.none": "Only looks",
  "approvals.effect.untrusted": "After reading untrusted content",

  "approvals.expired": "Expired. Nothing was done. Ask again if you still want it.",
  "approvals.void.changed":
    "This changed before you answered, so it was set aside. Nothing was done.",
  "approvals.void.runCancelled": "Cancelled because the task stopped. Nothing was done.",
  "approvals.void.restart": "Psyche restarted before you answered. Nothing was done.",
  "approvals.void.other": "This request is no longer needed. Nothing was done.",

  "approvals.undo.always": "Always allowed",
  "approvals.undo.session": "Allowed for this chat",
  "approvals.undo.site": "Allowed for this site",
  "approvals.undo.task": "Allowed for this task",
  "approvals.undo.button": "Undo",
  "approvals.undo.done": "Undone. Psyche will ask again.",

  "approvals.thread.detail": "Answer it on the card in the chat",
  "approvals.thread.show": "Show in chat",
  "approvals.thread.showNamed": "Show the card for {summary} in the chat",

  "approvals.inbox.allowMenu": "More ways to allow: {summary}",

  "approvals.allowed.title": "Allowed",
  "approvals.allowed.description":
    "What Psyche can do without asking. Remove one and it asks again.",
  "approvals.allowed.empty":
    "Nothing is allowed for good yet. When you pick an Always choice on an approval, it shows here.",
  "approvals.allowed.details": "Details",
  "approvals.allowed.group.sites": "Sites",
  "approvals.allowed.group.folders": "Folders",
  "approvals.allowed.group.commands": "Commands",
  "approvals.allowed.group.sends": "Sends",
  "approvals.allowed.group.tools": "Apps and tools",
  "approvals.allowed.group.spaces": "Spaces",
  "approvals.allowed.scope.always": "Always",
  "approvals.allowed.scope.session": "This chat",
  "approvals.allowed.scope.site": "This site",
  "approvals.allowed.scope.task": "This task",
  "approvals.allowed.runs": "runs {what}",
  "approvals.allowed.sends": "sends {what}",
  "approvals.allowed.used": "used {n, plural, one {# time} other {# times}}",
  "approvals.allowed.last": "last {when}",
  "approvals.allowed.remove": "Remove",
  "approvals.allowed.removeNamed": "Remove {name}",
} as const;
