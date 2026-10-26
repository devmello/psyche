# Cross-platform readiness audit (Windows + Linux)

Status: proposal (docs only), 2026-10-26. Nothing here changes code.
Scope: how far Psyche is from running on Windows and Linux as well as macOS, and what to do about it.
Out of scope: text-to-speech. The owner removed TTS; voice is speech-to-text into the pop-up chat window with text answers. Mentions of `speech.synthesize`, `SpeechSynthesis.swift`, `speech.readAloud.*` and `voice.conversation.speech` below are inventory of code that is being deleted, not something to port.

Method: grep-based inventory by cheap subagents, then synthesis. Swift framework usage is inferred from import lines and symbol names, not compiled. Line numbers drift; re-grep before acting.

## 1. Summary

- The **gateway, web UI, protocol, memory, search, connectors (non-Apple), browser, sandbox (Docker/Podman) and `apps/node`** are already portable Node/TS. There are no darwin-only npm dependencies (no keytar, fsevents, node-mac-*).
- Everything macOS-specific is concentrated in two places: **`apps/mac-helper`** (Swift, ~everything "native") and the **desktop app's main process** (supervisor, updater, signing, tray, window chrome).
- Linux is further along than Windows: systemd unit, CLI supervisor, Docker, CLI tarballs, zip maker and a headless Linux node already exist. Windows has essentially nothing: no maker, no supervisor, no updater, no node installer, no CI.
- The main structural gap is that the helper is the *only* provider of native capabilities, and the gateway and desktop call it (or check `darwin`) directly in several places. A "platform node" interface (section 4) fixes that.

## 2. Inventory of macOS-only dependencies

### 2.1 `apps/mac-helper` (Swift 6, SwiftPM, macOS 15+)

Targets: `PsycheProtocol`, `PsycheHelperCore` (pure logic, Foundation/CryptoKit/Security only), `PsycheHelperSystem` (live Apple adapters), `PsycheHelper` executable (`Sources/PsycheHelper/main.swift`, NSApplication run loop). Capabilities register in `System/HelperRuntime.swift` into a `CapabilityRegistry`; each `CapabilitySpec` (`Core/Node/Capability.swift`) carries name, side effect, target kind, input schema, TCC permissions and receipt kind.

| Area | Files (under `Sources/PsycheHelperSystem/` unless noted) | Apple API | Capabilities |
|---|---|---|---|
| Accessibility (AX) | `Computer/AXEngine.swift`, `LiveAX.swift`, `AttentionMonitor.swift`; `Core/Computer/AXSnapshot.swift`, `KeyChord.swift` (CoreGraphics types only, portable shape) | AXUIElement | `computer.ax_tree/ax_value/press/select/set_value/menu` |
| Input synthesis | `Computer/Input.swift` | CGEvent (also Esc stop tap) | `computer.click/type/key/scroll/drag` |
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

Rough split: ~50 capability names are pure Apple-app automation with no Windows/Linux analogue (see 3.2); ~25 are OS primitives (AX, input, capture, STT, secrets, notifications, permissions) that have analogues.

### 2.2 Packaging, deploy, signing

- `deploy/macos/`: `build-local.sh`, `build-helper.sh`, `make-dmg.sh` (hdiutil, codesign, notarytool, stapler), `install-local.sh`, `build-guest-image.sh`, icon scripts (iconutil).
- `deploy/launchd/com.psyche.gateway.plist` (LaunchAgent), `deploy/homebrew/psyche.rb.tmpl` (cask) and `psyche-cli.rb.tmpl` (formula, mac + Linux).
- Signing: `apps/desktop/entitlements.plist`, `apps/desktop/docs/signing.md`, `apps/desktop/src/packaging/signing-config.ts` (Developer ID + `APPLE_*` notarization env), helper entitlements.
- **Already Linux:** `deploy/systemd/psyche-gateway.service`, `deploy/Dockerfile`, `deploy/docker-compose.yml`, CLI writes `~/.config/systemd/user/psyche-gateway.service`, `apps/node/scripts/install-linux.sh`, CLI tarballs for linux-x64/arm64 (`release.yml`).
- **Nothing Windows.** No `.exe`/MSI/Squirrel.Windows, no Task Scheduler/service unit, no `install-windows.ps1`.
- CI: `desktop.yml` runs only on `macos-26`; `ci.yml` has ubuntu + macos-26.

### 2.3 Electron main process (`apps/desktop`, Electron Forge 8)

- `forge.config.ts` (:37, 101, 108, 112, 120): mac host detection, ad-hoc signing, `MakerZIP` for darwin+linux only, `packageAfterPrune` early-returns unless darwin, nested helper verification, Info.plist usage strings.
- `src/main/windows.ts:179`: inset title bar + traffic lights on darwin, native otherwise (already branched). Quick-entry window at ~:205 is portable.
- `src/main.ts`: `app.dock` (:731, 1006), `window-all-closed` keeps app alive on darwin (:1054), `bundledHelperPath` requires darwin (:366), glass mode (:754), menu-bar `PsycheTray` (:978, `src/main/tray.ts`).
- `src/main/glass.ts`: `electron-liquid-glass` (optional, undeclared), `/usr/sbin/screencapture`.
- `src/main/updater.ts:47`: darwin-only; Squirrel.Mac via `autoUpdater`; `/usr/bin/codesign -dvv` Developer-ID check. `update-manifest.ts` models only a `darwin` zip artifact.
- `src/main/supervisor.ts` (:166–491): `launchctl bootstrap/print/bootout/kickstart`, `xattr -dr com.apple.quarantine`, `~/Library/LaunchAgents`. No systemd/Windows branch.
- `src/main/helper-launcher.ts:126` (codesign), `browser/downloads.ts:127` (quarantine xattr), `permissions/permissions.ts:54` (`mac = darwin`), `lib/real-chrome.ts:29` (`open -n -a "Google Chrome"`; linux `google-chrome`; else null), `packaging/bundle-resources.ts` (Mach-O, codesign), `lib/device-key.ts:91` (darwin→macos else linux; no win32).

### 2.4 Other `process.platform` / darwin checks

- `apps/cli`: `snapshot.ts`, `doctor.ts`, `context.ts`, `audit.ts`, `supervisor.ts:160` (darwin→launchd, else systemd, so Windows falls into systemd incorrectly).
- `apps/node`: `runtime.ts:64,89` (helper auto-enabled on darwin; platform macos/linux only), `transports/vsock.ts` (sysctl `kern.hv_vmm_present`), `identity.ts:76` (win32 file-mode check, the only win32 awareness), `capabilities/health.ts:42`.
- `apps/gateway`: `compose/parts.ts:187` (`open` for OAuth consent URLs on darwin), `socket-path.ts` (Unix socket length; Windows would need named pipes or TCP loopback).
- `packages/sandbox/src/detect.ts` (:20–45, 83, 123, 137): prefers Apple `container` on darwin, `sw_vers`, Docker.app paths.
- `packages/ui`: `shortcuts.ts:233,249`, `SearchSurface.tsx` (Cmd vs Ctrl, already handled); `OnboardingSteps.tsx:335` ("apple:" group is "On this Mac").
- Protocol: `DevicePlatform = macos | ios | android | web | linux` (`schemas/identity.ts:13`): **no `windows`**. `sandbox` backend enum has `apple-container`. `vm.*`, `dictation.*`, `screen.*`, `presence.*` methods are Apple-shaped.

## 3. Feature by feature

Legend: **P** portable today, **M** mac-only today, **Part** partly portable.

### 3.1 Table

| Feature | Today | Windows / Linux equivalent | Gap |
|---|---|---|---|
| Chat | **P**. Web UI over WebSocket (`apps/web`, `packages/ui`); desktop hosts the same UI. | none needed | Window chrome polish only. |
| Gateway / daemon | **Part**. Node 24 + Docker everywhere; launchd (mac), systemd (Linux, exists). | Linux: systemd user unit (exists). Windows: Task Scheduler "at logon" task, or Windows service via `node-windows`/NSSM. | Desktop `supervisor.ts` is launchd-only; Windows has nothing. |
| Non-Apple connectors (Google, Microsoft, IMAP/JMAP, web search/fetch, MCP presets, OAuth PKCE loopback) | **P** (`packages/connectors/src/framework`). | none needed | OAuth consent URL open uses `open` on darwin (`parts.ts:187`); use Electron `shell.openExternal` / `xdg-open` / `start`. |
| Apple connectors (Notes, Reminders, Calendar, Mail, Messages, Things, Music, Shortcuts, Safari) | **M**, thin adapters over helper (`packages/connectors/src/apple/connector.ts`). | No analogue for Notes/Messages/Things/Shortcuts/Music-library. Calendar/Contacts/Mail: use the portable Google/Microsoft/IMAP connectors (already exist). Windows could use Outlook COM later; Linux EDS/evolution is niche. | Accept as mac-only; hide in onboarding when no provider is present. |
| Voice dictation (STT) | **Part**. Engine order `mac-node → whisper → web-speech` (`packages/speech/src/policy.ts:36`). whisper.cpp on the gateway host (`engines/whisper.ts`) and browser Web Speech are portable. | whisper-compatible endpoint (local whisper.cpp / faster-whisper server / any OpenAI-compatible `/v1/audio/transcriptions`); Windows has built-in Speech Recognition (`Windows.Media.SpeechRecognition`) as optional engine. | System-wide hold-to-talk key watch is M (helper CGEvent tap). Toggle hotkey via `globalShortcut` is P. Mic capture in Electron/renderer is P. |
| Pop-up chat window (quick entry) | **P**. Frameless always-on-top 640x160 BaseWindow, `Alt+Space` / `Ctrl+Alt+Space` via `globalShortcut` (`main.ts:1001`, `windows.ts:205`). | Same. `Alt+Space` conflicts with the Windows system menu and some Linux WMs; default must differ per OS. Wayland: `globalShortcut` is unreliable; need XDG GlobalShortcuts portal or compositor binding that runs `psyche --quick`. | Per-OS default shortcut; Wayland fallback; hide-on-blur behavior check. |
| Ask about my screen | **M**. Capture + AX via helper (`Screenshots.swift`, `ScreenAskCapabilities.swift`); orchestration in `apps/gateway/src/compose/screen-ask.ts`, panel in `apps/desktop/src/main/screen-ask/panel.ts`. | Capture: Electron `desktopCapturer` (Win/X11 fine; Wayland needs PipeWire portal prompt). Context: Windows UI Automation (UIA) tree of the foreground window; Linux AT-SPI over D-Bus (X11 + Wayland, apps must expose a11y). Fallback: screenshot-only + OCR/vision model. | Capture can move to Electron now; AX needs a per-OS provider. Screenshot-only mode is the degradation floor. |
| Computer use | **M**. Gateway driver `compose/computer.ts` → helper `computer.*` (CGEvent input, AX, tier enforcement, secure-field handling). | Windows: UIA + `SendInput`; also a RDP/VM guest. Linux X11: XTest + AT-SPI; Wayland: libei / RemoteDesktop portal (prompt per session) or uinput (root). Container/VM desktop (Xvfb + VNC) is the safest Linux story and fits the existing node-in-VM design. | Biggest single gap; highest cost. Phase late. |
| Browser | **P**. CDP via desktop bridge (`webContents.debugger`), Playwright driver, real-Chrome launcher, Docker Playwright sidecar (`deploy/browser`). | Same. Real-Chrome path discovery needs Windows registry/`Program Files` and Linux `google-chrome`/`chromium`/flatpak paths (`real-chrome.ts` returns null on Windows). | Small. |
| Vault & secrets | **Part**. SQLCipher + Argon2id recovery are P. Key-slot order (`compose/vault.ts:255`): injected wrapper → key file (server mode) → Electron `safeStorage` → mac Keychain via helper w/ Touch ID. | Windows: DPAPI (`safeStorage` uses it) + Windows Hello via `UserConsentVerifier` for presence. Linux: libsecret (`safeStorage` uses it; falls back to `basic_text`, must refuse that) or key file. | `safeStorage` slot already portable; just need to verify the "basic_text" refusal and a Hello/polkit presence story. Touch-ID-style approvals (`presence.*`) have no Windows/Linux provider yet. |
| Notifications | **Part**. SQLite inbox, in-app and channel surfaces are P; OS surface goes `notify.show` → helper `UNUserNotificationCenter`, fallback Electron `Notification`. | Electron `Notification` (Windows toast, Linux libnotify). | Make Electron `Notification` the default OS surface; helper only an enhancement. |
| Auto-update | **M**. Verified manifest (Ed25519, sha256, downgrade refusal) is portable logic; apply step is Squirrel.Mac and darwin-only (`updater.ts`, `update-manifest.ts`). | Windows: Squirrel.Windows or MSIX/`electron-updater` NSIS; Linux: no `autoUpdater`; use AppImage update or distro packages (deb/rpm repo, Flatpak) and just *notify*. | Manifest needs a per-platform artifact map; verification stays. |
| Packaging | **M** for desktop. Forge: zip for darwin/linux; DMG via shell script; helper bundled; notarization env-gated. CLI tarballs and Docker image are P. | Windows: Forge `maker-squirrel` or `maker-wix`/MSIX, Authenticode signing (cert or Azure Trusted Signing). Linux: `maker-deb`, `maker-rpm`, AppImage/Flatpak. | No Windows maker; no CI runners for win/linux desktop. |
| Sandbox | **P**. Container-based (Docker/Podman everywhere; Apple `container` is an extra on macOS 26+). `vm.*` / VZ is only the node guest VM. | Docker Desktop/WSL2 on Windows; Docker/Podman on Linux. | `sandbox` enum is fine; Windows path and Docker Desktop path discovery. VM guest feature stays mac-only. |
| Gateway in Docker / headless node | **P** (`deploy/Dockerfile`, `apps/node`). Linux node installer exists. | Windows node: add installer + `win32` platform. | Protocol `DevicePlatform` lacks `windows`. |

### 3.2 What has no equivalent

Messages/iMessage, Notes, Things, Music library, Shortcuts, Safari reading list, Finder-specific verbs, Secure Enclave presence key, Virtualization.framework guest VMs, AppleScript/JXA. These stay **mac-only capabilities**; the product should present them as "available on this Mac" and never as a failure elsewhere. Cross-platform substitutes already exist for calendar, mail and contacts via Google/Microsoft/IMAP connectors.

## 4. Architecture proposal

### 4.1 Platform node interface

Today the "node" concept already exists in `packages/protocol/src/node.ts` (`connect { role: "node", capabilities }`, `node.invoke`, `CapabilityManifest {platform, version, capabilities}`) and `apps/node/src/capabilities/types.ts` has a `CapabilityProvider`. `apps/mac-helper` is the Swift implementation of the same idea. What is missing is (a) naming capabilities by *what they do*, not *which Apple API*, and (b) a rule that gateway/desktop code asks the node, not `process.platform`.

Proposed **platform node** = a node (any process speaking the node protocol) that advertises capabilities from a fixed, versioned, OS-neutral vocabulary. Implementations:

| Implementation | Language | Platforms | Notes |
|---|---|---|---|
| `mac-helper` | Swift | macOS | Exists. Superset: all neutral caps + Apple-app caps. |
| `win-helper` | .NET or Rust (UIA, SendInput, DPAPI/Hello) | Windows | New, later. |
| `linux-helper` | Rust or Node + D-Bus (AT-SPI, libsecret, portals) | Linux | New, later. |
| `electron-node` | TS inside desktop main | all | **New and cheap**: implements the subset Electron already gives (screen capture via `desktopCapturer`, notifications, global shortcuts, `safeStorage` slot, open-external). Registers as a node in-process so the gateway needs no special-casing. |
| `apps/node` headless | TS | Linux/mac/win | Exists: exec, fs, browser, health. |

Multiple nodes may be connected at once (e.g. electron-node + mac-helper); the gateway routes each capability to the best advertiser by a per-capability priority.

### 4.2 Capability vocabulary

Required-vs-optional per platform. Names are proposed neutral aliases; the mac-helper keeps its current names as aliases during migration (no wire break).

| Neutral capability | mac-helper today | electron-node | win-helper | linux-helper |
|---|---|---|---|---|
| `ui.tree` (accessibility snapshot of a window/app; `AXSnapshot` shape) | `computer.ax_tree` | no | UIA | AT-SPI |
| `ui.act` (press/select/set_value/menu by element id) | `computer.press/...` | no | UIA patterns | AT-SPI actions |
| `input.synthesize` (click/type/key/scroll/drag) | `computer.click...` | no | SendInput | XTest / libei / uinput |
| `screen.capture` (display/window/region PNG) | `computer.screenshot` | `desktopCapturer` | yes | portal / X11 |
| `screen.context` (screenshot + foreground app/window/selection + AX excerpt) | `screen.context` | partial (capture + active window title) | yes | yes |
| `key.watch` (global key down/up for hold-to-talk) | `dictation.watch` | `globalShortcut` (toggle only; no hold) | low-level hook | evdev/portal (limited) |
| `text.insert` (insert into focused field) | `dictation.insert` | clipboard + synth paste | UIA / SendInput | AT-SPI / paste |
| `stt.transcribe` (stream + file) | `speech.transcribe_*` | no (use gateway whisper) | optional WinRT | optional |
| `secret.wrap` (key-slot wrap/unwrap with optional user presence) | `keychain.*` | `safeStorage` | DPAPI + Hello | libsecret |
| `presence.attest` (hardware/user-presence key for approvals) | `presence.public_key` | no | Hello/TPM | none (degrade) |
| `notify.show` | `notify.*` | `Notification` | toast | libnotify |
| `os.permissions` (status/request/open settings) | `permissions.*` | Electron media/screen perms | n/a mostly | portal prompts |
| `os.open` (url/file/reveal) | `apps.open`, `finder.reveal` | `shell.*` | yes | yes |
| `app.list/focus` | `apps.list/focus` | no | yes | partial |
| `files.trash/move/rename` | `files.*` | `shell.trashItem` | yes | yes |
| `apple.*` (notes, mail, messages, things, music, shortcuts, safari, calendar, reminders, contacts, applescript) | yes | no | no | no |
| `vm.*` | yes | no | no | no |

Every capability spec keeps today's metadata (side effect, target kind, TCC-style permission list, receipt kind), but the permission enum generalizes from `TCCPermission` to `OsPermission` (`accessibility`, `screenCapture`, `inputControl`, `microphone`, `notifications`, `automation`, ...), mapped per OS.

The manifest gains `platform: "windows"`, `features: string[]` and a per-capability `quality` hint (`full | degraded | unavailable` with a reason string, e.g. "Wayland: needs portal prompt each session").

### 4.3 Graceful degradation

1. **Capabilities are discovered, never assumed.** Gateway features check the manifest, not `process.platform`. UI shows "needs X (available on macOS / with the Windows helper)" instead of failing.
2. **Ordered fallbacks per feature**:
   - Dictation: `key.watch+stt.transcribe` → `globalShortcut` toggle + mic in renderer + gateway whisper → Web Speech in the pop-up window → typing.
   - Ask about my screen: `screen.context` (AX) → `screen.capture` only (vision model reads pixels) → user-attached screenshot.
   - Computer use: `ui.tree+ui.act` → `input.synthesize` + screenshots (pixel mode) → **disabled**; offer "use browser tool" or a container desktop node.
   - Vault: `secret.wrap` with presence → `safeStorage` → key file; **refuse** Linux `basic_text` safeStorage backend and tell the user.
   - Notifications: OS toast → in-app inbox → channels.
   - Update: verified in-app update → "update available, download here" notification (Linux).
3. **Mac-only connectors hide themselves** when no node advertises their capabilities; onboarding groups ("On this Mac") already supports this.
4. **Tier/permission rules (read-only tier, secure fields, taint) are enforced in the gateway** and echoed by the node, so a new helper cannot weaken them by omission. The helper conformance test (below) checks this.

### 4.4 Cheap things to abstract now (no behavior change)

1. Add `windows` to `DevicePlatform`; make `NodeAgent`/`device-key.ts`/`identity.ts` stop mapping "everything not darwin" to linux.
2. A single `packages/platform` (or `apps/desktop/src/platform/`) module exporting `platform = "macos"|"windows"|"linux"` plus path/command helpers (`openExternal`, `autostart`, `chromePaths`, `socketEndpoint`, `systemNotify`). Replace the ~40 scattered `process.platform` checks and the `open`/`launchctl`/`xattr` exec calls, one file at a time, behind it. Lint rule: no `process.platform` outside it.
3. Split desktop `supervisor.ts` into `Supervisor` interface + `LaunchdSupervisor` (existing), then `SystemdSupervisor` (the CLI one can be shared) and `TaskSchedulerSupervisor` stubs.
4. Generalize `TCCPermission` → `OsPermission` and rename-with-alias the neutral capabilities in protocol; the codegen to Swift/TS/JSON Schema already exists, so this is a schema change plus alias table.
5. Make Electron `Notification` and `safeStorage` first-class (not "fallbacks") and route `desktopCapturer` screenshots through an in-process `electron-node` provider.
6. Per-platform artifact map in the update manifest (`darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64` ...) while keeping the verification code unchanged.
7. Stop growing lock-in: new Apple-only features go behind `apple.*`; new OS-primitive features must be added to the neutral vocabulary first. Add a short "Adding a native capability" checklist to the contributing docs and a PR-template checkbox.
8. Run CI on `ubuntu-latest` and `windows-latest` for typecheck + unit tests of the TS packages now (they should mostly pass); desktop build jobs can follow.
9. A **node conformance suite** (golden manifest + invoke fixtures) in `packages/testing` that any helper implementation runs, replacing mac-helper-only assurance.

## 5. Phases

**Phase 0: stop the bleeding (1–2 weeks, no user-visible change).** Items 1, 2 (start), 7, 8 from 4.4; add Windows/Linux CI for TS packages; document the support matrix in README.

**Phase 1: Linux "works" (desktop + gateway).** `SystemdSupervisor` in desktop, Forge `deb`/`rpm`/AppImage makers, notification-only update path, `safeStorage` slot hardened, quick-entry shortcut defaults + Wayland fallback, `desktopCapturer`-based screen-ask (screenshot mode), whisper STT, real-Chrome paths. Linux is the cheapest because the gateway, systemd unit, CLI and node installer already exist.

**Phase 2: Windows "works" (same feature level as Phase 1).** Windows maker (Squirrel/MSIX), Authenticode signing in CI, Task Scheduler supervisor, named-pipe/loopback gateway endpoint, DPAPI via `safeStorage`, toast notifications, `windows` platform in protocol, update artifact map + Windows apply path, `install-windows.ps1` for the headless node, Docker Desktop sandbox detection.

**Phase 3: neutral capability vocabulary and `electron-node`.** Protocol aliases, `OsPermission`, manifest quality hints, in-process electron node, conformance suite; gateway routes by capability instead of "the helper".

**Phase 4: native helpers for UI automation (screen context + computer use).** Windows UIA helper first (largest desktop share, stable API), then Linux AT-SPI (X11 first; Wayland via portals). Hold-to-talk global key watching as part of it. Presence attestation via Windows Hello.

**Phase 5 (optional): parity extras.** Windows built-in STT engine, Outlook/Linux PIM connectors, container desktop node for sandboxed computer use, Flatpak.

Mac-only forever: iMessage, Notes, Things, Shortcuts, Music, VM guests, Secure Enclave presence.

## 6. Decision points (recommended defaults first)

1. **Order: Linux first or Windows first?** Recommend **Linux first** (Phase 1), then Windows, since most of the groundwork exists, with Windows done immediately after rather than deferred. Alternative: Windows first if the owner's users skew Windows.
2. **Native helper language for UIA/AT-SPI.** Recommend **Rust** for both (one codebase, single static binary, good `windows`/`atspi`/`zbus` crates, no .NET runtime to ship), speaking the existing node protocol. Alternative: .NET for Windows (best UIA ergonomics) and Rust for Linux.
3. **Do we keep the Swift helper's capability names or rename?** Recommend **neutral names with the current names kept as aliases** for at least two releases, so protocol codegen and the helper don't break.
4. **Computer-use scope off macOS.** Recommend **ship screenshot-only screen-ask first; gate computer use on Windows/Linux behind an "experimental" flag until the UIA/AT-SPI helpers pass the conformance suite**; on Linux Wayland, prefer a container/VM desktop node over host control.
5. **Auto-update on Linux.** Recommend **notify-only plus package repos (deb/rpm, AppImage with `AppImageUpdate`)**; no custom installer. Keep the existing signed-manifest verification for the "update available" check.
6. **Minimum bar for "supported".** Recommend **a platform is "supported" when chat, quick-entry pop-up, dictation via whisper/Web Speech, screenshot-only screen-ask, vault via `safeStorage`, notifications, browser and updates-or-notify work, with CI on that OS**; UI automation is "preview". Alternative: require UIA/AT-SPI for the label (delays release by a phase).

## 7. Risks and unknowns

- Wayland global shortcuts, screen capture and input injection each require portal prompts and vary by compositor; plan for X11 + GNOME/KDE Wayland testing, not "Linux" in general.
- Electron `safeStorage` on Linux can silently use a plaintext backend when no keyring is present (headless/minimal desktops).
- Windows Defender/SmartScreen reputation affects an unsigned or newly signed installer; budget for a signing cert or Azure Trusted Signing.
- Windows lacks Unix sockets in some code paths (`socket-path.ts`, helper transport); named pipes or loopback with a token are needed.
- Per-OS branded-Chrome path discovery and whether screen-ask is wired end-to-end today were not verified in this audit.
- Counts and line numbers come from grep and drift as sibling sessions merge.
