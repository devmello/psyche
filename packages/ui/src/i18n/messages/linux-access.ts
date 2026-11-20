/** Settings → Computer use on Linux: screen and input access, and what the desktop allows. */
export const linuxAccess = {
  "settings.computerUse.linux.screen.name": "Screen and input access",
  "settings.computerUse.linux.screen.allowed": "Allowed until you revoke it",
  "settings.computerUse.linux.screen.asks": "Asks the first time you use it",
  "settings.computerUse.linux.screen.notNeeded": "Not needed on X11",
  "settings.computerUse.linux.screen.unavailable": "Not available",
  "settings.computerUse.linux.screen.why":
    "{persona} sees your screen and uses the mouse and keyboard through your desktop's permission dialog. You approve it once.",
  "settings.computerUse.linux.revoke": "Revoke",
  "settings.computerUse.linux.revokeLabel": "Revoke screen and input access",
  "settings.computerUse.linux.warning.x11":
    "On X11 any app can read your screen and keystrokes, including your password when you approve something.",
  "settings.computerUse.linux.warning.wlroots":
    "On this desktop any app can read your screen and type for you without asking. Psyche cannot add a consent step.",
  "settings.computerUse.linux.accessibility":
    "Apps opened from now on expose their structure to Psyche. Apps already open may need a restart.",
  "settings.computerUse.linux.headless":
    "Needs a graphical session on this computer. Log in to the desktop, then try again.",
} as const;
