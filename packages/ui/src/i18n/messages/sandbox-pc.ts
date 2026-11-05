/**
 * The sandbox PC (Windows): Settings → Sandbox PC and the same card in onboarding's Safety step.
 * VM mode on a Mac is a sandbox Mac (`settings.vm.*`); on Windows it is a small Linux PC that runs
 * in Hyper-V, set up once with one administrator prompt and a guest image download.
 */
export const sandboxPc = {
  "settings.sandboxPc.title": "Turn on the sandbox PC",
  "settings.sandboxPc.explain":
    "{persona} gets a small private Linux PC that runs inside Windows. Tasks run there instead of on your PC, and see only the folders you share.",
  "settings.sandboxPc.oneTime":
    "One-time setup: Windows asks for administrator approval once, to add a background service that runs the PC. Then Psyche downloads the PC image ({download}, {disk} on disk). Nothing else needs an administrator.",
  "settings.sandboxPc.oneTimeNoSize":
    "One-time setup: Windows asks for administrator approval once, to add a background service that runs the PC. Then Psyche downloads the PC image. Nothing else needs an administrator.",
  "settings.sandboxPc.turnOn": "Turn on the sandbox PC",
  "settings.sandboxPc.cancelDownload": "Cancel download",
  "settings.sandboxPc.waitingAdmin": "Waiting for the administrator prompt…",
  "settings.sandboxPc.restarting": "Finishing setup…",
  "settings.sandboxPc.downloading": "Downloading the PC image: {received} of {total}",
  "settings.sandboxPc.progressLabel": "PC image download",
  "settings.sandboxPc.ready": "Set up",
  "settings.sandboxPc.readyText": "The sandbox PC is set up. Version {version}.",
  "settings.sandboxPc.unsupported": "The sandbox PC isn't available here: {reason}.",
  "settings.sandboxPc.failed": "The sandbox PC could not be turned on: {reason}",
  "settings.sandboxPc.failedDid": "Nothing else was changed. You can try again.",
  "settings.sandboxPc.gb": "{value, number} GB",
  "settings.sandboxPc.mb": "{value, number} MB",
  "settings.sandboxPc.loadLabel": "Sandbox PC",
  "settings.sandboxPc.onboarding": "Sandbox PC",
  "settings.sandboxPc.onboardingHint":
    "Optional: a private Linux PC for tasks that should not touch your files. You can set it up later in Settings.",

  "settings.sandboxPc.update.title": "Update the sandbox PC service",
  "settings.sandboxPc.update.explainCompatible":
    "This version of Psyche came with a newer sandbox PC service than the one installed. The sandbox PC keeps working as it is.",
  "settings.sandboxPc.update.explainRequired":
    "This version of Psyche can't use the sandbox PC service that is installed. The sandbox PC stays off until you update it.",
  "settings.sandboxPc.update.available": "Update available",
  "settings.sandboxPc.update.required": "Update needed",
  "settings.sandboxPc.update.versions":
    "Installed: {installed}. This version of Psyche: {bundled}.",
  "settings.sandboxPc.update.oneStep":
    "Windows asks for administrator approval once. A running sandbox PC stops while the service is replaced.",
  "settings.sandboxPc.update.button": "Update the sandbox PC service",
  "settings.sandboxPc.update.failed": "The sandbox PC service was not updated: {reason}",
  "settings.sandboxPc.update.failedDid": "Nothing else was changed. You can try again.",
  "settings.sandboxPc.controls.title": "The sandbox PC",
  "settings.sandboxPc.controls.hint": "Create it once, then start and stop it here.",
  "settings.sandboxPc.controls.create": "Create the sandbox PC",
  "settings.sandboxPc.controls.start": "Start",
  "settings.sandboxPc.controls.stop": "Stop",
  "settings.sandboxPc.controls.resume": "Resume",
  "settings.sandboxPc.controls.working": "Working…",
  "settings.sandboxPc.controls.helperOffline":
    "The Windows helper isn't running or doesn't have the sandbox PC yet, so it can't be controlled. Restart the helper in Settings → Devices.",
  "settings.sandboxPc.controls.failed": "That didn't work: {reason}",
  "settings.sandboxPc.controls.waitForImage": "Finish turning it on above first.",

  "settings.sandboxPc.snapshots.title": "Snapshots",
  "settings.sandboxPc.snapshots.hint":
    "Save the sandbox PC's disk to come back to. It has to be stopped to save or restore.",
  "settings.sandboxPc.snapshots.none": "No snapshots yet.",
  "settings.sandboxPc.snapshots.save": "Save a snapshot",
  "settings.sandboxPc.snapshots.saveFresh": "Save as the fresh PC",
  "settings.sandboxPc.snapshots.reset": "Reset to the fresh PC",
  "settings.sandboxPc.snapshots.restore": "Restore",
  "settings.sandboxPc.snapshots.delete": "Delete",
  "settings.sandboxPc.snapshots.fresh": "Fresh PC",
  "settings.sandboxPc.snapshots.item": "{label}, {when}",
  "settings.sandboxPc.snapshots.stopFirst": "Stop the sandbox PC first.",
} as const;
