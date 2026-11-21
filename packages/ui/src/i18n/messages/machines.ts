/** Computers Psyche can use: Linux machines paired as helpers (docs/design/linux-helper-only-2026.md §8). */
export const machines = {
  "machines.title": "Computers Psyche can use",
  "machines.description":
    "Linux computers you paired so Psyche can use apps, commands and files there while you keep using this one.",
  "machines.empty":
    "Give Psyche a Linux computer to work on, so it can use apps, commands and files there while you keep using this one.",
  "machines.add": "Add a Linux computer",
  "machines.add.description":
    "Psyche works on that computer while you keep using this one. Actions there follow your approval settings.",
  "machines.add.account": "Which account should Psyche use there?",
  "machines.add.account.own": "Your account (recommended)",
  "machines.add.account.ownHint":
    "Psyche can use your files, apps and logins there, as you can. It never gets root.",
  "machines.add.account.dedicated": "A separate psyche account",
  "machines.add.account.dedicatedHint":
    "Psyche sees only that account's files and apps. It has no sudo and no password.",
  "machines.add.needsNetwork":
    "Other computers can't reach this one yet. Turn on remote access or local network access in Settings → Server & remote access first.",
  "machines.add.make": "Show the commands",
  "machines.add.again": "Make new commands",
  "machines.add.commands": "Commands for the Linux computer",
  "machines.add.installStep": "1. On the Linux computer, install the helper",
  "machines.add.pairStep": "2. Start pairing there",
  "machines.add.expires": "The link works once and expires {when}.",
  "machines.add.waiting": "Waiting for the computer to pair…",
  "machines.add.paired": "{name} is paired. Psyche can use it now.",
  "machines.add.pairedToast": "{name} was added",
  "machines.add.done": "Done",
  "machines.copy": "Copy",
  "machines.status.online": "Online",
  "machines.status.offline": "Offline",
  "machines.status.degraded": "Needs attention",
  "machines.display.headless": "Private screen",
  "machines.display.desktopSession": "Its own desktop",
  "machines.display.container": "Container",
  "machines.thisComputer": "This computer",
  "machines.watch": "Watch",
  "machines.watchNamed": "Watch {name}",
  "machines.apps": "App access",
  "machines.appsNamed": "App access on {name}",
  "machines.folders": "Folders",
  "machines.foldersNamed": "Folders on {name}",
  "machines.rename.action": "Rename",
  "machines.rename.named": "Rename {name}",
  "machines.rename.label": "New name for {name}",
  "machines.rename.save": "Save",
  "machines.rename.cancel": "Cancel",
  "machines.remove": "Remove",
  "machines.removeTitle": "Remove {name}?",
  "machines.removeDescription":
    "Psyche stops using {name} right away and its pairing is revoked. To use it again, pair it again.",
  "machines.err.nameTaken":
    "Another computer already has that name, or it is reserved. Pick a different one.",
  "machines.err.nameInvalid":
    "That name can't be used. Use plain letters, numbers and punctuation, up to 64 characters, and don't mix look-alike letters.",
  "machines.err.forbidden": "Renaming needs an admin device. Try again from one.",
  "machines.err.failed": "That didn't work ({reason}). Nothing changed.",
  "machines.account.own":
    "Runs as your own account on {name}. Psyche can use your files, apps and logins there, as you can. If your Psyche were ever compromised, so could an attacker, except for root, which Psyche never gets.",
  "machines.account.dedicated":
    "Runs as a separate account on {name}. Psyche sees only that account's files and apps.",
  "machines.account.useSeparate": "Use a separate account instead…",
  "machines.account.useSeparateHint":
    "On {name}, run the installer again with the separate-account option, then pair it again:",
  "machines.shell.contained": "Commands run in a contained shell",
  "machines.shell.full": "Commands run in a full account shell",
  "machines.shell.off": "Commands are off",
  "machines.limits.folders":
    "{count, plural, =0 {No folders granted} one {# folder granted} other {# folders granted}}",
  "machines.helperVersion": "Helper {version}",
  "machines.helperVersionUnknown": "Helper version unknown",
  "machines.update": "A newer helper is available. Update the helper on {name}:",
  "machines.warnings": "Warnings for {name}",
  "machines.warn.fullShell":
    "Full account shell. Commands are not contained, so they can reach everything this account can.",
  "machines.warn.userLimits":
    "Limits are user-owned. Any program running as this account can change what Psyche may do on {name}.",
  "machines.warn.sudo":
    "This account has passwordless sudo. Psyche can't use sudo here, but other programs you run as this account can.",
  "machines.paired": "Paired {when}",
  "machines.line": "On “{name}” · Linux · {place}",
  "machines.place.screen": "private screen",
  "machines.place.desktop": "its desktop",
  "machines.place.command": "command",
  "machines.place.files": "files",
  "machines.step.on": "{label} on {name}",
  "machines.picker.title": "Computers",
  "machines.picker.description":
    "Choose which computer these settings are for, and where Psyche works when you aren't watching a particular one.",
  "machines.picker.show": "Show app access for",
  "machines.picker.default": "Default computer for background work",
  "machines.picker.defaultHint":
    "Tasks and automations run there unless they name a computer. Pick a Linux computer to have Psyche work over there while you work here.",
  "machines.picker.appsOn": "Apps on {name}",
  "machines.picker.appsHint":
    "Psyche syncs these to {name} and never goes beyond what that computer's own limits allow.",
  "machines.picker.noApps":
    "Psyche hasn't seen any apps on {name} yet. They appear here once it has.",
  "machines.picker.offline": "{name} is offline. Changes reach it when it reconnects.",
  "computerWatch.titleMachine": "{name} · private screen",
  "computerWatch.machineOffline": "Can't reach {name}. Trying again…",
  "computerWatch.empty.bodyMachine":
    "When the agent needs a screen on {name}, you can watch it here.",
  "notice.machine.working.title": "Psyche is working on {name}",
  "notice.machine.working.body":
    "It is using that computer's screen, apps or files. Watch it from Settings → Devices.",
  "notice.machine.offline.title": "{name} went offline",
  "notice.machine.offline.body":
    "Psyche can't use it until it reconnects. Tasks that need it wait for you.",
  "machines.add.linkStep": "3. When it asks for the link, paste this",
  "machines.add.installSource":
    "Get the helper package from {url}, unpack it, then run this on the Linux computer.",
  "machines.reports": "{name} reports:",
  "computerWatch.machineLoading": "Loading computer…",
  "computerWatch.machineMissing": "That computer isn't available.",
  "settings.key.computerUse.defaultMachine": "Default computer for background work",
  "settings.key.computerUse.machineApps": "App access on a Linux computer",
} as const;
