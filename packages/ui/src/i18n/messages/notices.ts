/**
 * Notices the Gateway authors (inbox notifications and security alerts). The Gateway sends a
 * `message` (title id, body id and values) next to its English `title` and `body`, and every
 * client words it here, in the owner's language. The English text below is also what the Gateway
 * sends as that fallback, so a change of wording here goes with a change in the Gateway's call.
 * Values arrive cleaned of control and bidirectional characters (packages/notifications notice.ts).
 */
export const notices = {
  "notice.install.failed.title": "An approved install didn't finish",
  "notice.install.failed.body":
    "{reason, select, lost {Psyche restarted before you approved it, so the proposal was lost. Propose it again.} expired {The proposal had expired before you approved it. Propose it again.} other {Psyche could not install it. Check the list and try again.}}",
  "notice.security.changed.title": "Psyche undid a security change made outside the app",
  "notice.security.changed.body":
    "A program on this Mac changed {count, plural, =1 {# security record} other {# security records}} (devices, keys, grants or settings) without going through Psyche{times, plural, =0 {} =1 {} other {, # times so far}}. Psyche put them back. If you did not do this, check the Mac for unwanted software.",
  "notice.security.untrusted.title": "Psyche cannot trust its security records",
  "notice.security.untrusted.body":
    "Psyche's check of its security records failed, so security changes, new devices and Touch ID approvals are blocked. Review your devices, then run `psyched security reseal` on the Mac (it applies after 24 hours).",
  "notice.security.firstSeal.title": "Psyche now checks its security records",
  "notice.security.firstSeal.body":
    "Psyche sealed {devices, plural, =1 {# paired device} other {# paired devices}} and its security settings. From now on a change made outside Psyche is undone and shown here. Review your devices once.",
  "notice.security.resealed.title":
    "{restored, select, yes {Security records sealed after a restore} other {Security records sealed again}}",
  "notice.security.resealed.body":
    "{restored, select, yes {Psyche started from a restored backup and sealed its security records as they are. If you did not restore a backup, check your devices.} other {Psyche sealed its security records again after the waiting period.}}",
  "notice.security.firstAdmin.title": "A command on this Mac made the first admin device",
  "notice.security.firstAdmin.body":
    "{device}{key, select, none {} other { (key {key})}} became the first admin device {via, select, desktop {from the Psyche app} other {through `psyched`}} on this Mac. If that was not you, revoke it in Settings → Devices.",
  "notice.security.recovery.title":
    "{state, select, requested {A command on this Mac asked for a security change} applied {A security change from this Mac was applied} cancelled {A security change from this Mac was cancelled} other {A security change from this Mac could not be applied}}",
  "notice.security.recovery.body":
    "{op, select, approve {Approve the device {device}{key, select, none {} other { (key {key})}} with {scopes}.} grant {Give {device}{key, select, none {} other { (key {key})}} {scopes}.} presence {Turn off the Touch ID and passkey requirement for security changes until a new key is registered.} seal {Accept the current security records as they are.} other {A security change.}}{state, select, requested { It applies {when, select, none {in 24 hours} other {on {when}}} unless you cancel it in Psyche.} failed {{reason, select, none {} other { {reason}}}} other {}}",
  "notice.browser.chrome.title": "Psyche is driving your Chrome",
  "notice.browser.chrome.body":
    "A task is using the Psyche Chrome profile, where you are signed in. Its window title says “Psyche is driving this window”. It closes when the task is done; you can also quit Chrome.",
  "notice.browser.takeover.title": "Psyche needs you in the browser",
  "notice.browser.takeover.body":
    "On {host}, the agent asks: {reason}. Take control in the browser pane, then hand it back.",
  "notice.connector.consent.title": "Finish connecting Google",
  "notice.connector.consent.body":
    "Open this link on the computer running Psyche to grant access: {url}",
  "notice.connector.changed.title": "A connection changed",
  "notice.connector.changed.body":
    "{reason, select, account_changed {A connector now signs in to a different account. Work bound to the old account was stopped.} disconnected {A connector was disconnected. Work that needed it was stopped.} scope_changed {A connector is now read-only. Pending actions through it were stopped.} other {A connector's access was revoked. Sign in again to keep using it.}}",
  "notice.connector.reconnect.title": "Reconnect needed",
  "notice.connector.reconnect.body": "A connector lost access and needs you to sign in again.",
  "notice.connector.syncFailing.title": "{name} isn't syncing",
  "notice.connector.syncFailing.body":
    "{name} failed to sync several times in a row ({reason}). Psyche keeps retrying. Open Settings › Connectors to check it.",
  "notice.connector.testingExpired.title": "Google signed you out",
  "notice.connector.testingExpired.body":
    "Google signs you out after 7 days while the Psyche OAuth app is in Testing mode. Publish the OAuth app in Google Cloud to stop this, then reconnect Google in Settings › Connectors.",
  "notice.attention.paused.title": "A task is waiting for you",
  "notice.attention.paused.body":
    "Paused before {tool} on a sensitive app or site until you are back in Psyche.",
  "notice.apiKey.changed.title":
    "{kind, select, brave {The {provider} key was {action, select, changed {changed} other {removed}}} other {The {provider} API key was {action, select, changed {changed} other {removed}}}}",
  "notice.apiKey.changed.body":
    '{action, select, changed {Changed} other {Removed}} from {device, select, none {a device} other {"{device}" ({platform}{paired, select, none {} other {, paired {paired}}})}}. If that was not you, revoke the device in Settings → Devices.',
  "notice.approvals.digest.title":
    "{count, plural, =1 {# action is waiting from your automations} other {# actions are waiting from your automations}}",
  "notice.approvals.digest.body": "Open Approvals to approve or decline them",
  "notice.approvals.resumeMissed.title":
    "{automation, select, none {An approved automation action was not done} other {{automation}: the approved action was not done}}",
  "notice.approvals.resumeMissed.body":
    "{why, select, expired {The approval ran out before the automation reached the action, so nothing was done. If it still needs it, it will ask again.} paused {The automation is paused or was removed, so it did not run again and nothing was done. If it still needs it, it will ask again.} restart {Psyche restarted before the automation could run again, so nothing was done. If it still needs it, it will ask again.} restart_kept {Psyche restarted before the automation could run again. The permission you gave stays, so its next run will do this without asking. To take it back, revoke it under Standing permissions in Approvals.} failed {The automation ran the action again, but it failed. See Activity for what went wrong. If it still needs it, it will ask again.} failed_kept {The automation ran the action again, but it failed. See Activity for what went wrong. The permission you gave stays, so its next run will try again without asking. To take it back, revoke it under Standing permissions in Approvals.} unknown {The automation ran the action again, but Psyche can't tell whether it worked. Check Activity to see.} not_reached_kept {The automation ran again but did not reach the same action, so nothing was done. The permission you gave stays, so its next run will do this without asking. To take it back, revoke it under Standing permissions in Approvals.} other {The automation ran again but did not reach the same action, so nothing was done. If it still needs it, it will ask again.}}",
  "notice.specialist.result.title":
    "{outcome, select, done {{who} finished {title}} partial {{who} stopped early on {title}} cancelled {{who} was stopped on {title}} other {{who} couldn't finish {title}}}",
  "notice.specialist.result.body":
    "{outcome, select, done {Done} partial {Partial} cancelled {Cancelled} other {Failed}}{findings, plural, =0 {} one { · # finding} other { · # findings}}{cost, select, none {} other { · {cost}}} · {minutes, plural, =0 {under 1 min} other {# min}}",
  "notice.mcp.changed.title": "MCP server {server} changed its tools",
  "notice.mcp.suspicious.title": "MCP server {server} has suspicious tool descriptions",
  "notice.mcp.review.body": "Review before you use this server: {details}",
  "notice.security.tightened.title":
    "Security settings were tightened from {device, select, none {a device} other {{device}}}",
  "notice.security.tightened.body":
    "This only reduced what Psyche is allowed to do, so no approval was needed. If that was not you, revoke the device in Settings → Devices.",
  "notice.codeRun.held.title": "Psyche held back launch config from a code run in {repo}",
  "notice.codeRun.held.body":
    "A command in the sandbox created {paths}. Apps or your next command could run code from it, so Psyche moved it aside without deleting it. If you or your tools made it, tap Keep it.",
  "notice.codeRun.changed.title": "Launch config changed during a code run in {repo}",
  "notice.codeRun.changed.body":
    "{paths} changed while a command ran in the sandbox. If that wasn't you or your editor, check it before you open the folder.",
  "notice.codeRun.partial.title": "{repo} is too large to check fully",
  "notice.codeRun.partial.body":
    "Psyche checked only the top folders for launch config that code runs create.",
  "notice.codeRun.recreated.title": "The sandbox for {repo} was set up again",
  "notice.codeRun.recreated.body":
    "Its read-only folders changed, so running servers and anything installed outside the repository are gone. Start again what you need.",
  "notice.action.keepIt": "Keep it",
  "notice.codeRun.incident.title":
    "Psyche held back something that may not be from a code run in {repo}",
  "notice.codeRun.incident.body":
    "While {paths} was moved aside, a folder on its way changed, so what was moved may come from somewhere else. It is kept in {place}. Look at it before you tap Keep it, which puts it at {paths} in {repo}.",
  "notice.codeRun.unmoved.title": "Launch config from a code run in {repo} is still in place",
  "notice.codeRun.unmoved.body":
    "A command in the sandbox created {paths}, and Psyche could not move it aside, so it is not held. Apps or your next command could run code from it. Delete it before you open the folder or run anything there. Don't change its permissions to look inside first, since that can let it run.",
  "notice.codeRun.unchecked.title": "Psyche could not check part of {repo} after a code run",
  "notice.codeRun.unchecked.body":
    "{paths} changed while Psyche checked it after a command ran in the sandbox, so nothing in it was checked for launch config. If you or your tools didn't change it, look at it before you open the folder or run anything there.",
  "notice.machine.added.title": "{name} was added as a computer Psyche can use",
  "notice.machine.added.body":
    "Psyche can use its screen, apps, shell and files, and each action there asks you first. If you didn't add it, remove it in Settings → Devices.",
  "notice.machine.removed.title": "{name} removed itself",
  "notice.machine.removed.body":
    "It was a computer Psyche could use. Psyche won't use it again unless you add it again.",
  "notice.machine.scanIncomplete.title":
    "Couldn't finish checking {folder} on {name} after a command",
  "notice.machine.scanIncomplete.body":
    "New repositories or launch files there may not have been moved aside. Check it for new .git or .vscode folders before you open it in an editor or run git there. Commands can't write there again until Psyche restarts on {name}.",
  "notice.machine.offline.title": "{name} went offline",
  "notice.machine.offline.body":
    "A task is waiting to use it and goes on when {name} is back. You can also cancel the task.",
} as const;
