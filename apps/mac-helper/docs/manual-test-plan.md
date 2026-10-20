# Psyche Helper: manual test plan

CI runs the Swift Testing suites (framing, node runtime, snapshot builder against fake trees, tiers, key chords, hygiene rules, key wrapping, notification planning, speech helpers). Everything below needs a real Mac, real apps and real TCC grants, so it is run by hand before a release and after changes to the area.

## Setup

1. `apps/mac-helper/scripts/build-app.sh --install` (signed with your Developer ID or Apple Development identity; add `PSYCHE_HELPER_PROFILE=…` to test the keychain and time-sensitive notifications).
2. Start a Gateway (`apps/gateway`), then `open ~/Applications/Psyche\ Helper.app` or `apps/mac-helper/scripts/install-agent.sh`. Never start the binary from a shell: TCC would check the shell's responsible process instead of the helper (spike 04).
3. Drive capabilities with the Gateway's `nodes.invoke` (or a test client on the node socket). Watch logs with `log stream --predicate 'subsystem == "com.psyche.helper"'` and confirm they never contain params, values, note bodies or transcripts.
4. Reset grants between runs with `apps/mac-helper/scripts/tcc-reset.sh`.

Record for each row: macOS version, app version, pass/fail, and any surprise.

## 1. Signing, identity, launch (A9)

| # | Step | Expect |
| --- | --- | --- |
| 1.1 | Build, install, launch; check `codesign -dv` | Identifier `com.psyche.helper`, hardened runtime flag, your team |
| 1.2 | Grant Accessibility, rebuild with the same identity, reinstall at the same path | Grant survives (A9 "grants survive app updates") |
| 1.3 | Rebuild ad-hoc (`PSYCHE_SIGN_IDENTITY=-`) | Grant lost; `tcc-reset.sh` + re-grant recovers |
| 1.4 | First launch with a Gateway running | Helper appears as a node with its manifest; loopback auto-pairs with the handshake secret |
| 1.5 | Restart the Gateway | Helper reconnects within the backoff (≤ 30 s); same device id (no re-pairing) |
| 1.6 | Unsigned/no-profile build | `keychain.status` → `missing_entitlement`; log `identity_store=file`; `~/.psyche/helper/device.key` is 0600; `chmod 644` → helper refuses to start |
| 1.7 | `install-agent.sh`; log out and in | launchd starts the helper; `launchctl print gui/$(id -u)/com.psyche.helper` shows it running |

## 2. Permissions (A9)

| # | Step | Expect |
| --- | --- | --- |
| 2.1 | `permissions.status` after `tcc-reset.sh` | Every row `notDetermined`/`unknown`, `next: "accessibility"`, settings URLs present |
| 2.2 | `permissions.request {permission: accessibility}` | System prompt naming Psyche Helper; after enabling, status `granted`; `inputMonitoring` also reads granted |
| 2.3 | `permissions.request {permission: screenRecording}` without purpose | `invalid_params` (never asked up front) |
| 2.4 | … with `purpose: "vision_fallback"` | System prompt; "Allow For One Month" |
| 2.5 | `permissions.request {permission: automation, target: com.apple.Notes}` with Notes running / not running | Prompt once / `app_not_running` |
| 2.6 | `permissions.request {permission: fullDiskAccess}` | System Settings opens at Full Disk Access; no prompt |
| 2.7 | `permissions.open_settings` for each permission | The matching pane opens |

## 3. AX snapshots (J1)

Run `computer.ax_tree` against each app with the window frontmost, then again in the background. Note visited/emitted, time and whether the target controls appear.

| # | App / window | Expect |
| --- | --- | --- |
| 3.1 | TextEdit, new document | `textarea {set}` focused; toolbar and format controls labelled |
| 3.2 | Notes, list + note | Note rows collapsed to one label with `custom:pin/Share/trash`; body `textarea {set}` |
| 3.3 | Finder, list view | Visible rows only; sidebar rows labelled; path bar present |
| 3.4 | Mail (account configured) | Message list as table rows; message body as `webarea` |
| 3.5 | Reminders | Rows with title, date, status; onboarding sheets visible when present |
| 3.6 | System Settings › Appearance | `#com.apple.settings.*` identifiers; `selected` on the active theme |
| 3.7 | Electron app (spikes/ax-snapshot/electron-form), frontmost | `webarea` appears within ~3 s; labels from `<label>`; `ph=` placeholders |
| 3.8 | A React-based Electron form | `set` on a controlled input fires React's onChange (the value sticks after blur) |
| 3.9 | Same Electron app in the background | Sparse tree → `hint: sparse_tree…` |
| 3.10 | Password field focused (Safari login, any app) | Value `•••`, `secure` flag, never walked into |
| 3.11 | `root: "app"` with a popover or menu open | Popover/menu items present |
| 3.12 | Large Finder folder (thousands of files) | Bounded by AXVisibleRows; no TRUNCATED; < 200 ms warm |
| 3.13 | `maxEmit: 20` | Header shows `TRUNCATED(maxEmit)` |

## 4. Actions and input (J2)

| # | Step | Expect |
| --- | --- | --- |
| 4.1 | Notes: `computer.click` "New Note" (AXPress), then `computer.set_value` on the focused body `"Title\nBody"` | Note created, status `ok` "verified after … ms" (J2 done-when) |
| 4.2 | Reminders: `computer.select` the list row, `computer.click` "Add Reminder", `computer.type` text, `computer.key return` | Reminder created (J2 done-when) |
| 4.3 | Finder rename: `computer.select` row, `computer.menu File>Rename`, `computer.set_value` on the detached focused field, `computer.key return` | File renamed on disk |
| 4.4 | `computer.set_value` on a Finder list name cell that is not focused | Refused `cosmetic_field` (spike 04 incident 3 regression) |
| 4.5 | Act on a ref after the element was removed (delete the note, then reuse its ref) | `not_found/stale_ref` (incident 1 regression) |
| 4.6 | Act with an `expect.label` that no longer matches (Reminders button relabelled "Add Item") | `conflict/expectation_failed` |
| 4.7 | `selector {role: "button", label: "Add"}` when "Add Reminder" and "Add List: Groceries" exist | `selector_no_match`; two equal labels → `selector_ambiguous` (incident 2 regression) |
| 4.8 | Press "Add List: Groceries" or a `custom:trash` action without approval | `approval_required/risky_label` |
| 4.9 | `computer.double_click`, `computer.right_click` (AXShowMenu), `computer.scroll dy:-10`, `computer.drag` a slider | Each works; receipts recorded |
| 4.10 | `computer.key cmd+q` without approval | `approval_required/risky_chord` |
| 4.11 | `computer.type` into a password field (by ref and by focus) | `policy_denied/secure_field` in both cases |
| 4.12 | Electron `<select>`: focus it, `computer.key o` | Option selected (keycode typeahead) |
| 4.13 | Type a 2,000-character paragraph with emoji and accents into TextEdit | Text arrives intact, no split graphemes |

## 5. Tiers, session lock, Esc (J5, F6)

| # | Step | Expect |
| --- | --- | --- |
| 5.1 | No `computer-use.json`: click in Notes | `approval_required/tier_ask`; with an `approvalId`, allowed for 30 minutes, then asks again |
| 5.2 | `{"apps": {"com.apple.Notes": "read"}}`: click in Notes | `policy_denied/tier_read` with a visible reason (F6 done-when) |
| 5.3 | Safari with `interact` in settings | Reads work; any write → `tier_read`, "use the agent browser" |
| 5.4 | Terminal / VS Code | Click works; type/key/right-click/drag → `tier_click` |
| 5.5 | 1Password, a banking app, Psyche desktop | Everything → `tier_off`; never in screenshots |
| 5.6 | Two runs (`session: a`, `session: b`) acting at once | Second gets `conflict/computer_busy`; after `computer.end_session` or 2 min idle it proceeds |
| 5.7 | During a long `computer.type` or `computer.scroll`, press Esc | Stops within 200 ms (J5 done-when); result `cancelled/user_stopped`; the Esc never reaches the app |
| 5.8 | After 5.7, the same session acts again | `user_stopped`; a new session id works |
| 5.9 | Esc with no session active | Reaches the app normally |
| 5.10 | `computer.key escape` from the agent during a session | Delivered to the app (tagged events are not treated as the user's Esc) |

## 6. Screenshots (J3)

| # | Step | Expect |
| --- | --- | --- |
| 6.1 | Without Screen Recording | `forbidden/permission_missing` (`permission: screenRecording`) |
| 6.2 | With it, Terminal, Psyche and 1Password visible | Those windows are absent from the image; wallpaper shows through |
| 6.3 | Retina display | Image ≤ 1372×887, aspect kept; `pointsPerPixel` maps back to clicks |
| 6.4 | Focus a password field, then screenshot | `policy_denied/secure_field_focused` |
| 6.5 | `windowOnly: true` for TextEdit | Only that window |
| 6.6 | `computer.screenshot_pick` | System picker; Psyche windows not offered; capture works with no Screen Recording grant; Cancel → `cancelled` |
| 6.7 | Leave the vision fallback unused for a month | No re-consent prompt appears (J3 done-when) |

## 7. Apple Events and Shortcuts (J4)

| # | Step | Expect |
| --- | --- | --- |
| 7.1 | `apps.applescript {source: "tell application \"Notes\" to count notes", target: "com.apple.Notes"}` | Automation prompt once, then the count |
| 7.2 | Deny Automation for Notes, run again | `forbidden/automation_denied` |
| 7.3 | Script with `do shell script` | `policy_denied/shell_escape` |
| 7.4 | `apps.jxa {source: "Application('Notes').notes().length"}` | Count |
| 7.5 | `apps.shortcut_run {name: "<a user shortcut>", input: "hi"}` | Its text output (J4 done-when) |
| 7.6 | A shortcut that needs a permission the helper has (e.g. Calendars) | Runs under its own identity (disclaimed), not the helper's grant |
| 7.7 | `apps.open {app: "com.apple.TextEdit"}`, `apps.focus {app: "TextEdit", window: 0}` | Opens/raises |

## 8. Keychain (G1, S06 contract) — Touch ID

| # | Step | Expect |
| --- | --- | --- |
| 8.1 | `keychain.status` with the profile | `available`, biometry available |
| 8.2 | `keychain.set {service: com.psyche.vault, account: test, value, accessControl, …}` | No prompt; `{}` |
| 8.3 | `vault.unlock {…, reason: "unlock your Psyche vault", reuseDurationSeconds: 0}` | Touch ID sheet naming Psyche Helper with the reason; value matches; immediately again → prompts again |
| 8.4 | Cancel the sheet | `cancelled` |
| 8.5 | "Use Password…" / lid closed | Login password works |
| 8.6 | Five failed fingers | Record: `biometry_lockout`, `auth_failed` or password fallback |
| 8.7 | Add or remove a fingerprint, unlock again | Fails (biometryCurrentSet invalidated); vault recovery key path works |
| 8.8 | Cancel the invocation while the sheet is up | Sheet closes, `cancelled` |
| 8.9 | Lock the screen during an unlock | Record behaviour |
| 8.10 | `keychain.delete` then `vault.unlock` | `not_found/item_not_found` |
| 8.11 | File identity present, launch a profile-signed build | `identity_migration=file_to_keychain`, same device id, key file removed |

## 9. Notifications (O10)

| # | Step | Expect |
| --- | --- | --- |
| 9.1 | Fresh grants: `notify.show` | `forbidden/permission_not_determined` |
| 9.2 | `notify.request_authorization {}` | No prompt; `provisional`; banner goes quietly to Notification Center with Keep / Turn Off |
| 9.3 | `{provisional: false}` | Prompt; Allow → `authorized` |
| 9.4 | Open `notify.subscribe`; show an approval with `requireBiometry: true`; click Approve | Touch ID, then `{type: notify.response, actionId: approve, authenticated: true}` (O10 done-when) |
| 9.5 | Cancel Touch ID / click Deny / tap the banner | `authenticated: false, authError: user_cancelled` / no Touch ID / `actionId: default` |
| 9.6 | `input_needed` with a reply | `actionId: reply`, `text` and `replyText`; the log holds no reply text |
| 9.7 | Quiet hours covering now (also overnight 22:00–07:00) | `quietHoursApplied: true`, passive, silent |
| 9.8 | Focus on, time-sensitive allowed / disallowed / no entitlement | Approval breaks through / does not / falls back to active |
| 9.9 | Three clicks with no subscriber, then subscribe | All three arrive in order |
| 9.10 | `notify.withdraw`; re-show the same id | Removed; replaced, not stacked |
| 9.11a | Profile-signed build: `presence.public_key` | 65-byte X9.63 key, `keyId` = SHA-256; same key on every call and after restart |
| 9.11b | Approval with `requireBiometry` + `presenceChallenge`; Approve | One Touch ID prompt; event has `presence {signature, keyId}`; Gateway accepts it once the key is registered |
| 9.11c | Same, Cancel / use password / re-enrol a finger | Cancel → no presence; password alone cannot sign (`biometryCurrentSet`); after re-enrolment the old key fails: record what happens and re-register |
| 9.11d | Unsigned build, approval with a challenge | `presenceError: missing_entitlement`; the Gateway keeps the approval refused |
| 9.11 | S15's Notifier payload (`category`, `interruptionLevel`, `textInput` action) | Accepted; the text-input action becomes the reply field |

## 10. Speech (Q1)

See the speech section of the README for engine selection. On macOS 26+:

| # | Step | Expect |
| --- | --- | --- |
| 10.1 | `speech.transcribe_stream {source: microphone}` and speak | Microphone prompt once; first partial in < 500 ms (Q1 done-when); finals replace partials |
| 10.2 | With `vocabulary: ["Psyche", "<a contact name>"]` | DictationTranscriber; the names come out right |
| 10.3 | `source: push` with 16 kHz PCM chunks via `speech.audio_push`, then `speech.stop` | Same transcript as the file |
| 10.4 | Two microphone streams | Second → `conflict/microphone_busy` |
| 10.5 | `speech.synthesize {text}` | PCM chunks play back cleanly; `nonCommercial: false` |
| 10.6 | `personalVoice: true` with and without Personal Voice authorization | Uses it and flags `nonCommercial: true` / falls back to a system voice |
| 10.6a | `contacts.list {limit: 500, fields: ["name"]}` before / after granting Contacts | No prompt and `forbidden/permission_denied` / names in family-name order, no phones or emails; `truncated` when over the limit |
| 10.7 | macOS 15 machine | SFSpeechRecognizer on-device engine; Speech Recognition prompt |

## 11. VM mode (L1–L5) — run on a host with more than 16 GB, one guest at a time

Spike 06 restarted a 16 GB host under two guests plus an install. Never run these in CI.

| # | Step | Expect |
| --- | --- | --- |
| 11.1 | `vm.restore_image` on a signed build | Latest version, build and size; unsigned build → `unavailable/virtualization_entitlement` |
| 11.2 | `vm.create {}` then `vm.create {download: true}` (or `ipsw: <path>`) | First: `download_not_confirmed` with the size; then download, install (~5 min on 27), `phase: installed` |
| 11.3 | `vm.start` (27 host and guest) | Provisioning boot; SSH reachable in about 40 s; `phase: running`; the admin password is in the keychain (`vm.sandbox.password`) |
| 11.4 | Guest `guest-bootstrap.sh --vsock 2:7980` | psyche-node connects through the relay; a pending pairing appears on the host; approve it and the guest node shows in `nodes.list` |
| 11.5 | `vm.share_add {share: "work", path: ~/Projects/x}` while running | Guest sees `/Volumes/Psyche Shares/work` (after mount); writes fail with EPERM; `readOnly: false` without approval → `approval_required` |
| 11.6 | `vm.share_add` with `~`, `~/Library`, `~/.psyche`, `/` | `share_forbidden` |
| 11.7 | `vm.stop`, then `vm.stop {force: true}` | Without a guest helper: `guest_did_not_stop`; force → `graceful: false` |
| 11.8 | `vm.create` a second guest | `guest_exists` |
| 11.9 | Start while two other macOS guests run (e.g. Tart) | `guest_limit` (Code 6 text) |
| 11.10 | Re-test `saveMachineStateTo` from the signed helper | Record whether warm start works (spike 06 got Code 11) |

## 12. Messages (J7) — needs Full Disk Access and Automation for Messages; use a test contact

| # | Step | Expect |
| --- | --- | --- |
| 12.1 | Without Full Disk Access: `messages.status`, `messages.read {limit: 5}` | `fullDiskAccess: false`, no prompt; read → `forbidden/full_disk_access_missing` naming Settings › Full Disk Access |
| 12.2 | Grant Full Disk Access, `messages.read {handle: "<contact>", limit: 20}` | The last 20 messages, ascending, texts match Messages.app (including ones only in `attributedBody`) (J7 done-when, read half) |
| 12.3 | `messages.chats {limit: 10}` | Newest first; group names and participants right; SMS chats `service: sms` |
| 12.4 | `messages.watch {}`; receive a text, a tapback, a photo and a voice note | One `messages.new` per poll; tapback as `reaction`; photo / voice as metadata (`isVoiceNote: true`), no paths |
| 12.5 | `messages.send` without `approvalId` | `approval_required`; nothing sent |
| 12.6 | Approved `messages.send {to: "<contact>", text: "test \"quote\""}` | Automation prompt once (Messages launched hidden if closed); the text arrives verbatim; receipt has no text (J7 done-when, send half) |
| 12.7 | Deny Automation in Settings, send again | `forbidden/automation_denied` |
| 12.8 | Approved send to a group `chatId` on macOS 26+ | Delivered via the `any;+;` fallback if needed; record which spelling worked |

## 13. Apple app adapters (J6)

| # | Step | Expect |
| --- | --- | --- |
| 12.1 | `calendar.list_events` with no Calendars grant | System prompt once; then events; denied → `permission_missing/calendars` |
| 12.2 | `calendar.create_event` then `calendar.update_event {span: future}` on a recurring event | Event appears in Calendar; the series changes from that date |
| 12.3 | `reminders.create` with `due`; `reminders.update {completed: true}`; `{due: null}` | Shows, completes, clears the due date |
| 12.4 | `mail.search {query: "invoice"}` and `mail.read` (Mail not running) | Mail launches hidden; Automation prompt once; plain-text body |
| 12.5 | `mail.draft` | A draft appears in Drafts; nothing sent |
| 12.6 | `mail.send` through the Gateway | Approval card with the exact recipients and body; sent only after approval; without `approvalId` → `send_needs_approval` |
| 12.7 | `notes.create {title, body: "<b>x</b>"}` and `notes.read` | The note shows the literal `<b>x</b>`; read returns HTML and text |
| 12.8 | `finder.list` with no granted folders / inside / outside / through a symlink out | `no_granted_folders` / entries / `outside_granted_folders` / refused |
| 12.9 | `safari.tabs`, `safari.current_tab`, `safari.open_url` | Tabs and URLs; a new tab; `file:` and `javascript:` refused |
