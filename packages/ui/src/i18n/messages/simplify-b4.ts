/**
 * Simplify batch B4: the Devices pane in plain words, "Pair iPhone", the Advanced disclosure on
 * the network pane. Merged into the catalogues like the other areas.
 */
export const simplifyB4 = {
  "simplifyB4.devices.title": "Devices",
  "simplifyB4.devices.description": "The computers and phones that can use Psyche.",
  "simplifyB4.devices.details": "Details",
  "simplifyB4.devices.canDo": "What it can do",
  "simplifyB4.devices.canDoOf": "What {name} can do",
  "simplifyB4.devices.hostKey": "This computer's key {fingerprint}",
  "simplifyB4.devices.helpers": "Helpers",
  "simplifyB4.devices.helpersHint": "The small apps that let Psyche work on a computer.",
  "simplifyB4.devices.noHelpers":
    "No helpers yet. A helper appears here once Psyche runs on a computer.",
  "simplifyB4.server.title": "Network & remote access",
  "simplifyB4.server.description":
    "How other devices reach this computer, and how to use Psyche away from home.",
  "simplifyB4.server.away": "Use it away from home",
  "simplifyB4.pairIphone.title": "Pair iPhone",
  "simplifyB4.pairIphone.description":
    "Scan a code with Psyche on your iPhone. Your iPhone and this computer need to be on the same Wi-Fi.",
  "simplifyB4.pairIphone.button": "Pair iPhone",
  "simplifyB4.pairIphone.scan": "Open Psyche on your iPhone and scan this code. It works once.",
  "simplifyB4.pairIphone.lanOn":
    "Pairing turned on network access, so your iPhone can find this computer.",
  "simplifyB4.pairIphone.lanOff": "Network access is off again.",
  "simplifyB4.pairIphone.turnOff": "Turn network access off",
  "simplifyB4.pairIphone.enableFailed": "Couldn't turn on network access: {reason}",
  "simplifyB4.pairIphone.turnOffFailed": "Couldn't turn network access off: {reason}",
  "simplifyB4.pairIphone.noNetwork":
    "This computer can't be reached on your network right now. Check that Wi-Fi is on, then try again.",
} as const;
