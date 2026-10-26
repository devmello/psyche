# Apple apps and Mac apps: connector plan (2026)

**Owner:** S09 (connectors). **Status:** spec, 2026-10-25. **Issues:** epic #636; G0 #637, H #638, G #639, U #640, P #641. **Asked by:** the owner ("Update and improve all the connectors to local Apple apps to really be able to provide a good user experience. Research what users automate … and add all those capabilities. Also research expanding the capabilities to other applications").

Research behind this plan, with sources:
- [research/apple-platform.md](research/apple-platform.md): macOS 26/27 automation surface, App Intents and Shortcuts per app, frameworks and their limits, TCC, competing assistants, open-source MCP servers.
- [research/automation-demand.md](research/automation-demand.md): Raycast / Alfred / Keyboard Maestro / Hazel / Shortcuts / Zapier / IFTTT usage, third-party app surfaces, the jobs users describe, a ranked top 40.
- [research/scripting-dictionaries.md](research/scripting-dictionaries.md): first-hand `sdef` reads of every scriptable app on macOS 27.0.1.

The short version: Psyche reaches six Apple apps today with the basics. The jobs people actually give an assistant are "brief me", "triage my mail into tasks", "find that note", "find a free slot", "play something" and "file this". They need **about 40 more operations** across Mail, Reminders, Calendar, Notes, Contacts, Music, Safari / Chrome, Files and Shortcuts, plus **six third-party apps** (Obsidian, Things 3, Spotify, Todoist, Chrome, Bear). Most of the work is in the helper, in one Swift session that ships one PR per app. The model-facing tools, the catalogue, the Settings card and the skills follow in parallel against fixtures.

## 1. Where we are (main, 2026-10-25)

| App | Helper capabilities today | Route | Model-facing tools today |
| --- | --- | --- | --- |
| Calendar | `calendar.list_calendars`, `calendar.list_events` (≤ 366 days), `calendar.create_event`, `calendar.update_event` (`span: future`) | EventKit | `calendar_*` (the same four) |
| Reminders | `reminders.list_lists`, `reminders.list` (list, completed, due before), `reminders.create`, `reminders.update` | EventKit | `reminders_*` |
| Mail | `mail.search` (text, unread, since / until, from; newest first, #626), `mail.read`, `mail.draft`, `mail.send` (approval-bound) | Mail scripting | `mail_search`, `mail_read`, `mail_draft`, `mail_send` |
| Notes | `notes.list` (folder), `notes.read`, `notes.create` (plain text) | Notes scripting | `notes_list` (title filter in the connector), `notes_read`, `notes_create` |
| Safari | `safari.tabs`, `safari.current_tab`, `safari.open_url` | Safari scripting | none (helper only) |
| Finder | `finder.list`, `finder.reveal` (granted folders only) | Foundation + Finder scripting | none |
| Messages | `messages.chats`, `messages.read`, `messages.send`, `messages.watch` | `chat.db` + Messages scripting | the iMessage **channel**, not a connector |
| Shortcuts / apps | `apps.list`, `apps.open`, `apps.focus`, `apps.shortcuts_list`, `apps.shortcut_run`, `apps.applescript`, `apps.jxa` | Shortcuts and OSAScript, out of process | computer-use tools only (destructive, device-only approvals) |

Connection state, permissions and one-instance-per-Mac already work (#549, #570, #620). Every app's tools go through the connector registry: action matrix, `ask` for writes, `send_email` binding for mail sends, receipts, untrusted outputs.

**What the platform already gives and Psyche does not use** ([scripting-dictionaries.md](research/scripting-dictionaries.md)):
- Mail: `reply`, `forward`, flags, read status, `move`, attachments, per-mailbox unread counts, the selected messages.
- Notes: folders, attachments, `set body` (append and edit), `whose` search.
- Reminders: `flagged`.
- Calendar: attendees and alarms (read).
- Contacts: the whole dictionary and the framework.
- Photos: search, albums, export.
- Music: playback, search, playlists.
- Safari: reading list and page text.
- Shortcuts Events: `run` with input.

**Usage strings and entitlements on both bundles.** The #570 lesson: a grant lands on the *responsible process*, so the helper bundle and the desktop app must both carry every key.

| Declared today | `apps/mac-helper/Support/Info.plist` + `PsycheHelper.entitlements` | `apps/desktop/forge.config.ts` `extendInfo` + `apps/desktop/entitlements.plist` |
| --- | --- | --- |
| Calendars (full and legacy), Reminders (full and legacy), Contacts, Apple Events, Microphone, Speech, Screen capture | yes | yes |
| Photos (`NSPhotoLibraryUsageDescription`, `com.apple.security.personal-information.photos-library`) | **no** | **no** |
| Music library (`NSAppleMusicUsageDescription`) | **no** | **no** |
| Location (`NSLocationUsageDescription`, `com.apple.security.personal-information.location`) | **no** | **no** |

`deploy/macos/build-helper.sh` checks the helper's keys at build time. Every PR that adds a key adds it to that check, and to `apps/desktop/test/forge-config.test.ts`.

## 2. What users want (evidence summary)

From [automation-demand.md](research/automation-demand.md):
- Raycast store installs: Chrome 579k, Spotify 499k, VS Code 419k, Slack 341k, Notion 285k, 1Password 257k, Obsidian 180k, Apple Notes 158k, Apple Reminders 125k, Apple Music 103k, Todoist 99k, Things 42k.
- ClawHub skill downloads: weather 172k, Obsidian 112k, Notion 105k, Apple Notes 38k, Apple Reminders 32k, Spotify 28k, iMessage 18k, Things 17k, Bear 14k.
- GitHub MCP servers: apple-mcp 3.1k, iMCP 1.8k, mcp-obsidian 4.5k.

Signals from [apple-platform.md](research/apple-platform.md):
- Apple's own App Intents grew exactly where users asked: Notes Markdown and section append in 27, Reminders sections and groups in 27, Messages mark-read and tapbacks in 27, Photos favorite and albums in 26/27.
- Zapier has **no** Apple integrations, so a local helper is the only way in.

The jobs, in order of evidence:
1. **Morning brief** (calendar, reminders, unread mail, weather, on a schedule).
2. **Summarize and triage unread mail**, and turn an email into a reminder with a link back to the message.
3. **Natural-language reminders**: create, list due and overdue, complete.
4. **Calendar**: what's next, block focus time, find a free slot, join the next meeting.
5. **"Find that note"**, and append to a daily or scratch note.
6. **Music**: play, pause, now playing, "play something for focus".
7. **"What am I looking at"**: the open tabs and the current page.
8. **Meeting prep**: an event and its attendees, plus related mail, into a note; action items into reminders.
9. **Files**: the latest download, Downloads cleanup, filing bills and attachments.
10. **Contacts**: someone's email or phone.
11. **Run my shortcut** as the long-tail escape hatch.

Competitors ([apple-platform.md §4](research/apple-platform.md)) and how they get there:
- ChatGPT computer use, Claude computer use, Muse for Mac, Perplexity's local MCP and Raycast AI's @-extensions all reach these jobs through GUI control, MCP, or both.
- OpenAI's guidance is to prefer a dedicated API over GUI control when one exists. That is Psyche's model too: typed helper capabilities first, computer use as the fallback.

## 3. Routes and rules (decisions)

| Route | Use for | Why / limits |
| --- | --- | --- |
| **Frameworks in the helper** (EventKit, Contacts, PhotoKit) | Calendar, Reminders, Contacts, Photos reads | Typed, fast, one TCC prompt per data class. EventKit cannot add attendees (Apple, documented) and has no Reminders tags, subtasks, sections or flags. Contacts' `note` needs an Apple-approved entitlement (skip it). macOS has no limited Photos picker (full or nothing). |
| **App scripting in the helper** (in-process OSAScript, fixed script text, inputs as handler arguments, `whose` clauses evaluated by the app) | Mail, Notes, Reminders `flagged`, Music, Spotify, Safari, Chrome, Finder, Things, Bear (writes via URL) | Automation prompt per target app. Never `do JavaScript` / `execute` / `do script` for the model: those stay with the browser part and exec. |
| **Shortcuts** (`shortcuts run` / Shortcuts Events) with **Psyche Actions**, a small set of signed `.shortcut` files Psyche ships and the owner installs once | App Intents-only features: Reminders tags, subtasks and sections; Notes Markdown, section append, checklist, tags and pin; Focus get/set; timers and alarms; Voice Memos find; Weather; Freeform add file; Photos favorite / hide / album ops | Needs the logged-in GUI session and blocks on any Ask or Alert step, and has no timeout of its own. So every Psyche Action ends in Stop and Output with a dictionary, is called by UUID, with a hard timeout in the helper. |
| **Owner's own shortcuts as tools** | The long tail ("run my shortcut") | Discovery via `shortcuts list` plus Shortcuts Events (`accepts input`). Each run is approval-gated as *unknown side effect* (`connector_action`, destructive tier) unless the owner marks a shortcut read-only in Settings. |
| **Read-only stores** (Mail Envelope Index, NoteStore.sqlite, Safari History.db) | Later fast paths only | They need Full Disk Access, which cannot be requested programmatically, and the schemas change across OS updates (Messages `text` went NULL on Tahoe). **Not in this plan's first wave.** Scripting with `whose` is the default; History.db is the one exception, behind an explicit FDA opt-in. |
| **Gateway-only** (no helper) | Obsidian vault files (a granted folder), Todoist, Notion and Slack (cloud APIs; Notion and Slack are already remote MCP presets) | No TCC, no Swift; testable with fixtures. |
| **Computer use** | Anything not listed | Already exists; the agent falls back to it with per-app tiers. |

Rules for every new capability, unchanged from today:
- **Approvals:** reads `allow`; writes `ask`; sends, deletes and anything outward-facing `ask` and never `allow`.
- **Untrusted output:** mail, notes, messages, web pages, files, calendar invitations (shared calendars) and shortcut output are all untrusted.
- **Bindings:** they cover the exact arguments, with sends bound to recipients, subject and body hash.
- **Timeouts:** each helper call has a timeout (60 s by default, 180 s when a prompt may be up).
- **Per-app permissions:** each app has its own permission row, kept up to date (#549 / #570).

## 4. Capability matrix: Apple apps (ranked by demand)

**Key**
- **Tier:** R = read, W = write (`ask`), D = destructive or outward (`ask`, never `allow`).
- **Route:** EK = EventKit, CN = Contacts, PK = PhotoKit, AS = app scripting, SC = Psyche Action shortcut, FS = files.
- **Grant:** the TCC grant the owner sees.
- **Name:** the helper capability. The model-facing tool is the same name with `_` (e.g. `mail.reply_draft` becomes `mail_reply_draft`).
- **Wave:** 1 = this plan's first wave, 2 = after it.

Capabilities in **bold** are new.

### 4.1 Mail (Automation → Mail)

| # | Name | Tier | Route | Notes | Wave |
| --- | --- | --- | --- | --- | --- |
| M1 | `mail.search` (done, #626) | R | AS `whose` | text, unread, since / until, from | done |
| M2 | **`mail.mailboxes`** | R | AS | accounts and mailboxes with `unread count` (the brief's "N unread") | 1 |
| M3 | **`mail.selected`** | R | AS (`selected messages` of the front viewer) | "this email", the Raycast "reminder from selected email" job | 1 |
| M4 | `mail.read` (+ **`link`**: `message://<message id>`) | R | AS | the link lets a reminder or note point back to the mail | 1 |
| M5 | **`mail.reply_draft`** / **`mail.forward_draft`** | W | AS `reply` / `forward` → saved draft, not sent | quotes and threading done by Mail; the owner sends, or `mail.send_draft` | 1 |
| M6 | **`mail.send_draft`** | D | AS `send` on a saved draft | `send_email` binding on the draft's recipients, subject and body | 1 |
| M7 | **`mail.set_flags`** (read / unread, flagged, flag color) | W | AS `read status`, `flagged status`, `flag index` | batch up to 100 ids | 1 |
| M8 | **`mail.move`** (to mailbox / archive / junk) | W | AS `move` | "file these", "archive newsletters" | 1 |
| M9 | **`mail.save_attachments`** | W | AS `mail attachment` → `save` into the Library or a granted folder | "file this bill"; files are untrusted | 1 |
| M10 | **`mail.delete`** (to Trash) | D | AS `delete` (Mail moves to Trash) | always asks | 2 |
| M11 | `mail.rules` (list), **`mail.rule_create`** | R / D | AS `rule` | standing automations: outward-facing, device-only card | 2 |
| M12 | **Follow-up check** (sent with no reply after N days) | R | M1 on Sent + thread check in the Gateway | a skill, not a capability | 2 |

### 4.2 Reminders (Reminders access; Automation → Reminders for `flagged`)

| # | Name | Tier | Route | Notes | Wave |
| --- | --- | --- | --- | --- | --- |
| R1 | `reminders.list` (+ **`overdue`, `dueToday`, `flagged`, `query`**, newest due first) | R | EK (+ AS for flagged) | "what's due", "what's overdue" | 1 |
| R2 | `reminders.create` (+ **`url`**, **`alarm`** (absolute or relative), **`recurrence`**) | W | EK | the email link from M4 goes in `url` | 1 |
| R3 | **`reminders.complete`** (by id or by exact-title match in a list) | W | EK | "done with the dentist one" | 1 |
| R4 | **`reminders.delete`** | D | EK | | 1 |
| R5 | **`reminders.set_flagged`** | W | AS (EventKit has no flag) | | 1 |
| R6 | **`reminders.create_list`** | W | EK | | 2 |
| R7 | **Tags, subtasks, sections** | W | SC (macOS 27 adds sections and groups; tag/subtask parameters on 27 are unverified) | ship only once verified on 27 | 2 |

### 4.3 Calendar (Calendars full access)

| # | Name | Tier | Route | Notes | Wave |
| --- | --- | --- | --- | --- | --- |
| C1 | `calendar.list_events` (+ **`query`**, **`attendees`** (read), **`url` / conference link** parsed from notes, location, URL) | R | EK | "join my next meeting" needs the link | 1 |
| C2 | **`calendar.free_busy`** (busy blocks across chosen calendars in a window) | R | EK | the free-slot finding lives in the Gateway (§6) | 1 |
| C3 | `calendar.create_event` / `update_event` (+ **`alarms`**, **`recurrence`** (RRULE subset), **`availability`**) | W | EK | focus blocks, travel buffers | 1 |
| C4 | **`calendar.delete_event`** (`span: this / future`) | D | EK | the calendar-planning skill already expects delete | 1 |
| C5 | **Invite attendees** | D | not in EventKit (attendees are read-only) → send an `.ics` invite through Mail (M5/M6), or open Calendar's editor | say so in the tool description; never fake it | 2 |
| C6 | **`calendar.respond`** (accept / decline an invitation) | D | not exposed by EventKit for the owner's own status (unverified): open the event in Calendar | 2 |

### 4.4 Notes (Automation → Notes)

| # | Name | Tier | Route | Notes | Wave |
| --- | --- | --- | --- | --- | --- |
| N1 | **`notes.search`** (title and body text, folder, modified since; newest first) | R | AS `whose name contains … or plaintext contains …` | "find that note"; replaces the connector-side title filter | 1 |
| N2 | `notes.list` / `notes.read` (+ **folder tree**, **attachments** listed) | R | AS | | 1 |
| N3 | **`notes.append`** (text or checklist lines at the end) | W | AS `set body` (HTML-escaped append) | the daily or scratch note job | 1 |
| N4 | **`notes.update`** (replace body; rename) | W | AS | binds the note id and a hash of the previous body (no blind overwrite) | 1 |
| N5 | **`notes.create`** (+ **Markdown**) | W | AS (HTML) now; SC "Create Note" (Markdown, macOS 27) | | 1 / 2 |
| N6 | **`notes.move`**, **`notes.create_folder`** | W | AS | | 2 |
| N7 | **`notes.delete`** | D | AS (to Recently Deleted) | | 2 |
| N8 | **Section append, tags, pin, checklist toggle** | W | SC (27); no toggle API exists (rebuild the note) | | 2 |

### 4.5 Contacts (Contacts access; new app)

| # | Name | Tier | Route | Notes | Wave |
| --- | --- | --- | --- | --- | --- |
| P1 | **`contacts.search`** (name, email, phone, organization) | R | CN | "Dana's email", meeting-prep attendees → people | 1 |
| P2 | **`contacts.read`** (all fields but `note`, groups) | R | CN | `note` needs Apple's entitlement: leave it out | 1 |
| P3 | **`contacts.create`** / **`contacts.update`** (add an email or phone, birthday) | W | CN | "save this sender" | 1 |
| P4 | **`contacts.groups`**, **`contacts.add_to_group`** | R / W | CN | | 2 |
| P5 | **`contacts.delete`** | D | CN | | 2 |

### 4.6 Music and Spotify (Automation → Music / Spotify; new)

| # | Name | Tier | Route | Notes | Wave |
| --- | --- | --- | --- | --- | --- |
| U1 | **`music.now_playing`**, **`music.control`** (play, pause, next, previous, volume, shuffle) | R / W | AS (Music, Spotify) | the most-installed category; `control` is W but low-risk: the matrix default may be `allow` (no data leaves) | 1 |
| U2 | **`music.search_library`** and **`music.play`** (track / album / playlist / artist, from the library) | R / W | AS Music `search`, `play` | "play something for focus" → the agent picks a playlist | 1 |
| U3 | **`music.add_to_playlist`**, **`music.create_playlist`** | W | AS | | 2 |
| U4 | **Spotify search, queue and playlists** | R / W | Spotify Web API (per-user OAuth; developer mode capped at 5 users since 2025) | AppleScript covers playback only | 2 |

### 4.7 Safari and Chrome (Automation → Safari / Google Chrome)

| # | Name | Tier | Route | Notes | Wave |
| --- | --- | --- | --- | --- | --- |
| S1 | `safari.tabs` / `safari.current_tab` (+ **`text`** of the current or a chosen tab, capped, untrusted) | R | AS tab `text` | "summarize what I'm reading" without the agent browser | 1 |
| S2 | **`chrome.tabs`**, **`chrome.current_tab`** (title, URL) | R | AS | the most-installed Raycast extension; page text needs `execute` (not exposed): use the agent browser or `web_fetch` for the URL | 1 |
| S3 | **`safari.add_reading_list`** | W | AS `add reading list item` | | 1 |
| S4 | **`safari.history`** (search, since) | R | History.db (Full Disk Access opt-in only) | | 2 |
| S5 | **Safari 27 `safaridriver --mcp`** | — | detect and offer as an MCP server preset (opt-in by the owner) | page automation stays in the agent browser | 2 |

### 4.8 Files and Finder (granted folders only)

| # | Name | Tier | Route | Notes | Wave |
| --- | --- | --- | --- | --- | --- |
| F1 | **`files.recent`** (latest downloads; files in a granted folder by added date, kind and size) | R | FS (Foundation + Spotlight metadata `kMDItemDateAdded`) | "my latest download" | 1 |
| F2 | **`files.move`** / **`files.rename`** (inside granted folders) | W | FS | Hazel-style filing, with the destination shown on the card | 1 |
| F3 | **`files.trash`** | D | Finder `delete` (to Trash, never `empty`) | Downloads cleanup | 1 |
| F4 | **`files.tag`** (Finder tags) | W | FS (`com.apple.metadata:_kMDItemUserTags` via `URLResourceValues.tagNames`) | | 2 |

### 4.9 Shortcuts (new app: "Shortcuts")

| # | Name | Tier | Route | Notes | Wave |
| --- | --- | --- | --- | --- | --- |
| K1 | **`shortcuts.list`** (name, id, folder, `accepts input`) | R | Shortcuts Events | discovery for the model and Settings | 1 |
| K2 | **`shortcuts.run`** (id, text or file input, output as text / JSON, timeout ≤ 120 s) | D by default; the owner can mark individual shortcuts "allow" | `shortcuts run <id>` from the helper's GUI session | the escape hatch; output untrusted | 1 |
| K3 | **Psyche Actions** (signed `.shortcut` files with stable UUIDs, installed from Settings with one click): Get / Set Focus, Start Timer, Get Weather, Find Voice Memos (+ transcript), Reminders tags / subtasks, Notes Markdown / section append | per action | SC | the bridge to intent-only features; each one is a typed helper capability with a fixed shortcut behind it | 2 |

### 4.10 Other Apple apps: verdicts

| App | Verdict | Why |
| --- | --- | --- |
| Photos | **Wave 2** (PhotoKit read: search by date, place, person label, favorites; export to the Library). Album ops via SC | Needs a new usage string and entitlement on both bundles. Full library or nothing on macOS. Demand is moderate (screenshots, "photos from the trip") |
| Weather | **Wave 2** via SC "Get Weather" (or WeatherKit through the Gateway with Apple's API terms) | High demand only inside the brief (172k ClawHub). The model only needs a forecast |
| Focus | **Wave 2** via SC | "Turn on Do Not Disturb for my focus block" pairs with C3 |
| Clock / timers | **Wave 2** via SC | Mac timer pause / cancel actions are iOS-only |
| Voice Memos | **Wave 2** via SC find + transcript (the `tsrp` atom in the m4a) | "What did I say in the memo" |
| Maps | **Skip as an app**; travel time via MapKit in the Gateway if needed | No dictionary, thin intents |
| Freeform, Books, Podcasts, Stocks, Journal, Image Playground, Passwords | **Skip** | Low demand, or no access by design (Passwords). `ImageCreator` throws on 27 |
| Home | **Skip** (HomeKit is Catalyst-only on the Mac); Shortcuts Control Home via K2 | |
| Messages | Stays the iMessage **channel**; add "unread chats" and "latest code" reads to the channel's tools later (out of scope here) | Separate owner (S10) |
| Pages / Numbers / Keynote | **Skip** for now (thin intents; rich AppleScript; low demand evidence); documents go through the Library and file tools | |

## 5. Third-party Mac apps (ranked)

| Rank | App | Route | Where | Wave | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | **Obsidian** | The vault folder as a **granted folder** (plain Markdown): search, read, append to the daily note, create. Obsidian URI to open a note. The Local REST API plugin is optional | Gateway (files) | 1 | Best API, big base (180k, 112k). No helper and no TCC: just a folder grant |
| 2 | **Things 3** | AppleScript reads (to-dos, projects, areas, tags, Today / Inbox) plus URL-scheme writes (`add`, `update` with the owner's auth token in the vault) | helper | 1 | Mac-native favorite, excellent local surface |
| 3 | **Spotify** | U1 playback via AppleScript (wave 1); Web API search and playlists (wave 2, per-user OAuth, capped) | helper / Gateway | 1 / 2 | 499k installs |
| 4 | **Google Chrome** | S2 tabs via AppleScript | helper | 1 | 579k installs |
| 5 | **Todoist** | REST API v1 with a personal token (vault) | Gateway | 2 | Cleanest task API; cloud |
| 6 | **Bear** | SQLite read (Bear's group container, read-only) plus x-callback writes (token in the vault) | helper | 2 | Good local API, smaller base |
| 7 | **Notion**, **Slack** | Already remote MCP presets (catalogue `notion`, `slack`); Slack is also a channel | Gateway (MCP) | done-ish | Wire their presets through the MCP add flow (#529), no new code |
| 8 | **VS Code** | `code` CLI to open a project or file | helper (`apps.open` with an argument) | 2 | Developer users; launch-only |
| 9 | **Zoom** | `join_url` from calendar events (C1) opens in the browser | none | 1 (via C1) | No connector needed |
| — | 1Password | Already the vault's external source (G10); never a model tool | — | — | Not a connector |
| — | Fantastical, OmniFocus, DEVONthink, Craft, Drafts, Day One, Arc, Terminal / iTerm | **Not now** | — | — | Small bases, redundant with EventKit (Fantastical), maintenance mode (Arc), or too risky (terminals) |

## 6. Gateway-side jobs (no new app needed)

These compose the capabilities above. They belong in the Gateway or in skills, not in the helper.
- **Free-slot finder:** `calendar_find_free_time {window, duration, working hours from USER.md, calendars}` over C2 (and Google free/busy). Returns ranked slots.
- **Morning brief:** a bundled skill plus a default automation. It reads today's events (C1), due and overdue reminders (R1), unread mail counts and the top senders (M2, M1), weather (wave 2), and the now-playing / focus state. It writes one Feed post and one notification.
- **Email to reminder:** a skill using M3/M4 and R2: title from the subject, `url` = `message://`, due from the text (asked when unclear).
- **Meeting prep:** a skill using C1 (attendees), P1 (who they are), M1 (recent mail with them), and N1/N3 (prep notes). It creates or appends a note and lists open threads.
- **Action items:** text into reminders (R2), one card per batch.
- **Downloads cleanup:** F1 → proposed moves and trash (F2/F3), one approval card for the batch with every path listed.

## 7. UX

### 7.1 Settings → Connectors

Each Apple app card gets the following:
- **What {persona} can do:** grouped capability lines in plain words, read and act separately. For example, Mail: "Read and search mail, including unread · See unread counts per mailbox · Use the email you have selected" and "Draft replies and forwards · Mark read, flag, file and archive · Save attachments · Send (always asks)". Each group has an allow / ask / deny control: the existing action matrix, with one row per group (e.g. `mail.organize` covers flags and move).
- **Permission state:** connected, needs permission with the exact System Settings path, or needs the helper (all exist since #549 / #570). The permission line names the right grant per app: Automation for Mail, Notes, Music, Safari, Chrome and Things; Calendars, Reminders, Contacts or Photos access for the framework apps.
- **Try it:** two or three example requests per app ("What's unread from today?", "Make a reminder from this email"). Clicking one prefills the composer.
- **Shortcuts card:** the owner's shortcuts list (K1) with a per-shortcut switch: off, ask, or allow (read-only ones). Plus "Install Psyche Actions" (K3), which opens the Shortcuts import once per action and shows which are installed.
- **Obsidian card:** "Choose your vault" uses the existing folder grant UI; the card shows the vault path and the daily-note folder.

### 7.2 Onboarding

The Connectors step groups the cards as "On this Mac" (Apple apps, then Things and Obsidian when installed: the helper reports installed bundle ids through `apps.list`) and "Accounts" (Google, Microsoft, IMAP). The default selection for a first run on a Mac: Calendar, Reminders, Mail, Notes. Each connect asks its macOS permission right then (#570 / #620).

### 7.3 How the agent discovers capabilities

- **Tool descriptions** say what each filter is for and give one example call, as `mail_search` does now (#626). Descriptions stay under about 350 characters.
- **Per-app guidance:** each Apple connector contributes one short system-prompt section when connected, with three lines: what it is for, what to prefer, and what never to do (e.g. "Calendar invites to other people go through Mail; EventKit cannot add attendees").
- **Skills:** the `requires.tools` families in `packages/skills/src/gating.ts` (`TOOL_CAPABILITIES`) gain `notes.*`, `reminders.*`, `contacts.*`, `music.*`, `files.*` and `shortcuts.*`, mapped to the new tool names. The bundled skills get Apple-app steps.
- **Few-shot examples:** two per app in the skill files, not in the system prompt.

### 7.4 End-to-end flows (acceptance)

1. **"Triage my unread mail into reminders."** `mail_search {unread: true, since: today}`, then `mail_read` for each, then a proposal list, then `reminders_create` with `url` (one card, or a task grant), then `mail_set_flags {read: true}` (asks).
2. **"What's on my calendar today? Prep notes for the 2 pm."** `calendar_list_events`, then for the 2 pm event: `contacts_search` per attendee, `mail_search {from}` per attendee, then `notes_create` or `notes_append` (asks).
3. **"Add 'renew passport' to Things for Friday."** `things_add {title, when}` (asks once; the auth token is a vault item).
4. **"Play something for focus and block two hours."** `music_search_library`, `music_play`, `calendar_create_event` (asks), and wave 2 `focus_set`.
5. **"Find the note about the offsite and add today's decisions."** `notes_search {query: "offsite"}`, `notes_read`, `notes_append` (asks, binding the note id).
6. **"Clean up my Downloads."** `files_recent {folder: Downloads, olderThan: 30d}`, a proposal, then `files_move` / `files_trash` (one card listing every path).

## 8. Plan: four workstreams

Order: **G0 (protocol) first**, then H and G in parallel (H implements the helper, G builds the tools against fixtures that follow the protocol), then U after G1, and P any time after G0 (it needs only the tool names fixed here).

Every PR:
- Tests run on fixtures only. CI makes no live app calls. Vitest runs with `--maxWorkers=1`, and only the changed packages are typechecked.
- At most **one announced local dev run** per PR, with `PSYCHE_HOME=~/.psyche-try PSYCHE_PORT=7989`, never the owner's installed app or `~/.psyche`. Announce any step that can put a macOS prompt on screen.
- One Swift build at a time on this machine.

### G0: protocol (one PR, first)

Brief:
> Add the Apple app capability shapes for docs/connectors/apple-apps-2026.md wave 1 to `packages/protocol/src/schemas/apple-apps.ts`, additively.
>
> - **Params and results:** for M2–M9, R1–R5, C1–C4, N1–N5, P1–P3, U1–U2, S1–S3, F1–F3, K1–K2, and Things (`things.list`, `things.add`, `things.update`, `things.complete`).
> - **Reuse:** follow the existing record shapes (`AppleMailMessageSummary` and friends).
> - **Results:** newest first wherever lists are returned.
> - **Per-param documentation:** each param carries a one-line `description`, because the model-facing tool text is built from these.
>
> Then:
> - add a CHANGES.md entry and a changeset;
> - run `pnpm protocol:gen` (TS, JSON Schema and Swift; `apps/mac-helper/Sources/PsycheProtocol/PsycheProtocol.generated.swift` must match);
> - check `pnpm protocol:check`.
>
> Touch only `packages/protocol/**`, the matching fake in `packages/testing/src/fakes/`, and the generated files. Title: `protocol: Apple app capabilities, wave 1 (part of #637)`.

### H: helper (Swift; one session, PRs in this order)

Brief:
> You own `apps/mac-helper` for the Apple app expansion in docs/connectors/apple-apps-2026.md. Implement wave 1 as **one PR per app**, in this order:
> 1. **Mail** (M2–M9);
> 2. **Reminders and Calendar** (R1–R5, C1–C4);
> 3. **Notes** (N1–N5);
> 4. **Contacts** (P1–P3: a new `ContactsBackend` on CNContactStore);
> 5. **Music and Spotify** (U1–U2);
> 6. **Safari and Chrome** (S1–S3);
> 7. **Files** (F1–F3, granted folders only, the same root checks as `finder.list`);
> 8. **Shortcuts** (K1–K2: move `apps.shortcuts_list` / `apps.shortcut_run` logic into `shortcuts.*` capabilities with input, output and a hard timeout; keep the old names working);
> 9. **Things** (AppleScript reads, URL writes with the token passed in by the Gateway, never stored by the helper).
>
> Rules:
> - Scripting uses `ScriptHandler.call` with fixed script text, inputs as handler arguments, filters in `whose` clauses evaluated by the app, and newest-first ordering done in Swift as in `MailScriptingBackend.search` (#626).
> - Never expose `do JavaScript`, `execute` or `do script`.
> - Every capability declares its side effect and `targetKind`, and adds its row to `@psyche/permissions` `APPLE_APP_ACTIONS` (coordinate with G: G owns that file; send the rows in the PR body).
> - New usage strings and entitlements go into **both** bundles: `apps/mac-helper/Support/Info.plist` + `PsycheHelper.entitlements`, **and** `apps/desktop/forge.config.ts` `extendInfo` + `apps/desktop/entitlements.plist`. Also update the checks in `deploy/macos/build-helper.sh` and `apps/desktop/test/forge-config.test.ts`. Contacts is already declared; Photos and Music are not, so add them only when you add those capabilities.
>
> Each PR proves itself with:
> - a test-backend fake in `Tests/PsycheHelperSystemTests/AppleAppsTests.swift`, and Core unit tests for any pure logic;
> - an `osacompile` check of each new script (compile only);
> - a manual-test-plan row in `apps/mac-helper/docs/manual-test-plan.md`;
> - a README table update.
>
> One `swift build --build-tests` per PR, then `swift test --skip-build --filter <your suites>`. Never run the helper against the owner's apps. One announced dev run per PR at most, with `PSYCHE_HOME=~/.psyche-try PSYCHE_PORT=7989`. Title each PR `feat(helper): <app> wave 1 (part of #638)`.

### G: Gateway and connectors (TypeScript; one session)

Brief:
> You own `packages/connectors/src/apple/`, the Gateway composition and `@psyche/permissions` `apple-apps.ts` for docs/connectors/apple-apps-2026.md wave 1.
>
> For each helper capability in §4 and §5:
> - **Model-facing tool:** add it to `TOOLS` in `packages/connectors/src/apple/connector.ts`. The name is the capability with `_`. Write the description under about 350 characters, with when to use it and one example, as `mail_search` (#626).
> - **Input schema:** mirror the protocol params from G0.
> - **Bindings:** `binding` for writes, with `send_email` for M6 and the note-id-plus-previous-body-hash binding for N4.
> - **Action-matrix groups:** e.g. `mail.read`, `mail.organize`, `mail.compose`, `mail.send`, with defaults R allow, W ask, D ask and never allow. Update the catalogue `DESCRIPTION` and scopes.
>
> New connectors in the catalogue: `apple:contacts`, `apple:music` (with Spotify as a second backend), `apple:files`, `apple:shortcuts`, `chrome:tabs` (helper), `things` (helper; auth token as a vault placeholder), and `obsidian` (Gateway-only: a granted vault folder, Markdown search / read / append-daily / create). All are single-instance except Obsidian (one per vault).
>
> Gateway jobs:
> - `calendar_find_free_time` over C2 and Google free/busy (§6);
> - the per-app system-prompt sections (§7.3) as one short block per connected app;
> - shortcut run approvals with the owner's per-shortcut setting (§7.1).
>
> Tests:
> - fixture tests per connector, as `packages/connectors/test/apple/apple.test.ts`: the fake helper, param mapping, approvals, bindings, untrusted outputs and permission states;
> - Gateway compose tests for the catalogue;
> - no live calls.
>
> Start each app's PR once G0 is merged; you do not need H's PR to land first (fixtures follow the protocol). Title: `feat(connectors): <app> tools wave 1 (part of #639)`.

### U: Settings and onboarding UI (TypeScript; one session, after G's first PR)

Brief:
> You own the connector UI in `packages/ui` for docs/connectors/apple-apps-2026.md §7.1–7.2:
> - per-app capability groups with the allow / ask / deny control (the existing action matrix, grouped);
> - the permission state line naming the right macOS grant;
> - "Try it" example requests that prefill the composer;
> - the Shortcuts card: the owner's shortcuts with off / ask / allow, and Install Psyche Actions;
> - the Obsidian vault picker through the folder-grant flow;
> - onboarding's "On this Mac" vs "Accounts" grouping, with the first-run defaults Calendar, Reminders, Mail and Notes.
>
> Strings go through the catalogue (A12 `pnpm i18n:check`). Follow docs/ui-audit.md:
> - one primary action per row;
> - ids and keys at level 2;
> - semantic colours only.
>
> Tests go in `packages/ui/test/` on the MockGateway: extend its catalogue and connectors with fixtures. Typecheck `@psyche/ui` only. Title: `feat(ui): connector capability cards (part of #640)`.

### P: prompts and skills (content; one session, after G0)

Brief:
> You own `skills/` and `packages/skills/src/gating.ts` `TOOL_CAPABILITIES` for docs/connectors/apple-apps-2026.md §6–7.3.
>
> 1. Add the families `notes.*`, `reminders.*`, `contacts.*`, `music.*`, `files.*` and `shortcuts.*`, mapped to the tool names in §4 (e.g. `notes.*` → `notes_*`), with Settings hints.
> 2. New bundled skills: `morning-brief` (§6, with a default weekday automation the owner can turn on), `email-to-task`, `meeting-prep`, `downloads-cleanup`. Each has `acceptance.md` and two few-shot examples.
> 3. Update `inbox-triage` and `calendar-planning` to use the Apple tools (mark read, flag, move; free-time finder; delete), and say that EventKit cannot invite attendees.
> 4. Write the per-app guidance text for G's system-prompt sections (three lines per app) in `docs/connectors/agent-guidance.md`; G wires it.
>
> Scenarios in `tests/scenarios/` with fixtures for flows 1, 2 and 5 of §7.4. No live calls. Title: `feat(skills): Apple app flows (part of #641)`.

### What each workstream must prove before its last PR merges

| Workstream | Proof |
| --- | --- |
| G0 | `protocol:check` clean; Swift generated file matches; protocol tests |
| H | per app: fake-backend tests, `osacompile` of each script, the build-helper key checks, a manual test row; one announced dev run for the whole wave at most |
| G | fixture tests for every tool (mapping, approvals, bindings, untrusted, permission states); the catalogue offers only implemented apps (#529) |
| U | MockGateway tests for the cards, permission states and Try it; A12 clean |
| P | gating tests for the new families; scenario fixtures for flows 1, 2 and 5 pass |

## 9. Risks

- **Permission grants on the wrong process** (#570). Both bundles carry every key, and the build checks fail if they don't.
- **Automation prompts per app:** each app connects with its own prompt; onboarding asks them one by one, never all at once.
- **Private stores** (History.db, Envelope Index, NoteStore, Bear SQLite) change across OS versions. They stay optional fast paths behind Full Disk Access, with scripting as the default.
- **Shortcuts:** hangs and blocking prompts (hard timeouts; Psyche Actions never Ask). Apple's server-side limits apply only to AI actions, which we do not use.
- **Prompt injection** from mail, notes, messages, web pages, files and shortcut output: all untrusted, already marked; writes still need cards.
- **Spotify Web API restrictions** (developer mode capped at 5 users): playback via AppleScript only in wave 1.
- **Scope creep:** wave 2 items stay out of wave 1 PRs; each wave-2 item gets its own issue when wave 1 lands.
