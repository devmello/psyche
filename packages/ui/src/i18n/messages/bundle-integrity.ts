/**
 * The warning the desktop app shows when its own signature no longer verifies
 * (apps/desktop/src/main/bundle-integrity.ts). The main process shows it in a native dialog.
 */
export const bundleIntegrity = {
  "app.integrity.title": "Psyche's files were changed",
  "app.integrity.detail":
    "This copy of Psyche no longer matches the signature it was released with, so something may have modified it. Until you reinstall it from the official download, Psyche keeps the microphone, screen, Apple Events, Contacts and Calendar features turned off.",
  "app.integrity.blocked":
    "Turned off: this copy of Psyche was modified. Reinstall it from the official download.",
  "app.integrity.ok": "OK",
} as const;
