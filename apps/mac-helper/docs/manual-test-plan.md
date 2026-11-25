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
| 3.7 | Electron app (docs/archive/spikes/ax-snapshot/electron-form), frontmost | `webarea` appears within ~3 s; labels from `<label>`; `ph=` placeholders |
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
| 9.11a | `presence.public_key` | `kind: device_identity`, `algorithm: ed25519`, a 32-byte key equal to the helper's device public key (the one the Gateway paired); same on every call and after restart; no sheet, no keychain prompt |
| 9.11e | Allow on a payment card in the Psyche window (a purchase) | One system sheet (Touch ID, with "Use Password…"), naming the card and its code ("approve code xxxx-xxxx: “…” in Psyche"), the same code the card shows; touching or typing the password approves it once, Cancel leaves it pending with no error and no second sheet; no notification and no keychain dialog |
| 9.11f | Quit the helper, then Allow on a payment card in the window | The card says Psyche Helper isn't running and offers Start Psyche Helper; after it pairs nothing is approved until Allow is clicked again |
| 9.11g | Psyche in front, a new approval arrives | The helper's banner still shows (`willPresent` returns banner, list, sound for non-passive kinds) |
| 9.11b | Approval with `requireBiometry` + `presenceChallenge`; Approve | One system sheet; event has `presence {signature, keyId}`; the Gateway accepts it once, with no registration step |
| 9.11c | Same, Cancel / wrong password / use the password instead of a finger | Cancel → `authenticated: false, authError: user_cancelled`, no presence, no second sheet; wrong finger or password retries inside the sheet; the Mac password approves; adding or removing a fingerprint changes nothing |
| 9.11d | Self-signed build with no provisioning profile | Approvals still sign (the device identity is a file under `$PSYCHE_HOME/helper`), with no keychain dialog ("wants to access your keychain") at any point |
| 9.11h | Self-signed build, update and reinstall | After reinstalling signed with another certificate or ad-hoc, the next approval signs with no prompt other than the owner sheet; `psyche-helper --print-identity` prints only `{deviceId}` and creates nothing |
| 9.11j | Allow on any non-payment card (a credential fill, a host command) in the window and via the notification's Approve | One tap approves it: no system sheet, no helper signature, `presence.confirm` is never called |
| 9.11 | S15's Notifier payload (`category`, `interruptionLevel`, `textInput` action) | Accepted; the text-input action becomes the reply field |

## 10. Speech (Q1)

See the speech section of the README for engine selection. On macOS 26+:

| # | Step | Expect |
| --- | --- | --- |
| 10.1 | `speech.transcribe_stream {source: microphone}` and speak | Microphone prompt once; first partial in < 500 ms (Q1 done-when); finals replace partials |
| 10.2 | With `vocabulary: ["Psyche", "<a contact name>"]` | DictationTranscriber; the names come out right |
| 10.3 | `source: push` with 16 kHz PCM chunks via `speech.audio_push`, then `speech.stop` | Same transcript as the file |
| 10.3a | `source: push, preset: short`, then `preset: long`, five spoken questions each (your own voice, pushed from a recording you made for the test), then `speech.status` | `engine: dictationTranscriber` for short without a vocabulary; `preset` and `finalizeMs` in each result; `timings.firstPartialMs` and `finalizeMs` with `long` and `short` medians |
| 10.4 | Two microphone streams | Second → `conflict/microphone_busy` |
| 10.6a | `contacts.list {limit: 500, fields: ["name"]}` before / after granting Contacts | No prompt and `forbidden/permission_denied` / names in family-name order, no phones or emails; `truncated` when over the limit |
| 10.6b | `speech.transcribe_file {path}` on a 60–90 min test recording of your own in a granted folder (not someone else's meeting) | `speech.progress` after each 10-minute chunk; one result with no repeated or missing sentence at the 10:00 / 20:00 marks; `audioMs` matches the file; `provenance: untrusted` |
| 10.6c | The same with a path outside the granted folders, a folder, a text file, and a file over `maxDurationMs` | `policy_denied/outside_granted_folders`, `not_found`, `invalid_params/unsupported_audio`, `invalid_params/too_long`, each before any audio is read |
| 10.7 | macOS 15 machine | SFSpeechRecognizer on-device engine; Speech Recognition prompt |
| 10.8 | `dictation.watch {key: null, keys: [{key: fn, role: dictation}, {key: rightOption, role: voice}]}`; hold each key, then both, then fn+arrow | One initial `down: false` per key with its role; each hold and release reports its own key and role; fn+arrow ends the fn hold at once; `dictation.watch {key: fn}` alone still sends events without `role` |

## 11. VM mode (L1–L5): run on a host with more than 16 GB, one guest at a time

Spike 06 restarted a 16 GB host under two guests plus an install. Never run these in CI or on a 16 GB machine.

| # | Step | Expect |
| --- | --- | --- |
| 11.1 | `vm.restore_image` on a signed build | Latest version, build and size. An unsigned build → `unavailable/virtualization_entitlement` |
| 11.2 | `vm.create {}` then `vm.create {download: true}` (or `ipsw`) | First call → `download_not_confirmed` with the size. Second → download, install (~5 min on 27), `phase: installed` |
| 11.3 | `vm.start` (27 host and guest) | Provisioning boot; SSH in about 40 s; `phase: running`; `vm.sandbox.password` in the keychain |
| 11.4 | `vm.install_psyche {payload: <release>}` | Key installed, `guest-bootstrap.sh` runs, `psycheInstalled: true`. A pending pairing appears for the guest node; approve it |
| 11.5 | `vm.stop`, `vm.grant_permissions`, `vm.start`, `vm.agent_status` | Agent `connected`, `accessibility: true`, `screenRecording: true`, no prompts in the guest |
| 11.6 | `vm.stop` with the agent running | `graceful: true` in about 16 s, no `fsck` on the next boot |
| 11.7 | `vm.pause` / `vm.resume`; `vm.suspend` then `vm.start` | Phases change. Record whether the warm start works (spike 06 saw code 11); on failure the guest boots cold |
| 11.8 | `vm.share_add {share: work, path: ~/Projects/x}` while running | `/Volumes/Psyche Shares/work` after `guest.mount_shares`. Writes fail with EPERM. `readOnly: false` without approval → `approval_required` |
| 11.9 | `vm.share_add` with `~`, `~/Library`, `~/.psyche`, `/` | `share_forbidden` |
| 11.10 | `vm.copy_in` a file; `vm.copy_out` it back to a granted folder | Appears under `psyche-in/<id>/` in the guest; back on the host as `name 2.ext`, never overwriting |
| 11.11 | `vm.display {visible: true}` | A window with the guest desktop; keyboard and mouse work |
| 11.12 | `vm.configure {cpus: 6}` while running, then stopped | `vm_running`, then applied on the next boot |
| 11.13 | `vm.create` a second guest; start while two other macOS guests run | `guest_exists`; `guest_limit` |
| 11.14 | `vm.watch` open during 11.2–11.7 | One `vm.updated` per change; `vm.deleted` after `vm.delete` |
| 11.15 | `vm.delete` | Bundle, transfers and the stored password are gone |

## 12. Messages (J7) — needs Full Disk Access and Automation for Messages; use a test contact

| # | Step | Expect |
| --- | --- | --- |
| 12.1 | Without Full Disk Access: `messages.status`, `messages.read {limit: 5}` | `fullDiskAccess: false`, no prompt; read → `forbidden/full_disk_access_missing` naming Settings › Full Disk Access |
| 12.2 | Grant Full Disk Access, `messages.read {handle: "<contact>", limit: 20}` | The last 20 messages, ascending, texts match Messages.app (including ones only in `attributedBody`) (J7 done-when, read half) |
| 12.3 | `messages.chats {limit: 10}` | Newest first; group names and participants right; SMS chats `service: sms` |
| 12.4 | `messages.watch {}`; receive a text, a tapback, a photo and a voice note | One `messages.new` per poll; tapback as `reaction`; photo / voice as metadata (`isVoiceNote: true`), no paths |
| 12.4a | `mail.search {unread: true, since: <yesterday>}`, then `{from: "<a sender>"}`, then `{}` (#626) | Only unread mail received since yesterday, newest first; then only that sender; then the inbox, newest first. A large inbox answers in seconds |
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
| 12.3a | Reminders wave 1 (§4.2): `reminders.list {overdue: true}`, `{dueToday: true}`, `{query: "milk"}`, `{flagged: true}` | Only open past-due / due today / matching, soonest due first; `flagged` asks for Automation of Reminders once and returns only flagged ones with `flagged: true` |
| 12.3b | `reminders.create {title, due, url: <mail link from mail.read>, alarm: {relativeMinutes: -30}, recurrence: {frequency: weekly, daysOfWeek: [mo]}}` | In Reminders with the link (opens the mail), an alert 30 min before, repeating Mondays |
| 12.3c | `reminders.complete {title: "<one open title>"}`, then with a title two reminders share, then `{id, completed: false}`; `reminders.set_flagged {id, flagged: true}`; `reminders.delete {id}` | Completed; `reminder_ambiguous` listing both ids; reopened; the flag shows in Reminders; gone (the Gateway asked first) |
| 12.2a | Calendar wave 1 (§4.3): `calendar.list_events {from, to, query: "standup"}` on a Zoom / Meet invite with attendees | Only matching events; `conferenceUrl` is the meeting link; attendees with their statuses and the organizer marked |
| 12.2b | `calendar.free_busy {from, to}` over a day with a busy, a tentative and a free event | Two blocks (busy, tentative) in start order, no titles |
| 12.2d | `calendar.watch {}` held open on a test calendar, then add three events within 10 s, then one more a minute later | One `calendar.changed {coalesced ≥ 3}` about 30 s after the first add, then one more; nothing while idle; without Calendars access `permission_missing` and no prompt |
| 12.2c | `calendar.create_event {…, alarms: [{relativeMinutes: -10}], recurrence: {frequency: daily, count: 3}, availability: free}`; `calendar.update_event {id, recurrence: null}`; `calendar.delete_event {id, span: future}` on a series | Alert 10 min before, three days, shown as free; the repeat removed; that day and later gone, earlier ones kept |
| 12.7a | Notes wave 1 (§4.4): `notes.search {query: "<word in a body>"}`, `{folder, modifiedSince}`; `notes.folders {}` | Matches by body as well as title, newest first, with a snippet around the word; the folder tree with nested folders under their parent and note counts |
| 12.7b | `notes.read {id}` on a note with an image; `notes.append {id, text: "eggs\nbread", checklist: true}` | `attachments` lists the image; two "☐" lines at the end, the rest of the note untouched |
| 12.7c | `notes.update {id, previousBodySha256: <from read>, body: "new"}`; edit the note in Notes, then update again with the old hash; `{id, previousBodySha256, title: "Renamed"}` | Body replaced (title kept as the first line); `note_changed`, nothing overwritten; renamed |
| 12.7d | `notes.create {title, body: "# H\n- **a**\n[x](https://example.com)", format: markdown}` | A heading, a bullet with bold and a working link; `<script>` in the body shows as text |
| 12.8a | Contacts wave 1 (§4.5): `contacts.search {query: "<first name>"}`, `{query: "<last 4 digits of a phone>"}`, `{query: "<company>"}` | Best match first (exact / prefix names before later words); phone and company matches |
| 12.8b | `contacts.read {id}` on a contact with a note, a birthday without a year and a group | Everything but the note; `birthday: "--MM-DD"`; the group name |
| 12.8c | `contacts.create {givenName, emails: [{label: work, value}]}`, then `contacts.update {id, addPhones: [{label: mobile, value}], addEmails: [<same email>]}` | The contact in Contacts with a Work email; the mobile added, the email not duplicated |
| 12.9a | Music wave 1 (§4.6): with Spotify playing, `music.now_playing {}`; with nothing open, again; `music.control {action: pause}` | Spotify's track and position; `stopped` and no app opens; pause does nothing when closed, and pauses when playing |
| 12.9b | `music.control {app: music, action: volume, volume: 30}`, `{action: shuffle, shuffle: true}`, `{action: next}` | Music's volume, shuffle and next track change |
| 12.9c | `music.search_library {query: "<an album>"}`, then `music.play` an album, a playlist (`shuffle: true`) and a track | Album, artist, track and playlist hits, best first; the album plays in order from the "Psyche" playlist (nothing else in the library changes); the playlist shuffled; the track |
| 12.10a | Safari and Chrome wave 1 (§4.7): `safari.tab_text {}` on an article, then `{window: 0, index: <another tab>, maxLength: 500}` | The article's text (untrusted), then 500 characters of the other tab with `truncated: true` |
| 12.10b | `safari.add_reading_list {url: "https://…", title}`; `{url: "javascript:…"}` | In Reading List; `invalid_params` |
| 12.10c | `chrome.tabs {}` and `chrome.current_tab {}` with Chrome open; then quit Chrome and call `chrome.tabs` | Titles and URLs with the active tab marked; `[]` and Chrome stays closed |
| 12.11a | Files wave 1 (§4.8) with ~/Downloads granted: `files.recent {folder: "~/Downloads", contentTypes: ["pdf"]}` after downloading two PDFs and an image | The two PDFs, newest added first, with `added` and `contentType` |
| 12.11b | `files.move {items: [{path: <pdf>, to: "~/Downloads/Bills", name: "2026-10 bill.pdf"}]}`; repeat with a name that exists; move to a folder outside the grants | Moved and renamed; `file_exists`, nothing moved; `outside_granted_folders` |
| 12.11c | `files.trash {paths: [<file>, <symlink to a file elsewhere>]}`, then Put Back in Finder | Both in the Trash (the link's target untouched); Put Back restores them; the Trash is not emptied |
| 12.12a | Shortcuts wave 1 (§4.9): `shortcuts.list {}` | Every shortcut with its id, folder, accepts input and action count (Automation of Shortcuts Events asked once); if refused, names and ids from the CLI |
| 12.12b | `shortcuts.run {id: <a shortcut that returns a dictionary>}`, `{id: <one with text input>, input: "hi"}`, `{id: <one with a Wait 30 s>, timeoutSeconds: 5}` | `outputType: json`; the text echoed back; `timeout` after 5 s |
| 12.12c | `apps.shortcut_run {name}` and `apps.shortcuts_list {}` | Same behaviour as before (names) |
| 12.13a | Things wave 1 (with Things 3 installed): `things.list {list: today}`, `{list: project, name: <a project>, query: <word>}` | Today's to-dos with when / deadline / tags; only that project's matching to-dos (Automation of Things asked once) |
| 12.13b | `things.add {title, when: "2026-11-01", tags: [<existing tag>], checklist: [a, b]}` | In Things for that day with the tag and two checklist items; Things not brought to the front |
| 12.13c | `things.update {id, authToken, deadline: null, addTags: [x]}`, `things.complete {id, authToken, status: canceled}`; then with a wrong token | Deadline cleared, tag added; canceled; Things shows its own "wrong token" message and nothing changes |
| 12.6a | Mail wave 1 (apple-apps-2026 §4.1): `mail.mailboxes {}` | Every account's mailboxes, nested ones as `Parent/Child`, unread counts match Mail's sidebar; the unified `INBOX` first; `special` set for inbox / sent / drafts / junk / trash / archive |
| 12.6b | Select two messages in Mail, `mail.selected {}`; then quit Mail and call it again | The two, newest first, each with a `message://` link that opens it; with Mail quit: `[]` and Mail stays closed |
| 12.6c | `mail.read {id}` on a message with attachments | `summary.link` opens the message from a reminder; `attachments` lists names, sizes and types (nothing saved) |
| 12.6d | `mail.reply_draft {id, body: "Thanks"}`, `{replyAll: true}`, and `mail.forward_draft {id, to: [<you>]}` | Drafts in Drafts with Mail's quoting and threading (Re: / Fwd:, In-Reply-To); "Thanks" above the quote; nothing sent; each returns `draftId` and `bodySha256` |
| 12.6e | Approved `mail.send_draft` with the returned draft; then edit a second draft's subject in Mail and send it with the old values; then quit Mail and send a third | Sent; `binding_mismatch/draft_changed` naming `subject`; `not_found/draft_not_open` (send it from Drafts). Without `approvalId` → `send_needs_approval` |
| 12.6f | `mail.set_flags {ids: [2 ids], read: false, flagColor: 3}`, then `{flagged: false}` | Both unread with a green flag; then unflagged |
| 12.6g | `mail.move {ids, to: "archive"}`, `{to: "junk"}`, `{to: {mailbox: "Receipts", account: <acct>}}` | In Archive / Junk (marked junk) / Receipts; an account without an Archive mailbox → a clear error, nothing moved |
| 12.6h | `mail.save_attachments {id, folder: <granted>}`, then `{id}` (Library), then `{id, folder: "/etc"}` | Files in the folder with safe, unique names; staged under `$PSYCHE_HOME/helper/staging/mail-…` with `stagedPath`; `outside_granted_folders` |
| 12.7 | `notes.create {title, body: "<b>x</b>"}` and `notes.read` | The note shows the literal `<b>x</b>`; read returns HTML and text |
| 12.8 | `finder.list` with no granted folders / inside / outside / through a symlink out | `no_granted_folders` / entries / `outside_granted_folders` / refused |
| 12.9 | `safari.tabs`, `safari.current_tab`, `safari.open_url` | Tabs and URLs; a new tab; `file:` and `javascript:` refused |

## 13b. Record in an app (J8 phase 2): use a throwaway Mail account or Notes, never real mail

**Needs a real run by the owner before release:** the live AXObserver, the per-process mouse tap and the status item are compile-checked only (their decisions and the run-loop thread are unit-tested).

The AXObserver source cannot run in unit tests; this is its check. Grant the app in Settings → Computer use first (Interact), and Accessibility to the helper.

| # | Step | Expect |
| --- | --- | --- |
| 13b.1 | Psyche → browser pane → "Record in an app": the list shows only the apps you allowed; open Mail, pick it, Start | A "● Recording Mail" item appears in the menu bar and the pane shows the recording bar. No screenshot permission prompt appears |
| 13b.2 | In Mail: click "New Message", type a Subject, choose File ▸ Close or another harmless menu item | The count in the bar goes up; typing in one field is one step |
| 13b.3 | Type into a password field of any sheet (add a mail account, cancel before saving), and into a field labelled "Verification code" | The review shows the step as "you type into ‘…’ yourself" with no value; the pane never shows the text. With Secure Event Input on (a password field has focus) nothing typed elsewhere is kept either |
| 13b.4 | Switch to Notes (or Psyche) and click and type there | Nothing is recorded from the other app; Psyche's own windows never add a step |
| 13b.5 | Trigger a macOS password sheet (System Settings ▸ unlock) while recording | Nothing is recorded from it; the review says some input was left out |
| 13b.6 | Choose "Stop recording" from the menu-bar item | Recording ends and the pane offers Review with the steps; the menu-bar item is gone |
| 13b.7 | Start again, quit Mail | Recording ends ("the app closed"), the steps wait for Review |
| 13b.8 | Review, name it, Save, approve the card ("Install skill from your recording", tainted wording about an app) | Installed; "Run it once now" fills the message box |
| 13b.9 | Run it with Mail closed, then with the New Message button renamed or hidden | `app_not_running`-style stop; `computer.check_target` answers missing and the agent asks, it does not pick a similar control |
| 13b.10 | Start a computer-use run, then try Record | `computer_busy` |
| 13b.11 | Start recording, close Psyche | The menu-bar Stop still works; steps are held only until collected (30 min) |
| 13b.12 | Open a window titled "Two-factor authentication" (or any sheet with a label such as "Enter the code" beside a bare box) and type digits | The step is marked as yours to type, with no value; the review never shows the window title or the label |
| 13b.13 | Click Start and immediately Stop (menu bar) or Discard, several times | No "● Recording" item is left behind, no recording keeps running, a new Start works |
| 13b.14 | Focus a field that is already filled (Mail's "Re: " subject), add a word; then autofill a field and leave it | Only the added word is recorded; the autofilled field makes no step |
| 13b.15 | Switch to another app or to a system sheet while a field has focus, then type | Nothing is recorded for the typing; the last field's step ends |
| 13b.16 | Choose File > Open Recent > a document; click a message row and a pop-up button showing a document name | Steps read "File > Open Recent", "a row" and "a pop-up": no document or message names |
| 13b.17 | While recording, ask the agent to open or focus an app or run a script | Refused with a clear "recording" reason until you stop |

## 14. Install from DMG (bundled helper)

The contract is in `docs/archive/status/s14.md` "Packaging". Build a DMG with `deploy/macos/build-helper.sh`, then `electron-forge package`, then `deploy/macos/make-dmg.sh`. Run each row twice:

- **Developer ID:** `PSYCHE_SIGN_IDENTITY` set and notarized.
- **Ad-hoc:** no identity.

Use a fresh macOS user account, or reset first:

- `tccutil reset All com.psyche.helper`
- `rm -rf ~/.psyche`
- quit any running `psyche-helper`

**Resetting TCC for a retest.** `apps/mac-helper/scripts/tcc-reset.sh` resets each service the helper uses. `tccutil reset All com.psyche.helper` resets everything at once. Notifications are not TCC: remove Psyche Helper in System Settings › Notifications. Restart the helper after a reset. A running process keeps TCC answers it has cached.

### Install and first run

| # | Step | Expect |
| --- | --- | --- |
| 14.1 | Open the DMG, drag Psyche to Applications, open it | Developer ID: opens without a Gatekeeper warning. Ad-hoc: right-click › Open once. `spctl -a -vv /Applications/Psyche.app` shows the build kind |
| 14.2 | `codesign -dv --verbose=2 /Applications/Psyche.app/Contents/Resources/PsycheHelper.app` and `codesign -d --entitlements - …` | Identifier `com.psyche.helper`, hardened runtime, the helper's own entitlements (Apple Events, audio input, calendars, contacts, virtualization), not Electron's. Developer ID: your team and a timestamp |
| 14.3 | First launch of Psyche with no terminal open | Within a few seconds `psyche-helper` runs (`pgrep -lf psyche-helper`). Its parent in Activity Monitor is launchd, not Psyche. No Dock icon, no prompts |
| 14.4 | Gateway nodes list (desktop › Devices, or `psyche nodes`) | One `mac-helper` node, paired with no approval card (loopback + handshake secret) |
| 14.5 | No permission prompts appear until the owner acts | Nothing from macOS at first run. `permissions.status` lists every permission as `notDetermined`/`unknown`, with `bundle.insideApp: true` and `bundle.signing` `developer_id` or `adhoc` |
| 14.6 | Quit and reopen Psyche (twice quickly) | Still exactly one helper process. A second copy logs "already running" and exits 0 |
| 14.7 | Quit Psyche, wait 1 min, reopen | The helper stayed running and reconnects (≤ 30 s). Same device id, no new pairing |

### Grant flows, one per permission (from onboarding or `permissions.request`)

| # | Permission | Step | Expect |
| --- | --- | --- | --- |
| 14.8 | Accessibility | Onboarding "Enable computer use" | Prompt names **Psyche Helper**, not Psyche. After the toggle, `permissions.status` shows `granted` without restarting |
| 14.9 | Screen Recording | `permissions.request` with `purpose: "vision_fallback"` | Prompt names Psyche Helper. macOS may need the helper restarted; status flips after that |
| 14.10 | Microphone, Speech Recognition | Start dictation | One prompt each, naming Psyche Helper, with the usage strings from Info.plist |
| 14.11 | Contacts, Calendars, Reminders | Turn on the connector, run a list call | One prompt each with the Info.plist text; denied → `permission_missing/<perm>` |
| 14.12 | Automation | A Notes or Mail action | "Psyche Helper wants to control Notes" once per target app |
| 14.13 | Full Disk Access | `permissions.request {permission: fullDiskAccess}` | System Settings opens at Full Disk Access with no prompt. Psyche Helper is not listed until added with "+" from `/Applications/Psyche.app/Contents/Resources/PsycheHelper.app` (⇧⌘. shows hidden files in the picker) |
| 14.14 | Notifications | `notify.request_authorization` | The banner prompt names Psyche Helper |
| 14.15 | Input Monitoring | After Accessibility | Reads `granted` (Accessibility covers the listen-only taps) |

### Upgrade

| # | Step | Expect |
| --- | --- | --- |
| 14.16 | With Psyche running and grants given, install a newer DMG over it (quit Psyche, replace in Applications, open) | Within 30 s of the replacement the old helper exits ("bundle replaced"). The new Psyche starts the new helper. The node manifest shows the new version |
| 14.17 | Developer ID → Developer ID upgrade | Every grant from 14.8–14.15 still applies (`permissions.status` all `granted`; a computer-use snapshot works) |
| 14.18 | Ad-hoc → ad-hoc upgrade | System Settings still shows the old toggles on, but `permissions.status` reports them missing. `tccutil reset All com.psyche.helper`, restart the helper, grant again → works. Doctor warns about ad-hoc signing |
| 14.19 | Move Psyche.app to the Trash while it runs | The helper exits within 30 s; nothing relaunches it |
| 14.20 | Downgrade (older DMG) | Same as 14.16. Developer ID grants are kept |

## 15. Psyche points overlay (W4)

Psyche points shows a ring and a note card next to the field the owner fills next. It must never click, type, take keyboard focus or activate anything. Design: `docs/design/psyche-points-2026.md` §4. Until the Gateway wiring (W7) lands, drive `points.windows`, `points.session` and `points.show` from a test client on the node socket, using a throwaway form (a local HTML page with a name, employer, city and a password field is enough) and never a real account. The card's button text comes from the `strings` the client sends: use `{app}`, `{label}`, `{n}` and `{total}` placeholders in a few of them and check they are filled.

Run the whole table in Safari and again in Chrome. Rows 15.20 to 15.25 also need a second display, Spaces and a full-screen app.

### Windows and focus

| # | Step | Expect |
| --- | --- | --- |
| 15.1 | Start a session on the form window, then `points.show` for the first field (kind `fill`, a note, a value, two sources, step 1 of 3) | A 3 pt ink ring 4 pt outside the field and a 300 pt wide card beside it. The ring does not cover the field, so the text you type stays readable |
| 15.2 | Click into the field and type | The text goes into the field. The page's caret stays, Psyche Helper never becomes the frontmost app (the menu bar still names the browser), no Dock icon |
| 15.3 | Press Tab and Shift-Tab, use arrow keys and Cmd-L while the card is up | The browser behaves as without Psyche. The card takes no key input |
| 15.4 | Click the ring area and the field through it | The click reaches the field: the pointer layer ignores the mouse |
| 15.5 | Click a card button (Skip) while the browser is frontmost and the form field is focused | One click is enough (no activation click). The field keeps focus and its caret. The client receives `{type: "action", action: "skip"}` |
| 15.6 | Click the card's text area and its empty margins | Nothing happens to the form. Focus stays in the field |
| 15.7 | Activity Monitor, the helper's row | CPU near 0 while idle, no new Dock icon, no extra process |
| 15.8 | Cmd-Tab and Mission Control | The ring and card are not listed as windows or apps and do not get in the way |

### The card

| # | Step | Expect |
| --- | --- | --- |
| 15.9 | Show a step with a value, `sources` and a warning | Rows in order: app name, note, the value in a monospace chip, the warning, the sources and the step count (`1/3`), then the buttons |
| 15.10 | Show a step with a very long note and a long warning | The card never grows past 160 pt. The note is cut with an ellipsis |
| 15.11 | Show a field the helper judged sensitive (a password or card number) with a `value` | No value is drawn |
| 15.12 | Show a `self` step on a Pay button | The card says the fixed pay-button text from the strings, not the model's note |
| 15.13 | Press Hide note | The card collapses to a small pill with the step count. Press it and the card is back |
| 15.14 | Press Stuck? | The three stuck choices replace the buttons. Each sends its `stuck_*` action. Press Stuck? again and the normal buttons return |
| 15.15 | Press Looks wrong?, Back, Next (kind `next_page`) and Ask in Psyche | Each sends its action (`wrong`, `back`, `next`, `ask`) and does nothing else |
| 15.16 | Turn on Increase Contrast, then Reduce Motion, in System Settings › Accessibility › Display | The ring is 5 pt. With Reduce Motion the ring and card appear at once, with no fade |
| 15.17 | Type in the target field | The card dims to 40% and clicks go through it. One second after the last keystroke it is back at full strength and clickable |
| 15.18 | Scroll the page until the field is off screen | The ring turns into an edge chevron at the window edge and the card shows the "scroll to {label}" text. Scroll back and the ring returns to the field |
| 15.19 | Resize and move the browser window | The ring and card follow within a moment. The card never sits on the field or on the next two fields |

### Displays, Spaces and full screen

| # | Step | Expect |
| --- | --- | --- |
| 15.20 | Two displays: drag the window so it spans both, with the field on the second display | A pointer layer on each display the field touches, the card on the display that holds the field. Mixed Retina and non-Retina look the same size |
| 15.21 | Unplug or reconfigure a display during a session | The panels rebuild on the remaining display, no stray ring is left behind |
| 15.22 | Switch to another Space, then back | The ring and card are gone while the window is not on the active Space and return when it is |
| 15.23 | Switch to Mail (Cmd-Tab), then back to the browser | The ring and card vanish while Mail is in front and return when the browser is |
| 15.24 | Put the browser into full screen (green button) and show a step | The ring and card show over the full-screen Space. The menu-bar item may be hidden there: Stop on the card and Esc still work |
| 15.25 | Minimise the window, then restore it | Hidden while minimised, back after |

### Stopping

| # | Step | Expect |
| --- | --- | --- |
| 15.26 | While a session runs | The menu bar shows "◉ Pointing: <app>" (the `menuBarTitle` string) with a Stop row. It is gone after the session ends |
| 15.27 | Choose Stop in the menu-bar item | The overlay disappears at once and the client receives `action: stop` and then `ended` |
| 15.28 | Press a bare Esc with the browser in front | The session ends (`ended`, reason `stop`). The browser still received the Esc (a date picker closes, for example) |
| 15.29 | Press Shift-Esc, Cmd-Esc, or Esc with another app in front | The session keeps running |
| 15.30 | Press Stop on the card | Same as 15.27 |
| 15.31 | Quit the target app, or close its window | The overlay is gone and the session ends |
| 15.32 | `log stream --predicate 'subsystem == "com.psyche.helper"'` during all of the above | No note text, values, labels or field titles in the log. No key characters |

### What the guarantee rules out

| # | Step | Expect |
| --- | --- | --- |
| 15.33 | `apps/mac-helper/scripts/check-points-boundary.sh` | "all checks passed": no pasteboard write, no event posting, no activation, no key-window call and no `characters` read in `PsycheHelperPoints` |
| 15.34 | Run a normal `computer.click` while a session runs | Refused with `conflict/points_active` |
| 15.35 | Copy something, run a whole session, paste | Your clipboard is unchanged: the helper never writes it (Copy is not in the helper; see the PR note) |

### Let Psyche look (vision fallback, W5)

`points.look` takes one picture of the session's window only, with every known sensitive field painted solid, for the owner's own Let Psyche look press. Until the Gateway calls it (W7) and the card shows the button (W8), drive it from a test client on the node socket: the helper mints an `actionId` and streams it on the `action` event of a `look` press (or of `next` while vision mode is on), and `points.look` answers only for that id. Use the same throwaway form as above, never a real account. Screen Recording must be granted to the helper for these rows (row 15.44 turns it off again).

| # | Step | Expect |
| --- | --- | --- |
| 15.36 | Start a session on the throwaway form (name, city, a password field, a "Social Security number" field). Press look, then call `points.look` with the `actionId` of that `action` event | An image of that one window: no menu bar, no Dock, no other window, no Psyche card or ring. The password and SSN fields are solid black with a few points of margin. The name and city fields are visible. `masked` is true, `width` and `height` match the image, `pointsPerPixel` is the window width over the image width |
| 15.37 | Call `points.look` again with the same `actionId` | Refused with `forbidden/action_used`. No picture |
| 15.38 | Call `points.look` with a made-up `actionId`, then with an empty one | Refused with `forbidden/action_unknown` both times |
| 15.39 | Press look twice, then use the first id | Refused (`action_used`): only the newest id works |
| 15.40 | Press look, wait 5 minutes, use its id | Refused with `forbidden/action_stale` |
| 15.41 | Click into the password field (Secure Event Input turns on), press look, call `points.look` | Refused with `policy_denied/secure_input`. Click out, press look again: it works |
| 15.42 | With a look in flight, click into the password field | No picture comes back, or the call is refused with `secure_input` |
| 15.43 | Try to start a session in a password manager, a banking app, Terminal and System Settings, if installed | `points_refused`: no session, so no look. Quit the app a session runs on and call `points.look` for it: `no_session` or `not_a_window`, never a picture of another app |
| 15.44 | Turn off Screen Recording for the helper in System Settings › Privacy & Security, press look, call `points.look` | `forbidden/permission_missing` with `permission: screenRecording`. Nothing else happens |
| 15.45 | Two windows of the same app: start on window A with window B in front of it. Look | The picture is window A's own content, B is not in it (the window filter, not a screen crop) |
| 15.46 | Drag the window while the call runs | `conflict/window_moved`; the picture is not returned |
| 15.47 | A page with more fields than the digest cap (a very long form) | `unavailable/mask_unavailable`: no picture rather than a partly masked one |
| 15.48 | Look at the window on a Retina display, then drag it to a non-Retina display and look again | Both pictures are at most 1372 x 887, and the masks sit exactly over the fields on both |
| 15.49 | After a look, `points.show` with `target: {box, imageSize}` where `box` is drawn on the picture around the city field | The ring sits on the city field on screen, on a Retina and on a non-Retina display |
| 15.50 | `points.show` with a box that hangs over the window edge, then one wholly outside the window | The first is cut to the window. The second is refused (`invalid_params`) and no ring is drawn |
| 15.51 | `points.show` with a box around the painted password field and a `value` | The ring and the note show, and no suggestion is drawn: a box that touches a painted field never gets a value |
| 15.52 | `points.show` with a box before any look, then after moving the window | `conflict/no_look`, then `conflict/window_moved` |
| 15.53 | Window across two displays, field on the second one, `points.show` with a box on it | The ring draws on the display that holds the box |
| 15.55 | Show a step (kind `info`) on a window whose tree is sparse (fewer than 3 fillable fields, for example a PDF or a canvas form) | The card has a Let Psyche look button. Press it: the client receives an `action: look` event with an `actionId`. On an ordinary form with 3 or more fields the button is absent |
| 15.56 | Show a step on a checkout page (a Card number field) or a plain `http:` page with a sparse tree | No Let Psyche look button. A `points.look` with any id is refused with `forbidden/directions_only`, and no picture is taken |
| 15.57 | Press look, then scroll the page while `points.look` runs | `conflict/page_moved` (retryable), no picture. Press look again with the page still: it works |
| 15.58 | Minimise the window, press look, call `points.look` | Refused (`mask_unavailable` or `no_window`), never a picture of something else |
| 15.59 | A form with a password field nested very deeply in groups (a long accessibility path) | `unavailable/mask_unavailable` rather than a picture with that field unpainted |
| 15.60 | After a look, `points.show` with a `box` on a page that has since turned into a checkout page | The card says the fixed "You fill this yourself" text and shows no value, whatever the note and value were |
| 15.61 | `log stream --predicate 'subsystem == "com.psyche.helper"'` during a look | No image data, labels, titles or values in the log. No picture file appears on disk |
