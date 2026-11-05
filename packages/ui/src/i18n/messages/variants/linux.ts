import type { MessageId } from "../index.ts";

/**
 * Linux wording for messages whose English names a Mac ("This Mac", "Touch ID", "Finder", ⌘
 * shortcuts). `t()` uses these on Linux (`lib/platform.ts`), so screens keep one id and never
 * branch on the platform for copy. Rules (docs/guides/translating.md applies):
 * - the same placeholders as the English message and the same meaning: a variant only says it the
 *   way Linux does ("This computer", "your password", "Files", "Ctrl+K"). Presence on Linux is the
 *   account password, asked for through the system dialog;
 * - no variant for Mac-only features (Apple apps, Apple's on-device model, Shortcuts): they are
 *   hidden on Linux or say "Available on macOS" (cross-platform-2026 §4.3);
 * - a translation of a variant goes in `LINUX_LOCALES` (./linux-locales.ts); until then a
 *   translated catalogue shows the English variant rather than its Mac wording.
 */
export const linux: Partial<Record<MessageId, string>> = {
  "settings.devices.nodeKind.hostHelper": "Linux helper",
  "settings.links.description":
    "Where a link in a chat message, card or artifact opens. Ctrl+click always uses your default browser.",
  "errors.presence_required": "Confirm it's you with your password or a passkey first.",
  "chat.toolbar.keySheet": "Ctrl+Shift+A",
  "chat.toolbar.keyModel": "Ctrl+Shift+I",
  "chat.toolbar.keyView": "Ctrl+O",
  "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
  "blocks.details.runsOnHost": "on your computer, outside the sandbox",
  "blocks.details.runsSandboxed":
    "on your computer, in the sandbox: it cannot read Psyche's vault, your SSH keys, the system keyring or browser profiles",
  "blocks.details.runsNoSandbox": "on your computer, and the sandbox is not set up ({reason})",
  "blocks.permission.need.capability": "Turn on Run commands on this computer",
  "blocks.permission.need.macos_access": "Give {connector} access in Settings",
  "blocks.permission.openSystemSettings": "Open Settings",
  "blocks.approval.answerOnHost":
    "Answer on {host}, or set up password approvals for this computer in Settings → Devices.",
  "blocks.approval.needsAuth": "Needs your password or a passkey to approve.",
  "blocks.approval.touchIdFailed": "The password check failed: {reason}. Try again.",
  "blocks.approval.touchIdFailedNoReason": "The password check failed. Try again.",
  "blocks.approval.touchId.helperOffline":
    "The Linux helper isn't running, so your password can't confirm this here.",
  "blocks.approval.touchId.noKey":
    "Password approvals aren't set up on this computer yet. Set them up in Settings → Devices, where you can check the key first.",
  "blocks.approval.touchId.invalidated":
    "Your password setup changed since this computer's key was set up, so it can't confirm approvals. Set it up again in Settings → Devices.",
  "blocks.approval.touchId.noUnsandboxed":
    "Running a command without the sandbox can't be approved with your password from this window. Set up the sandbox instead",
  "blocks.approval.touchId.onceOnly": "password approvals from this window are once only.",
  "blocks.approval.status.allowedOnceTouchId":
    "Allowed once (password approvals from this window are once only)",
  "blocks.approval.touchId.keyUnavailable":
    "This build of the Linux helper can't keep an approval key, so cards that need your password can't be approved on this computer.",
  "blocks.approval.touchId.cancelled": "The password prompt was cancelled, so nothing was approved",
  "shell.shortcut.pushToTalkKeys": "Hold Right Ctrl",
  "settings.shared.needsPresence":
    "Changing “{label}” needs your approval with your password or a passkey. Approve it in Settings or in the Psyche notification, then change it again.",
  "settings.page.permissions.description":
    "What {persona} may do on this computer without asking, and where it always stops to ask you.",
  "settings.page.data.description":
    "What stays on this computer, how long it is kept, exports, backups and starting over.",
  "settings.essentials.model.noneHint":
    "{persona} needs a model before it can answer. Add a key, or use a model on this computer.",
  "settings.essentials.read.hint":
    "Off until you turn one on. What it reads is indexed on this computer so it can find things for you, and memory learns from it too unless you opt out under Memory → Sources.",
  "settings.searchModel.apple.notOnThisMac": "Available on macOS",
  "settings.macHelper.paired.text":
    "Runs computer use, screen context, dictation, password approvals and notifications on this computer.",
  "settings.macHelper.unbundled.text": "This build of Psyche has no Linux helper.",
  "settings.key.appearance.showInDock": "Show in the taskbar when no windows are open",
  "settings.semanticSearch.encrypt.pending":
    "Waiting for the Linux helper to open the encrypted index",
  "settings.semanticSearch.rerankHint":
    "A small cloud model puts the best results first. The top 20 snippets leave this computer. Off by default.",
  "settings.key.vm.enabled": "Use a sandbox computer for tasks",
  "settings.key.vm.resetPerTask": "Fresh computer for every task",
  "settings.credentials.backend.psyche": "Psyche vault (your password)",
  "settings.credentials.backend.keychain": "System keyring",
  "settings.credentials.backendIn.keychain": "in the system keyring",
  "settings.credentials.err.lockedChange":
    "The vault is locked. Unlock it with your password, then {verb, select, delete {delete} other {change}} {name} again.",
  "settings.credentials.err.lockedImport":
    "The vault is locked. Unlock it with your password, then import again.",
  "settings.credentials.slot.keychain": "the system keyring (your password)",
  "settings.credentials.slot.safeStorage": "this computer's app storage",
  "settings.credentials.slot.keyFile": "a key file on this computer",
  "settings.credentials.moveToKeychain": "Move to the system keyring",
  "settings.credentials.keyFileExplainer":
    "The key that opens your vault is a file only your account can read. Moving it to the system keyring needs the Linux helper; this build's helper is not available.",
  "settings.credentials.link.err.locked":
    "The vault is locked. Unlock it with your password, then link {name} again.",
  "settings.approval.presenceUnavailable":
    "This window can't confirm it's you. Approve the change in the Psyche app on your computer (your password), or from a device with a passkey. Nothing changes until then.",
  "settings.approval.promptDetail":
    "Security settings need your password or a passkey. Approve it here or in the Psyche notification; the setting is saved as soon as it is approved.",
  "settings.approval.presenceInvalid":
    "Your password or the passkey didn't confirm it's you. Try again.",
  "settings.about.revealHome": "Show in Files",
  "settings.uninstall.keychainStays":
    "System keyring items stay (the vault key and helper items). Remove them in your keyring app if you want.",
  "settings.uninstall.keychainGoes":
    "The system keyring items for the vault and the helper are removed too.",
  "settings.uninstall.removeKeychain":
    "Also remove my system keyring items (the ones for Psyche). Without your data they are useless.",
  "settings.uninstall.presence":
    "You will then be asked to confirm with your password or on this device, because this removes your data.",
  "settings.appearance.showInDockHint":
    "Off, Psyche keeps running in the system tray when its last window closes.",
  "settings.appearance.openAtLoginHint":
    "Starts Psyche in the system tray when you sign in, so scheduled automations can always run.",
  "settings.browser.letTasksUseHint":
    "Each task still asks you first, on this device with your password or a passkey.",
  "settings.browser.detailsText":
    "While a task uses it, Psyche runs Google Chrome with this profile and a DevTools port on this computer's loopback (127.0.0.1), and closes it when the task is done. {persona} is not attached while you have the profile open yourself.",
  "settings.browser.openFromMac":
    "Open it from the Psyche app on the computer that runs the Gateway.",
  "settings.channels.empty":
    "No channels yet. Connect Telegram or Slack to reach {persona} away from this computer.",
  "settings.computerUse.description":
    "{persona} can use apps on this computer only where you allow it.",
  "settings.computerUse.macPermissions": "Desktop permissions",
  "settings.computerUse.openSystemSettingsFor": "Open Settings for {name}",
  "settings.computerUse.openSystemSettings": "Open Settings",
  "settings.trusted.loading": "Reading them from this computer…",
  "settings.trusted.noHelper": "Open Psyche on your computer to list them: the helper reads them.",
  "settings.trusted.failed": "Psyche couldn't read them from this computer.",
  "settings.mcp.sandboxHelp": "Command servers need a sandbox on this computer.",
  "settings.sandbox.why":
    "Commands run on your computer with your files, but can't read your vault, keys or Psyche's private data.",
  "settings.sandbox.whyHow":
    "Uses srt, Anthropic's sandbox runtime, with Linux's own sandboxing (bubblewrap). No virtual machine needed.",
  "settings.sandbox.checking": "Looking at this computer…",
  "settings.sandbox.containers.body":
    "A container runtime runs code in its own Linux machine with no access to your computer's files: for code the agent runs and some file conversions. Command servers keep using srt unless the Gateway is set to use containers.",
  "settings.searchSources.description":
    "What Psyche reads into your search index. All off until you switch them on; the index stays on this computer. Turning a source on also lets memory learn from it, unless you opt out on Memory → Sources (Memory and Contacts are the exceptions: neither is learned from).",
  "settings.searchSources.runOnBatteryHint":
    "Lets indexing, Rebuild and reading text in images carry on while your computer runs on battery, at a gentler pace. It uses more battery. Energy saver still pauses indexing.",
  "settings.searchSources.ocrHint":
    "Reads screenshots and scanned PDFs, one page at a time, on power (or on battery with Index on battery on). Nothing leaves your computer.",
  "settings.semanticSearch.description":
    "Find things by meaning as well as by their words, all on this computer.",
  "settings.semanticSearch.engine.builtinHint":
    "Multilingual E5 small, about 100 languages, runs on this computer's processor.",
  "settings.semanticSearch.engine.routerHint":
    "Uses the embedding model set in Roles, for example Ollama or LM Studio on this computer.",
  "settings.semanticSearch.allowCloudHint":
    "Only if the embedding model is a cloud service. Your chats, tasks and Library text are sent to it. Off keeps everything on this computer.",
  "settings.semanticSearch.state.cloudBlocked":
    "The embedding model in Roles is a cloud service. Semantic search only uses models on this computer.",
  "settings.data.encryptMemory.pending": "Waiting for the key from the Linux helper.",
  "settings.devices.touchId.none":
    "No password key yet. Cards that need your password can't be approved until one is registered.",
  "settings.devices.touchId.noBundledKey":
    "The Linux helper in this app has no approval key ({reason}).",
  "settings.devices.touchId.manualHint":
    "Run psyche-helper --print-identity on the computer and paste the presenceKeyId it prints.",
  "settings.devices.noNodes":
    "No nodes. The Linux helper appears here once Psyche runs on this computer.",
  "settings.files.execHost": "Run commands on this computer",
  "settings.files.execHostSwitch": "Allow commands on this computer",
  "settings.model.ram.tooSmall":
    "This computer has {gb, number} GB. Local models need at least {min, number} GB; use a cloud provider instead.",
  "settings.model.ram.fits": "This computer has {gb, number} GB, so {fits} fit.",
  "settings.model.ram.thisMac": " (this computer)",
  "settings.model.localHint": "Run models on this computer with Ollama or LM Studio.",
  "settings.permissions.never.browserPasswords":
    "Read passwords saved in your browsers or the system keyring",
  "settings.server.bindHint":
    "127.0.0.1 keeps it on this computer. Use remote access below instead of binding to every interface.",
  "settings.gateways.description":
    "Use Psyche from this computer with the Gateway on another one, such as your computer at home. One Gateway is active at a time, and switching restarts Psyche.",
  "settings.gateways.thisMac": "This computer",
  "settings.gateways.switchKeep":
    "Psyche restarts on {name}. Psyche on this computer keeps running, so its automations continue.",
  "settings.gateways.switchAndStop": "Switch and stop Psyche on this computer",
  "settings.gateways.addHint":
    "Paste the pairing link from the computer that runs Psyche (Settings, Server & remote access, Pair another computer). Without a link, type its Tailscale address, https://<host>.<tailnet>.ts.net; this computer then asks to pair, and the owner approves it there.",
  "settings.gateways.problem.link_malformed":
    "That pairing link is damaged. Copy it again from the computer that made it.",
  "settings.gateways.problem.link_bad_field":
    "That pairing link is damaged. Copy it again from the computer that made it.",
  "settings.gateways.problem.link_lan":
    "This pairing link is for a computer on your local network but doesn't carry its certificate, so it isn't used. On that computer, make a new one: Pair another computer, From this network.",
  "settings.remote.description":
    "Let Psyche on another computer use this computer's Gateway over Tailscale. The Gateway stays on this computer and listens only to it, and Tailscale Serve is the only way in.",
  "settings.remote.step1":
    "Install Tailscale on this computer and on the other computer, and sign both in to the same tailnet.",
  "settings.remote.step2":
    "In a terminal on this computer, publish the Gateway to your tailnet. This is Serve, not Funnel.",
  "settings.remote.step4":
    "Restart Psyche. Then on the other computer, add this computer as a Gateway. It shows a pairing code and a key fingerprint: compare them with the request under Waiting to pair here, then approve it.",
  "settings.remote.admin":
    "A computer that pairs gets read, write and approvals. Admin stays off unless you tick it when you approve, and each admin change still needs your password here.",
  "settings.pair.needsAddress":
    "Set this computer's public address first (step 3 above), then make a pairing link.",
  "settings.pair.adminHint":
    "Admin lets it change security settings, devices and the vault, and stays off unless you tick it. Each admin change still needs your password here.",
  "settings.pair.compare":
    "It checks this computer's key before it uses the link: {fingerprint}. You can compare.",
  "settings.pair.secret":
    "Anyone who has this link in the next ten minutes can pair one computer. Don't post it or send it to anyone you wouldn't trust with this computer.",
  "settings.pair.err.noAddress":
    "This computer has no public address yet, so there is nothing to put in a link.",
  "settings.pair.viaAddress": "Over Tailscale, at this computer's address",
  "settings.pair.viaLanHint":
    "A link for this network holds this computer's key and certificate, so it works only for computers on the same Wi-Fi or Ethernet.",
  "settings.pair.lanNote":
    "This link is for computers on the same network as this computer. It names the key and certificate Psyche will insist on.",
  "settings.lan.description":
    "Let Psyche on another computer on the same Wi-Fi or Ethernet reach this computer's Gateway, without Tailscale. It is off until you turn it on.",
  "settings.lan.toggleHint":
    "Psyche listens on one network, over an encrypted connection with its own certificate. A computer that connects still has to be approved here with your password.",
  "settings.lan.noInterface": "No Wi-Fi or Ethernet connection was found on this computer.",
  "settings.lan.notAdvertised": "Not shown. Add this computer by its address.",
  "settings.lan.problem.unknownInterface": "{name} is not a network on this computer.",
  "settings.lan.problem.advertise":
    "Psyche couldn't announce itself on the network. Computers can still add this computer by its address.",
  "settings.server.noVm":
    "No VM. VM mode runs Psyche inside a separate guest computer; set it up from onboarding.",
  "settings.shortcut.key.Control": "Ctrl",
  "settings.shortcut.key.Alt": "Alt",
  "settings.skills.permission.exec_host": "Run commands on this computer",
  "settings.skills.permission.computer_action": "Use apps on this computer",
  "settings.skills.pathPlaceholder": "/home/you/Downloads/pdf-merge",
  "settings.skills.signer.originAgent":
    "Written by an assistant on the sender's computer. Read it as unreviewed text, whoever signed it.",
  "settings.skills.export.hint":
    "The file is signed with your author key, so people who get it can tell it is yours and that it was not changed. The key stays on this computer.",
  "settings.vm.phase.installing": "Setting up the guest",
  "settings.vm.description":
    "Run tasks in a separate sandbox computer, so {persona} works in its own copy of Linux instead of yours.",
  "settings.vm.sandboxMac": "Sandbox computer",
  "settings.vm.between": "Between your computer and the guest",
  "settings.vm.credentialsHint":
    "With the host vault, values stay on your computer. A guest vault keeps its own copy.",
  "settings.vm.noReports":
    "No guest has reported yet. Create one from the Psyche helper on this computer; its state shows here.",
  "settings.voice.key.rightOption": "Right Alt",
  "settings.voice.key.rightCommand": "Right Ctrl",
  "settings.voice.reply.gatewayHint": "The voice set for the persona, or the system voice.",
  "settings.voice.engine.local": "On this computer",
  "settings.voice.engine.localHint": "Whisper runs locally; audio never leaves the computer.",
  "settings.voice.engine.system": "System dictation",
  "settings.voice.engine.systemHint":
    "The system's on-device recognizer, through the Linux helper.",
  "settings.voice.model.usingHelper":
    "Dictation uses the helper's speech recognition. The speech model transcribes better and runs on this computer.",
  "settings.voice.model.downloadHint":
    "A one-time download from the whisper.cpp project, checked before it is used. Audio never leaves this computer.",
  "settings.voice.model.ready": "Whisper ({model}) on this computer",
  "settings.voice.model.readyHint":
    "Dictation and recordings are transcribed here; audio never leaves the computer.",
  "settings.connect.finishOpened":
    "The sign-in to {name} opened in your browser on the Gateway's computer. This updates when you're done.",
  "settings.connect.needsPermission":
    "{name} is set up, but the system has not allowed it yet. Allow it in",
  "settings.connect.openSystemSettings": "Open Settings",
  "settings.people.description":
    "The cards {persona} keeps for the people and projects in your life. They stay on this computer, and every fact shows where it came from.",
  "settings.about.versionsHint": "What is running on this computer.",
  "settings.computerUse.macPermissionsHint": "What the desktop allows.",
  "settings.connectorBundle.sandbox.none":
    "This computer has no sandbox for command connectors, and Psyche never runs one outside it. This connector cannot be installed here. Nothing was started or saved.",
  "settings.connectorBundle.share.unavailable":
    "Only Psyche on the computer that runs it can sign a connector.",
  "settings.deviceAccess.files.title": "Files on this computer",
  "settings.deviceAccess.terminal.hint":
    "{persona} can run terminal commands on this computer when Run commands on this computer is on in Permissions → Access.",
  "settings.deviceAccess.terminal.where":
    "Commands run on your computer, in the folders you shared, and can write only to a folder you shared read and write.",
  "settings.mcp.needs.title": "What this needs on your computer",
  "settings.mcp.needs.node.fix":
    "Runs on Psyche's own Node; needs npm on this computer. Install Node.js from nodejs.org, or with your package manager.",
  "settings.mcp.needs.uv.fix": "A Python server. Install uv from docs.astral.sh/uv.",
  "settings.mcp.fail.node_missing":
    "Install Node.js (nodejs.org, or your package manager) so npm is on this computer, then check again.",
  "settings.mcp.fail.uv_missing": "Install uv (docs.astral.sh/uv), then check the server again.",
  "settings.mail.voice.learn.hint":
    "Wren reads only what you wrote in sent mail, without quoted text or signatures. The profile stays on this computer in mail/VOICE.md.",
  "settings.mail.voice.localModel.hint": "Drafts in your voice never leave this computer.",
  "settings.mail.transcribe.endpoint.hint":
    "Optional. An OpenAI-compatible /v1/audio/transcriptions server (for example whisper.cpp on this computer). Used when the Linux helper has no speech engine. Audio goes only to this address: https, or http on 127.0.0.1.",
  "onboarding.mail.voiceHint":
    "Reads only what you wrote, without quoted text or signatures. It stays on this computer and you can view, edit or reset it.",
  "gallery.preset.git.field.repo.help":
    "The folder of a Git repository on this computer. Psyche can read its history and diffs.",
  "settings.connectors.page.onThisMac": "On this computer",
  "settings.connectors.page.row.local": "Runs on this computer",
  "settings.connectors.page.server.local": "A tool that runs in a sandbox on this computer",
  "onboarding.permission.denied": "Off in Settings",
  "onboarding.permission.deniedHint":
    "Turn it on in your system Settings; this page updates when you come back.",
  "onboarding.permission.unavailableHint":
    "Psyche can ask for this only in the Psyche desktop app.",
  "onboarding.connectors.onThisMac": "On this computer",
  "onboarding.connectors.onThisMacHint":
    "Each app asks the system for permission as it connects, one at a time.",
  "onboarding.model.kind.localHint": "Runs on this computer; nothing leaves it.",
  "onboarding.model.subscriptionNote":
    "Psyche uses the Claude Code or Codex app already signed in on this computer, so it needs no API key and stores none. Sign in there first if you haven't.",
  "onboarding.safety.touchId": "Your password for approvals",
  "onboarding.safety.touchId.checking": "Looking at the Linux helper…",
  "onboarding.safety.touchId.setHint": "Approvals that need you ask for your password.",
  "onboarding.safety.touchId.starting":
    "The Linux helper is still starting. Check again in a moment.",
  "onboarding.safety.touchId.noKey": "The Linux helper has no approval key ({reason}).",
  "onboarding.safety.touchId.hint":
    "Register the Linux helper’s key once, so your password can confirm approvals.",
  "onboarding.safety.asks":
    "If you let {name} run commands on this computer, ones that only read, like ls or cat, run without a card. Anything else asks you first.",
  "onboarding.done.touchId": "Your password",
  "onboarding.done.try.search":
    "Ask a question in Search (Ctrl+K). The answer shows where in your life it came from.",
  "screens.search.source.revealFile": "Show in Files",
  "everything.model.localHint":
    "A model on this computer reads everything. Nothing leaves the computer. Fewer, noisier facts.",
  "everything.run.reason.battery":
    "Not now: the computer is on battery. Plug it in, or allow battery runs.",
  "everything.run.reason.thermal": "Not now: the computer is too warm.",
  "everything.run.reason.not_idle": "Not now: you are using the computer.",
  "everything.storage.note": "Everything is stored on this computer only.",
  "memoryWork.consent.k1": "Nothing leaves this computer. Dates and status are worked out by code.",
  "screens.library.reveal": "Show in Files",
  "web.zoom.description":
    "How large the app renders on this computer. Ctrl+Plus and Ctrl+Minus change the same setting, so it survives a restart; {min, number}–{max, number} %.",
  "web.transcriptMode.optionTitle": "{mode} (Ctrl+O cycles)",
  "web.backups.restore": "Restore on a new computer with the Gateway stopped:",
  "web.passkeys.firstApproval":
    "Approve “Add a passkey” with your password on your computer or with a passkey on another device, then press Add again.",
  "web.passkeys.added":
    "Added {name}. It now approves changes that need your password or a passkey.",
  "web.remotePresence.title": "Your password for approvals",
  "web.remotePresence.description":
    "Purchases, credential fills, host commands and security changes need your password or a passkey. Set it up on this computer to answer them here; until then those cards say to answer on {host}. Ordinary approvals never need it.",
  "web.remotePresence.on": "Password approvals are on for this computer.",
  "web.remotePresence.off": "Password approvals aren't set up on this computer.",
  "web.remotePresence.enable": "Use your password for approvals on this computer",
  "web.remotePresence.waiting": "Waiting for your password…",
  "web.remotePresence.passkeyName": "Your password on this computer",
  "web.remotePresence.enabled": "Password approvals are on for this computer.",
  "web.remotePresence.disabled": "Password approvals are off on this computer.",
  "web.remotePresence.approveOnHost":
    "Approve “Add a passkey” on {host}, with its Touch ID, Windows Hello or password, or a passkey, then press the button again.",
  "web.remotePresence.unavailable":
    "Password approvals need {host}'s Gateway at an https:// address (gateway.publicOrigin). Until then, answer those cards on {host}.",
  "web.webauthn.noPasskeyYet":
    "This browser has no passkey yet. Add one in Settings → Devices, or approve on the computer that runs the Gateway.",
  "web.webauthn.needsOrigin":
    "Passkeys need the server's https address (gateway.publicOrigin). Approve on the computer that runs the Gateway instead.",
  "web.setup.gatewayOk": "Running on this computer.",
  "web.setup.adminOk": "This computer is the admin device.",
  "web.viewers.noSandbox":
    "Previews of slides need the sandbox, and no container runtime (Docker or Podman) is available.",
  "web.voice.noEngine":
    "No speech engine is available. Install a speech model in Settings → Voice, or connect the Linux helper.",
  "web.threads.newSideChatTitle": "New side chat (Ctrl+N)",
  "web.panes.closePaneTitle": "Close pane (Ctrl+\\)",
  "web.chat.permissionModeTitle": "Permission mode (Ctrl+Shift+M)",
  "web.chat.modelTitle": "Model (Ctrl+Shift+I)",
  "web.splash.installing": "Setting up Psyche on this computer…",
  "web.splash.helper": "Getting Psyche ready on your computer…",
  "web.splash.remote.useThisMac": "Use this computer",
  "web.remote.thisMac": "This computer",
  "web.teach.bar.body":
    "Psyche is noting your clicks and typing in this tab only. Passwords, card numbers and codes are never recorded, and nothing leaves this computer until you save.",
  "settings.teach.storage.description":
    "When you ask Psyche to keep a recording so you can make another version, the steps are saved on this computer.",
  "settings.teach.storage.encrypted":
    "Encrypted. The file is locked with a key held in the system keyring, so it cannot be read outside Psyche. It expires after 90 days.",
  "settings.teach.storage.unavailable":
    "Recordings are not kept. The system keyring is not available, and Psyche will not save a recording as plain text. You can still save a recording as a skill.",
  "web.teach.review.keepUnavailable":
    "Not available: the system keyring is not available to encrypt a kept recording.",
  "web.teach.review.keepRecording":
    "Keep this recording on this computer so I can make another version",
  "web.teach.app.recordHint": "Show Psyche how to do something in an app you already allowed",
  "web.teach.app.bar.body":
    "Psyche is noting your clicks, menu choices and typing in {app} only. Secure fields are never recorded, no screenshots are taken, and nothing leaves this computer until you save. The system tray also has a Stop.",
  "voice.key.rightOption": "Right Alt",
  "voice.key.rightCommand": "Right Ctrl",
  "voice.settings.reviewHint":
    "Keeps what Psyche heard in the pop-up so you can fix it and press Enter. Off, it's sent when you let go of the key.",
  "meetingRecord.unavailable":
    "Recording needs a way to turn audio into notes (a speech model or the Linux helper), and none is connected.",
  "meetingRecord.micDenied": "Psyche can't use the microphone. Allow it in your system Settings.",
  "platform.term.os": "Linux",
  "platform.term.device": "computer",
  "platform.term.thisDevice": "This computer",
  "platform.term.thisDeviceLower": "this computer",
  "platform.term.presence": "your password",
  "platform.term.secretStore": "System keyring",
  "platform.term.systemSettings": "Settings",
  "platform.term.fileManager": "Files",
  "platform.term.trayArea": "system tray",
  "platform.term.taskbar": "taskbar",
  "platform.term.systemSearch": "desktop search",
  "platform.term.helper": "Linux helper",
  "platform.term.terminal": "Terminal",
  "platform.term.alt": "Alt",
  "platform.term.mod": "Ctrl",
  "web.security.banner.recovery":
    "{count, plural, one {A security change asked for on this computer applies on {when} unless you cancel it.} other {# security changes asked for on this computer are waiting. The next applies on {when}.}}",
  "web.security.alert.changed":
    "A program on this computer changed {count, plural, one {1 security record} other {# security records}} without going through Psyche. Psyche put {count, plural, one {it} other {them}} back. If you did not do this, check the computer for unwanted software.",
  "web.security.alert.untrusted":
    "The check of Psyche's security records failed. New devices, security settings and password approvals are blocked. Review your devices, then run psyched security reseal on the computer; it applies after 24 hours.",
  "web.security.alert.firstAdmin":
    "A command on this computer made {name} the first admin device. If that was not you, revoke it in Devices.",
  "web.security.alert.requested": "Asked for on this computer: {action} Applies on {when}.",
  "web.security.op.presenceReset":
    "stop requiring your password or a passkey for security changes until a new key is registered.",
  "web.security.needsApproval":
    "Approve the card with your password or a passkey, then press the button again.",
};
