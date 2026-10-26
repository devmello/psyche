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

## 14. Install from DMG (bundled helper)

The contract is in `docs/status/s14.md` "Packaging". Build a DMG with `deploy/macos/build-helper.sh`, then `electron-forge package`, then `deploy/macos/make-dmg.sh`. Run each row twice:

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
