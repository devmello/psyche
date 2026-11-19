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
  "platform.helper.choose.title": "Two Psyche Helpers are connected",
  "platform.helper.choose.text":
    "Psyche won't guess which one runs on this computer, so Mail, Notes, Calendar and Reminders are paused. Choose the one to use.",
  "platform.helper.choose.use": "Use {name}",
  "platform.helper.choose.failed": "Couldn't choose the helper: {reason}",
  "platform.helper.contactsPermission":
    "Contacts needs permission for Psyche Helper in System Settings.",
} as const;
