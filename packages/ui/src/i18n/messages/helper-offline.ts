/**
 * The "Psyche Helper isn't connected" banner (desktop): one dismissable notice with a Reconnect
 * action, shown while the bundled helper is offline. Merged into `./index.ts`.
 */
export const helperOffline = {
  "platform.helper.offline.title": "Psyche Helper isn't connected",
  "platform.helper.offline.text":
    "Mail, Notes, Calendar, Reminders and the work that depends on them wait until it reconnects.",
  "platform.helper.offline.reconnect": "Reconnect",
  "platform.helper.offline.dismiss": "Dismiss",
  "platform.helper.choose.title": "More than one Psyche Helper is connected",
  "platform.helper.choose.text":
    "Psyche won't pick one for you, so Mail, Notes, Calendar and Reminders are paused. Choose which to use while they are all connected.",
  "platform.helper.choose.use": "Use the helper paired {when} (…{id})",
  "platform.helper.choose.useNoTime": "Use the helper (…{id})",
  "platform.helper.choose.name": "Calls itself: {name}",
  "platform.helper.choose.failed": "Couldn't choose the helper: {reason}",
  "platform.helper.contactsPermission":
    "Contacts needs permission for Psyche Helper in System Settings.",
} as const;
