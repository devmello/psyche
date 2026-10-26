# What Mac users automate, and what they want an assistant to do in their apps

Research date: 2026-10-25. Scope: demand evidence for ranking Psyche connector work. Web research only.

**Method and caveats.** The strongest numbers come from three public catalogs I pulled directly:
- The Raycast Store backend (`https://backend.raycast.com/api/v1/store_listings`, 3,456 listings, each with `download_count`, `commands` and AI `tools`).
- The ClawHub registry for OpenClaw skills (`https://clawhub.ai/api/v1/skills?sort=downloads`, top 1,190 by downloads).
- The MacStories Shortcuts Archive data file ([archive-data.json](https://www.macstories.net/shortcuts/assets/archive-data.json), 444 shortcuts, generated 2026-09-11).

The paginated Raycast dump missed a few top items, which I re-fetched one by one: Kill Process, Color Picker and Google Chrome. Other items may still be missing. GitHub star counts come from the GitHub search API. **Reddit (r/shortcuts, r/macapps) could not be read.** Reddit blocks unauthenticated JSON fetches, and `site:reddit.com` searches returned no threads. So every "recurring Reddit request" below is **unverified** as Reddit evidence. Where possible I back the same request with another source.

---

## 1. Raycast Store

### 1.1 Most-installed extensions overall (installs as of 2026-10-25)

| # | Extension | Installs | AI tools |
|---|---|---|---|
| 1 | [Kill Process](https://www.raycast.com/rolandleth/kill-process) | 788,841 | 3 |
| 2 | [Color Picker](https://www.raycast.com/thomas/color-picker) | 627,004 | 7 |
| 3 | [Google Chrome](https://www.raycast.com/Codely/google-chrome) | 579,363 | 7 |
| 4 | [Google Translate](https://www.raycast.com/gebeto/translate) | 506,293 | 0 |
| 5 | [Spotify Player](https://www.raycast.com/mattisssa/spotify-player) | 498,631 | 7 |
| 6 | [Visual Studio Code](https://www.raycast.com/thomas/visual-studio-code) | 419,212 | 0 |
| 7 | [Linear](https://www.raycast.com/linear/linear) | 408,346 | 54 |
| 8 | [Slack](https://www.raycast.com/mommertf/slack) | 340,714 | 21 |
| 9 | [Brew](https://www.raycast.com/nhojb/brew) | 300,757 | 0 |
| 10 | [Notion](https://www.raycast.com/notion/notion) | 285,213 | 6 |
| 11 | [ChatGPT](https://www.raycast.com/abielzulio/chatgpt) | 264,750 | 0 |
| 12 | [1Password](https://www.raycast.com/khasbilegt/1password) | 256,622 | 0 |
| 13 | [Arc](https://www.raycast.com/the-browser-company/arc) | 255,335 | 13 |
| 14 | [GitHub](https://www.raycast.com/raycast/github) | 214,282 | 16 |
| 15 | [Obsidian](https://www.raycast.com/marcjulian/obsidian) | 179,537 | 7 |
| 16 | [Apple Notes](https://www.raycast.com/raycast/apple-notes) | 158,191 | 9 |
| 17 | [Apple Reminders](https://www.raycast.com/raycast/apple-reminders) | 124,645 | 8 |
| 18 | [Zoom](https://www.raycast.com/raycast/zoom) | 118,152 | 6 |
| 19 | [Music (Apple Music)](https://www.raycast.com/fedevitaledev/music) | 103,076 | 21 |
| 20 | [Todoist](https://www.raycast.com/doist/todoist) | 98,636 | 29 |

Other Apple-app and productivity installs:
- [Downloads Manager](https://www.raycast.com/thomas/downloads-manager): 87,020
- [Google Calendar](https://www.raycast.com/thomas/google-calendar): 73,250
- [Safari](https://www.raycast.com/loris/safari): 61,789
- [Messages](https://www.raycast.com/thomaslombart/messages): 53,462
- [Apple Mail](https://www.raycast.com/yug2005/mail): 47,473
- [Spotify Controls](https://www.raycast.com/thomas/spotify-controls): 46,593
- [iTerm](https://www.raycast.com/ron-myers/iterm): 44,756
- [Things](https://www.raycast.com/loris/things): 42,367
- [2FA Code Finder (iMessage)](https://www.raycast.com/yuercl/imessage-2fa): 40,678
- [TickTick](https://www.raycast.com/appest/ticktick): 25,449
- [Fantastical](https://www.raycast.com/devahschaefers/fantastical): 22,510
- [Apple Maps Search](https://www.raycast.com/djpowers/apple-maps-search): 19,193
- [Xcode](https://www.raycast.com/SvenTiigi/xcode): 17,264
- [FaceTime](https://www.raycast.com/ron-myers/facetime): 16,099
- [Bear](https://www.raycast.com/hmarr/bear): 15,240
- [Craft](https://www.raycast.com/sfkmk/craftdocs): 15,143
- [Reclaim](https://www.raycast.com/reclaim-ai/reclaim-ai): 14,533
- [Keyboard Maestro macro list](https://www.raycast.com/eluce2/list-keyboard-maestro-macros): 9,970
- [Drafts](https://www.raycast.com/FlohGro/drafts): 8,352
- [DEVONthink](https://www.raycast.com/bgnfu7re/devonthink): 5,071
- [OmniFocus](https://www.raycast.com/nicolas-marien/omnifocus): 2,248
- [Day One](https://www.raycast.com/AntonNiklasson/day-one): 1,364
- [Apple Photos](https://www.raycast.com/wesbaker/apple-photos): 1,306

The store has no Apple Contacts or Apple Shortcuts extension with meaningful installs. The only Contacts-adjacent listing is [Google Contacts](https://www.raycast.com/aic/google-contacts) at 532. Only 319 of 3,456 extensions expose AI tools (Raycast API dump).

Apple Calendar is not an extension. It is a Raycast core feature, "My Schedule". It shows the next meeting in root search, joins Zoom or Meet with ⌘↵, has an optional auto-join, and blocks focus time with ⌘⇧B. It reads macOS calendar accounts (iCloud, Exchange, Google, CalDAV) ([Raycast Calendar](https://www.raycast.com/core-features/calendar)).

**Read-through for Psyche.** Users install for six things: music control, browser tabs, editor and project launch, team chat, notes, and reminders. Utility commands like kill process and color picker top the chart, but they are not "assistant" jobs.

### 1.2 Commands and AI tools inside the top Apple-app extensions

All commands and tools below are from the Raycast API dump, linked per extension.

- **Apple Reminders** ([store](https://www.raycast.com/raycast/apple-reminders))
  - Commands: My Reminders (view and complete), Create Reminder, Create Reminder from Current Tab, **Create Reminder from Selected Email**, Menu Bar Reminders, Next Reminder, Quick Add Reminder (natural language), Manage Locations, Manage Create Actions (runs a Shortcut after create).
  - AI tools: Get Reminders, Get Completed Reminders, Create Reminder, Update Reminder, Delete Reminder, Get Lists, Get Locations, Create Location.
- **Apple Notes** ([store](https://www.raycast.com/raycast/apple-notes))
  - Commands: Search Notes, New Note, AI Note, Add Text to Note, View Selected Note, Menu Bar Notes, Random Note.
  - AI tools: Create, Search, Get Note Content, Update, Append, Delete, Restore, Move Note, List Folders.
- **Apple Mail** ([store](https://www.raycast.com/yug2005/mail))
  - Commands: Check for New Mail, Paste Latest OTP Code, Compose, See Recent Mail, See Important Mail, Mark All as Read, Copy Mail Deeplink.
  - AI tools: Search Emails, Read Inbox Emails, Read Email, List Mailboxes, Send Email, Reply or Forward, Manage Email, List Email Attachments, **Save Email Attachment**, Move to Trash, Copy Email Link.
- **Messages** ([store](https://www.raycast.com/thomaslombart/messages))
  - Commands: Open Chat, My Latest Messages, Send Message, Unread Messages, Paste Latest OTP Code.
  - AI tools: Search Chats, Send Message, Search Latest Messages, Count Message Activity.
- **Music** ([store](https://www.raycast.com/fedevitaledev/music))
  - 21 AI tools, including Get Currently Playing, Play Library Album, Play Library Track, Start Playlist, Add to Playlist, Toggle Favorite, Set Volume and Toggle Shuffle.
- **Spotify Player** ([store](https://www.raycast.com/mattisssa/spotify-player))
  - 35 commands, including Search, Now Playing, Like, Queue, Start Radio, Generate Playlist and Start DJ.
  - AI tools: Search, Play, Get Current Track, Create Playlist, Add Track to Playlist, Queue.
- **Safari** ([store](https://www.raycast.com/loris/safari))
  - AI tools: Get All Tabs, **Get Tab Contents**, Get Focused Tab, Select Tab, Close Tab, Open URL, Search History, Search Bookmarks, Search Reading List, Add to Reading List.
- **Arc** ([store](https://www.raycast.com/the-browser-company/arc))
  - AI tools: Get Spaces, Get Tabs, Get Focused Tab, Select Tab, Select Space, Close Tab, Search History, Open New Tab and Open New Window variants.
- **Google Chrome** ([store](https://www.raycast.com/Codely/google-chrome))
  - AI tools: New Tab, New Window, Search Bookmarks, Search History, Get Profiles.
- **Things** ([store](https://www.raycast.com/loris/things))
  - 18 AI tools: Get To-Dos, Search To-Dos, Get Projects, Get Areas, Get Tags, Add To-Do, Add Project, Add Via JSON, Update To-Do, Set To-Do Property, Delete To-Do, and more.
- **Todoist** ([store](https://www.raycast.com/doist/todoist))
  - 29 tools covering full CRUD on tasks, projects, sections, labels, filters and comments, plus Complete and Uncomplete Task.
- **Obsidian** ([store](https://www.raycast.com/marcjulian/obsidian))
  - Commands: Append to Daily Note, Daily Note, Append Task, Quick Capture.
  - AI tools: Get Vaults, Search Note, Read Note, Create Note, Append to Note, Update Note, Open Note.
- **Zoom** ([store](https://www.raycast.com/raycast/zoom))
  - AI tools: Get Upcoming Meetings, Create Meeting Link, Schedule Meeting, Edit Meeting, Delete Meeting, Join Meeting.
- **Google Calendar** ([store](https://www.raycast.com/thomas/google-calendar))
  - 23 tools, including **Suggest Time**, **Check Availability**, Respond to Event, Move Event and Quick Add Event.
  - This is the best proxy for what users want from an Apple Calendar tool set.
- **Slack** ([store](https://www.raycast.com/mommertf/slack))
  - 21 tools, including Get Channel History, Read Thread, Search Messages, Send Message, Reply to Thread, Set Status and Add Reaction.
- **Bear** ([store](https://www.raycast.com/hmarr/bear)): Search Notes, New Note.
- **Drafts** ([store](https://www.raycast.com/FlohGro/drafts)): Create Draft, Find Drafts, Append/Prepend, Run Drafts Action.
- **Craft** ([store](https://www.raycast.com/sfkmk/craftdocs)): Search Blocks, Get Document, Create Document, Append, Add to Daily Note.
- **Downloads Manager** ([store](https://www.raycast.com/thomas/downloads-manager)): Get, Open, Copy, Paste and Delete Latest Download.

**Raycast built-in AI Extensions** ([manual](https://manual.raycast.com/ai/ai-extensions)):
- Built-ins include `@calendar` (schedule, free slots, upcoming events), `@finder`, `@file-search`, `@clipboard`, `@screen-awareness`, `@selected-text`, `@terminal`, `@browser`, `@memory` and `@weather`. `@reminders` is built in only on iOS.
- The manual's flagship prompts are "block out 2 hours tomorrow morning for deep work" and a chained "@calendar @things any free slots tomorrow that I could use to clear overdue tasks?".
- The "Auto" permission mode runs read-only tools freely and always asks before destructive actions ([manual](https://manual.raycast.com/ai/ai-extensions)).
- In MacStories' hands-on, these worked: playing an album by naming a remembered track (Music), listing Downloads, batch-renaming five PNGs and moving them into a new folder (Finder), and making a calendar event at sunset (Weather and Calendar). Attaching files to an Apple Notes note failed repeatedly. Reliability was the main complaint ([MacStories](https://www.macstories.net/reviews/hands-on-with-raycasts-new-ai-extensions/)).

## 2. Alfred

The [Alfred Gallery](https://alfred.app/workflows/) shows no download or popularity data, so I used GitHub stars as the proxy.
- **Largest collections and libraries:** [zenorocha/alfred-workflows](https://github.com/zenorocha/alfred-workflows) (12.2k stars) and [deanishe/alfred-workflow](https://github.com/deanishe/alfred-workflow) (2.9k).
- **Apple-app workflows:**
  - Reminders: [alfred-reminders](https://github.com/surrealroad/alfred-reminders) (695 stars)
  - Apple Notes: [alfred-search-notes-app](https://github.com/sballin/alfred-search-notes-app) (591)
  - Safari, Chrome, Arc and Brave tab search: [alfred-browser-tabs](https://github.com/epilande/alfred-browser-tabs) (474)
  - Bear: [alfred-bear](https://github.com/drgrib/alfred-bear) (442)
  - Things: [alfred-things](https://github.com/xilopaint/alfred-things) (359)
  - Safari bookmarks, history and reading list: [alfred-safari-assistant](https://github.com/deanishe/alfred-safari-assistant) (192)
  - Read and reply to iMessages: [alfred-mouseless-messenger](https://github.com/stephancasas/alfred-mouseless-messenger) (114)
  - Apple Music: [play-song](https://github.com/caleb531/play-song) (115)
  - Apple Calendar: [alfred-calendar](https://github.com/zeitlings/alfred-calendar) (94)
- **Third-party apps:**
  - Spotify: [alfred-spotify-mini-player](https://github.com/vdesabou/alfred-spotify-mini-player) (1.1k)
  - Obsidian: [shimmering-obsidian](https://github.com/chrisgrieser/shimmering-obsidian) (1.0k)
  - Notion: [notion-search-alfred-workflow](https://github.com/wrjlewis/notion-search-alfred-workflow) (842)
  - DEVONthink: [AlfredWorkflow-DEVONthink-Search](https://github.com/mpco/AlfredWorkflow-DEVONthink-Search) (584)
  - Keyboard Maestro: [alfred-maestro](https://github.com/iansinnott/alfred-maestro) (422)
- **Pattern:** Alfred demand is almost entirely *search* (notes, tabs, bookmarks) plus *quick capture* (reminders, tasks).

## 3. Keyboard Maestro, Hazel, Automator, BetterTouchTool

- **Keyboard Maestro.**
  - The community [Best Macro List](https://forum.keyboardmaestro.com/t/best-macro-list/4118) groups macros into these categories: clipboard processing, date/time stamps, file processing (batch rename in Finder, move selected Finder items to a chosen folder), text processing, palettes, browser macros (run JS in front browser, get Safari URL) and window management. Its only Mail entry is Mail Drop. The list is dated (2021).
  - Mail-filing is a live need. Users are building a palette to file Mail messages because Sonoma disabled the Mail Act-On plugin ([KM forum](https://forum.keyboardmaestro.com/t/macro-to-move-messages-in-apple-mail-to-replace-mail-act-on/36725)).
  - Users also want custom "Remind me in N days" presets for Mail ([KM forum](https://forum.keyboardmaestro.com/t/shortcuts-for-setting-remind-me-to-remind-me-in-2-days-3-days/36582)).
  - Calendar threads cover an emailed daily agenda from Apple Calendar and calendar-event-triggered macros ([KM calendar tag](https://forum.keyboardmaestro.com/tag/calendar)).
- **Hazel.**
  - In the MPU thread, the recurring rules are: label or trash stale Downloads (age-based, for example untouched for 3 months), move screenshots off the Desktop and delete them after N days, OCR PDFs then file bills, statements and receipts by content, and auto-expire share folders ([MPU Hazel rule examples](https://talk.macpowerusers.com/t/hazel-rule-examples/3308)).
  - The canonical example matches PDF text, then renames and files it as a dated "Gas Utility Bill" ([The Sweet Setup](https://thesweetsetup.com/use-hazel-to-auto-file-your-documents/)).
  - Hazel rules can call Shortcuts ([Hazel manual](https://www.noodlesoft.com/?p=1920)) and run AppleScript, JavaScript or shell ([manual](https://www.noodlesoft.com/manual/hazel/attributes-actions/using-applescript-or-javascript)).
  - I found no external API for creating or triggering rules (**unverified**).
- **Automator.**
  - The perennial Quick Actions are: batch-resize images, combine PDFs, then rename and move the result, sequential or date-stamped renaming, and folder actions on drop ([Macworld](https://www.macworld.com/article/668476/excellent-automator-workflows.html), [Apple dev forum](https://developer.apple.com/forums/thread/706793)).
- **BetterTouchTool.**
  - BTT is mostly input remapping: trackpad-corner window snapping and halves, moving windows between displays, quit-app gestures, and pasting text snippets ([Automators thread](https://talk.automators.fm/t/how-do-you-use-bettertouchtool/1104), [BTT docs](https://docs.folivora.ai/docs/window-snapping/overview/)).
  - This is low relevance to an app-connector agent.

## 4. Shortcuts

- **Gallery.**
  - Apple shows curated rows such as "Essentials" and "Morning Routine" ([Apple](https://support.apple.com/guide/shortcuts-mac/apdd018638ca/mac)).
  - Coverage also names Quick Shortcuts, Photography, "Shortcuts on macOS" and "Great with Siri" ([iGeeksBlog](https://www.igeeksblog.com/how-to-use-shortcuts-on-mac/)).
  - Apple's Gallery "Morning Summary" shortcut shows today's events, pending or overdue reminders, and the weather ([BGR](https://www.bgr.com/2211498/apple-iphone-shortcuts-perfect-busy-mornings/); exact Gallery placement **unverified**).
- **MacStories Shortcuts Archive** (444 shortcuts; counts from [archive-data.json](https://www.macstories.net/shortcuts/assets/archive-data.json)).
  - Category sizes: Shortcuts Playground 113, Photos 34, Web 31, **Task Management 25**, Media 21, Files 20, Mac 20, Calendar 11, Notes 7, Contacts 6, Music 5, Email 1.
  - Task Management is almost all Reminders: Create Reminder with Rich Link, Search Reminders For…, Today ReScheduler, Remove Completed Reminders, Log Completed Reminders, Webpage to Things, Append Notes to Things Task.
  - Calendar: Upcoming Events, Travel Time to Next Calendar Event, Create Calendar Event from Template, Weather for Upcoming Events.
  - Files: Delete Old Files, Rename and Save File, Document OCR, Zip and Share.
  - The newer Playground set includes **ActionItems**, which extracts action items from meeting notes or an email and makes one reminder each. It also includes MeetingNotes, DailyDigest, SmartSummarize, DraftEmail, PDFMerge, QuickOCR and CalendarConflictsRadar.
- **Viticci's starter pack** includes "Create Reminder" with a rich link from a copied URL ([MacStories](https://www.macstories.net/news/federico-shares-a-starter-pack-of-shortcuts-on-apples-app-store/)).
- **Recurring requests.** Reddit itself is **unverified**. These are the corroborating sources:
  - **Meeting notes from a calendar event** (title, time, attendees into a note): [Bear forum](https://community.bear.app/t/create-meeting-notes-from-calendar-apt/12872), [Drafts forum](https://forums.getdrafts.com/t/create-meeting-notes-from-event-details/5595) (attendees only reachable via Shortcuts), [tyler.io](https://tyler.io/preparing-for-work-meetings/).
  - **Daily briefing** (calendar, weather and to-dos into a note, scheduled each morning): [Craft Daily Agenda](https://www.craft.do/imagine/daily-agenda). Also a Weather, Mail, Calendar and Reminders summary via ChatGPT texted each morning ([techtiff](https://techtiff.substack.com/p/your-iphone-needs-a-job)).
  - **Email to reminder or task:** Raycast ships "Create Reminder from Selected Email" as a first-class command ([store](https://www.raycast.com/raycast/apple-reminders)). A search for a Reddit thread on this returned nothing (**unverified**).
  - **Clean up Downloads:** Hazel thread above. The MacStories "Delete Old Files" shortcut. Raycast Downloads Manager at 87k installs.
  - **Summarize unread mail:** Viticci asks his OpenClaw agent to "summarize his unread emails" ([Korben](https://korben.info/en/openclaw-personal-ai-assistant-mac.html)). There is also a ClawHub `email-daily-summary` skill with 18.7k downloads (ClawHub API).
- **Apple Mail AppleScript patterns people share:**
  - Move selected messages to a mailbox by setting `mailbox` ([MacScripter](https://macscripter.net/viewtopic.php?id=3200)). Nested-folder movers work on IMAP and Exchange; on POP accounts messages sometimes snap back to the inbox ([MacRumors](https://forums.macrumors.com/threads/sonoma-script-testers-needed-for-apple-mail-message-mover.2416638/)).
  - Save attachments of selected messages, or save them from a Mail rule ([Late Night Software](https://forum.latenightsw.com/t/saving-mail-message-attachments/1012/4), [Automators](https://talk.automators.fm/t/mail-attachments-from-mail-automate-download-to-folder/1527)).

## 5. Zapier, IFTTT and Make (demand signal)

- **Zapier** has no Apple app integrations: "There are no Apple app integrations available" (partner, 2026-06-10). Zapier's community manager says "Apple Calendar doesn't have a public API". The workaround is a Shortcuts webhook into a Zap, and a user called native support "a game changer" ([Zapier Community](https://community.zapier.com/how-do-i-3/connecting-apple-mail-and-calendar-to-zapier-53457)). This gap is Psyche's opening: local helpers are the only way in.
- **IFTTT** user counts:
  - iOS Contacts → Google Sheets: 272k ([IFTTT iOS Contacts](https://ifttt.com/ios_contacts))
  - iOS Contacts → Google Contacts: 124k ([IFTTT iOS Contacts](https://ifttt.com/ios_contacts))
  - Track work hours in iOS Calendar: 89k ([IFTTT iOS Calendar](https://ifttt.com/ios_calendar))
  - Weather forecast into iOS Calendar: 61.5k ([IFTTT iOS Calendar](https://ifttt.com/ios_calendar))
  - iOS Calendar → Google Calendar: 29.9k ([IFTTT iOS Calendar](https://ifttt.com/ios_calendar))
  - iOS Reminders → Todoist: 19.5k ([IFTTT iOS Reminders](https://ifttt.com/ios_reminders))
  - Reminders → Calendar events: 19.3k ([IFTTT iOS Reminders](https://ifttt.com/ios_reminders))
  - Alexa reminders → iPhone Reminders: 19.3k ([IFTTT iOS Reminders](https://ifttt.com/ios_reminders))
  - Screenshots → album: 115k ([IFTTT iOS Photos](https://ifttt.com/ios_photos))

  The dominant intent is **sync, backup and bridging** of Apple PIM data to other systems, not creation.
- **Make:** I found no Apple Calendar or Reminders module (**unverified**). iCloud access elsewhere goes through CalDAV with app-specific passwords and no push ([search summary incl. Nylas](https://developer.nylas.com/docs/cookbook/calendar/apple-calendar-api.md)).

## 6. Third-party Mac apps: automation surfaces

Raycast installs are the Mac-user-base proxy (Raycast API). ClawHub downloads come from the ClawHub API.

| App | Mac proxy | Surfaces | Quality for an agent |
|---|---|---|---|
| **Spotify** | Raycast 498,631 + 46,593; ClawHub `spotify-player` 28.4k | **Local:** AppleScript (`player state`, `current track`, play/pause/next, volume); metadata breaks when playing via Connect ([community](https://community.spotify.com/t5/Spotify-for-Developers/Connect-Recent-update-broke-AppleScript-for-Spotify-Connect/m-p/4778252/highlight/true), [node wrapper](https://github.com/matthewnitschke/spotify-node-applescript)). **Cloud:** [Web API](https://developer.spotify.com/documentation/web-api); extended access limited since 2025-05-15 ([Spotify](https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access)); dev mode capped at 5 users and needs Premium ([TechCrunch](https://techcrunch.com/2026/02/06/spotify-changes-developer-mode-api-to-require-premium-accounts-limits-test-users/)) | AppleScript is good for transport. Web API needed for search, playlists and queue, and is workable per user in dev mode (self-hosted, each user brings their own app) |
| **Google Chrome** | Raycast 579,363 | AppleScript windows and tabs (URL, title, execute JS; JS needs a user toggle, **unverified** here); used by [alfred-browser-tabs](https://github.com/epilande/alfred-browser-tabs) | Good for tab listing and reading pages |
| **Arc** | Raycast 255,335 | AppleScript spaces and tabs ([arc-applescript-api](https://github.com/kkoscielniak/arc-applescript-api)); in maintenance since May 2025, possible sunset noted on [Wikipedia](https://en.wikipedia.org/wiki/Arc_(web_browser)) (date disputed) | Good but declining; low priority |
| **VS Code** | Raycast 419,212 | `code` CLI (open files and folders, diff, goto, install extensions) ([docs](https://code.visualstudio.com/docs/configure/command-line)); `vscode://` URLs; editor content needs an extension ([OpenAI](https://help.openai.com/en/articles/10119604-work-with-apps-on-macos)) | Launching is excellent; reading state is weak |
| **Slack** | Raycast 340,714; ClawHub `slack` 54.4k | [Web API](https://docs.slack.dev/reference/methods/) (history, search, post, status) needs a Slack app and user token; the desktop app's AppleScript dictionary is **unverified** (likely none) | API quality high; setup friction high |
| **Notion** | Raycast 285,213; ClawHub 104.9k | [REST API](https://developers.notion.com/reference/intro) with integration token, page sharing per integration | High quality; per-page sharing friction |
| **1Password** | Raycast 256,622; ClawHub 34.8k | [`op` CLI](https://developer.1password.com/docs/cli/) with desktop-app biometric unlock | Excellent; must be read-only and approval-gated |
| **Obsidian** | Raycast 179,537; ClawHub 112.2k; [mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) 4.5k stars | Plain Markdown vault on disk. Obsidian URI (`open`, `new`, `daily`, `search`, `x-success`) ([docs](https://obsidian.md/help/Extending+Obsidian/Obsidian+URI)). Official CLI since 1.12.4, 2026-02-27 ([changelog](https://obsidian.md/changelog/2026-02-27-desktop-v1.12.4/)). [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) (HTTPS :27124, API key, heading and frontmatter PATCH, search, run commands, built-in MCP) | **Best in class.** Files work even when the app is closed |
| **Zoom** | Raycast 118,152 | `zoommtg://` is deprecated and undocumented per Zoom staff ([devforum](https://devforum.zoom.us/t/is-there-a-documentation-of-the-zoommtg-parameters/67755)); [REST API](https://developers.zoom.us/docs/api/) via OAuth for create and list meetings | Joining via `join_url` is easy; scheduling needs OAuth |
| **Todoist** | Raycast 98,636; ClawHub 22.8k | Unified API v1 at `api.todoist.com/api/v1`, bearer personal token, OpenAPI spec, Sync endpoint ([docs](https://developer.todoist.com/)) | Excellent; simplest auth of any task app |
| **iTerm2 / Terminal** | Raycast iTerm 44,756 (tools: Read/Write Contents) | iTerm2 AppleScript ([docs](https://iterm2.com/documentation-scripting.html)) plus [Python API](https://iterm2.com/python-api/); Terminal.app AppleScript `do script` (**unverified** here) | Good; high risk, so gate writes |
| **Things 3** | Raycast 42,367; ClawHub `things-mac` 17.1k; Alfred 359 stars | URL scheme `add`, `add-project`, `update`, `show`, `search`, `json` with x-callback returning IDs; `update` and `json` updates need an **auth-token** ([Cultured Code](https://culturedcode.com/things/support/articles/2803573/)). Full AppleScript CRUD for to-dos, projects, areas and tags plus `schedule`; no headings or checklist edits ([Cultured Code](https://culturedcode.com/things/support/articles/4562654/)) | Excellent locally (AppleScript reads, URL writes) |
| **Fantastical** | Raycast 22,510 | `x-fantastical://parse?sentence=…&add=1`, `show`, `date`, `search`; AppleScript `parse sentence … with add immediately` ([Flexibits](https://flexibits.com/fantastical/help/integration)) | Write-only natural-language capture; reads come from EventKit anyway |
| **Xcode** | Raycast 17,264 (tools for simulators, DerivedData) | `xcodebuild` and `xcrun simctl` CLIs ([Apple TN2339](https://developer.apple.com/library/archive/technotes/tn2339/_index.html)) | Excellent CLI; niche audience |
| **Bear** | Raycast 15,240; ClawHub 14.1k; Alfred 442 | x-callback-url: `/create`, `/add-text`, `/open-note`, `/search`, `/tags`; search and tag reads return nothing without the API token ([Bear](https://bear.app/faq/x-callback-url-scheme-documentation/)); SQLite `database.sqlite` in the group container, safe to read, editing discouraged ([Bear](https://bear.app/faq/where-are-bears-notes-located/)) | Good: SQLite read plus URL write |
| **Craft** | Raycast 15,143 | REST API per "connection" scoped to daily notes or chosen docs, with CRUD ([Craft](https://support.craft.do/en/integrate/api)); deeplinks to open, create, append and reach daily notes ([Craft](https://support.craft.do/en/integrate/deeplinks)) | Good, newer; smaller base |
| **Drafts** | Raycast 8,352 | URL scheme `/create`, `/append`, `/runAction`, `||clipboard||` token, some Pro-only ([docs](https://docs.getdrafts.com/docs/automation/urlschemes)); Mac AppleScript: make, query and update drafts, `perform action` ([docs](https://docs.getdrafts.com/docs/automation/applescript)) | Very good; small base |
| **DEVONthink** | Raycast 5,071; Alfred 584 stars; [MCP](https://github.com/dvcrn/mcp-server-devonthink) 104 stars | Deep AppleScript dictionary (**details unverified** here; [product page](https://www.devontechnologies.com/apps/devonthink)) | Strong API; niche pro audience |
| **OmniFocus** | Raycast 2,248; [OmniFocus-MCP](https://github.com/themotionmachine/OmniFocus-MCP) 250 stars | Omni Automation JS with plug-ins and a security toggle ([omni-automation.com](https://omni-automation.com/omnifocus/index.html)); [URL schemes](https://inside.omnifocus.com/url-schemes); AppleScript (**unverified** here) | Most powerful task API; small base |
| **Day One** | Raycast 1,364 | `dayone` CLI (renamed from `dayone2` in 2025.19) with `new` only ([Day One](https://dayoneapp.com/guides/command-line-interface-cli/)); `dayone://` links reported broken on macOS 15.5–15.6.1 ([forum](https://forums.dayoneapp.com/forums/topic/dayone-url-links-not-working-on-macos/)) | Write-only, weak |
| **Hazel** | n/a | Rules run Shortcuts, AppleScript, JS or shell ([manual](https://www.noodlesoft.com/?p=1920)); no external rule API found (**unverified**) | Treat as a downstream automation target, not a connector |

**Ranking by base × API quality:** Obsidian > Todoist > Things 3 > Spotify > Chrome > Notion > Slack > 1Password > VS Code > Zoom > iTerm2 > Fantastical > Bear > Drafts > Craft > OmniFocus > DEVONthink > Xcode > Arc > Day One.

## 7. The "assistant jobs" users describe

Context:
- **ChatGPT "Work with Apps"** reads the front app (Apple Notes, Notion, Xcode, VS Code, Terminal, iTerm, Warp) via the Accessibility API, includes the last 200 lines, and proposes diffs to apply ([OpenAI](https://help.openai.com/en/articles/10119604-work-with-apps-on-macos)).
- **New Siri:** the personal-context and in-app-action Siri slipped from iOS 18.4 ([Macworld](https://www.macworld.com/article/2631137/apple-is-delaying-the-only-apple-intelligence-feature-everyone-wanted.html)). It reached the iOS 27 beta built on App Intents entities and actions ([WWDC26](https://developer.apple.com/videos/play/wwdc2026/240/)). Testers found "plenty of misfires" but strong results inside Apple's own apps ([SlashGear](https://www.slashgear.com/2204931/new-siri-apple-intelligence-ios-27-test-review-what-works-or-doesnt/)). Apple's canonical example is "When does mom's plane land?" ([heise](https://heise.de/-10309947)).
- **Claude:** computer use reached Cowork and Claude Code on macOS on 2026-03-23. Its examples are a morning briefing, organizing folders, invoice spreadsheets and email workflows ([Anthropic](https://claude.com/blog/dispatch-and-computer-use)).
- **Rewind:** Meta acquired Limitless (formerly Rewind) on 2025-12-05 and disabled capture on 2025-12-19. That left demand for "search everything I saw" without a product ([9to5Mac](https://9to5mac.com/2025/12/05/rewind-limitless-meta-acquisition/)).
- **OpenClaw** is the closest comparable to Psyche. It has 393k GitHub stars (GitHub API). Its bundled skills include `apple-notes`, `apple-reminders`, `things-mac`, `bear-notes`, `obsidian`, `notion`, `1password`, `spotify-player`, `himalaya` (IMAP mail), `gog` (Google Workspace), `weather`, `summarize`, `openhue`, `sonoscli`, `tmux` and `peekaboo` ([repo skills/](https://github.com/openclaw/openclaw/tree/main/skills)).

**Top 25 concrete tasks, with evidence:**

1. **Morning briefing** (calendar, reminders, mail, weather): ClawHub `weather` 172.5k, `news-summary` 51.5k, `morning-email-rollup`, `ai-daily-briefing`. The [OpenClaw showcase](https://openclaw.ai/showcase) lists a "morning rollup of Gmail and Calendar". ChatGPT Pulse built a product around it ([Tom's Guide](https://www.tomsguide.com/ai/chatgpt-pulse-is-here-now-ai-starts-the-chat-and-curates-your-feed)). Apple's Morning Summary and [Craft](https://www.craft.do/imagine/daily-agenda) offer the same.
2. **Summarize unread or important mail:** Viticci ([Korben](https://korben.info/en/openclaw-personal-ai-assistant-mac.html)). ClawHub `email-daily-summary` 18.7k. Raycast Mail's "See Important Mail".
3. **Triage inbox, unsubscribe, clear backlog:** a showcase user cleared about 10k emails ([showcase](https://openclaw.ai/showcase)). Unsubscribe and surface-important are named in an [OpenClaw guide](https://aiblewmymind.substack.com/p/openclaw-ai-agent-use-cases-guide).
4. **Turn an email into a reminder or task:** Raycast "Create Reminder from Selected Email" ([store](https://www.raycast.com/raycast/apple-reminders)). Mail-to-task is the defining trick of Things and OmniFocus users (**unverified** Reddit).
5. **Capture a reminder in natural language with a due date:** Raycast Quick Add Reminder (124,645 installs); ClawHub `apple-reminders` 32.2k; [alfred-reminders](https://github.com/surrealroad/alfred-reminders).
6. **Review what's due or overdue and reschedule it:** MacStories "Today ReScheduler" and "Remove Completed Reminders" ([archive](https://www.macstories.net/shortcuts/)); the Raycast chained prompt about overdue tasks in free slots ([manual](https://manual.raycast.com/ai/ai-extensions)).
7. **Block focus time or time-block tasks:** `@calendar block out 2 hours` ([manual](https://manual.raycast.com/ai/ai-extensions)); "Timeblocking tasks" ([showcase](https://openclaw.ai/showcase)); Reclaim and Motion's core value ([Morgen](https://morgen.so/blog-posts/motion-vs-reclaim)).
8. **Schedule a meeting in a free slot:** the Google Calendar Raycast tools "Suggest Time" and "Check Availability" ([store](https://www.raycast.com/thomas/google-calendar)); ClawHub `google-calendar-scheduling`; Reclaim Smart Meetings ([Morgen](https://morgen.so/blog-posts/motion-vs-reclaim)).
9. **Resolve calendar conflicts:** "Resolving calendar conflicts" ([showcase](https://openclaw.ai/showcase)); MacStories "CalendarConflictsRadar" ([archive](https://www.macstories.net/shortcuts/)).
10. **Pre-meeting brief or meeting notes from an event:** "pre-meeting briefings" ([showcase](https://openclaw.ai/showcase)); [Bear forum](https://community.bear.app/t/create-meeting-notes-from-calendar-apt/12872); ClawHub `meeting-prep`.
11. **Extract action items from notes or a transcript into reminders:** MacStories ActionItems ([archive](https://www.macstories.net/shortcuts/)); ClawHub `ai-meeting-notes` 12.2k and `meeting-to-action`.
12. **Join my next meeting:** the Raycast core "killer feature" ([Raycast](https://www.raycast.com/core-features/calendar)); Zoom Join Meeting tool.
13. **Find that note about X:** Raycast Apple Notes Search (158k); [mcp-apple-notes](https://github.com/RafalWilinski/mcp-apple-notes), RAG over Notes, 417 stars; Obsidian search tools.
14. **Append to today's daily note or quick capture:** Obsidian "Append to Daily Note" ([store](https://www.raycast.com/marcjulian/obsidian)); "Updating Obsidian daily notes" ([showcase](https://openclaw.ai/showcase)); Craft "Add to Daily Note".
15. **Follow up with people who haven't replied:** Superhuman Auto Reminders and Auto Drafts ([Superhuman](https://help.superhuman.com/hc/en-us/articles/40144492186515)); "writing email follow-ups" ([showcase](https://openclaw.ai/showcase)).
16. **Draft or send a reply:** Raycast Mail "Reply or Forward Email" and "Send Email" tools; [apple-mail-mcp](https://github.com/patrickfreyer/apple-mail-mcp) at 237 stars.
17. **File this message or save this attachment:** Raycast "Save Email Attachment" tool; the KM Mail Act-On replacement ([KM](https://forum.keyboardmaestro.com/t/macro-to-move-messages-in-apple-mail-to-replace-mail-act-on/36725)); "turning forwarded email receipts into a parts list" ([showcase](https://openclaw.ai/showcase)).
18. **Play focus or mood music:** Viticci's mood playlists ([Korben](https://korben.info/en/openclaw-personal-ai-assistant-mac.html)); Spotify Player 498k; Raycast Music "Play Library Album" demo ([MacStories](https://www.macstories.net/reviews/hands-on-with-raycasts-new-ai-extensions/)).
19. **Read or reply to iMessages:** Raycast Messages 53k; [mac_messages_mcp](https://github.com/carterlasalle/mac_messages_mcp) 335 stars; ClawHub `imsg` 18.3k; "reading Beeper messages" ([showcase](https://openclaw.ai/showcase)).
20. **Paste the latest 2FA code:** [2FA Code Finder](https://www.raycast.com/yuercl/imessage-2fa) 40,678; "Paste Latest OTP Code" in both the Mail and Messages extensions.
21. **Clean up and organize Downloads and Desktop:** [MPU Hazel](https://talk.macpowerusers.com/t/hazel-rule-examples/3308); Downloads Manager 87k; Cowork "reorganizing a messy Downloads folder" ([Anthropic](https://claude.com/blog/dispatch-and-computer-use)).
22. **File and rename documents** such as bills, receipts and PDFs: [Sweet Setup](https://thesweetsetup.com/use-hazel-to-auto-file-your-documents/); the Raycast @finder batch rename ([MacStories](https://www.macstories.net/reviews/hands-on-with-raycasts-new-ai-extensions/)); ClawHub `nano-pdf` 123k.
23. **Ask about or act on what's on screen or in a tab:** ChatGPT Work with Apps ([OpenAI](https://help.openai.com/en/articles/10119604-work-with-apps-on-macos)); Dia tab chat and summaries ([Composite](https://composite.com/blog/dia-browser-reviews-pricing-alternatives)); Raycast Safari "Get Tab Contents".
24. **Control home and speakers** (Hue, Sonos, HomePod): Viticci dims his lights ([Korben](https://korben.info/en/openclaw-personal-ai-assistant-mac.html)); ClawHub `sonoscli` 90.4k and `openhue` 14.5k; "Controlling HomePods" ([showcase](https://openclaw.ai/showcase)).
25. **Recall "that thing I saw" and look up a contact:** Rewind's searchable history, now gone ([9to5Mac](https://9to5mac.com/2025/12/05/rewind-limitless-meta-acquisition/)); the Contacts tools of [apple-mcp](https://github.com/supermemoryai/apple-mcp), 3.1k stars, archived 2026-01-01.

---

## Ranked: top 40 capabilities by demand evidence

1. **Calendar:** list today and upcoming events (Raycast core, @calendar, every briefing).
2. **Briefing:** compose the daily summary (calendar, reminders, mail, weather) on a schedule (ClawHub weather 172k, Pulse, Gallery).
3. **Reminders:** create with due date, list and priority from natural language (124k installs; 32k ClawHub).
4. **Spotify:** play, pause, skip and now-playing (498k + 47k installs).
5. **Spotify:** search, play, queue and playlist from mood (Viticci; Player tools).
6. **Chrome/Safari:** list and search open tabs; read the focused tab's content (579k + 62k).
7. **Notes:** search Apple Notes and read a note (158k; 591-star Alfred; 417-star MCP).
8. **Mail:** search and read inbox; summarize unread (Raycast tools; Viticci; 18.7k summary skill).
9. **Reminders:** list due or overdue and complete (Raycast My Reminders; MacStories).
10. **Calendar:** create an event or block focus time (@calendar flagship prompt).
11. **Calendar:** find free slots and suggest times (Google Calendar tools; Reclaim).
12. **Mail → Reminders:** reminder from the selected email with a `message://` link (Raycast first-class command).
13. **Obsidian:** search, read, and append to the daily note (180k; 112k ClawHub; 4.5k-star MCP).
14. **Notion:** search, read, and create a page (285k; 105k ClawHub).
15. **Slack:** unread, search, read thread, send (341k; 54k ClawHub).
16. **VS Code:** open a project or file; recent projects (419k).
17. **Messages:** read recent or unread chats (53k; 335-star MCP).
18. **Messages/Mail:** extract the latest OTP code (41k plus two built-in commands).
19. **Notes:** create a note or append text (Raycast and Alfred append workflows).
20. **Zoom/Calendar:** join the next meeting (Raycast core; Zoom 118k).
21. **Files:** latest download; clean up stale Downloads (87k; Hazel).
22. **Files:** batch rename, move, or sort by rule (Hazel, KM, Automator, @finder).
23. **Mail:** draft a reply or send (approval-gated) (Raycast tools; apple-mail-mcp).
24. **Messages:** send an iMessage (approval-gated) (Raycast; apple-mcp).
25. **Todoist:** create, list, and complete tasks (99k; 23k ClawHub).
26. **Apple Music:** play a library album or playlist; now playing (103k; 21 tools).
27. **Mail:** move or file messages to a mailbox (KM Mail Act-On replacement).
28. **Mail:** save attachments to a folder (Raycast tool; script threads).
29. **Meeting prep:** event plus attendees into a note (forums, ClawHub).
30. **Action items:** extract from text into reminders (MacStories ActionItems; ClawHub).
31. **Things 3:** add a to-do; show Today and Inbox (42k; 17k ClawHub).
32. **1Password:** fetch an item via `op` (read-only, approval) (257k; 35k ClawHub).
33. **Zoom:** create a meeting link or schedule (Zoom tools).
34. **Mail:** follow up on unanswered sent mail (Superhuman; showcase).
35. **Contacts:** look up phone or email for a person (IFTTT 272k bridges; Alfred).
36. **iTerm/Terminal:** run a command and read the output (45k with Read/Write tools; Work with Apps).
37. **Shortcuts:** run a named user shortcut, as a long-tail escape hatch (Hazel, Raycast "Manage Create Actions", 352-star MCP).
38. **System:** list and kill processes (Kill Process, 789k, #1 overall).
39. **Home:** Hue, Sonos, and HomeKit scenes (ClawHub 90k + 14k).
40. **Bear:** search and create notes (15k; 14k ClawHub; 442-star Alfred).

## Top 10 third-party apps worth supporting

1. **Spotify:** largest music install base (499k). AppleScript covers playback with no auth; the per-user Web API adds search and playlists.
2. **Google Chrome:** the most-installed app extension (579k). AppleScript tabs give "what am I looking at" context.
3. **Obsidian:** 180k installs and 112k ClawHub downloads. Plain files plus the official CLI and Local REST API make it the most reliable connector to build.
4. **Notion:** 285k installs and 105k ClawHub downloads. A mature REST API; the only friction is per-page sharing.
5. **Slack:** 341k installs and 21 Raycast AI tools show heavy read/search/send use. API-only, so BYO app token.
6. **Todoist:** 99k installs. The cleanest task API (v1, personal token), with 29 tools proven in Raycast.
7. **Things 3:** 42k installs and 17k ClawHub downloads. Excellent local AppleScript reads plus auth-token URL writes; a Mac-native favorite.
8. **VS Code:** 419k installs. `code` CLI and URL scheme for open and launch; pair it with Terminal or iTerm2 for developer users.
9. **Zoom:** 118k installs. Join via `join_url` is trivial; schedule via OAuth API. Pairs with calendar jobs 12, 20 and 33.
10. **1Password:** 257k installs. The `op` CLI with biometric unlock lets the agent fill credentials safely; read-only with per-use approval.

Near misses:
- **Arc** (255k installs, but in maintenance mode).
- **Fantastical** (22k; its write-only parse is redundant with EventKit).
- **Bear and Drafts** (good local APIs, small bases).
- **OmniFocus and DEVONthink** (the best APIs, the smallest audiences).
