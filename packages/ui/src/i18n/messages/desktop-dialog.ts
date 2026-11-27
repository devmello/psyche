/**
 * Native dialogs and notifications the desktop main process shows (confirmations, warnings, the
 * second-copy prompt, the uninstall sheet, the Gateway change boxes). Merged into the catalogues
 * like the other areas. `{os}` is "macos", "windows" or "linux" (`hostWords().os`): the host nouns
 * are ICU selects, so each language writes its own words for "this Mac", "this PC", "this computer".
 */
export const desktopDialog = {
  "desktop.dialog.notificationsOn": "Notifications are on.",
  "desktop.dialog.anotherCopyTitle": "Another copy of Psyche is already running",
  "desktop.dialog.anotherCopyDetail":
    "It runs from {path}. Using this copy switches Psyche to this app; the other copy then connects to this one.",
  "desktop.dialog.keepOtherCopy": "Keep the other copy",
  "desktop.dialog.useThisCopy": "Use this copy",
  "desktop.dialog.cancel": "Cancel",
  "desktop.dialog.ok": "OK",
  "desktop.dialog.shareFolderTitle": "Share a folder with Psyche",
  "desktop.dialog.share": "Share",
  "desktop.dialog.gatewaysFileTitle": "Psyche can't read its saved Gateways",
  "desktop.dialog.gatewaysFileDetail":
    "{problem}. Psyche starts on {os, select, macos {this Mac} windows {this PC} other {this computer}} and leaves the file as it is, so no pinned identity is lost. Fix or remove the file in Psyche's data folder to use another computer's Gateway.",
  "desktop.dialog.stillRunningTitle": "Psyche is still running",
  "desktop.dialog.stillRunningBody":
    "Tasks and automations keep going. Open Psyche from its icon in the notification area; right-click it to quit.",
  "desktop.dialog.manualStepsTitle": "One more step to finish removing Psyche",
  "desktop.dialog.uninstallTitle": "Uninstall Psyche?",
  "desktop.dialog.uninstall": "Uninstall",
  "desktop.dialog.uninstallAndDelete": "Delete data and uninstall",
  "desktop.dialog.uninstallItems":
    "{count, plural, one {# item} other {# items}} will be moved to the Trash, including Psyche.app.",
  "desktop.dialog.uninstallDataFolder": "Your data folder {folder} will be moved to the Trash too.",
  "desktop.dialog.uninstallDataKept": "Your data folder is kept.",
  "desktop.dialog.uninstallKeychain": "The Keychain items Psyche keeps will be removed.",
  "desktop.dialog.uninstallKeychainKept":
    "Keychain items stay; remove them in Keychain Access if you want.",
  "desktop.dialog.stopTitle":
    "Stop Psyche on {os, select, macos {this Mac} windows {this PC} other {this computer}}?",
  "desktop.dialog.stopDetail":
    "Its automations and scheduled tasks stop until you switch back. Leave it running to keep them going.",
  "desktop.dialog.stopButton":
    "Stop Psyche on {os, select, macos {this Mac} windows {this PC} other {this computer}}",
  "desktop.dialog.keepRunning": "Keep it running",
  "desktop.dialog.forgetTitle": "Forget {name}?",
  "desktop.dialog.forgetDetail":
    "{origin}\n\nThis removes this computer's key for it and everything Psyche stored here for it. {name} still lists this computer until someone removes it there.",
  "desktop.dialog.forgetButton": "Forget",
  "desktop.dialog.repairTitle": "Pair with {name} again?",
  "desktop.dialog.repairDetail":
    "{origin}\n\nThis forgets the identity Psyche pinned for it and this computer's key, so the next connection pins whatever answers at that address and asks to pair as a new computer. Only do this if you know why its identity changed.",
  "desktop.dialog.repairButton": "Pair again",
  "desktop.dialog.claimTitle": "Set up the Psyche server at {origin}?",
  "desktop.dialog.claimDetail":
    "Psyche checks that the server knows the setup code you typed before it trusts it, and the server checks that this computer knows it before making it the server's admin. Only continue if you just installed that server yourself.",
  "desktop.dialog.setUp": "Set up",
  "desktop.dialog.addLanTitle": "Is {origin} a Psyche on this network?",
  "desktop.dialog.addLanDetail":
    "Name: {name}\n\nA Psyche on this network uses its own certificate, which Psyche pins instead of trusting the system's: it checks the certificate and the Gateway's key at the first connection and refuses any other later. Choose \"Plain https\" only for a server with an ordinary certificate (for example a reverse proxy with your own CA). Nothing is shared until its owner approves this computer there.",
  "desktop.dialog.psycheOnNetwork": "Psyche on this network",
  "desktop.dialog.plainHttps": "Plain https",
  "desktop.dialog.addLinkTitleLan": "Connect Psyche to {origin} on this network?",
  "desktop.dialog.addLinkTitle": "Connect Psyche to {origin}?",
  "desktop.dialog.addLinkDetail":
    "{external, select, yes {This link was opened by another app or a website, not pasted by you. Only continue if you made it yourself on {os, select, macos {the Mac} windows {the PC} other {the computer}} that runs Psyche.\n\n} other {}}Psyche will connect only if that Gateway proves this identity:\n{fingerprint}\n\n{lan, select, yes {It uses its own certificate, not one the system trusts. Psyche holds it to the one this link names ({pin}…) before sending anything, and refuses any other. Only continue if the link came from your own {os, select, macos {Mac} windows {PC} other {computer}} on this network.\n\n} other {}}The link's one-time code then lets that Gateway approve this computer without asking again, with the access its owner chose when making it.",
  "desktop.dialog.addDetailKey":
    "Name: {name}\nKey it announced: {key}…\n\nThis computer will ask that Gateway to pair. Nothing is shared until its owner approves this computer there, and Psyche pins the Gateway's identity at the first connection.",
  "desktop.dialog.addDetailPlain":
    "Name: {name}\n\nThis computer will ask that Gateway to pair. Nothing is shared until its owner approves this computer there, and Psyche pins the Gateway's identity at the first connection.",
  "desktop.dialog.addGatewayButton": "Add Gateway",
};
