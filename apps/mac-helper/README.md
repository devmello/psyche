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

One helper runs per `$PSYCHE_HOME`. It holds `$PSYCHE_HOME/run/helper.lock`, and a second copy exits 0 before loading anything. A helper running from an `.app` checks its own executable every 30 s. When the executable is replaced or removed (upgrade, Trash), it exits with 75, so a LaunchAgent restarts the new binary and the desktop's next `open` starts the bundled one. Bundled layout and launch contract: `docs/status/s14.md` "Packaging".

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
| `permissions.status` | read | `automationTargets?`, `wanted?` → per permission `{status, title, explanation, whenRequested, settingsURL, requestStyle}`, Automation per target, `next` to ask for, `bundle {path, version, build, signing: developer_id\|development\|adhoc\|unsigned, teamId?, insideApp}` |
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
{ "version": 1, "default": "ask", "apps": { "com.apple.Notes": "interact", "com.apple.finder": "read" }, "sensitive": ["com.example.Health"] }
```

**Pause-when-unwatched** (docs/05 §7.2 item 5): in sensitive apps (terminals and IDEs, messaging and mail apps, and the `sensitive` list), anything beyond reading and scrolling needs owner keyboard, mouse or trackpad input on this Mac within the last 5 minutes. A listen-only event tap records that input and ignores the helper's own tagged events. Otherwise the call fails with `presence_required/awaiting_attention` (`retryable`, `details.idleSeconds`, `details.windowSeconds`) before any approval is asked.

`ask` (the default) answers `approval_required/tier_ask`; once the Gateway sends the call with an `approvalId`, the app is allowed for 30 minutes ("Allow for this session"). One session (`session` param, the run id) drives the computer at a time (`conflict/computer_busy`; released by `computer.end_session` or after 2 minutes idle). A bare **Esc** from the user during a session is consumed by an active event tap, stops the in-flight action within one 20 ms step and ends the session (`cancelled/user_stopped`); the helper's own key events are tagged and never trip it.

**Screenshot hygiene** (J3, security §12): Psyche's windows, terminals/IDEs, password managers, finance apps and every app whose tier is Off are excluded from the capture filter; captures fit 1372×887 (JPEG ladder under 600 KB); refused while a password field has focus.

### Apple Events and Shortcuts (J4)

| Capability | Side effect | Notes |
| --- | --- | --- |
| `apps.list` | read | running apps with tier and fixed cap |
| `apps.open` | write | `app`/`bundleId`/`name`, `url?`; password managers and finance apps refused |
| `apps.focus` | write | activate, raise window `window?` |
| `apps.applescript` | destructive | `source`, `target`, `timeoutSeconds?` (Automation asked first via `AEDeterminePermissionToAutomateTarget`); disclaimed `osascript`, out of process; shell, ASObjC and apps other than `target` refused (#268) |
| `apps.jxa` | destructive | same, JavaScript; `doShellScript`, ObjC bridging, `$` and `eval` refused |
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

### Messages (J7)

Code: `Sources/PsycheHelperCore/Messages/` (SQLite reader, chat.db queries, typedstream text, watcher, send script) and `Sources/PsycheHelperSystem/Messages/` (the capability group). Shapes: `packages/protocol/src/schemas/messages.ts`.

| Capability | Side effect | Params → result |
| --- | --- | --- |
| `messages.status` | none | → `MessagesStatus {fullDiskAccess, automation, databasePresent, lastCursor}`; never prompts |
| `messages.chats` | read | `limit` (≤ 200, default 50), `query?` → `{chats: [MessagesChat]}` newest first |
| `messages.read` | read | `chatId?`, `handle?`, `sinceCursor?`, `limit` (≤ 200, default 20) → `{messages, cursor, hasMore}` ascending; without `sinceCursor` the newest `limit` |
| `messages.watch` | read, streaming | `sinceCursor?` (default: now), `intervalMs` (500–60000, default 2000), `includeFromMe?` → `node.event`s `{type: "messages.new", messages, cursor}` / `{type: "messages.watch_error", reason, retryable}` until `node.cancel` |
| `messages.send` | destructive, `recipient` | `to` (E.164 or email) or `chatId`, `text` (≤ 20000), `service?` (`imessage`/`sms`) → `{sent, recipient, sentAt}` + receipt (`message_send`, recipient and length, never the text) |

- **Read-only chat.db.** `~/Library/Messages/chat.db` is opened `file:…?mode=ro` with bound parameters only; optional columns (`thread_originator_guid`, `date_edited`, `associated_message_emoji`, `is_sticker`) are probed per database. The cursor is `message.ROWID`. Dates are Apple-epoch nanoseconds (seconds on old rows).
- **Full Disk Access** cannot be requested programmatically (security §12). Without it every read fails with `forbidden/full_disk_access_missing` and a message naming System Settings › Privacy & Security › Full Disk Access (`details.settingsURL`); `messages.watch` emits one `watch_error` and ends instead of spinning. A busy database backs off (doubling, ≤ 30 s) and emits one `watch_error` per failure streak. No `~/Library/Messages` at all is `not_found/database_missing` (Messages never set up), not a grant problem.
- **Cursor safety.** Each message is returned once (one chat per row, the lowest `chat_id`, so merged SMS/iMessage threads do not duplicate). The watcher also reads rows not yet linked to a chat: one younger than 30 s holds the cursor before it until the next poll, an older one is skipped, so a late `chat_message_join` write cannot make a row vanish. `hasMore` means "newer rows after `cursor`" and is always false in newest-N mode.
- **Bodies.** `message.text`, or when it is NULL (macOS 13+), the first `NSString` in `attributedBody`, read from the typedstream bytes without `NSUnarchiver` (no object instantiation from untrusted data). U+FFFC attachment placeholders are stripped. Tapbacks (`associated_message_type` 2000–2006 / 3000–3006) become `reaction`; inline replies `replyToGuid`. Everything from other people is untrusted content for the Gateway.
- **Attachments are metadata only:** guid, transfer name (not the path), MIME type, UTI, size, `isVoiceNote` (CAF / `is_audio_message`), `isSticker`. No bytes, no paths.
- **Send.** Refused without `approvalId` (`approval_required`): the Gateway asks with the `message_send` kind, `once` / `task` only (security §3.4). Automation for `com.apple.MobileSMS` is checked (and asked once, launching Messages hidden if needed); denied → `forbidden/automation_denied`. The script is in-process AppleScript with the text and recipient as escaped string literals (validated handle and chat-id grammars), inside `with timeout of 20 seconds` so a hung Messages cannot hold the main thread for the default two minutes. Only "no such chat / participant" errors (-1728, -1719) fall through to another chat-id spelling; any other failure is final, so a slow send is never sent twice. A 1:1 `chatId` is sent to its participant handle, because macOS 26+ chat GUIDs (`any;-;…`) do not always resolve through scripting; its account comes from the prefix, or for `any;` from the chat's last message service (SMS and RCS go through the SMS account); a group chat tries the `iMessage;+;` and `any;+;` spellings.
- **Not yet:** sending attachments or CAF voice bubbles, reading attachment bytes, polls (26+). The Messages.app send has no message id; the watcher (with `includeFromMe`) sees the sent row.
### Dictation (system-wide dictation, J9 / Q2)

| Capability | Side effect | Params → result |
| --- | --- | --- |
| `dictation.target` | read | `{}` → `{target: {pid, bundleId, appName, role, insertable, refusal?} \| null}` |
| `dictation.insert` | write | `text` (≤ 4000), `expectPid?` → `{method: "ax" \| "typed", chars, target}`; receipt "Dictated N characters into App", never the text |
| `dictation.watch` | read, streaming | `key: "fn" \| "rightOption" \| "rightCommand" \| null` → events `{key, down, at}` until a newer watch, `key: null` or cancel |

The Gateway forwards its `dictation.*` methods here for desktop callers only; `nodes.invoke` and agent tools never reach them. Inserted text is the owner's keystrokes into another app and never goes to the agent. Insertion order: set `kAXSelectedTextAttribute` (checked by reading the value back, since Chromium answers success and ignores it), then replace the selected range in `kAXValueAttribute` and move the caret, then unicode CGEvent typing through the HID tap (16 UTF-16 units per event). Refusals (`forbidden`-class `policy_denied`, `details.refusal`): `no_focus`, `own_window` (`com.psyche.desktop` / `com.psyche.helper`: the composer dictates there), `secure_field` (AX subrole `AXSecureTextField` or Carbon Secure Event Input, which also covers Electron apps without an AX tree), `not_editable` (a focused control with no caret; web areas and apps without AX fall through to typing), `focus_changed` (`expectPid` no longer has focus; re-checked before every typed chunk). Control characters, newlines and tabs included, collapse to one space, so dictation never presses Return or Tab. `dictation.watch` is a listen-only session tap on `flagsChanged` / `keyDown` using the device-dependent flag bit of the exact key, so Left Option does not trigger Right Option; a key pressed while the modifier is held (fn+arrow) is a chord and ends the hold at once. Holding fn alone can also open macOS's emoji picker or dictation on release: set System Settings › Keyboard › "Press 🌐 key to" to "Do Nothing", or pick Right Option.

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

### VM mode (L1–L5)

One sandbox Mac per user on Virtualization.framework, following spike 06 (`docs/spikes/spike-06-vz-provisioning.md`). Shapes live in `packages/protocol` `schemas/vm.ts`. Clients call these capabilities through `nodes.invoke`; the Permission Broker gates the writes.

| Area | Capabilities | Notes |
| --- | --- | --- |
| Status | `vm.status`, `vm.watch` (read; `vm.watch` streams) | `vm.watch` streams `{type: vm.updated, guest, at}` and `{type: vm.deleted, name}` for the Gateway's `vm.updated` broadcast |
| Create, install (L1) | `vm.restore_image` (read), `vm.create` (write, streaming) | Local `ipsw`, or `download: true` to confirm the ~26 GB download. Defaults 4 vCPU / 8 GB / 80 GB, and the host keeps ≥ 2 CPUs and 4 GB. One guest per user; installs count against the two-guest cap |
| Lifecycle (L1) | `vm.start`, `vm.stop`, `vm.pause`, `vm.resume`, `vm.suspend` (write); `vm.delete` (destructive) | Stop sends `guest.shutdown` through the guest helper, then `requestStop`, then `force`. `vm.suspend` saves the machine state, and the next start restores it; a failed restore is discarded and the guest boots cold. Spike 06 could not save on 27.0.1, so re-test |
| Provisioning (L2) | first `vm.start` | `VZMacGuestProvisioningOptions` on a 27 host with a 27 guest: admin user, auto-login, Remote Login, random password in the keychain. Other pairs: `provisioning_unsupported` (needs one guided step) |
| Settings (L1, L4, L5) | `vm.configure`, `vm.display` (write) | CPUs, memory and display size only while stopped. `clipboard`: off / paste-only (default) / bidirectional. `vault`: host (default) / guest. `vm.display` opens or hides a `VZVirtualMachineView` window (Take control) |
| Guest install (L3) | `vm.install_psyche`, `vm.grant_permissions` (write, streaming) | Install shares a Psyche release read-only (`/Volumes/My Shared Files/psyche-payload`), installs an SSH key with the provisioning password on first contact, then runs `guest-bootstrap.sh --vsock 2:7980` with the helper's `vsock-bridge`. Grant writes the guest helper's Accessibility and Screen Recording rows into the stopped guest's `TCC.db` offline (bundle id plus `csreq`) |
| Agent channel (L3) | `vm.agent_status` (read) | The guest helper listens on vsock 7000 (peer CID 2 only) and serves `guest.ping`, `guest.shutdown`, `guest.mount_shares` and `guest.export` as req/res frames. Root work uses the provisioning password sent per request, so there is no root daemon |
| Shares (L5) | `vm.share_add`, `vm.share_remove` (write, `targetKind: path`) | `psyche` VirtioFS tag at `/Volumes/Psyche Shares/<share>`. Read-only by default; read-write needs an approval. `/`, home, `~/Library`, system trees and `$PSYCHE_HOME` are never shared. Changes apply live |
| Snapshots (L6) | `vm.snapshot` (write, streaming); `vm.restore`, `vm.reset`, `vm.snapshot_delete` (destructive) | APFS clones (`clonefile`) of the stopped or saved guest's disk, `AuxiliaryStorage`, `state.json` and `SavedState.vzvmsave`, kept in `snapshots/<id>/`. Never the identity (`HardwareModel`, `MachineIdentifier`, MAC). `kind: base` is the "fresh Mac" `vm.reset` returns to; the previous base becomes manual. At most 10 manual snapshots; task snapshots are pruned to the newest 3. Restore clones beside the current files, then swaps them in, so a failed clone changes nothing. Non-APFS homes answer `clone_unsupported` |
| File transfer | `vm.copy_in`, `vm.copy_out` (write, `targetKind: path`, receipts) | In: copied (APFS clone) to `psyche-in/<id>/`, read-only in the guest. Out: the guest helper stages the file in `_psyche-out/<id>/`, then the helper moves it into a granted host folder and never overwrites |

- **vsock:** port 7980 relays guest psyche-node streams to the Gateway's node socket, where they pair like any node. Port 7000 is the guest helper. The guest IP is used only for the one-time SSH install, never as a control path.
- **Bundle:** `$PSYCHE_HOME/vm/<name>/` (0700) holds `config.json`, `state.json`, `shares.json`, `transfers.json`, `transfer/in`, `transfer/out`, `ssh/`, `SavedState.vzvmsave`, `HardwareModel`, `MachineIdentifier`, `AuxiliaryStorage`, `Disk.asif` or `Disk.img`, and `snapshots/` (L6).
- **Builds:** the macOS 26 SDK (CI) has neither DiskImageKit nor `VZMacGuestProvisioningOptions`, so those paths compile only with the 27 SDK (`canImport(DiskImageKit)`).
- **Tests:** the fake backend, shell, permission writer and guest agent cover the whole lifecycle, the agent protocol, transfers, install and permission ordering, `vm.watch`, and decoding against the protocol models. `PSYCHE_VM_LIVE_TESTS=1` runs a read-only catalog check. Nothing in tests downloads or boots.
- **Not built:** overlay resets (L6, P2), the 26-guest Data-volume path, and clipboard sync (the mode is stored and reported; the display pane or desktop enforces it).

### Apple app adapters (J6)

These are typed node capabilities. Their shapes are in `packages/protocol` `schemas/apple-apps.ts`. They are gated by the `apple.<app>` action matrix in `@psyche/permissions`: reads Allow, writes Ask, and `mail.send` always asks. Everything read from an app is `untrusted`.

| App | Capabilities (side effect) | How |
| --- | --- | --- |
| Calendar | `calendar.list_calendars`, `calendar.list_events` (read); `calendar.create_event`, `calendar.update_event` (write, `span: future` for a recurring series) | EventKit. The first call asks for full Calendars access (macOS has no read-only option). |
| Reminders | `reminders.list_lists`, `reminders.list` (read); `reminders.create`, `reminders.update` (write; `due: null` clears) | EventKit. Reminders access is asked on first use. |
| Mail | `mail.search`, `mail.read` (read); `mail.draft` (write: saved, not sent); `mail.send` (write) | Mail scripting. `mail.send` refuses without an `approvalId`, even if the Gateway forwards it, and the approval binds the exact recipients, subject and body. Message bodies are plain text, capped by `maxLength`. |
| Notes | `notes.list`, `notes.read` (read: HTML and plain text); `notes.create` (write: title plus plain text, HTML-escaped) | Notes scripting. |
| Finder | `finder.list`, `finder.reveal` (read, `targetKind: path`) | Only inside the owner's granted folders (`permissions.folders` in `$PSYCHE_HOME/config.json`). Nothing is granted by default. Symlinks are listed, never followed out. |
| Safari | `safari.tabs`, `safari.current_tab` (read); `safari.open_url` (write: http(s) only, a new tab in the user's Safari) | Safari scripting. Acting inside pages stays with the agent browser. |

The scripting adapters run constant AppleScript handlers (`psyche_search`, `psyche_compose`, …) with the inputs passed as handler arguments, so app content and model text never become script source. The helper launches the target app in the background if needed and asks for Automation per app on first use. Messages (J7) is a separate adapter.

### Teach mode (J8)

The owner demonstrates a flow and the helper turns it into a skill draft. The Gateway offers `teach.*` to the owner's devices only, never to the agent.

| Capability | Side effect | Notes |
| --- | --- | --- |
| `teach.start` | write (streaming, receipt `teach`, needs Accessibility) | `{name?, description?, app?, screenshots?, maxSteps? (≤ 200, default 100), maxSeconds? (10–1800, default 600)}`. Streams `teach.started`, then `teach.step` for each step; returns the draft when recording ends. Refused while a computer-use session runs (`computer_busy`) or another recording is active (`teach_busy`) |
| `teach.stop` | none | `{sessionId}` → the draft (the same one `teach.start` returns) |
| `teach.cancel` | none | `{sessionId}` → discards everything (`endedBy: cancel`, no steps, no files) |
| `teach.status` | read | `{active, sessionId?, steps?, startedAt?}` |

- **Recorder:** a listen-only session tap (left and right mouse down, key down), ignoring the helper's own `Input.marker` events. Targets come from the accessibility tree (`AXUIElementCopyElementAtPosition` for clicks, the focused element for keys): role, subrole, title or description, identifier, window title, app. It never reads `AXValue`.
- **Steps:** typing into one field is coalesced into one `type` step, and backspace edits it. Keys that are not text become `press` steps with `KeyChord` names (`cmd+s`, `return`). A second click becomes `double_click`.
- **Never recorded:**
  - text typed into a password field: `secure: true`, no text, and backspace is ignored there;
  - text typed while Secure Event Input is on (the field counts as secure, and taps get no keys anyway);
  - text typed into an element whose target cannot be read;
  - anything in Psyche, password managers, finance apps or system authority prompts: one `skipped` step with no target or text.
- **Screenshots** (`screenshots: true`, needs Screen Recording): the clicked app's largest window, 300 ms after the click, downscaled, never for apps `computer.screenshot` excludes. The bytes ride on the `teach.step` event, and the draft lists `screens/step-N.jpg` by path.
- **Draft:** `{sessionId, name, description, startedAt, endedAt, endedBy, steps, files}`. `SKILL.md` has frontmatter (`allowed-tools: ["computer.*", "apps.open", "apps.focus"]`, `metadata.psyche.source: teach`) and numbered steps that name targets by role and JSON-quoted label. App text is single-line, so a label cannot add lines to the skill. It parses with `packages/skills`' `parseSkill` and `manifestOf`.
- **Nothing is written to disk.** After the owner reviews the draft, the Gateway writes it to `workspace/skills/<name>/`, and T2's `skill_install` trust card makes it active.

## Entitlements and Info.plist

| Key | Where | Why |
| --- | --- | --- |
| Hardened runtime (`codesign -o runtime`) | signing | Developer ID, notarization |
| `com.apple.security.automation.apple-events` | entitlements | J4 |
| `com.apple.security.device.audio-input` | entitlements | microphone under the hardened runtime |
| `com.apple.security.personal-information.calendars`, `.addressbook` | entitlements | EventKit / Contacts (J6) |
| `keychain-access-groups` = `<TEAM>.com.psyche.helper`, `com.apple.application-identifier`, `com.apple.developer.team-identifier` | added by `build-app.sh` with `PSYCHE_HELPER_PROFILE` | data-protection keychain (restricted: needs an embedded provisioning profile) |
| `com.apple.developer.usernotifications.time-sensitive` | added when the profile carries it | time-sensitive approvals; otherwise they post as active |
| `com.apple.security.virtualization` | entitlements | VM mode (even the restore-image catalog needs it) |
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
