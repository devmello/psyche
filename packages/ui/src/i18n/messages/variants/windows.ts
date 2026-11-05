import type { MessageId } from "../index.ts";

/**
 * Windows wording for messages whose English names a Mac ("This Mac", "Touch ID", "Finder", ⌘
 * shortcuts). `t()` uses these on Windows (`lib/platform.ts`), so screens keep one id and never
 * branch on the platform for copy. Rules (docs/guides/translating.md applies):
 * - the same placeholders as the English message and the same meaning: a variant only says it
 *   the way Windows does ("This PC", "Windows Hello", "File Explorer", "Ctrl+K");
 * - no variant for Mac-only features (Apple apps, Apple's on-device model): they are
 *   hidden on Windows or say "Available on macOS" (cross-platform-2026 §4.3). Mail, Calendar and
 *   Reminders are the exception: on Windows they are classic Outlook, and say so;
 * - a translation of a variant goes in `WINDOWS_LOCALES` (./index.ts); until then a translated
 *   catalogue shows the English variant rather than its Mac wording.
 */
export const windows: Partial<Record<MessageId, string>> = {
  "settings.trusted.title.reminders": "Your Outlook task lists",
  "settings.trusted.none.reminders": "No Outlook task lists yet.",
  "settings.trusted.loading": "Reading them from this PC…",
  "settings.trusted.noHelper": "Open Psyche on your PC to list them: the helper reads them.",
  "settings.trusted.failed": "Psyche couldn't read them from this PC.",
  "settings.links.description":
    "Where a link in a chat message, card or artifact opens. Ctrl+click always uses your default browser.",
  "errors.presence_required": "Confirm it's you with Windows Hello or a passkey first.",
  "chat.toolbar.keySheet": "Ctrl+Shift+A",
  "chat.toolbar.keyModel": "Ctrl+Shift+I",
  "chat.toolbar.keyView": "Ctrl+O",
  "chat.approval.keysHint": "Ctrl+Enter {allows} · Ctrl+D {denies}",
  "blocks.details.runsOnHost": "on your PC, outside the sandbox",
  "blocks.details.runsSandboxed":
    "on your PC, in the sandbox: it cannot read Psyche's vault, your SSH keys, Credential Manager or browser profiles",
  "blocks.details.runsNoSandbox": "on your PC, and the sandbox is not set up ({reason})",
  "blocks.permission.need.capability": "Turn on Run commands on this PC",
  "blocks.permission.need.macos_access": "Give {connector} access in Windows Settings",
  "blocks.permission.openSystemSettings": "Open Windows Settings",
  "blocks.approval.answerOnHost":
    "Answer on {host}, or set up Windows Hello for approvals on this computer in Settings → Devices.",
  "blocks.approval.needsAuth": "Needs Windows Hello or a passkey to approve.",
  "blocks.approval.touchIdFailed": "Windows Hello failed: {reason}. Try again.",
  "blocks.approval.touchIdFailedNoReason": "Windows Hello failed. Try again.",
  "blocks.approval.touchId.helperOffline":
    "The Windows helper isn't running, so Windows Hello can't confirm this here.",
  "blocks.approval.touchId.noKey":
    "Windows Hello isn't set up for approvals on this PC yet. Set it up in Settings → Devices, where you can check the key first.",
  "blocks.approval.touchId.invalidated":
    "Windows Hello changed since this PC's key was set up, so it can't confirm approvals. Set it up again in Settings → Devices.",
  "blocks.approval.touchId.noUnsandboxed":
    "Running a command without the sandbox can't be approved with Windows Hello from this window. Set up the sandbox instead",
  "blocks.approval.touchId.onceOnly": "Windows Hello approvals from this window are once only.",
  "blocks.approval.status.allowedOnceTouchId":
    "Allowed once (Windows Hello approvals from this window are once only)",
  "blocks.approval.touchId.keyUnavailable":
    "This build of the Windows helper can't keep a Windows Hello key, so cards that need Windows Hello can't be approved on this PC.",
  "blocks.approval.touchId.cancelled": "Windows Hello was cancelled, so nothing was approved",
  "settings.shared.needsPresence":
    "Changing “{label}” needs your approval with Windows Hello or a passkey. Approve it in Settings or in the Psyche notification, then change it again.",
  "settings.page.permissions.description":
    "What {persona} may do on this PC without asking, and where it always stops to ask you.",
  "settings.page.data.description":
    "What stays on this PC, how long it is kept, exports, backups and starting over.",
  "settings.essentials.model.noneHint":
    "{persona} needs a model before it can answer. Add a key, or use a model on this PC.",
  "settings.essentials.read.hint":
    "Off until you turn one on. What it reads is indexed on this PC so it can find things for you, and memory learns from it too unless you opt out under Memory → Sources.",
  "settings.searchModel.apple.notOnThisMac": "Available on macOS",
  // VM mode is the sandbox PC here: a small Linux guest in Hyper-V.
  "settings.nav.vm": "Sandbox PC",
  "settings.key.vm.enabled": "Use the sandbox PC for tasks",
  "settings.key.vm.resetPerTask": "Fresh PC for every task",
  "settings.vm.phase.installing": "Setting up the guest",
  "settings.vm.sandboxMac": "The sandbox PC",
  "settings.vm.description":
    "Run tasks in a separate sandbox PC, so {persona} works in its own small Linux computer instead of yours.",
  "settings.vm.between": "Between your PC and the guest",
  "settings.vm.credentialsHint":
    "With the host vault, values stay on your PC. A guest vault keeps its own copy.",
  "settings.vm.noReports":
    "No guest has reported yet. Turn on the sandbox PC above, then create it; its state shows here.",
  "settings.macHelper.paired.text":
    "Runs computer use, screen context, dictation, Windows Hello and notifications on this PC.",
  "settings.macHelper.unbundled.text": "This build of Psyche has no Windows helper.",
  "settings.key.appearance.showInDock": "Show in the taskbar when no windows are open",
  "settings.semanticSearch.encrypt.pending":
    "Waiting for the Windows helper to open the encrypted index",
  "settings.semanticSearch.rerankHint":
    "A small cloud model puts the best results first. The top 20 snippets leave this PC. Off by default.",
  "settings.credentials.backend.psyche": "Psyche vault (Windows Hello)",
  "settings.credentials.err.lockedChange":
    "The vault is locked. Unlock it with Windows Hello, then {verb, select, delete {delete} other {change}} {name} again.",
  "settings.credentials.err.lockedImport":
    "The vault is locked. Unlock it with Windows Hello, then import again.",
  "settings.credentials.slot.keychain": "Credential Manager (Windows Hello)",
  "settings.credentials.slot.safeStorage": "this PC's app storage (Windows data protection)",
  "settings.credentials.slot.keyFile": "a key file on this PC",
  "settings.credentials.moveToKeychain": "Move behind Windows Hello",
  "settings.credentials.moveToKeychainNeeds":
    "Needs a signed Windows helper and Windows Hello set up on this PC",
  "settings.credentials.backend.keychain": "Credential Manager",
  "settings.credentials.backendIn.keychain": "in Credential Manager",
  "settings.permissions.never.browserPasswords":
    "Read passwords saved in your browsers or Credential Manager",
  "settings.skills.signer.originAgent":
    "Written by an assistant on the sender's computer. Read it as unreviewed text, whoever signed it.",
  "web.viewers.noSandbox":
    "Previews of slides need the sandbox, and no container runtime (Docker or Podman) is available.",
  "voice.settings.reviewHint":
    "Keeps what Psyche heard in the pop-up so you can fix it and press Enter. Off, it's sent when you let go of the key.",
  "settings.files.pathPlaceholder": "C:\\Users\\you\\Documents\\Taxes",
  "settings.skills.pathPlaceholder": "C:\\Users\\you\\Downloads\\pdf-merge",
  "settings.mail.notes.folder.placeholder": "C:\\Users\\you\\Documents\\Recordings",
  "work.anchors.pathPlaceholder": "C:\\Users\\you\\School\\MATH21",
  "settings.credentials.keyFileExplainer":
    "The key that opens your vault is a file only your account can read. Moving it behind Windows Hello needs a signed Windows helper; this build's helper is not signed.",
  "settings.credentials.link.err.locked":
    "The vault is locked. Unlock it with Windows Hello, then link {name} again.",
  "settings.approval.presenceUnavailable":
    "This window can't confirm it's you. Approve the change in the Psyche app on your PC (Windows Hello), or from a device with a passkey. Nothing changes until then.",
  "settings.approval.promptDetail":
    "Security settings need Windows Hello or a passkey. Approve it here or in the Psyche notification; the setting is saved as soon as it is approved.",
  "settings.approval.presenceInvalid":
    "Windows Hello or the passkey didn't confirm it's you. Try again.",
  "settings.about.revealHome": "Show in File Explorer",
  "settings.appearance.showInDockHint":
    "Off, Psyche keeps running in the notification area when its last window closes.",
  "settings.appearance.openAtLoginHint":
    "Starts Psyche in the notification area when you sign in to Windows, so scheduled automations can always run.",
  "settings.browser.letTasksUseHint":
    "Each task still asks you first, on this device with Windows Hello or a passkey.",
  "settings.browser.detailsText":
    "While a task uses it, Psyche runs Google Chrome with this profile and a DevTools port on this PC's loopback (127.0.0.1), and closes it when the task is done. {persona} is not attached while you have the profile open yourself.",
  "settings.browser.openFromMac":
    "Open it from the Psyche app on the computer that runs the Gateway.",
  "settings.channels.empty":
    "No channels yet. Connect Telegram or Slack to reach {persona} away from this PC.",
  "settings.computerUse.description": "{persona} can use apps on this PC only where you allow it.",
  "settings.computerUse.macPermissions": "Windows access",
  "settings.computerUse.openSystemSettingsFor": "Open Windows Settings for {name}",
  "settings.computerUse.openSystemSettings": "Open Settings",
  "settings.mcp.sandboxHelp":
    "Command servers run in the sandbox PC: turn it on in Settings → Sandbox PC.",
  "settings.mcp.kind.commandHint":
    "A program run in the sandbox PC, a small Linux computer with no access to your files.",
  "settings.mcp.kind.commandUnavailable":
    "Command servers run in the sandbox PC, which isn't on: turn it on in Settings → Sandbox PC. URL servers can be added now.",
  "settings.sandbox.why":
    "Scripts and command servers run away from your files, your vault, your keys and Psyche's private data.",
  "settings.sandbox.whyHow":
    "On Windows that's the sandbox PC, a small Linux computer of its own in Hyper-V. A container runtime (Docker Desktop or Podman) is optional, for code the agent runs.",
  "settings.sandbox.checking": "Looking at this PC…",
  "settings.sandbox.containers.body":
    "A container runtime runs code in its own Linux machine with no access to your PC's files: for code the agent runs and some file conversions. Command servers and scripts run in the sandbox PC unless the Gateway is set to use containers.",
  "settings.sandbox.missing.docker":
    "Docker Desktop (on WSL 2) is the point-and-click choice; Podman works too.",
  "settings.sandbox.stopped.docker": "Open Docker Desktop, then check again.",
  "settings.sandbox.without":
    "Without the sandbox PC, Psyche can still use URL servers and your connectors, but it can't run scripts or local MCP command servers.",
  "blocks.permission.need.sandbox": "Turn on the sandbox PC",
  "blocks.execHost.noHostSandbox":
    "Windows has no sandbox for commands on this PC, so this command can only run without one. Type {word} to run it this once.",
  "blocks.details.runsNoHostSandbox":
    "on your PC, without a sandbox: Windows has none for commands on the PC itself",
  "settings.searchSources.description":
    "What Psyche reads into your search index. All off until you switch them on; the index stays on this PC. Turning a source on also lets memory learn from it, unless you opt out on Memory → Sources (Memory and Contacts are the exceptions: neither is learned from).",
  // Windows reads Mail, Calendar, Reminders and Contacts from classic Outlook (through the Windows
  // helper) when it is there, else from Microsoft 365, Google and Microsoft To Do. No Notes or
  // Messages row is shown on Windows.
  "settings.searchSources.hint.mail":
    "Subject, sender, recipients, date and the text of your mail in Outlook, Microsoft 365 or Gmail. Quoted replies are skipped.",
  "settings.searchSources.hint.reminders":
    "Tasks in Outlook or Microsoft To Do, with their lists, due dates and notes.",
  "settings.searchSources.hint.contacts":
    "Your contacts in classic Outlook: name, nickname, company, job title, emails, phone numbers, the city and country of each address, and birthday. Street addresses, notes and groups are never read. The agent can't search it until you allow it, and that switch covers only this index: what Memory has learned about people, and their pages with emails or numbers, follow Memory's own agent access.",
  "settings.searchSources.runOnBatteryHint":
    "Lets indexing, Rebuild and reading text in images carry on while your PC runs on battery, at a gentler pace. It uses more battery. Energy saver still pauses indexing.",
  "settings.searchSources.ocrHint":
    "Reads screenshots and scanned PDFs, one page at a time, on power (or on battery with Index on battery on). Nothing leaves your PC.",
  "settings.semanticSearch.description":
    "Find things by meaning as well as by their words, all on this PC.",
  "settings.semanticSearch.engine.builtinHint":
    "Multilingual E5 small, about 100 languages, runs on this PC's processor.",
  "settings.semanticSearch.engine.routerHint":
    "Uses the embedding model set in Roles, for example Ollama or LM Studio on this PC.",
  "settings.semanticSearch.allowCloudHint":
    "Only if the embedding model is a cloud service. Your chats, tasks and Library text are sent to it. Off keeps everything on this PC.",
  "settings.semanticSearch.state.cloudBlocked":
    "The embedding model in Roles is a cloud service. Semantic search only uses models on this PC.",
  "settings.data.encryptMemory.pending": "Waiting for the key from the Windows helper.",
  "settings.devices.touchId.none":
    "No Windows Hello key yet. Cards that need Windows Hello can't be approved until one is registered.",
  "settings.devices.touchId.noBundledKey":
    "The Windows helper in this app has no Windows Hello key ({reason}).",
  "settings.devices.touchId.manualHint":
    "Run psyche-win-helper --print-identity on the PC and paste the presenceKeyId it prints.",
  "settings.devices.noNodes":
    "No nodes. The Windows helper appears here once Psyche runs on this PC.",
  "settings.files.execHost": "Run commands on this PC",
  "settings.files.execHostSwitch": "Allow commands on this PC",
  "settings.model.ram.tooSmall":
    "This PC has {gb, number} GB. Local models need at least {min, number} GB; use a cloud provider instead.",
  "settings.model.ram.fits": "This PC has {gb, number} GB, so {fits} fit.",
  "settings.model.ram.thisMac": " (this PC)",
  "settings.model.localHint": "Run models on this PC with Ollama or LM Studio.",
  "settings.server.bindHint":
    "127.0.0.1 keeps it on this PC. Use remote access below instead of binding to every interface.",
  "settings.gateways.description":
    "Use Psyche from this computer with the Gateway on another one, such as your computer at home. One Gateway is active at a time, and switching restarts Psyche.",
  "settings.gateways.thisMac": "This PC",
  "settings.gateways.switchKeep":
    "Psyche restarts on {name}. Psyche on this PC keeps running, so its automations continue.",
  "settings.gateways.switchAndStop": "Switch and stop Psyche on this PC",
  "settings.gateways.addHint":
    "Paste the pairing link from the computer that runs Psyche (Settings, Server & remote access, Pair another computer). Without a link, type its Tailscale address, https://<host>.<tailnet>.ts.net; this computer then asks to pair, and the owner approves it there.",
  "settings.gateways.problem.link_malformed":
    "That pairing link is damaged. Copy it again from the computer that made it.",
  "settings.gateways.problem.link_bad_field":
    "That pairing link is damaged. Copy it again from the computer that made it.",
  "settings.gateways.problem.link_lan":
    "This pairing link is for a computer on your local network but doesn't carry its certificate, so it isn't used. On that computer, make a new one: Pair another computer, From this network.",
  "settings.remote.description":
    "Let Psyche on another computer use this PC's Gateway over Tailscale. The Gateway stays on this PC and listens only to it, and Tailscale Serve is the only way in.",
  "settings.remote.step1":
    "Install Tailscale on this PC and on the other computer, and sign both in to the same tailnet.",
  "settings.remote.step2":
    "In Windows Terminal or PowerShell on this PC, publish the Gateway to your tailnet. This is Serve, not Funnel.",
  "settings.remote.step4":
    "Restart Psyche. Then on the other computer, add this PC as a Gateway. It shows a pairing code and a key fingerprint: compare them with the request under Waiting to pair here, then approve it.",
  "settings.remote.admin":
    "A computer that pairs gets read, write and approvals. Admin stays off unless you tick it when you approve, and each admin change still needs your Windows Hello here.",
  "settings.pair.needsAddress":
    "Set this PC's public address first (step 3 above), then make a pairing link.",
  "settings.pair.adminHint":
    "Admin lets it change security settings, devices and the vault, and stays off unless you tick it. Each admin change still needs your Windows Hello here.",
  "settings.pair.compare":
    "It checks this PC's key before it uses the link: {fingerprint}. You can compare.",
  "settings.pair.secret":
    "Anyone who has this link in the next ten minutes can pair one computer. Don't post it or send it to anyone you wouldn't trust with this PC.",
  "settings.pair.err.noAddress":
    "This PC has no public address yet, so there is nothing to put in a link.",
  "settings.pair.viaAddress": "Over Tailscale, at this PC's address",
  "settings.pair.viaLanHint":
    "A link for this network holds this PC's key and certificate, so it works only for computers on the same Wi-Fi or Ethernet.",
  "settings.pair.lanNote":
    "This link is for computers on the same network as this PC. It names the key and certificate Psyche will insist on.",
  "settings.lan.description":
    "Let Psyche on another computer on the same Wi-Fi or Ethernet reach this PC's Gateway, without Tailscale. It is off until you turn it on.",
  "settings.lan.toggleHint":
    "Psyche listens on one network, over an encrypted connection with its own certificate. A computer that connects still has to be approved here with Windows Hello.",
  "settings.lan.noInterface": "No Wi-Fi or Ethernet connection was found on this PC.",
  "settings.lan.notAdvertised": "Not shown. Add this PC by its address.",
  "settings.lan.problem.unknownInterface": "{name} is not a network on this PC.",
  "settings.lan.problem.advertise":
    "Psyche couldn't announce itself on the network. Computers can still add this PC by its address.",
  "settings.server.noVm":
    "No VM. The sandbox PC runs Psyche inside a separate Linux guest; turn it on in Settings → Sandbox PC.",
  "settings.shortcut.key.Alt": "Alt",
  "settings.skills.permission.exec_host": "Run commands on this PC",
  "settings.skills.permission.computer_action": "Use apps on this PC",
  "settings.skills.export.hint":
    "The file is signed with your author key, so people who get it can tell it is yours and that it was not changed. The key stays on this PC.",
  "settings.voice.key.rightOption": "Right Alt",
  "settings.voice.reply.gatewayHint": "The voice set for the persona, or the system voice.",
  "settings.voice.engine.local": "On this PC",
  "settings.voice.engine.localHint": "Whisper runs locally; audio never leaves the PC.",
  "settings.voice.engine.system": "Windows speech",
  "settings.voice.model.usingHelper":
    "Dictation uses Windows speech recognition (SAPI), which often mishears names and short phrases. The speech model transcribes much better and runs on this PC.",
  "settings.voice.model.downloadHint":
    "A one-time download from the whisper.cpp project, checked before it is used. Audio never leaves this PC.",
  "settings.voice.model.ready": "Whisper ({model}) on this PC",
  "settings.voice.model.readyHint":
    "Dictation and recordings are transcribed here; audio never leaves the PC.",
  "settings.voice.model.crashed":
    "The speech engine stopped unexpectedly; dictation uses Windows speech recognition until it starts again.",
  "settings.connect.finishOpened":
    "The sign-in to {name} opened in your browser on the Gateway's computer. This updates when you're done.",
  "settings.connect.openSystemSettings": "Open Windows Settings",
  // Mail, Calendar and Reminders on Windows are classic Outlook, served by the Windows helper
  // under the same connector types (apps/win-helper `src/outlook/`).
  "settings.connect.needsPermission":
    "{name} is set up, but Outlook is blocking other programs right now. Turn on Windows Security or update your antivirus, or change it in",
  "settings.connectors.catalog.appleMail": "Outlook Mail",
  "settings.connectors.catalog.appleCalendar": "Outlook Calendar",
  "settings.connectors.catalog.appleReminders": "Outlook Tasks",
  "gallery.builtin.appleMail": "Read and draft mail in classic Outlook.",
  "gallery.builtin.appleCalendar": "See your Outlook calendar and add events.",
  "gallery.builtin.appleReminders": "See and create tasks in Outlook.",
  "settings.people.description":
    "The cards {persona} keeps for the people and projects in your life. They stay on this PC, and every fact shows where it came from.",
  "settings.about.versionsHint": "What is running on this PC.",
  "settings.computerUse.macPermissionsHint": "What Windows allows.",
  "settings.deviceAccess.files.title": "Files on this PC",
  "settings.deviceAccess.terminal.hint":
    "{persona} can run terminal commands on this PC when Run commands on this PC is on in Permissions → Access.",
  "settings.deviceAccess.terminal.where":
    "Commands run on your PC, in the folders you shared, and can write only to a folder you shared read and write.",
  "settings.mcp.needs.title": "What this needs on your PC",
  "settings.mcp.needs.node.fix":
    "Runs on Psyche's own Node; needs npm on this PC. Install Node.js from nodejs.org, or run winget install OpenJS.NodeJS.LTS.",
  "settings.mcp.needs.uv.fix":
    "A Python server. Install uv with winget install astral-sh.uv or from docs.astral.sh/uv.",
  "settings.mcp.fail.node_missing":
    "Install Node.js (nodejs.org, or winget install OpenJS.NodeJS.LTS) so npm is on this PC, then check again.",
  "settings.mcp.fail.uv_missing":
    "Install uv (winget install astral-sh.uv, or docs.astral.sh/uv), then check the server again.",
  "settings.mail.voice.learn.hint":
    "Wren reads only what you wrote in sent mail, without quoted text or signatures. The profile stays on this PC in mail/VOICE.md.",
  "settings.mail.voice.localModel.hint": "Drafts in your voice never leave this PC.",
  "settings.mail.transcribe.endpoint.hint":
    "Optional. An OpenAI-compatible /v1/audio/transcriptions server (for example whisper.cpp on this PC). Used when the Windows helper has no speech engine. Audio goes only to this address: https, or http on 127.0.0.1.",
  "onboarding.mail.voiceHint":
    "Reads only what you wrote, without quoted text or signatures. It stays on this PC and you can view, edit or reset it.",
  "gallery.preset.git.field.repo.help":
    "The folder of a Git repository on this PC. Psyche can read its history and diffs.",
  "settings.connectors.page.onThisMac": "On this PC",
  "settings.connectors.page.row.local": "Runs on this PC",
  "settings.connectors.page.server.local": "A tool that runs in a sandbox on this PC",
  "onboarding.permission.denied": "Off in Windows Settings",
  "onboarding.permission.deniedHint":
    "Turn it on in Settings → System → Notifications; this page updates when you come back.",
  "onboarding.permission.unavailableHint":
    "Psyche can ask for this only in the Psyche desktop app.",
  "onboarding.connectors.onThisMac": "On this PC",
  "onboarding.connectors.onThisMacHint":
    "Each app asks Windows for permission as it connects, one at a time.",
  "onboarding.model.kind.localHint": "Runs on this PC; nothing leaves it.",
  "onboarding.model.subscriptionNote":
    "Psyche uses the Claude Code or Codex app already signed in on this PC, so it needs no API key and stores none. Sign in there first if you haven't.",
  "onboarding.safety.touchId": "Windows Hello for approvals",
  "onboarding.safety.touchId.checking": "Looking at the Windows helper…",
  "onboarding.safety.touchId.starting":
    "The Windows helper is still starting. Check again in a moment.",
  "onboarding.safety.touchId.noKey": "The Windows helper has no Windows Hello key ({reason}).",
  "onboarding.safety.touchId.hint":
    "Register the Windows helper’s key once, so Windows Hello can confirm approvals.",
  "onboarding.safety.asks":
    "If you let {name} run commands on this PC, ones that only read, like ls or cat, run without a card. Anything else asks you first.",
  "onboarding.done.touchId": "Windows Hello",
  "onboarding.done.try.search":
    "Ask a question in Search (Ctrl+K). The answer shows where in your life it came from.",
  "screens.search.source.revealFile": "Show in File Explorer",
  "everything.model.localHint":
    "A model on this PC reads everything. Nothing leaves the PC. Fewer, noisier facts.",
  "everything.run.reason.battery":
    "Not now: the PC is on battery. Plug it in, or allow battery runs.",
  "everything.run.reason.thermal": "Not now: the PC is too warm.",
  "everything.run.reason.not_idle": "Not now: you are using the PC.",
  "everything.storage.note": "Everything is stored on this PC only.",
  "memoryWork.consent.k1": "Nothing leaves this PC. Dates and status are worked out by code.",
  "screens.library.reveal": "Show in File Explorer",
  "web.zoom.description":
    "How large the app renders on this PC. Ctrl+Plus and Ctrl+Minus change the same setting, so it survives a restart; {min, number}–{max, number} %.",
  "web.transcriptMode.optionTitle": "{mode} (Ctrl+O cycles)",
  "web.backups.restore": "Restore on a new PC with the Gateway stopped:",
  "web.passkeys.firstApproval":
    "Approve “Add a passkey” with Windows Hello on your PC or with a passkey on another device, then press Add again.",
  "web.passkeys.added":
    "Added {name}. It now approves changes that need Windows Hello or a passkey.",
  "web.remotePresence.title": "Windows Hello for approvals",
  "web.remotePresence.description":
    "Purchases, credential fills, host commands and security changes need Windows Hello or a passkey. Set it up on this computer to answer them here; until then those cards say to answer on {host}. Ordinary approvals never need it.",
  "web.remotePresence.on": "Windows Hello is on for approvals from this computer.",
  "web.remotePresence.off": "Windows Hello isn't set up on this computer.",
  "web.remotePresence.enable": "Use Windows Hello for approvals on this computer",
  "web.remotePresence.waiting": "Waiting for Windows Hello…",
  "web.remotePresence.passkeyName": "Windows Hello on this computer",
  "web.remotePresence.enabled": "Windows Hello is on for approvals from this computer.",
  "web.remotePresence.disabled": "Windows Hello for approvals is off on this computer.",
  "web.remotePresence.approveOnHost":
    "Approve “Add a passkey” on {host}, with its Touch ID, Windows Hello or a passkey, then press the button again.",
  "web.remotePresence.unavailable":
    "Windows Hello needs {host}'s Gateway at an https:// address (gateway.publicOrigin). Until then, answer those cards on {host}.",
  "web.webauthn.noPasskeyYet":
    "This browser has no passkey yet. Add one in Settings → Devices, or approve on the computer that runs the Gateway.",
  "web.webauthn.needsOrigin":
    "Passkeys need the server's https address (gateway.publicOrigin). Approve on the computer that runs the Gateway instead.",
  "web.setup.gatewayOk": "Running on this PC.",
  "web.setup.adminOk": "This PC is the admin device.",
  "web.voice.noEngine":
    "No speech engine is available. Install a speech model in Settings → Voice, or connect the Windows helper.",
  "web.threads.newSideChatTitle": "New side chat (Ctrl+N)",
  "web.panes.closePaneTitle": "Close pane (Ctrl+\\)",
  "web.chat.permissionModeTitle": "Permission mode (Ctrl+Shift+M)",
  "web.chat.modelTitle": "Model (Ctrl+Shift+I)",
  "web.splash.installing": "Setting up Psyche on this PC…",
  "web.splash.helper": "Getting Psyche ready on your PC…",
  "web.splash.remote.useThisMac": "Use This PC",
  "web.remote.thisMac": "This PC",
  "web.teach.bar.body":
    "Psyche is noting your clicks and typing in this tab only. Passwords, card numbers and codes are never recorded, and nothing leaves this PC until you save.",
  "settings.teach.storage.description":
    "When you ask Psyche to keep a recording so you can make another version, the steps are saved on this PC.",
  "settings.teach.storage.encrypted":
    "Encrypted. The file is locked with a key Windows keeps for your account, so it cannot be read outside Psyche. It expires after 90 days.",
  "settings.teach.storage.unavailable":
    "Recordings are not kept. Windows data protection is not available, and Psyche will not save a recording as plain text. You can still save a recording as a skill.",
  "web.teach.review.keepUnavailable":
    "Not available: Windows data protection is not available to encrypt a kept recording.",
  "web.teach.review.keepRecording": "Keep this recording on this PC so I can make another version",
  "voice.key.rightOption": "Right Alt",
  "voice.key.rightCommand": "Right Ctrl",
  "meetingRecord.unavailable":
    "Recording needs a way to turn audio into notes (a speech model or the Windows helper), and none is connected.",
  "meetingRecord.micDenied":
    "Psyche can't use the microphone. Allow it in Settings → Privacy & security → Microphone.",
  "settings.shortcut.key.Control": "Ctrl",
  "settings.voice.key.rightCommand": "Right Ctrl",
  "settings.voice.engine.systemHint": "Windows' on-device recognizer, through the Windows helper.",
  "onboarding.safety.touchId.setHint":
    "Approvals that need you ask for your face, fingerprint or PIN.",
  "shell.shortcut.pushToTalkKeys": "Hold Right Ctrl",
  "platform.term.os": "Windows",
  "platform.term.device": "PC",
  "platform.term.thisDevice": "This PC",
  "platform.term.thisDeviceLower": "this PC",
  "platform.term.presence": "Windows Hello",
  "platform.term.secretStore": "Credential Manager",
  "platform.term.systemSettings": "Settings",
  "platform.term.fileManager": "File Explorer",
  "settings.connectorBundle.sandbox.none":
    "This PC has no sandbox for command connectors, and Psyche never runs one outside it. This connector cannot be installed here. Nothing was started or saved.",
  "settings.connectorBundle.share.unavailable":
    "Only Psyche on the PC that runs it can sign a connector.",
  "platform.term.trayArea": "notification area",
  "platform.term.taskbar": "taskbar",
  "platform.term.systemSearch": "Windows Search",
  "platform.term.helper": "Windows helper",
  "platform.term.terminal": "Windows Terminal",
  "platform.term.alt": "Alt",
  "platform.term.mod": "Ctrl",
};
