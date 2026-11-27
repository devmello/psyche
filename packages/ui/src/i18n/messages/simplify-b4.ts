/**
 * Simplify batch B4: the Devices pane in plain words, "Pair iPhone", the Advanced disclosure on
 * the network pane. Merged into the catalogues like the other areas.
 */
export const simplifyB4 = {
  "simplify.b4.devices.title": "Devices",
  "simplify.b4.devices.description": "The computers and phones that can use Psyche.",
  "simplify.b4.devices.details": "Details",
  "simplify.b4.devices.canDo": "What it can do",
  "simplify.b4.devices.canDoOf": "What {name} can do",
  "simplify.b4.devices.hostKey": "This computer's key {fingerprint}",
  "simplify.b4.devices.helpers": "Helpers",
  "simplify.b4.devices.helpersHint": "The small apps that let Psyche work on a computer.",
  "simplify.b4.devices.noHelpers":
    "No helpers yet. A helper appears here once Psyche runs on a computer.",
  "simplify.b4.server.title": "Network & remote access",
  "simplify.b4.server.description":
    "How other devices reach this computer, and how to use Psyche away from home.",
  "simplify.b4.server.away": "Use it away from home",
  "simplify.b4.pairIphone.title": "Pair iPhone",
  "simplify.b4.pairIphone.description":
    "Scan a code with Psyche on your iPhone. Your iPhone and this computer need to be on the same Wi-Fi.",
  "simplify.b4.pairIphone.button": "Pair iPhone",
  "simplify.b4.pairIphone.scan": "Open Psyche on your iPhone and scan this code. It works once.",
  "simplify.b4.pairIphone.lanOn":
    "Pairing turned on network access, so your iPhone can find this computer.",
  "simplify.b4.pairIphone.lanOff": "Network access is off again.",
  "simplify.b4.pairIphone.turnOff": "Turn network access off",
  "simplify.b4.pairIphone.enableFailed": "Couldn't turn on network access: {reason}",
  "simplify.b4.pairIphone.turnOffFailed": "Couldn't turn network access off: {reason}",
  "simplify.b4.pairIphone.noNetwork":
    "This computer can't be reached on your network right now. Check that Wi-Fi is on, then try again.",
} as const;
