# Cross-platform readiness audit (macOS + Windows)

Status: proposal (docs only), 2026-10-26, revised after the owner's decision. Nothing here changes code.

Scope decisions (owner):
- **Desktop app targets macOS and, eventually, Windows. No Linux desktop support.**
- The **Gateway may still run on Linux** in Docker or headless as a *server deployment* (today's `deploy/Dockerfile`, `docker-compose.yml`, `deploy/systemd`, CLI). That is not desktop support and gets no desktop work.
- **No text-to-speech.** Voice is speech-to-text into the pop-up chat window with text answers. `speech.synthesize`, `SpeechSynthesis.swift`, `speech.readAloud.*` and `voice.conversation.speech` appear below only as inventory of code being deleted.

Method: grep-based inventory by cheap subagents, then synthesis. Swift framework usage is inferred from imports and symbol names, not compiled. Line numbers drift; re-grep before acting.

## 1. Summary

- The **gateway, web UI, protocol, memory, search, non-Apple connectors, browser, Docker/Podman sandbox and `apps/node`** are already portable Node/TS. There are no darwin-only npm dependencies (no keytar, fsevents, node-mac-*).
- macOS-specific code is concentrated in **`apps/mac-helper`** (Swift) and the **desktop main process** (supervisor, updater, signing, tray, window chrome).
- Windows has essentially nothing today: no installer maker, no supervisor, no updater, no node installer, no CI, and `DevicePlatform` has no `windows` value.
- The structural gap: the helper is the *only* provider of native capabilities, and gateway/desktop code calls it (or checks `darwin`) directly in several places. A "platform node" interface (section 4) fixes that and keeps a second platform cheap.

## 2. Inventory of macOS-only dependencies

### 2.1 `apps/mac-helper` (Swift 6, SwiftPM, macOS 15+)

Targets: `PsycheProtocol`, `PsycheHelperCore` (pure logic), `PsycheHelperSystem` (live Apple adapters), `PsycheHelper` executable (`Sources/PsycheHelper/main.swift`, NSApplication run loop). Capabilities register in `System/HelperRuntime.swift` into a `CapabilityRegistry`; each `CapabilitySpec` (`Core/Node/Capability.swift`) carries name, side effect, target kind, input schema, TCC permissions and receipt kind.

| Area | Files (under `Sources/PsycheHelperSystem/` unless noted) | Apple API | Capabilities |
|---|---|---|---|
| Accessibility (AX) | `Computer/AXEngine.swift`, `LiveAX.swift`, `AttentionMonitor.swift`; `Core/Computer/AXSnapshot.swift`, `KeyChord.swift` (portable shape) | AXUIElement | `computer.ax_tree/ax_value/press/select/set_value/menu` |
| Input synthesis | `Computer/Input.swift` | CGEvent (+ Esc stop tap) | `computer.click/type/key/scroll/drag` |
| Screen capture | `Computer/Screenshots.swift`, `ScreenAskCapabilities.swift`; `Core/Screenshot/*` | CoreGraphics / ScreenCaptureKit | `computer.screenshot`, `screen.context` |
| Teach mode | `Teach/TeachRecorder.swift`, `TeachCapabilities.swift` | Carbon, CGEvent, ScreenCaptureKit | `teach.*` |
| Key watching / dictation | `Dictation/DictationCapabilities.swift` | CGEvent tap (fn / Right-Option / Right-Cmd hold-to-talk), AX insert | `dictation.watch/insert/target` |
| Speech-to-text | `Speech/SFSpeechEngine.swift`, `SpeechAnalyzerEngine.swift` (macOS 26+), `SpeechTranscription.swift`, `SpeechAudio*.swift`, `LongFormTranscription.swift` | Speech, AVAudioEngine | `speech.transcribe_stream/transcribe_file/audio_push/prepare` |
| TTS (being removed) | `Speech/SpeechSynthesis.swift` | AVSpeechSynthesizer | `speech.synthesize/voices/personal_voice.*` |
| Keychain / Touch ID | `Keychain/KeychainVault.swift`, `KeychainBackend.swift`, `KeychainDeviceIdentityStore.swift`; `Core/Keychain/*` | SecItem, LocalAuthentication | `keychain.*`, `vault.unlock` |
| Presence key | `Notifications/PresenceKey.swift` | Secure Enclave | `presence.public_key` |
| Notifications | `Notifications/NotificationCenterBridge.swift` | UserNotifications | `notify.*` |
| Contacts | `Contacts/ContactsCapabilities.swift`, `AppleApps/ContactsStoreBackend.swift` | Contacts | `contacts.*` |
| Calendar / Reminders | `AppleApps/CalendarWatch.swift`, `AppleAppBackends.swift` | EventKit | `calendar.*`, `reminders.*` |
| Notes / Mail / Things / Music / Safari / Chrome | `AppleApps/*Backend*.swift`; `Core/AppleApps/*Wave1.swift` (pure) | Apple Events / OSAKit / osascript | `notes.* mail.* things.* music.* safari.* chrome.*` |
| Shortcuts | `AppleApps/ShortcutsBackend.swift` | `/usr/bin/shortcuts` | `shortcuts.*` |
| AppleScript / JXA | `Apps/AppsCapabilities.swift`, `DisclaimedProcess.swift`; `Core/Apps/ScriptGuard.swift` | `/usr/bin/osascript` | `apps.*` |
| Messages | `Messages/MessagesCapabilities.swift`; `Core/Messages/ChatDatabase.swift`, `SQLiteReader.swift`, `TypedStream.swift` | reads `~/Library/Messages/chat.db` | `messages.*` |
| Files / Finder | `AppleApps/FilesCapabilities.swift` | FileManager, NSWorkspace | `files.trash/move/rename/recent`, `finder.*` |
| Permissions | `Permissions/Permissions.swift`, `PermissionProbe.swift`, `BundleIdentity.swift`, `HostAttribution.swift`; `Core/Permissions/TCCAttribution.swift` | TCC, SecCode | `permissions.*` |
| VM | `VM/VZBackend.swift`, `VMLive.swift`, `VMManager.swift`, `VMImages.swift`, `GuestSide.swift`, `VMSnapshots.swift` | Virtualization.framework, hdiutil, diskutil, codesign, dscl | `vm.*` (~25) |
| Transport | `Core/UnixSocket.swift` | Darwin sockets | n/a |
| Packaging | `Support/Info.plist`, `PsycheHelper.entitlements`, `com.psyche.helper.plist`; `scripts/build-app.sh`, `install-agent.sh`, `tcc-reset.sh` | codesign, plutil, launchctl, tccutil | n/a |

Rough split: ~50 capability names are Apple-app automation with no Windows analogue (3.2); ~25 are OS primitives (AX, input, capture, STT, secrets, notifications, permissions) that have Windows analogues.

### 2.2 Packaging, deploy, signing

- `deploy/macos/`: `build-local.sh`, `build-helper.sh`, `make-dmg.sh` (hdiutil, codesign, notarytool, stapler), `install-local.sh`, `build-guest-image.sh`, icon scripts (iconutil).
- `deploy/launchd/com.psyche.gateway.plist` (LaunchAgent), `deploy/homebrew/psyche.rb.tmpl` (cask) and `psyche-cli.rb.tmpl`.
- Signing: `apps/desktop/entitlements.plist`, `apps/desktop/docs/signing.md`, `apps/desktop/src/packaging/signing-config.ts` (Developer ID + `APPLE_*` notarization env), helper entitlements.
- **Server-side (unchanged, not desktop):** `deploy/systemd/psyche-gateway.service`, `deploy/Dockerfile`, `deploy/docker-compose.yml`, CLI tarballs, `apps/node/scripts/install-linux.sh`.
- **Nothing Windows.** No `.exe`/MSI/Squirrel.Windows, no Task Scheduler/service, no `install-windows.ps1`.
- CI: `desktop.yml` runs only on `macos-26`; `ci.yml` has ubuntu + macos-26.

### 2.3 Electron main process (`apps/desktop`, Electron Forge 8)

- `forge.config.ts` (:37, 101, 108, 112, 120): mac host detection, ad-hoc signing, `MakerZIP` for darwin/linux, `packageAfterPrune` early-returns unless darwin, nested helper verification, Info.plist usage strings.
- `src/main/windows.ts:179`: inset title bar + traffic lights on darwin, native otherwise (already branched). Quick-entry window (~:205) is portable.
- `src/main.ts`: `app.dock` (:731, 1006), `window-all-closed` keeps app alive on darwin (:1054), `bundledHelperPath` requires darwin (:366), glass mode (:754), menu-bar `PsycheTray` (:978, `src/main/tray.ts`).
- `src/main/glass.ts`: `electron-liquid-glass` (optional, undeclared), `/usr/sbin/screencapture`.
- `src/main/updater.ts:47`: darwin-only; Squirrel.Mac via `autoUpdater`; `/usr/bin/codesign -dvv`. `update-manifest.ts` models only a `darwin` zip artifact.
- `src/main/supervisor.ts` (:166–491): `launchctl`, `xattr -dr com.apple.quarantine`, `~/Library/LaunchAgents`. No Windows branch.
- `src/main/helper-launcher.ts:126` (codesign), `browser/downloads.ts:127` (quarantine xattr), `permissions/permissions.ts:54` (`mac = darwin`), `lib/real-chrome.ts:29` (`open -n -a "Google Chrome"`; returns null on Windows), `packaging/bundle-resources.ts` (Mach-O, codesign), `lib/device-key.ts:91` (darwin→macos else linux; no win32).

### 2.4 Other `process.platform` / darwin checks

- `apps/cli`: `snapshot.ts`, `doctor.ts`, `context.ts`, `audit.ts`, `supervisor.ts:160` (darwin→launchd, else systemd; Windows would fall into systemd incorrectly).
- `apps/node`: `runtime.ts:64,89` (helper auto-enabled on darwin; platform macos/linux only), `transports/vsock.ts`, `identity.ts:76` (the only win32 awareness), `capabilities/health.ts:42`.
- `apps/gateway`: `compose/parts.ts:187` (`open` for OAuth consent URLs on darwin), `socket-path.ts` (Unix socket length; a Windows desktop-hosted gateway needs named pipes or authenticated loopback).
- `packages/sandbox/src/detect.ts` (:20–45, 83, 123, 137): prefers Apple `container` on darwin, `sw_vers`, Docker.app paths.
- `packages/ui`: `shortcuts.ts`, `SearchSurface.tsx` (Cmd vs Ctrl, already handled); `OnboardingSteps.tsx:335` ("apple:" group is "On this Mac").
- Protocol: `DevicePlatform = macos | ios | android | web | linux` (`schemas/identity.ts:13`), **no `windows`**. `sandbox` backend enum has `apple-container`. `vm.*`, `dictation.*`, `screen.*`, `presence.*` are Apple-shaped.

## 3. Feature by feature (macOS vs Windows)

Legend: **P** portable today, **M** mac-only today, **Part** partly portable.

### 3.1 Table

| Feature | Today | Windows equivalent | Gap |
|---|---|---|---|
| Chat | **P**. Web UI over WebSocket (`apps/web`, `packages/ui`); desktop hosts the same UI. | none needed | Window chrome polish only. |
| Gateway / daemon | **Part**. Node 24 everywhere; desktop supervisor is launchd-only. | Task Scheduler "at logon" task (or a per-user service wrapper), supervised by the desktop app. Server deployments keep Docker/systemd. | `supervisor.ts` needs an interface and a Windows implementation. |
| Non-Apple connectors (Google, Microsoft, IMAP/JMAP, web search/fetch, MCP presets, OAuth PKCE loopback) | **P**. | none needed | OAuth consent open uses `open` on darwin (`parts.ts:187`); use Electron `shell.openExternal`. |
| Apple connectors (Notes, Reminders, Calendar, Mail, Messages, Things, Music, Shortcuts, Safari) | **M**, thin adapters over helper (`packages/connectors/src/apple/connector.ts`). | No analogue for Notes/Messages/Things/Shortcuts/Music. Calendar/Mail/Contacts: use the portable Google/Microsoft/IMAP connectors (already exist). Outlook COM is a later option. | Accept as mac-only; hide when no node advertises them. |
| Voice dictation (STT) | **Part**. Engine order `mac-node → whisper → web-speech` (`packages/speech/src/policy.ts:36`). whisper.cpp on the gateway host and browser Web Speech are portable. | whisper-compatible endpoint (local whisper.cpp / faster-whisper / any OpenAI-compatible `/v1/audio/transcriptions`); optional WinRT speech engine. | System-wide hold-to-talk key watch is M (CGEvent tap); Windows uses a low-level keyboard hook (`WH_KEYBOARD_LL`). Toggle hotkey via `globalShortcut` and mic capture in the renderer are P. |
| Pop-up chat window (quick entry) | **P**. Frameless always-on-top 640x160 BaseWindow, `Alt+Space` / `Ctrl+Alt+Space` via `globalShortcut` (`main.ts:1001`, `windows.ts:205`). | Same. `Alt+Space` opens the Windows system menu, so the Windows default must differ (e.g. `Ctrl+Alt+Space`); let users rebind. | Per-OS default shortcut; focus/blur behavior check. |
| Ask about my screen | **M**. Capture + AX via helper (`Screenshots.swift`, `ScreenAskCapabilities.swift`); orchestration in `apps/gateway/src/compose/screen-ask.ts`, panel in `apps/desktop/src/main/screen-ask/panel.ts`. | Capture: Electron `desktopCapturer` (or Windows.Graphics.Capture). Context: UI Automation (UIA) tree of the foreground window. Floor: screenshot-only + vision model. | Capture can move to Electron now; UIA needs a Windows provider. |
| Computer use | **M**. Gateway driver `compose/computer.ts` → helper `computer.*` (CGEvent input, AX, tier enforcement, secure-field handling). | UIA patterns + `SendInput`. Note UIPI: cannot drive elevated windows unless the helper is elevated or has `uiAccess`. | Biggest gap; highest cost; phase last. |
| Browser | **P**. CDP via desktop bridge, Playwright driver, real-Chrome launcher, Docker sidecar. | Same. Real-Chrome discovery needs `Program Files` / registry lookup and Edge. | Small. |
| Vault & secrets | **Part**. SQLCipher + Argon2id recovery are P. Key-slot order (`compose/vault.ts:255`): injected wrapper → key file (server mode) → Electron `safeStorage` → mac Keychain via helper with Touch ID. | DPAPI (what `safeStorage` uses on Windows) + Windows Hello (`UserConsentVerifier`/KeyCredential) for presence. | `safeStorage` slot is already portable. `presence.*` approvals (Secure Enclave/Touch ID) need a Hello-backed provider. |
| Notifications | **Part**. SQLite inbox, in-app and channel surfaces are P; OS surface goes `notify.show` → helper `UNUserNotificationCenter`, fallback Electron `Notification`. | Electron `Notification` (Windows toast; needs AppUserModelID set by the installer). | Make Electron `Notification` the default OS surface; helper an enhancement. |
| Auto-update | **M**. Verified manifest (Ed25519, sha256, downgrade refusal) is portable; apply step is Squirrel.Mac, darwin-only. | Squirrel.Windows (Forge maker) or MSIX; same signed manifest. | Manifest needs a per-platform artifact map (`darwin-arm64`, `darwin-x64`, `win32-x64`). |
| Packaging | **M**. Forge zip + DMG script, helper bundled, notarization env-gated. | Forge `maker-squirrel` (or MSIX), Authenticode signing (cert or Azure Trusted Signing), bundle Windows helper. | No Windows maker and no Windows CI runner. |
| Sandbox | **P**. Docker/Podman; Apple `container` is a macOS 26+ extra. `vm.*`/VZ is only the node guest VM. | Docker Desktop (WSL2). | Windows path discovery in `detect.ts`. VM guests stay mac-only. |
| Gateway server deploy / headless node | **P** (`deploy/Dockerfile`, `apps/node`). | Unchanged; Linux server is a supported *deployment*, not desktop. | Add `windows` to `DevicePlatform` for Windows nodes. |

### 3.2 What has no Windows equivalent

Messages/iMessage, Notes, Things, Music library, Shortcuts, Safari reading list, Finder-specific verbs, Secure Enclave presence key, Virtualization.framework guest VMs, AppleScript/JXA. These stay **mac-only capabilities**, shown as "available on this Mac", never as failures elsewhere. Calendar, mail and contacts have cross-platform substitutes through the Google/Microsoft/IMAP connectors.

## 4. Architecture proposal

### 4.1 Platform node interface

The "node" concept already exists: `packages/protocol/src/node.ts` (`connect { role: "node", capabilities }`, `node.invoke`, `CapabilityManifest {platform, version, capabilities}`) and `apps/node/src/capabilities/types.ts` (`CapabilityProvider`). `apps/mac-helper` is the Swift implementation. Missing: (a) naming capabilities by *what they do* rather than *which Apple API*, and (b) a rule that gateway/desktop code asks the node, not `process.platform`.

Proposed **platform node** = any process speaking the node protocol that advertises capabilities from a fixed, versioned, OS-neutral vocabulary. Implementations:

| Implementation | Language | Platforms | Notes |
|---|---|---|---|
| `mac-helper` | Swift | macOS | Exists. Superset: neutral caps + Apple-app caps. |
| `electron-node` | TS in desktop main | macOS, Windows | **New, cheap.** Implements what Electron already gives: `desktopCapturer` screen capture, notifications, `globalShortcut`, `safeStorage` wrapping, open-external, trash. Registers in-process so the gateway needs no special case. |
| `win-helper` | .NET (recommended) | Windows | New, later: UIA, SendInput, key hook, Hello presence. |
| `apps/node` headless | TS | any (server use) | Exists: exec, fs, browser, health. |

Several nodes can be connected at once (electron-node + mac-helper); the gateway routes each capability to the best advertiser by per-capability priority.

### 4.2 Capability vocabulary

Names are proposed neutral aliases; mac-helper keeps current names as aliases during migration (no wire break).

| Neutral capability | mac-helper today | electron-node | win-helper |
|---|---|---|---|
| `ui.tree` (accessibility snapshot, `AXSnapshot` shape) | `computer.ax_tree` | no | UIA |
| `ui.act` (press/select/set_value/menu) | `computer.press/...` | no | UIA patterns |
| `input.synthesize` | `computer.click/type/key/scroll/drag` | no | SendInput |
| `screen.capture` | `computer.screenshot` | `desktopCapturer` | yes |
| `screen.context` (capture + foreground app/window/selection + UI excerpt) | `screen.context` | partial (capture + window title) | yes |
| `key.watch` (hold-to-talk) | `dictation.watch` | toggle only (`globalShortcut`) | low-level hook |
| `text.insert` | `dictation.insert` | clipboard + synthesized paste | UIA / SendInput |
| `stt.transcribe` | `speech.transcribe_*` | no (gateway whisper) | optional WinRT |
| `secret.wrap` (optional user presence) | `keychain.*` | `safeStorage` | DPAPI + Hello |
| `presence.attest` | `presence.public_key` | no | Hello/TPM |
| `notify.show` | `notify.*` | `Notification` | toast |
| `os.permissions` | `permissions.*` | Electron media/screen perms | mostly n/a (mic privacy toggle, UIPI) |
| `os.open` | `apps.open`, `finder.reveal` | `shell.*` | yes |
| `app.list/focus` | `apps.list/focus` | no | yes |
| `files.trash/move/rename` | `files.*` | `shell.trashItem` | yes |
| `apple.*`, `vm.*` | yes | no | no |

Capability specs keep today's metadata (side effect, target kind, permission list, receipt kind); `TCCPermission` generalizes to `OsPermission` (`accessibility`, `screenCapture`, `inputControl`, `microphone`, `notifications`, `automation`, ...), mapped per OS. The manifest gains `platform: "windows"` and a per-capability `quality` hint (`full | degraded | unavailable` plus a reason string).

### 4.3 Graceful degradation

1. **Capabilities are discovered, never assumed.** Gateway features check the manifest, not `process.platform`; UI says "needs X (available on macOS / with the Windows helper)" instead of failing.
2. **Ordered fallbacks:**
   - Dictation: `key.watch + stt.transcribe` → `globalShortcut` toggle + renderer mic + gateway whisper → Web Speech in the pop-up → typing.
   - Ask about my screen: `screen.context` (UI tree) → `screen.capture` only (vision model reads pixels) → user-attached screenshot.
   - Computer use: `ui.tree + ui.act` → `input.synthesize` + screenshots → disabled, offering the browser tool instead.
   - Vault: `secret.wrap` with presence → `safeStorage` → key file (server mode).
   - Notifications: OS toast → in-app inbox → channels.
   - Update: verified in-app update → "update available" notification.
3. **Mac-only connectors hide themselves** when no node advertises their capabilities.
4. **Tier/permission rules (read-only tier, secure fields, taint) are enforced in the gateway** and echoed by the node, so a new helper cannot weaken them by omission; the conformance suite checks this.

### 4.4 Cheap abstractions to do now (no behavior change)

1. Add `windows` to `DevicePlatform`; stop mapping "everything not darwin" to `linux` in `device-key.ts`, `NodeAgent`, `identity.ts`.
2. A single platform module (`packages/platform` or `apps/desktop/src/platform/`) exporting `platform` plus helpers (`openExternal`, `autostart`, `chromePaths`, `socketEndpoint`, `systemNotify`). Replace the ~40 scattered `process.platform` checks and `open`/`launchctl`/`xattr` exec calls one file at a time; lint rule: no `process.platform` outside it.
3. Split desktop `supervisor.ts` into a `Supervisor` interface + `LaunchdSupervisor` (existing) + `TaskSchedulerSupervisor` (stub).
4. Generalize `TCCPermission` → `OsPermission`; add neutral capability aliases. Protocol codegen (TS/JSON Schema/Swift) already exists, so this is a schema change plus an alias table.
5. Make Electron `Notification` and `safeStorage` first-class, not fallbacks; route `desktopCapturer` through an in-process `electron-node`.
6. Per-platform artifact map in the update manifest; verification code unchanged.
7. Stop growing lock-in: new Apple-only features go behind `apple.*`; new OS-primitive features enter the neutral vocabulary first. Add an "Adding a native capability" checklist and a PR-template checkbox.
8. Add a `windows-latest` CI job for typecheck + unit tests of the TS packages (desktop build job follows in Phase 2).
9. A **node conformance suite** (golden manifest + invoke fixtures) in `packages/testing` that any helper implementation runs.

## 5. Phases

**Phase 0: stop the bleeding (1–2 weeks, no user-visible change).** 4.4 items 1, 2 (start), 7, 8; document the support matrix (macOS desktop; Windows planned; Linux = server deployment only).

**Phase 1: Windows "works" (parity with the portable feature set).** Windows Forge maker + Authenticode signing in CI, `TaskSchedulerSupervisor`, named-pipe/authenticated-loopback gateway endpoint, DPAPI via `safeStorage`, toast notifications, `windows` platform in protocol, update artifact map + Squirrel.Windows apply path, quick-entry shortcut default, `desktopCapturer` screenshot-only screen-ask, whisper/Web Speech dictation, Windows real-Chrome/Edge paths, Docker Desktop sandbox detection, `install-windows.ps1` for the headless node.

**Phase 2: neutral capability vocabulary and `electron-node`.** Protocol aliases, `OsPermission`, manifest quality hints, in-process electron node, conformance suite; gateway routes by capability.

**Phase 3: Windows helper (UIA).** `win-helper`: `ui.tree`, `ui.act`, `screen.context`, hold-to-talk key hook, Hello presence. Computer use (`input.synthesize`) last, behind an experimental flag until it passes the conformance suite.

**Phase 4 (optional).** Windows built-in STT engine, Outlook connector.

Mac-only forever: iMessage, Notes, Things, Shortcuts, Music, VM guests, Secure Enclave presence.

## 6. Decision points (recommended default first)

1. **Windows helper language.** Recommend **.NET (C#, self-contained/AOT-published)**: first-class UIA (`UIAutomationClient`), WinRT access for Hello, toast and speech, DPAPI, and the easiest path for a small team. Alternative: Rust (single static binary, but UIA and WinRT bindings are rougher).
2. **When to start Windows.** Recommend **Phase 0 now, Phase 1 after the current mac milestone ships**, so the abstractions land before more mac-only code accumulates.
3. **Capability names.** Recommend **neutral names with the current mac-helper names kept as aliases for at least two releases.**
4. **Computer use on Windows.** Recommend **screenshot-only screen-ask first; computer use experimental until the helper passes the conformance suite**; accept the UIPI limit on elevated windows.
5. **Windows installer/update stack.** Recommend **Forge Squirrel.Windows + the existing signed manifest**; alternative MSIX if Store distribution or enterprise deployment matters.
6. **Minimum bar for "supported" on Windows.** Recommend **chat, quick-entry pop-up, whisper/Web Speech dictation, screenshot-only screen-ask, vault via `safeStorage`, notifications, browser and updates, with CI on windows-latest**; UI automation is "preview". Alternative: require UIA to use the label (delays release by a phase).

## 7. Risks and unknowns

- Windows SmartScreen reputation for new signed installers; budget for a cert or Azure Trusted Signing.
- UIPI blocks input/UIA against elevated windows; secure desktop (UAC prompts, lock screen) is off limits.
- `socket-path.ts` and the helper transport assume Unix sockets; Windows needs named pipes or loopback with a token.
- Windows Hello presence needs a user-present assertion design equivalent to the Touch ID approvals.
- Per-OS branded-Chrome paths and whether screen-ask is wired end to end today were not verified in this audit.
- Counts and line numbers come from grep and drift as sibling sessions merge.
