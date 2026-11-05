/**
 * The Linux helper's connection check, as Settings → Devices words it (linux design §4.3). The
 * Gateway records what it saw of the helper's process in `devices.hostHelper.status`.
 */
export const helperCheck = {
  "settings.devices.helperCheck.title": "Linux helper check",
  "settings.devices.helperCheck.description":
    "When the Linux helper connects, Psyche checks which program it really is.",
  "settings.devices.helperCheck.state.verified": "Verified: installed system helper",
  "settings.devices.helperCheck.state.userOwned": "Unverified: helper from your home folder",
  "settings.devices.helperCheck.state.unverified": "Unverified: Psyche couldn't check the helper",
  "settings.devices.helperCheck.detail.verified":
    "This is the helper installed with Psyche. Only the system can change it.",
  "settings.devices.helperCheck.detail.userOwned":
    "It runs from files you own, such as an AppImage or a build in your home folder. Psyche accepts it, but can't rule out that another program of yours replaced it.",
  "settings.devices.helperCheck.detail.unverified":
    "Psyche accepts it for now, but couldn't tell which program it is.",
  "settings.devices.helperCheck.refused": "Refused: {reason}",
  "settings.devices.helperCheck.reason.unclear": "Psyche couldn't verify the helper",
  "settings.devices.helperCheck.reason.notHelper": "this program is not the Psyche helper",
  "settings.devices.helperCheck.reason.userCopy":
    "it is a copy outside the system install, and the installed helper is required",
  "settings.devices.helperCheck.reason.loaderEnv":
    "it was started with a library path or a preloaded library",
  "settings.devices.helperCheck.reason.foreignCode": "it has code loaded from outside the system",
  "settings.devices.helperCheck.reason.severalPrograms":
    "more than one program shares its connection",
  "settings.devices.helperCheck.reason.handedOver":
    "its connection was handed to it by another program",
  "settings.devices.helperCheck.reason.stillStarting": "it was still starting up",
  "settings.devices.helperCheck.reason.debugged": "it is stopped or being debugged",
  "settings.devices.helperCheck.reason.restartNeeded":
    "it was replaced or a system library was updated since it started; restart the helper",
  "settings.devices.helperCheck.reason.filesNotLocked":
    "its files could be changed by someone other than the system",
  "settings.devices.helperCheck.reason.otherNamespace":
    "it runs in a separate sandbox of this computer",
  "settings.devices.helperCheck.reason.busy":
    "Psyche was busy checking other connections; the helper will try again",
} as const;
