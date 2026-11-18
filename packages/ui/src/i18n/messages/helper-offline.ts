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
  "platform.helper.contactsPermission":
    "Contacts needs permission for Psyche Helper in System Settings.",
} as const;
