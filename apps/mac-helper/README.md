# Psyche Helper (apps/mac-helper)

**Owner:** S14 (`prompts/s14-mac-helper.md`). Feature ids: A9, J1–J5, O10 (OS delivery), Q1 (engines), G1 (keychain), later J6, J7, J9, L1–L5 ([docs/03-feature-spec.md](../../docs/03-feature-spec.md)).

`Psyche Helper.app` (`com.psyche.helper`, ADR-001, ADR-020) is the signed Swift app that holds every macOS permission Psyche uses and offers them to the Gateway as a **node** (architecture §6, §7): Accessibility-driven computer use, screenshots, Apple Events and Shortcuts, the keychain with Touch ID, actionable notifications and on-device speech. It is not a pnpm package (no `package.json`; the root vitest config skips it).

## Build, test, run

```sh
swift build --package-path apps/mac-helper
swift test  --package-path apps/mac-helper           # Swift Testing; no TCC grants, network or GUI needed
apps/mac-helper/scripts/build-app.sh --install       # signed .app in ~/Applications (see Signing)
open ~/Applications/Psyche\ Helper.app               # or scripts/install-agent.sh for launchd
apps/mac-helper/.build/debug/psyche-helper --manifest  # print the capability manifest
```

Requires macOS 15+ (ADR-016) and Swift 6. CI builds with the macOS 26 SDK; newer APIs sit behind `#available`.

`psyche-helper` with no flags stays connected to the Gateway's node socket (`$PSYCHE_NODE_SOCKET`, else `$PSYCHE_HOME/run/node.sock`), pairs, declares its manifest and serves `node.invoke`, reconnecting with capped backoff (0.5 s → 30 s; 5 s while pairing is pending). `--handshake-only` keeps the S00 smoke test (exit 0 paired/pending, 2 socket missing, 3 denied, 4 timeout); `--challenge-only` stops after the challenge.

**Never run the binary from a shell for real use.** TCC attributes a shell child to its responsible process (the terminal, or the Claude Code CLI), so grants would go to the wrong app (spike 04). Launch the bundle through LaunchServices (`open`) or launchd.

## Layout

| Target | What |
| --- | --- |
| `PsycheProtocol` | Generated models (`pnpm protocol:gen`; do not edit) and the hand-written `Wire*` envelopes and `JSONValue`. |
| `PsycheHelperCore` | Pure logic, unit-tested: NDJSON framing, handshake, `FrameChannel`, `NodeSession` (serve loop), `NodeDaemon` (reconnects), the capability API (`CapabilitySpec`, `CapabilityError`, `ReceiptDraft`, `Schema`), the AX snapshot builder over an abstract `AXTreeSource`, tiers and fixed caps, session lock, Esc `StopSignal`, key chords, capture hygiene, permission catalog, key wrapping and keychain status mapping, notification planning, speech helpers. |
| `PsycheHelperSystem` | Live adapters and capability groups: `LiveAX` / `AXEngine`, `Input` + `EscStopTap`, `ScreenshotCapabilities`, `AppsCapabilities`, `PermissionsCapabilities` / `LivePreflight`, `KeychainCapabilities`, `NotifyCapabilities` / `NotificationCenterBridge`, `SpeechCapabilities`, `HelperRuntime` (assembles the registry). |
| `PsycheHelper` → `psyche-helper` | Entry: flags, device identity, AppKit run loop on the main thread, node connection on a background thread. |
| `Support/` | `Info.plist`, `PsycheHelper.entitlements`, LaunchAgent template. |
| `scripts/` | `build-app.sh`, `install-agent.sh`, `tcc-reset.sh`. |
| `docs/manual-test-plan.md` | What CI cannot test: real apps, TCC, Touch ID, notifications, microphone. |

## Node protocol

Wire spec v1 (`docs/plans/s00.md`). After `connect` (with `capabilities` = the manifest) and `connect.verify`:

```
Gateway → req node.invoke {invocationId, capability, params, approvalId?}
node    → res {accepted: true}                       (or not_found / conflict / invalid_params)
node    → req node.event {invocationId, data}        (zero or more)
node    → req node.result {invocationId, ok, result?, error?, receipt?}
```

- Each capability declares `sideEffect` (`none` / `read` / `write` / `destructive`), `targetKind` (`app` for computer use and Apple Events) and an `inputSchema` (JSON Schema). Side-effecting results carry a `Receipt` (`id`, `kind`, `approvalId`, `outcome` ok/failed/uncertain, `summary`, `externalRefs`); refused side effects get a `failed` receipt.
- Errors use protocol `ErrorCode`s with a machine reason in `details.reason` (`stale_ref`, `expectation_failed`, `secure_field`, `tier_read`, `permission_missing`, `missing_entitlement`, …).
- The helper also honours `node.cancel {invocationId}` (not in protocol v1 yet; see Requests).
- Logs (`os.Logger`, subsystem `com.psyche.helper`) carry capability names, ids, sizes, outcomes and reasons only: never params, results, AX text, note bodies, transcripts or keys (ADR-017).

## Capability reference

`psyche-helper --manifest` prints every schema. Summary:

### Permissions (A9)

| Capability | Side effect | Params → result |
| --- | --- | --- |
| `permissions.status` | read | `automationTargets?`, `wanted?` → per permission `{status, title, explanation, whenRequested, settingsURL, requestStyle}`, Automation per target, `next` to ask for |
| `permissions.request` | write | `permission`, `purpose?` (`vision_fallback`, required for Screen Recording), `target?` (Automation) → `{status, openedSettings}` |
| `permissions.open_settings` | none | `permission` → opens the `x-apple.systempreferences:` pane |

### Computer use (J1, J2, J3, J5)

| Capability | Side effect | Notes |
| --- | --- | --- |
| `computer.ax_tree` | read | `app`/`pid`, `window?`, `root?` (`window`/`app`/ref), `menubar?`, `maxVisit` 6000, `maxEmit` 400, `textMax` 80, `valueMax` 160, `clip`, `format` text/json → `{text, header, nodes?, tier, hint?, provenance: "untrusted"}` |
| `computer.ax_value` | read | full value of one ref (secure fields refused) |
| `computer.click` / `double_click` / `right_click` | write | `ref` + `expect`, or `selector` + `expect`, or `x`/`y`; `modifiers?`. AXPress / AXShowMenu first, HID mouse events at the frame centre as fallback |
| `computer.press` | write | `action`: press, confirm, cancel, pick, inc, dec, raise, menu, open, `custom:<Name>` |
| `computer.set_value` | write | settable check, read-back with backoff (50/100/200/400 ms) → `ok` or `unverified`; Finder name cells refused (`cosmetic_field`) |
| `computer.select` | write | `AXSelected = true`, read back |
| `computer.type` | write | text at the caret (element focused through AX first); refused in secure fields and for `{{cred:…}}` |
| `computer.key` | write | `keys` chord (`cmd+shift+t`, `return`, `f5`), `repeat?`; keycode events; `cmd+q`/`cmd+w`/`cmd+delete` need approval |
| `computer.scroll` | write | `dx`/`dy` lines over a ref or point |
| `computer.drag` | write | `from` → `to` (ref or point), same app only |
| `computer.menu` | write | `path` "File>Rename"; each segment must match exactly one item |
| `computer.screenshot` | read | `app?`, `display?`, `windowOnly?`, `maxWidth` 1372, `maxHeight` 887, `format` → `{image (base64), mimeType, width, height, screen, pointsPerPixel}` |
| `computer.screenshot_pick` | read | system `SCContentSharingPicker`; user-initiated, needs no Screen Recording grant |
| `computer.end_session` | none | release the session lock |

Rules every mutating call follows (spike 04):

- **Refs** (`e12`) are helper-held handles keyed by element identity, stable across snapshots, never reassigned, evicted after 25 snapshots unseen. A gone element is `not_found/stale_ref`, never a guess.
- **`expect {role, label?, valuePrefix?}`** is required with a ref; the helper re-reads the element and refuses with `expectation_failed` when it changed (apps reuse views).
- **Selectors** must match exactly one node of the last snapshot, by exact role/label/id.
- **Outcomes**: `ok`, `unverified` (read-back did not match within 750 ms, e.g. a background Chromium window), `ineffective` (AX refused) → receipt `ok` / `uncertain` / `failed`.
- **Secure fields** are refused at dispatch, below the model: no value, no typing, no screenshots while one has focus.
- **Risky labels** (`Delete`, `Trash`, `Send`, `Add List…`, `Quit`, …) and risky chords need an approved invocation even when the tier allows interaction.
- **Electron**: `AXManualAccessibility` is set on every attach; the first snapshot waits up to 3 s for a `webarea`; a sparse tree adds a `hint` to bring the window forward or take a screenshot.

**Tiers** (F6, J5). Effective tier = min(fixed cap, user tier):

| Fixed cap | Apps |
| --- | --- |
| Off | Psyche itself, password managers (1Password, Bitwarden, Passwords, Keychain Access, …), banking / trading / crypto apps |
| Read | Browsers (Safari, Chrome, Firefox, Edge, Arc, Brave, …): use the agent browser to act on the web |
| Click | Terminals and IDEs (Terminal, iTerm, Ghostty, VS Code, Cursor, Xcode, JetBrains, …): plain clicks and scrolling only |
| Interact | Everything else |

User tiers come from `$PSYCHE_HOME/config/computer-use.json`, written by the Gateway/desktop settings (never through `node.invoke`):

```json
{ "version": 1, "default": "ask", "apps": { "com.apple.Notes": "interact", "com.apple.finder": "read" } }
```

`ask` (the default) answers `approval_required/tier_ask`; once the Gateway sends the call with an `approvalId`, the app is allowed for 30 minutes ("Allow for this session"). One session (`session` param, the run id) drives the computer at a time (`conflict/computer_busy`; released by `computer.end_session` or after 2 minutes idle). A bare **Esc** from the user during a session is consumed by an active event tap, stops the in-flight action within one 20 ms step and ends the session (`cancelled/user_stopped`); the helper's own key events are tagged and never trip it.

**Screenshot hygiene** (J3, security §12): Psyche's windows, terminals/IDEs, password managers, finance apps and every app whose tier is Off are excluded from the capture filter; captures fit 1372×887 (JPEG ladder under 600 KB); refused while a password field has focus.

### Apple Events and Shortcuts (J4)

| Capability | Side effect | Notes |
| --- | --- | --- |
| `apps.list` | read | running apps with tier and fixed cap |
| `apps.open` | write | `app`/`bundleId`/`name`, `url?`; password managers and finance apps refused |
| `apps.focus` | write | activate, raise window `window?` |
| `apps.applescript` | destructive | `source`, `target?` (Automation asked first via `AEDeterminePermissionToAutomateTarget`); in-process `OSAScript` on the main thread; `do shell script` / `run script` refused |
| `apps.jxa` | destructive | same, JavaScript; `doShellScript` / `ObjC.import` refused |
| `apps.shortcut_run` | destructive | `name`, `input?` → text output; `/usr/bin/shortcuts` spawned with responsibility disclaimed and a minimal environment |
| `apps.shortcuts_list` | read | shortcut names |

Script and shortcut sources are approved verbatim by the Gateway (binding hash); the denylist is defense in depth, not a sandbox (security §5.4: no host-shell fallback).

### Keychain (G1, S06's contract)

The vault (`packages/vault`, `KeychainWrapper`) seals the DEK itself; the helper only holds the key-encryption key in the **data-protection keychain** (`kSecUseDataProtectionKeychain`, never synchronized, this device only), with `SecAccessControlCreateWithFlags(kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.biometryCurrentSet, .or, .devicePasscode])`. There is no fallback to the legacy file keychain. These capabilities are Gateway-internal: no agent tool may reach them.

| Capability | Side effect | Params → result |
| --- | --- | --- |
| `keychain.set` | write | `service: "com.psyche.vault"`, `account`, `value` (base64, 16–64 bytes), `accessControl: ["biometryCurrentSet","or","devicePasscode"]`, `accessible: "whenPasscodeSetThisDeviceOnly"`, `synchronizable: false`, `dataProtection: true` (anything weaker is refused) → `{}`; replaces an existing key; no prompt |
| `vault.unlock` | read | `service`, `account`, `reason` (prompt text, ≤ 120 chars), `reuseDurationSeconds` (0–300) → `{value}` base64, **a secret**; user cancel → `cancelled` |
| `keychain.delete` | destructive | `service`, `account` → `{}` |
| `keychain.store` | write | System keychain mode (G9, `packages/vault` `KeychainItemStore`): `name` (`^[a-z0-9._-]{1,64}$`), `value` (base64url, ≤ 16 KiB), `requireAuth` (default true: `[.biometryCurrentSet, .or, .devicePasscode]` + `WhenPasscodeSetThisDeviceOnly`; false: `WhenUnlockedThisDeviceOnly`), `replace`, `reason?` → `{name, stored, requireAuth, replaced}`; the value is never echoed; an existing name without `replace` → `conflict/duplicate_item` |
| `keychain.retrieve` | read | `name`, `reason` (prompt text) → `{name, value}` base64url, **a secret** |
| `keychain.delete_item` | destructive | `name`, `reason?` → `{deleted, name}`; missing → `not_found/item_not_found` (the vault treats it as removed) |
| `keychain.status` | read | `{dataProtectionKeychain: available \| missing_entitlement \| error, accessGroup, biometry: {...}}`; never prompts |

Errors (`details.reason`): `-34018` → `unavailable/missing_entitlement`; `-25300` → `not_found/item_not_found`; `-128` or LA cancel → `cancelled/user_cancelled`; `-25293` → `forbidden/auth_failed`; `-25308` → `unavailable/interaction_not_allowed` (retryable); LA lockout → `forbidden/biometry_lockout`; `-50` → `internal/keychain_param`. Without the entitlement, add/delete return `-34018` but a read of a missing item returns `-25300`, so status and unlock probe with a delete to tell them apart.

**Device identity:** a keychain item (`com.psyche.helper.identity`, `AfterFirstUnlockThisDeviceOnly`, no user presence: it is needed at launch). Builds without the entitlement fall back to `$PSYCHE_HOME/helper/device.key` (base64url Ed25519, dir 0700, file 0600; refused if wider, owned by someone else or a symlink); a later entitled build migrates it with the same device id. Logs say `identity_store=keychain|file`, never the key.

### Notifications (O10)

`UNUserNotificationCenter` needs the bundled, signed app; unbundled runs answer `unavailable/not_bundled`.

| Capability | Side effect | Notes |
| --- | --- | --- |
| `notify.show` | write | S15's `NotifyShowParams` (`id`, `category` = kind, `title`, `body`, `interruptionLevel`, `threadId`, `route`, `actions[{id, label, destructive, authenticationRequired, textInput}]`) or the helper names (`kind`, `interruption`, `reply`, `requireBiometry`, `quietHours {start, end}`, `sound`, `approvalId`). Re-showing an id replaces it. → `{delivered, interruptionLevel, quietHoursApplied, category, authorization}` |
| `notify.withdraw` | write | `id` |
| `notify.authorization_status` | read | status (notDetermined / denied / authorized / provisional) and per-setting state |
| `notify.request_authorization` | write | `provisional` (default true: quiet delivery first, security §12) |
| `notify.subscribe` | read, streaming | long-lived; emits `{type: "notify.response", notificationId, actionId, text?, replyText?, approvalId?, authenticated, authError?}`; buffers 100 while nobody listens |

Default categories: approval → Approve / Deny (destructive); input_needed → text reply; task_failed → Open / Retry; reminder → Open / Snooze; others → Open; custom action sets get `psyche.custom.<hash>`. Interruption: approval and input_needed time-sensitive, proactive and briefing passive, others active; quiet hours (overnight ranges work) make everything passive and silent. With `requireBiometry`, a non-destructive action or reply runs `LAContext.evaluatePolicy(.deviceOwnerAuthentication)` before it is forwarded (`authenticated: false` + `authError` on failure, so the Gateway refuses). Without the time-sensitive entitlement, time-sensitive posts as active. `userInfo` and logs carry ids only.

### Contacts (dictation vocabulary, issue #121)

| Capability | Side effect | Params → result |
| --- | --- | --- |
| `contacts.list` | read | `limit` (1–2000, default 500), `fields` (`["name"]` only), `query?` (≤ 80, prefix of given or family name; case- and diacritic-insensitive) → `{contacts: [{id, name, nickname?, organization?}], total, truncated}` ordered by family then given name |

Names only (S17's `NodeContactsSource` feeds them to `DictationTranscriber` as contextual strings): the fetch requests name, nickname and organization keys only, so phone numbers, emails and addresses are never read. Contacts without a name are skipped. The capability never prompts: without the Contacts grant it fails with `forbidden/permission_denied` (`details.permission: "contacts"`), which the Gateway treats as "no names"; the prompt comes from `permissions.request {permission: "contacts"}`.

### Presence (Touch ID approvals, issue #84)

Approvals that require authentication (purchase, credential fill, exec_host, pairing, policy change; security §3.7) need proof, not a boolean. When `notify.show` carries `requireBiometry: true` and `presenceChallenge` (hex SHA-256 from the Gateway; the answer token never leaves it), a non-destructive answer runs Touch ID for the presence key's access control (`LAContext.evaluateAccessControl(.useKeySign)`) and signs with that same context, so the owner sees one prompt:

- **Key:** one Secure Enclave P-256 key (`kSecAttrTokenIDSecureEnclave`, permanent, data-protection keychain, non-synchronizable), access control `[.privateKeyUsage, .biometryCurrentSet]`, tag `com.psyche.helper.presence`. Needs the keychain access group (provisioning profile).
- **Signature:** `ecdsaSignatureMessageX962SHA256` (DER) over the UTF-8 bytes `psyche.presence.helper.v1|<presenceChallenge>`, sent on `notify.response` as `presence: {signature: <base64url DER>, keyId: <hex SHA-256 of the X9.63 public key>}` with `authenticated: true`. Cancel or failed Touch ID → `authenticated: false` + `authError`, no presence. Without a usable key the helper falls back to device-owner authentication and reports `presenceError` (e.g. `missing_entitlement`); the Gateway then refuses the approval.
- **`presence.public_key`** (read) → `{publicKey: <X9.63 uncompressed, base64url>, keyId}`; created on first use, never prompts. Registering it is an owner action in the Gateway (S01), never something the helper does.

### Speech (Q1)

All speech runs on the Mac (ADR-014). Engine per stream: macOS 26+ with `vocabulary` → `dictationTranscriber` (SpeechAnalyzer + DictationTranscriber, `AnalysisContext.contextualStrings`); macOS 26+ otherwise → `speechAnalyzer` (SpeechTranscriber, volatile results, audio time ranges); else, or for unsupported locales → `sfSpeech` (on-device `SFSpeechRecognizer`, interim on macOS 15 until spike 03 picks FluidAudio or WhisperKit). Missing models install through `AssetInventory` with `speech.model_download` events.

| Capability | Side effect | Notes |
| --- | --- | --- |
| `speech.transcribe_stream` | read, streaming | `source` microphone/push, `locale?`, `vocabulary?` (≤ 100 × 64), `format?` (push: pcm_s16le/pcm_f32le, 8–48 kHz, 1–2 ch), `maxDurationMs` (default 5 min), `volatile` → events `speech.started`, `speech.partial`, `speech.final`; result `{streamId, text, segments, engine, language, stopReason, audioMs, firstResultMs}` |
| `speech.audio_push` | read | `streamId`, `data` (base64 ≤ 512 KiB), `final?` |
| `speech.stop` | read | `streamId` |
| `speech.synthesize` | read, streaming | `text` (≤ 5000), `voice?`, `rate?`, `personalVoice` (opt-in), `format` → `speech.audio` chunks (≤ 64 KiB); result flags `nonCommercial: true` for Personal Voice (Apple's terms) |
| `speech.voices`, `speech.status` | read | voices; engines, OS gates, locales, permissions, active streams |

One microphone stream at a time (`microphone_busy`), at most 4 streams, 8 MiB push buffer (`push_buffer_full`, retryable). Microphone permission for `source: microphone`; Speech Recognition only for `sfSpeech`. `AVSpeechSynthesizer` renders only with the main run loop serviced, which is why the helper runs AppKit on the main thread.

**Measured** (M5, macOS 27.0.1; a synthesized 6 s clip pushed in real time in 100 ms chunks): first partial ≈ 1.04 s after speech onset with SpeechTranscriber, ≈ 0.75 s with DictationTranscriber; finalizing 55–115 ms; peak RSS ≈ 42 MiB (excluding the system speech daemon); synthesis first audio ≈ 0.8 s cold. This bench misses Q1's < 500 ms target; a real-microphone measurement is in the manual test plan, and Parakeet (spike 03) is the next lever if it still misses.

## Entitlements and Info.plist

| Key | Where | Why |
| --- | --- | --- |
| Hardened runtime (`codesign -o runtime`) | signing | Developer ID, notarization |
| `com.apple.security.automation.apple-events` | entitlements | J4 |
| `com.apple.security.device.audio-input` | entitlements | microphone under the hardened runtime |
| `com.apple.security.personal-information.calendars`, `.addressbook` | entitlements | EventKit / Contacts (J6) |
| `keychain-access-groups` = `<TEAM>.com.psyche.helper`, `com.apple.application-identifier`, `com.apple.developer.team-identifier` | added by `build-app.sh` with `PSYCHE_HELPER_PROFILE` | data-protection keychain (restricted: needs an embedded provisioning profile) |
| `com.apple.developer.usernotifications.time-sensitive` | added when the profile carries it | time-sensitive approvals; otherwise they post as active |
| `com.apple.security.virtualization` | M3 | VM mode |
| `NSAppleEventsUsageDescription`, `NSCalendarsFullAccessUsageDescription`, `NSRemindersFullAccessUsageDescription`, `NSContactsUsageDescription`, `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`, `NSScreenCaptureUsageDescription` | Info.plist | prompt text |
| `PsycheKeychainAccessGroup` | Info.plist, set by `build-app.sh` | access group the keychain code uses (`PSYCHE_KEYCHAIN_GROUP` overrides in development) |
| `LSUIElement` | Info.plist | no Dock icon |

The app is not sandboxed (AX and CGEvent need it unsandboxed).

## Permission flows (security §12)

Order: **Accessibility** first (first computer-use tier above Off; one grant also covers event posting and listening), **Notifications** at onboarding (provisional first, `notify.request_authorization`), then on first use: Microphone and Speech Recognition (first dictation), **Automation** per target app (first Apple Event; the app must be running), Calendars/Reminders/Contacts (when the connector is enabled), **Screen Recording** only for the vision fallback (`purpose: "vision_fallback"`; user-initiated captures use the picker instead), **Full Disk Access** only for iMessage reading (cannot be requested: `permissions.request` opens System Settings). Status always comes from preflight APIs (`AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess`, `AVCaptureDevice.authorizationStatus`, `EKEventStore.authorizationStatus`, `AEDeterminePermissionToAutomateTarget(ask: false)`, a read probe for Full Disk Access), never `TCC.db`.

## Signing and grant resets (contributors)

- TCC grants key on **signature + bundle id + path**. Sign every build with the same real identity (Developer ID or Apple Development) and install at one fixed path (`build-app.sh --install` → `~/Applications/Psyche Helper.app`). **Rebuilds signed ad-hoc lose Accessibility and Screen Recording every time.**
- Without `PSYCHE_HELPER_PROFILE`, the data-protection keychain is unavailable (`-34018`): `keychain.*` fails with `missing_entitlement` and the device key falls back to `$PSYCHE_HOME/helper/device.key` (0600). A later profile-signed build migrates it into the keychain with the same device id.
- Reset grants: `apps/mac-helper/scripts/tcc-reset.sh` (runs `tccutil reset <service> com.psyche.helper` for every service the helper uses; notifications are reset in System Settings › Notifications).
- launchd: `scripts/install-agent.sh` writes `~/Library/LaunchAgents/com.psyche.helper.plist`, clears quarantine (macOS 27 launchd ignores quarantined plists) and bootstraps it; `--uninstall` removes it.
- Subprocesses (Shortcuts) are spawned with `responsibility_spawnattrs_setdisclaim` so they never inherit the helper's grants.

## Stubbed / later

- **M2/M3**: J6 Apple app adapters, J7 Messages (`chat.db`), J9 system-wide dictation, L1–L5 VM manager.
- **Speech on macOS 15** uses on-device `SFSpeechRecognizer` until spike 03 picks FluidAudio Parakeet or WhisperKit.
- **Teach mode** (J8) and per-display picking beyond `display` index are not built.
- The vision fallback's model-side triggers are the Gateway's; the helper only reports `hint: sparse_tree`.
