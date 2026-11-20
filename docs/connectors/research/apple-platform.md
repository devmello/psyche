# Apple platform research: automation, assistants, and app connectors (macOS 26 / 27)

Research date: 2026-10-25. Target machine: macOS 27.0.1 ("Golden Gate"). This file comes from web research only. Nothing here was run or tested against apps. Each claim has a link. "Unverified" means I could not confirm the point in a primary or two secondary sources.

---

## 1. macOS 26 (Tahoe) and macOS 27 (Golden Gate): automation and assistant surface

### 1.1 Release facts
- macOS 27 "Golden Gate" shipped to the public on 2026-09-14 and runs only on Apple silicon ([MacRumors roundup](https://www.macrumors.com/roundup/macos-27/), [MacObserver](https://www.macobserver.com/news/apple-releases-macos-27-golden-gate-with-new-siri-ai-and-more/)).
- Siri AI is still labelled **beta** on macOS 27. It needs an Apple Intelligence Mac (M1 or later, or a MacBook Neo with A18 Pro) and starts in English only. Server-side features have **daily usage limits**, and Apple says expanded access "will be available for a fee" later ([Apple Support: Siri AI on Mac](https://support.apple.com/en-au/guide/mac-help/mac88e1mkh19/mac), [Apple: New in OS 27](https://support.apple.com/en-us/149045)).

### 1.2 Siri with App Intents on the Mac (personal context, on-screen awareness, cross-app actions)
- **Personal context:** Siri AI can search Photos, Mail, Messages and Calendar, for example to find flight details in an email ([Apple Support](https://support.apple.com/en-au/guide/mac-help/mac88e1mkh19/mac)). Third-party content joins the same pool through Spotlight indexing ([evezone summary, secondary](https://evezone.evetech.co.za/build-lab/how-to-use-the-new-personal-context-siri-on-mac-to-find-things-across-your-apps)).
- **On-screen awareness:** ⇧⌘Space captures a window and ⇧⌘6 captures a region, and the capture goes to Visual Intelligence ([Apple Support](https://support.apple.com/en-au/guide/mac-help/mac88e1mkh19/mac), [MacRumors 50 features](https://www.macrumors.com/2026/09/17/new-features-changes-macos-27/)).
- **Spotlight now doubles as Siri.** ⌘Space opens a "Search or Ask" bar. There is also a separate Siri app that keeps chat history and syncs it across devices ([MacRumors](https://www.macrumors.com/2026/09/17/new-features-changes-macos-27/)).
- **Developer APIs (WWDC26):**
  - *Entity schemas* add app content to the **Spotlight semantic index**.
  - *Intent schemas* let Siri act on that content without trigger phrases.
  - A new **View Annotations API** maps on-screen views to entities.
  - **AppIntentsTesting** lets developers test intents without UI automation.
  - Sources: [Apple WWDC26 macOS guide](https://developer.apple.com/wwdc26/guides/macos/), [MacRumors SOTU](https://www.macrumors.com/2026/06/09/apple-outlines-major-ai-and-developer-tool-updates/), [session 240](https://developer.apple.com/videos/play/wwdc2026/240/).
  - View annotations use `.appEntityIdentifier(EntityIdentifier(for:identifier:))`, and indexing uses `IndexedEntity` with `indexingKey`. Content moves between apps through `Transferable` and `IntentValueRepresentation` ([DEV write-up of session 240, secondary](https://dev.to/arshtechpro/wwdc-2026-build-intelligent-siri-experiences-with-app-schemas-102o)).
- **App schema domains** ([Apple docs](https://developer.apple.com/documentation/appintents/app-schema-domains)):
  - *Primary domains (Siri and Apple Intelligence):* Audio, Calendar, Camera, Clock, Mail, Maps, Messages, Notes, Phone, Photos, Reminders, and System/in-app search.
  - *Shortcuts-only domains:* Books, Browser, Files, Journaling, Presentation, Reader, Spreadsheet, Whiteboard, and Word processor.
- **Who can call these intents.** App Intents are invoked by system surfaces: Siri, Spotlight, Shortcuts and widgets. I found **no public API that lets one third-party app call another app's App Intents directly** (unverified as an absolute claim; the [session write-up](https://dev.to/arshtechpro/wwdc-2026-build-intelligent-siri-experiences-with-app-schemas-102o) says only that intents surface in system features). In practice, Shortcuts (and its CLI) is the bridge.
- **Reliability is uneven.** MacStories' macOS 27 review gives these results ([MacStories](https://www.macstories.net/stories/macos-27-the-macstories-review/6/)):
  - Siri "integrates well with Calendar, Notes, Reminders, Mail, Messages, Maps, and Photos, although not perfectly."
  - In Finder it "couldn't rename files, move them, or duplicate them."
  - In Music it miscounted the library.
  - The Siri app "can't use the command line or AppleScript," which Shortcuts can.

### 1.3 Foundation Models framework (on-device LLM for apps)
- **macOS 26 baseline:** the API is `LanguageModelSession`, with `@Generable` and `@Guide` for guided generation, a `Tool` protocol, and streaming. The on-device model is about 3B parameters at 2-bit quantization ([atelier-socle guide, secondary](https://www.atelier-socle.com/en/articles/foundation-models-api-guide)). Each session gets **4,096 tokens**, shared by instructions, prompt, tool output and response ([Apple TN3193](https://developer.apple.com/tutorials/data/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window.md)).
- **WWDC26 additions** ([Apple WWDC26 guide](https://developer.apple.com/wwdc26/guides/macos/), [MacRumors](https://www.macrumors.com/2026/06/09/apple-outlines-major-ai-and-developer-tool-updates/), [session 241](https://developer.apple.com/videos/play/wwdc2026/241/)):
  - Image input.
  - Built-in Vision tools (OCR, barcodes) that the model can call on-device.
  - A `LanguageModel` protocol, so "cloud models like Claude and Gemini, or any other provider" can sit behind the same Swift API.
  - **Dynamic Profiles**, which swap models, tools and instructions within one session ("multi-agent workflows").
  - An Evaluations framework.
  - The `fm` CLI and a Python SDK.
  - Free Private Cloud Compute access for apps with fewer than 2M first-time downloads.
  - Apple says the framework will be open-sourced.
- A larger on-device model is reported for 12 GB+ devices ([implicator](https://www.implicator.ai/apple-expands-xcode-and-foundation-models-for-wwdc-ai-developers/), [Callstack](https://callstack.com/blog/on-device-ai-after-wwdc-2026-whats-new); secondary).
- The **Core AI** framework (new) runs custom on-device models ([Apple](https://developer.apple.com/wwdc26/guides/macos/)).

### 1.4 Shortcuts changes
**macOS 26 Tahoe** ([Apple: What's new in Shortcuts 26](https://support.apple.com/en-gb/125148)):
- **Use Model** sends data to an on-device model, Private Cloud Compute, or ChatGPT. Output can be text, a dictionary, or app entities, and there is a Follow Up toggle ([Crosley guide](https://blakecrosley.com/guides/shortcuts)).
- New Writing Tools and Image Playground actions.
- **Mac personal automations for the first time.** Triggers: Time of Day, Alarm, Email, Message, Folder, File, External Drive, Wi-Fi, Bluetooth, Display, Stage Manager, App, Battery Level, Charger, and Focus.
- Shortcuts can run from Spotlight with selected text as input, and can sit in Control Center or the menu bar.

**macOS 27** ([Apple: New in OS 27](https://support.apple.com/en-us/149045), [9to5Mac](https://9to5mac.com/?p=1071897)):
- You can describe a shortcut in natural language and Shortcuts builds it ("usage limits may apply").
- New triggers: **Screenshot** (Mac) and **Notification**. Apple's example is News notifications.
- Use Model gains "enhanced" models (AFM 3 Cloud, with daily caps) and live web lookup.
- New storage actions keep data between runs (Store/Get/Delete Stored Content).
- New **Get Selected Text** action, and a richer **Get What's On Screen**.
- "Otherwise If" in the If action.
- Automations are now stored *inside* shortcuts and sync between devices. This conflicts with an older note that automations are device-local ([Crosley](https://blakecrosley.com/guides/shortcuts)). Unverified which behaviour holds on 27.0.1.
- Known 27 beta issue: Battery and Charger automations may not fire ([Crosley](https://blakecrosley.com/guides/shortcuts)).

### 1.5 MCP / "agent" support from Apple
- **App Intents: no MCP shipped.**
  - Code in the iOS 26.1 / macOS 26.1 betas pointed to MCP inside App Intents ([9to5Mac via Computerworld](https://www.computerworld.com/article/4061614/apple-to-deploy-mcp-support-for-powerful-ai-experiences.html), [AlternativeTo](https://alternativeto.net/news/2025/9/apple-begins-testing-early-model-context-protocol-mcp-support-in-ios-ipados-and-macos), [BGR](https://www.bgr.com/1976159/ios-26-beta-mcp-ai-feature/)).
  - At WWDC26 Apple announced MCP for **Xcode only** ("only for developers, not for end users") and not for App Intents ([Omni Group](https://www.omnigroup.com/blog/omni-roadmap-2026-post-wwdc-update), [MacSparky](https://www.macsparky.com/blog/2026/07/omni-group-building-toward-mcp-support/)).
  - No system-wide App Intents to MCP bridge has been confirmed in macOS 27 (unverified, but nothing found).
- **Xcode 27 `mcpbridge`** translates stdio MCP to XPC calls into a running Xcode ([andrew.ooo](https://andrew.ooo/answers/apple-mcp-xcode-27-vs-anthropic-mcp-vs-microsoft-mcp-june-2026/), [Vaughan](https://codex.danielvaughan.com/2026/06/11/xcode-27-codex-cli-mcp-bridge-apple-agentic-coding-ios-macos-development/); secondary).
- **Safari 27 ships a native MCP server** (`/usr/bin/safaridriver --mcp`) ([WebKit blog](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/)):
  - *Opt-in:* Safari ▸ Settings ▸ Advanced ▸ "Show features for web developers", then Developer ▸ "Allow remote automation and external agents".
  - *17 tools:* `create_tab`, `close_tab`, `list_tabs`, `switch_tab`, `navigate_to_url`, `wait_for_navigation`, `page_info`, `get_page_content`, `screenshot`, `page_interactions`, `evaluate_javascript`, `browser_dialogs`, `browser_console_messages`, `list_network_requests`, `get_network_request`, `set_viewport_size`, and `set_emulated_media`.
  - *Isolation:* no access to AutoFill or browsing history, and no network calls of its own. One report adds a dedicated automation window without cookies ([Forkast](https://forkast.news/safari-27-ships-a-native-mcp-server-and-apple-gave-enterprises-no-way-to-turn-it-off/)).
  - *Enterprise:* there is **no MDM key to disable it** on macOS ([Forkast](https://forkast.news/safari-27-ships-a-native-mcp-server-and-apple-gave-enterprises-no-way-to-turn-it-off/)).
  - *Scope:* it is aimed at web developers, so it cannot reach the user's logged-in browsing.

### 1.6 The `shortcuts` CLI as a universal bridge to App Intents
- **Commands:**
  - `shortcuts run <name|UUID> [-i paths…] [-o path] [--output-type UTI]`
  - `shortcuts list [-f folder] [--folders] [--show-identifiers]`
  - `shortcuts view`
  - `shortcuts sign`
  - Sources: [Apple guide](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac), [Crosley](https://blakecrosley.com/guides/shortcuts).
- **Exit status** is 0 on success and 1 on error.
- **Input and output:**
  - `-i` takes file paths. Piped stdin arrives as **text**, and `-i -` reads stdin ([Crosley](https://blakecrosley.com/guides/shortcuts)).
  - Output comes back only if the shortcut ends with an output action or Stop and Output ([Apple](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac)).
- **Limits:**
  - Alerts or Ask-for-Input steps **block the process** until a person answers.
  - It needs a **logged-in GUI session**. Over SSH or from a LaunchDaemon it fails with "Couldn't communicate with a helper application."
  - There is no built-in timeout, so callers must add one.
  - Consent prompts must be pre-cleared with "Always Allow."
  - Sources: [Apple](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac), [Crosley](https://blakecrosley.com/guides/shortcuts).
  - Size limits: unverified.
- **Alternative through Apple Events:** `tell application "Shortcuts Events" to run shortcut "X" with input …` runs in the background ([Cassinelli](https://matthewcassinelli.com/shortcuts-applescript-commands/), [Six Colors](https://sixcolors.com/post/2022/01/shortcuts-applescript-terminal-working-around-automation-roadblocks/)). A hardened-runtime app reportedly needs the Apple Events entitlement, `NSAppleEventsUsageDescription`, and `com.apple.shortcuts.events` ([Apple forums](https://developer.apple.com/forums/thread/698879)).
- **Why it matters:** shortcuts are the only supported way for an outside process to reach Apple-app intents that have no other API, such as Notes tags, Notes checklists, Photos album operations, Messages tapbacks, and Freeform boards.

---

## 2. Per-app Shortcuts actions / App Intents (and what people automate)

Baseline action names come from Matthew Cassinelli's action directory ([index](https://matthewcassinelli.com/actions/)) and Apple's release notes: [OS 16](https://support.apple.com/en-us/101583), [OS 17](https://support.apple.com/en-us/HT213909), [OS 18](https://support.apple.com/en-md/121131), [OS 26](https://support.apple.com/en-gb/125148), and [OS 27](https://support.apple.com/en-us/149045).

| App | Exposed actions (Shortcuts / App Intents) | Notable gaps |
|---|---|---|
| **Calendar** | Find Calendar Events, Get Details of Calendar Events, Get Details of Event Attendees, Filter Event Attendees, Add New Event, Edit Calendar Event, Get Upcoming Events, Remove Events, Show in Calendar ([Cassinelli](https://matthewcassinelli.com/action_groups/apps/calendar/)). Attendees gained a Type (person, group, room) in OS 17 ([Apple](https://support.apple.com/en-us/HT213909)). macOS 27 adds natural-language event create and edit in the app ([MacRumors](https://www.macrumors.com/2026/09/17/new-features-changes-macos-27/)). | **No "Add attendee" action** found (unverified). Attendees are read-only, the same as in EventKit. No new Calendar actions in 26 or 27 ([9to5Mac](https://9to5mac.com/?p=1071897)). |
| **Reminders** | Add New Reminder, Find Reminders, Get Upcoming Reminders, Get Details of Reminders, Edit Reminder, Remove Reminders, Show Reminders List ([Cassinelli](https://matthewcassinelli.com/action_groups/apps/reminders/)). Create List and Search in Reminders (OS 16), Open Smart List (16.1) ([Apple](https://support.apple.com/en-us/101583)). **OS 27 adds** Edit List, Create/Delete Groups, and Create/Delete Sections ([Apple](https://support.apple.com/en-us/149045)). | Tags and subtask actions are historically weak: no tag access, and subtasks need a parent picked for each item ([McHale](https://curtismchale.ca/2022/12/14/issues-with-apple-reminders), [MacStories Club](https://club.macstories.net/posts/automation-academy-diving-deeper-into-reminders-actions)). Current tag and subtask parameters on 27: unverified. |
| **Mail** | Send Email, Open Mailbox, Search in Mail (OS 16) ([Apple](https://support.apple.com/en-us/101583)). **Find Message** (OS 26) ([Apple](https://support.apple.com/en-gb/125148)). Email trigger on Mac (26). The Mail App Intents schema domain covers draft, reply, forward and send ([Apple](https://developer.apple.com/documentation/appintents/app-schema-domains), [zenn](https://zenn.dev/shu223/articles/app-intent-domains)). | No flag, move, or rule actions found. Those exist only in AppleScript. |
| **Notes** | Create Note, Find Notes, Append to Note, Show Note, Show Notes Folder ([Cassinelli](https://matthewcassinelli.com/action_groups/documents/notes/)). OS 16 added Delete Notes, Pin Notes, Create Folder, Delete Folders, Move Notes to Folder, Open Folder, Add/Remove Tags, Create/Delete/Open Tag, and Change Notes Setting ([Apple](https://support.apple.com/en-us/101583)). OS 18.5 added Rename Folder, **Append Checklist Item**, and Add File ([Apple](https://support.apple.com/en-md/121131)). **OS 27:** Create Note and Append Text to Note accept **Markdown**, and Append can target a **section** (start or end) ([Apple](https://support.apple.com/en-us/149045)). | No action to toggle one checklist item; changing one checkbox means rebuilding the note ([apple-notes-mcp notes](https://skillselion.com/skills/spillwavesolutions/automating-mac-apps-plugin/automating-notes)). Locked notes are unreadable. |
| **Contacts** | Find Contacts, Get Details of Contacts, Edit Contact, Select Contact, Get Contacts/Phone Numbers from Input, Call ([Cassinelli](https://matthewcassinelli.com/action_groups/apps/contacts/)). | No group management found (unverified). |
| **Photos** | Find Photos, Get Latest Photos/Screenshots/Videos, Create Photo Album, Save to/Remove from Album, Delete Photos ([Cassinelli](https://matthewcassinelli.com/action_groups/media/photos/)). OS 17: Open Collection. **OS 26:** Rename Album, Search Photos, Create New Memory, Filter Library ([Apple](https://support.apple.com/en-gb/125148)). **OS 27:** Favorite, Hide, Auto Enhance, Find Albums, Delete Albums, Open Photo ([Apple](https://support.apple.com/en-us/149045)). | No action for the new macOS 27 keywords or star ratings (unverified). |
| **Music** | Play Music, Find Music, Get Current Song, Get Details of Music, Select Music ([Cassinelli](https://matthewcassinelli.com/action_groups/media/music/)). Also Add to Playlist and Playback controls (unverified naming). | Siri's library handling on 27 was unreliable ([MacStories](https://www.macstories.net/stories/macos-27-the-macstories-review/6/)). |
| **Safari** | Open URLs, Run JavaScript on Web Page, Add to Reading List, Get Details of Safari Web Page ([Cassinelli](https://matthewcassinelli.com/action_groups/web/safari/)). OS 16 added Tab Groups, Find/Open Bookmarks, **Find Reading List Items**, Find/Close/Create Tabs, and Reader ([Apple](https://support.apple.com/en-us/101583)). | History is not exposed. JavaScript needs the "Allow JavaScript from Apple Events" setting ([Apple forums](https://developer.apple.com/forums/thread/836299)). |
| **Finder / Files** | Get Details of Files, Filter Files, Search in Files (OS 16), **Get Info** (Finder, 18.1), plus the scripting file actions ([Cassinelli](https://matthewcassinelli.com/action_groups/documents/files-document/), [Apple](https://support.apple.com/en-md/121131)). Folder and File triggers (26). | Siri on 27 cannot rename or move files ([MacStories](https://www.macstories.net/stories/macos-27-the-macstories-review/6/)). |
| **Maps** | Open Directions, Open in Maps, Get Travel Time, Parked Car (OS 16) ([Cassinelli](https://matthewcassinelli.com/action_groups/location/maps/), [Apple](https://support.apple.com/en-us/101583)). | Directions results are thin; MapKit is better. |
| **Weather** | Get Current Weather, Get Weather Forecast, Show Weather ([Cassinelli](https://matthewcassinelli.com/action_groups/location/weather/)). **OS 26:** Add/Remove Location to List ([Apple](https://support.apple.com/en-gb/125148)). | None of note. |
| **Voice Memos** | OS 16: Create Recording, Search Voice Memos, Play/Open Recording, folder operations ([Apple](https://support.apple.com/en-us/101583)). **OS 26:** Find Voice Recording ([Apple](https://support.apple.com/en-gb/125148)). | A "Get transcript" action: unverified. Transcripts live in the m4a `tsrp` atom (§3). |
| **Freeform** | Create Board, Open Board (18), Rename/Update Board (18.2), **Add Files to Board** (26) ([Apple](https://support.apple.com/en-md/121131), [Apple](https://support.apple.com/en-gb/125148)). | No content read. |
| **Focus** | Set Focus, **Get Current Focus**, Focus Filters (macOS 13) ([Apple](https://support.apple.com/en-us/101583)). Focus trigger on Mac (26). | None of note. |
| **Clock** | Create/Toggle/Delete Alarm, Find Alarm, Start Timer (macOS 13); Add/Remove City (18.4) ([Apple](https://support.apple.com/en-us/101583), [Apple](https://support.apple.com/en-md/121131)). | Pause, resume and cancel timer actions are listed for iOS only ([Apple](https://support.apple.com/en-us/HT213909)). |
| **Messages** | Send Message, Open Conversation (18.4). **OS 26:** Find Message, Find Conversation ([Apple](https://support.apple.com/en-gb/125148)). **OS 27:** Send Tapback, Mark as Read, Delete Messages/Conversations, Open Inbox, Search in Messages; group sends; Find Message filtered by sender ([Apple](https://support.apple.com/en-us/149045)). Message trigger on Mac. | Attachments: unverified. |
| **Preview** | No dedicated actions found. Generic PDF and image actions apply (Optimize PDF, Remove Background, Extract Text) ([Apple](https://support.apple.com/en-us/101583)). | — |
| **Pages / Numbers / Keynote** | Open a document, Open a spreadsheet, Add to a spreadsheet, Open a presentation ([Cassinelli Pages](https://matthewcassinelli.com/action_groups/apps/pages/), [Numbers](https://matthewcassinelli.com/action_groups/apps/numbers-app/), [Keynote](https://matthewcassinelli.com/action_groups/apps/keynote/)). Schema domains exist for word processor, spreadsheet and presentation ([Apple](https://developer.apple.com/documentation/appintents/app-schema-domains)). | Thin Shortcuts coverage. The real power is the AppleScript dictionaries. |
| **Home** | Control Home, Get the state of Home ([Cassinelli](https://matthewcassinelli.com/action_groups/apps/home/)). | HomeKit has no native macOS API (§3). |
| **Books** | Open Book, Play Audiobook, Search in Books, Turn Page, Find Books ([Apple](https://support.apple.com/en-us/101583)). | Highlights are not exposed. |
| **Podcasts** | Play Podcast, Get Podcasts from Library, Get Episodes, Subscribe, Search ([Cassinelli](https://matthewcassinelli.com/action_groups/media/podcasts/)). | None of note. |
| **Stocks** | Get Stock Quote, Get Details of Stocks; **OS 26:** Add/Delete Symbol to/from Watchlist ([Cassinelli](https://matthewcassinelli.com/action_groups/apps/stocks/), [Apple](https://support.apple.com/en-gb/125148)). | None of note. |
| **Journal** | Create Entry, Create Audio Entry, Search Entries (OS 18, iOS/iPadOS only) ([Apple](https://support.apple.com/en-md/121131)). Journal came to Mac in macOS 26 ([TechRadar](https://www.techradar.com/computing/websites-apps/macos-tahoe-26-finally-brings-journal-to-mac-and-i-might-use-it-now)). | Mac actions: unverified. |
| **Passwords** | Show Passwords only ([Apple](https://support.apple.com/en-us/HT213909)). | By design, no read access. |
| **Image Playground** | Create Image (26) ([Apple](https://support.apple.com/en-gb/125148)). | Programmatic `ImageCreator` is **deprecated and throws `notSupported` on macOS 27** ([Apple docs](https://developer.apple.com/documentation/imageplayground/imagecreator), [WWDC26 375](https://developer.apple.com/videos/play/wwdc2026/375/)). |

**Common automations people build:** daily agenda briefs from Calendar and Weather; dictation into Reminders; a "scratchpad" note built with Find Note and Append ([9to5Mac 2019](https://9to5mac.com/2019/03/26/shortcuts-notes-integration-more/)); Focus-triggered setups; folder-watch file processing; and turning email into tasks.

---

## 3. Programmatic routes per app, with constraints

### 3.1 EventKit (Calendar, Reminders)
- **Access levels** (since macOS 14) ([TN3152](https://developer.apple.com/documentation/technotes/tn3152-migrating-to-the-latest-calendar-access-levels)):
  - `requestFullAccessToEvents()` with `NSCalendarsFullAccessUsageDescription`.
  - `requestWriteOnlyAccessToEvents()` with `NSCalendarsWriteOnlyAccessUsageDescription`.
  - `requestFullAccessToReminders()` with `NSRemindersFullAccessUsageDescription`. Reminders have **no write-only level**.
  - The deprecated `requestAccess(to:)` throws an error when linked against the macOS 14+ SDK.
- **Prompts:** no prompt appears unless the bundle has the key, so a bare CLI binary fails silently ([eventkit-js](https://cdn.jsdelivr.net/npm/eventkit-js@3.2.0/readme.md)). Headless or launchd contexts can block forever on a prompt that never renders ([mcp-server-apple-events](https://github.com/FradSer/mcp-server-apple-events)).
- **Attendees are read-only.** Apple: "EventKit cannot add participants to an event nor change participant information" ([EKParticipant](https://developer.apple.com/documentation/eventkit/ekparticipant)). The KVC workaround crashes ([Apple forums](https://developer.apple.com/forums/thread/730603)).
- **What EventKit supports:** recurrence (`EKRecurrenceRule`), alarms, and structured locations. iMCP, for example, creates events with recurrence, alarms and availability ([iMCP](https://github.com/mattt/iMCP)).
- **Reminders gaps:** EventKit has **no API for tags, subtasks, sections, list groups, or flagged** ([Apple forums, sections](https://developer.apple.com/forums/thread/820848), [rem CLI](https://pkg.go.dev/github.com/BRO3886/rem), [Automators](https://talk.automators.fm/t/get-flagged-unflagged-for-reminders/8150)).
  - Tools fall back to the private ReminderKit, AppleScript for flagged, or hashtags in the title. che-ical-mcp's tags are "MCP-level" ([che-ical-mcp](https://github.com/PsychQuant/che-ical-mcp)).
  - The OS 27 Shortcuts actions for sections and groups are the only supported write path for those.

### 3.2 Contacts framework
- Uses `NSContactsUsageDescription`.
- `CNAuthorizationStatus.limited` is iOS, iPadOS and Catalyst 18+ only. It is **not on native macOS** ([Apple](https://developer.apple.com/documentation/contacts/cnauthorizationstatus/limited)).
- Reading the **note field** needs the restricted `com.apple.developer.contacts.notes` entitlement, which requires Apple approval. Approval takes weeks and the entitlement is impractical for CLIs ([Apple forums](https://developer.apple.com/forums/thread/745017)).

### 3.3 PhotoKit
- Uses `NSPhotoLibraryUsageDescription` and the `com.apple.security.personal-information.photos-library` entitlement.
- `.limited` exists on macOS 10.13+ ([Apple](https://developer.apple.com/documentation/photos/phauthorizationstatus/limited)), but `presentLimitedLibraryPicker` is **not available on macOS** ([Apple](https://developer.apple.com/documentation/photos/phphotolibrary/presentlimitedlibrarypicker(from:))).
- Photos.app also has an AppleScript dictionary (albums are "containers", media items, `import … into`, export) with quirks ([MacScripter](https://macscripter.net/t/help-importing-photos-to-specific-album-in-photos-app/68736), [Tinderbox forum](https://forum.eastgate.com/t/getting-data-from-photos-app-into-tinderbox/5822/1)).
- osxphotos reads the library database directly ([PyPI](https://pypi.org/project/osxphotos/)).

### 3.4 MusicKit vs Music.app AppleScript
- Current docs list `MusicLibrary` and `ApplicationMusicPlayer` as **macOS 14+** ([MusicLibrary](https://developer.apple.com/documentation/musickit/musiclibrary), [ApplicationMusicPlayer](https://developer.apple.com/documentation/musickit/applicationmusicplayer)). This reverses earlier "not on macOS" answers ([Apple forums 2022](https://developer.apple.com/forums/thread/707436)).
- Bugs persist on Golden Gate ([Apple forums, June 2026](https://developer.apple.com/forums/thread/832470)):
  - No AirPlay picker.
  - No volume control.
  - Plays don't update play count.
  - `MusicLibraryRequest` misses non-Apple-Music tracks.
- MusicKit also plays music *in its own player*, not in Music.app. To control Music.app itself, AppleScript remains the route. iMCP uses Automation for playback and MusicKit for catalog search ([iMCP](https://github.com/mattt/iMCP)).
- Usage key: `NSAppleMusicUsageDescription`. Its exact macOS requirement is unverified.

### 3.5 AppleScript / JXA dictionaries
Detailed dictionaries are in `docs/connectors/scripting-dictionaries.md`. Web findings:
- **Mail (rich dictionary):** `make new rule` (actions first, then conditions), `flag index` 0–6 with -1 to clear, and moving by setting a message's mailbox ([Apple Community](https://discussions.apple.com/thread/3282748), [C-Command](https://c-command.com/scripts/spamsieve/apple-mail-move-if-spam), [MacScripter](https://macscripter.net/t/add-mail-message-to-rule/73669)).
- **Notes (folders, notes, attachments, HTML body):**
  - Checklist state is misleading through AppleScript.
  - Attachment order is not guaranteed.
  - Rebuilding a note through HTML is lossy (tables and checklists cannot be created).
  - Notes are addressed by name.
  - Sources: [skill notes](https://skillselion.com/skills/spillwavesolutions/automating-mac-apps-plugin/automating-notes), [MacScripter](https://www.macscripter.net/viewtopic.php?pid=189539).
- **Safari:** tabs, documents, and `do JavaScript`, which is gated by a Developer setting ([Apple forums](https://developer.apple.com/forums/thread/836299)). AppleScript access to the Reading List is unverified; use the Shortcuts action instead.
- **Messages:** sending through `participant` of the iMessage service still works on Tahoe. Sending by `any;-;` chat GUID fails ([issue](https://claudeissues.com/issue/46747-imessage-plugin-reply-fails-on-macos-with-any-chat-guid-format)). File sends are slow and can hit the wrong recipient ([MacScripter](https://macscripter.net/t/sending-on-messages-app-via-applescript/72493), [KM forum](https://forum.keyboardmaestro.com/t/send-imessage-action-2023-reliability-and-alternate-methods/32267)).
- **Pages, Numbers, Keynote, Finder, Music, Contacts, Photos** have rich dictionaries (see the local file).

### 3.6 Read-only SQLite stores (all need Full Disk Access unless noted)
- **Notes:** `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`. The body is a gzipped protobuf in `ZICNOTEDATA.ZDATA`, with a CRDT structure, and locked notes are unreadable ([apple_cloud_notes_parser](https://github.com/jareware/apple_cloud_notes_parser), [Willison](https://www.simonwillison.net/2021/Dec/9/notes-on-notesapp)).
- **Messages:** `~/Library/Messages/chat.db`.
  - On Tahoe the `text` column is NULL for recent rows. The content is a typedstream in `attributedBody`, which `NSUnarchiver` decodes ([fsck blog](https://blog.fsck.com/agent-blog/2026/02/19/imessageprinter/), [issue](https://claudeissues.com/issue/41783-imessage-channel-plugin-messages-not-detected-on-macos-26-text-column-is-null)).
  - Length-prefix bugs show up above 127 bytes ([issue](https://claudeissues.com/issue/41520-imessage-plugin-parseattributedbody-truncates-messages-127-bytes-on-macos-15)).
- **Safari:** `~/Library/Safari/History.db` (`history_items`, `history_visits`). It sits in a data vault, and Apple DTS says there is **no API to request FDA programmatically** ([Apple forums](https://developer.apple.com/forums/thread/687633), [plaso](https://plaso.readthedocs.io/en/stable/_modules/plaso/parsers/sqlite_plugins/safari.html)).
- **Reminders:** `~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores/Data-*.sqlite` (`ZREMCDREMINDER`, `ZREMCDHASHTAGLABEL`). Private schema ([gist](https://gist.github.com/jsejcksn/de89e62bf2468dd2092bee253365334b), [Hook forum](https://discourse.hookproductivity.com/t/is-reminders-app-linkable/2397/29)).
- **Mail:** the `Envelope Index` SQLite under `~/Library/Mail/V*/MailData/` plus `.emlx` files ([iMCP](https://github.com/mattt/iMCP)).
  - iMCP opens it read-only, in WAL mode, with 100 ms per statement, and matches sender and subject only.
- **Voice Memos:** `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/CloudRecordings.db` plus `.m4a` files. Transcripts sit in a `tsrp` MP4 atom (community-reported) ([apple-voice-memo-mcp](https://glama.ai/mcp/servers/jwulff/apple-voice-memo-mcp), [tomevault](https://tomevault.io/tome/jessedc/apple-voice-memos)).

### 3.7 Spotlight (`mdfind`, MDQuery)
- Works well for files.
- **Mail is not reliably indexed for third-party queries since Catalina or Big Sur.** Indexing moved to CoreSpotlight and the emlx importer was removed, so reading `Envelope Index` is the recommended route instead ([Apple forums](https://developer.apple.com/forums/thread/121187), [Apple forums](https://developer.apple.com/forums/thread/683459), [skill](https://playbooks.com/skills/openclaw/skills/apple-mail-search)).
- Apps that adopt `IndexedEntity` feed the *semantic* index, which only Siri reads (§1.2).

### 3.8 TCC, Info.plist keys, entitlements

| Resource | Prompt / pane | Info.plist key | Hardened-runtime entitlement |
|---|---|---|---|
| Calendar | Calendars: Full or Add-only | `NSCalendarsFullAccessUsageDescription` / `NSCalendarsWriteOnlyAccessUsageDescription` | `com.apple.security.personal-information.calendars` ([Apple](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.calendars)) |
| Reminders | Reminders (full only) | `NSRemindersFullAccessUsageDescription` | same calendars entitlement ([eclecticlight](https://eclecticlight.co/2021/01/08/notarisation-privacy-controls/)) |
| Contacts | Contacts | `NSContactsUsageDescription` | `…personal-information.addressbook` |
| Photos | Photos | `NSPhotoLibraryUsageDescription` (and `NSPhotoLibraryAddUsageDescription`) | `…personal-information.photos-library` |
| Location | Location Services | `NSLocationUsageDescription` (the macOS key) ([Apple](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationusagedescription)) | `…personal-information.location` |
| Apple Music | Media & Apple Music | `NSAppleMusicUsageDescription` | — |
| Apple Events | Automation, one prompt **per target app** | `NSAppleEventsUsageDescription` (a single string for all targets) ([Tsai](https://mjtsai.com/blog/2018/08/23/apple-events-usage-description)) | `com.apple.security.automation.apple-events` (not needed for same-team targets) ([Apple](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events)) |
| SQLite stores | Full Disk Access (manual only, no API) | — | — |
| UI scripting / computer use | Accessibility (+ Screen Recording) | — | — |

- Entitlements don't bypass consent; the user still sees a prompt ([Apple hardened runtime](https://developer.apple.com/documentation/security/hardened-runtime), [Lazarus wiki](https://wiki.lazarus.freepascal.org/Hardened_runtime_for_macOS)).
- `AEDeterminePermissionToAutomateTarget(askUserIfNeeded:false)` cannot silently read a "denied" state ([Tsai](https://mjtsai.com/blog/2018/08/31/aedeterminepermissiontoautomatetarget-added-but-aepocalyse-still-looms)).
- Full Disk Access is granted to the **responsible process**. That might be the terminal or a Node binary rather than the parent app ([apple-notes-mcp](https://github.com/sweetrb/apple-notes-mcp)).

### 3.9 Other frameworks
- **HomeKit:** `HMHomeManager` is iOS and **Mac Catalyst only**, with no native macOS ([Apple](https://developer.apple.com/documentation/homekit/hmhomemanager)). iMCP needs a separately built helper with the user's own developer account ([iMCP](https://github.com/mattt/iMCP)).
- **Maps:** MapKit `MKLocalSearch` and `MKDirections` (iMCP uses these for place search, directions and ETA) ([iMCP](https://github.com/mattt/iMCP)).
- **Weather:** WeatherKit needs its own entitlement (unverified for helper use).
- **Passwords:** no API.

---

## 4. Competing assistants on the Mac

- **ChatGPT desktop (OpenAI):**
  - The 2024 "Work with Apps" feature read context from IDEs, terminals and Notes through ⌥Space ([OpenAI help](https://help.openai.com/en/articles/10119604-work-with-apps-on-macos), [TechCrunch](https://techcrunch.com/2024/11/14/chatgpt-can-now-read-some-of-your-macs-desktop-apps)).
  - In 2026 the Codex and ChatGPT apps merged around "ChatGPT Work" ([TechFinitive](https://www.techfinitive.com/explainers/should-you-hand-control-of-your-computer-to-chatgpt-work/)).
  - **Computer Use** ships as a plugin that is an MCP server plus a skill ([OpenAI docs](https://learn.chatgpt.com/docs/computer-use)):
    - It needs Screen Recording and Accessibility, with approval per app ("Always-allowed apps").
    - It can unlock the Mac while locked, using an authorization plug-in.
    - It can't approve privacy prompts or automate terminals.
    - The docs **recommend a dedicated MCP server over GUI control when one exists**.
  - MCP servers are configurable in Codex mode ([iMCP README](https://github.com/mattt/iMCP)).
- **Claude for Mac (Anthropic):**
  - Computer use in Cowork and Claude Code is a research preview on Pro and Max ([Claude support](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork), [Anthropic blog](https://claude.com/blog/dispatch-and-computer-use)).
  - It asks per app and works in background windows on macOS 15+. The Mac must stay awake.
  - The desktop app is sandboxed, with no native Reminders, Calendar, Notes or Mail access. Third-party bridges such as Orchard fill the gap ([Orchard](https://orchard.5km.tech/claude-apple-apps)).
  - Local MCP servers and `.dxt`/`.mcpb` extensions are the main route ([apple-mcp](https://github.com/supermemoryai/apple-mcp)).
- **Meta Muse for Mac:**
  - Launched 2026-09-17, US only.
  - Acts on Mail, Messages, Calendar, Notes and local files.
  - It is opt-in through macOS Settings, including **Full Disk Access**, and asks before sensitive steps such as deleting or sending ([iThinkDiff](https://www.ithinkdiff.com/metas-muse-ai-agent-gets-a-native-mac-app-with-file-and-message-access/), [BetaNews](https://betanews.com/article/meta-launches-a-muse-app-for-macos/)).
  - Reportedly runs actions through a cloud "Secure VM" behind a "Sentinel" approval gate ([AI Weekly, secondary](https://aiweekly.co/alerts/meta-ships-muse-for-mac-agent-now-acts-in-native-macos-apps)).
  - How it reaches the apps (AppleScript, Accessibility, or databases): unverified.
- **Google Gemini Spark (Mac):**
  - Beta since 2026-06-30, for Ultra subscribers.
  - Uses "Connected folders" for file access.
  - MCP support is reported but conflicting ([9to5Google](https://9to5google.com/2026/06/30/gemini-spark-mac-app/), [eWeek](https://www.eweek.com/news/google-gemini-spark-macos-ai-agent/), [Thurrott](https://www.thurrott.com/?p=338198)). apple-notes-mcp documents a "Gemini Spark (macOS Local MCP)" setup ([README](https://github.com/sweetrb/apple-notes-mcp)).
- **Perplexity for Mac:**
  - Has local MCP "Connectors" since July 2025, through a **PerplexityXPC** helper because the App Store build is sandboxed.
  - Its demos create reminders, edit Notes and send email via AppleScript MCP servers ([9to5Mac](https://9to5mac.com/2025/07/25/perplexity-for-mac-now-supports-mcp-and-you-should-check-it-out/)).
  - Native Apple-app actions: unverified.
- **Raycast AI:**
  - `@`-mention AI Extensions whose commands are exposed as tools.
  - Built-ins on Mac: Calendar, Finder, Focus, Location, Weather, Screen Awareness, Selected Text, Browser, Terminal, and others. Reminders is iOS-only.
  - Has an Ask / Auto / Always-Allow permission model, and MCP tools fall under the same rules ([Raycast manual](https://manual.raycast.com/ai/ai-extensions)).
  - A community Apple Notes extension needed Full Disk Access and was flaky ([MacStories](https://www.macstories.net/reviews/hands-on-with-raycasts-new-ai-extensions/)).
- **Apple Siri:** App Intents and schemas, personal context, and on-screen awareness (§1.2). No AppleScript or CLI, beta reliability, and daily limits.

### Open-source MCP servers for Apple apps (GitHub stars as of 2026-10-25, via GitHub API)

| Repo | ★ | Route | Tools / scope |
|---|---|---|---|
| [openclaw/Peekaboo](https://github.com/openclaw/Peekaboo) | 5,388 | ScreenCaptureKit + AX | Screenshots and GUI automation |
| [supermemoryai/apple-mcp](https://github.com/supermemoryai/apple-mcp) | 3,114 | AppleScript/JXA (Bun) | Messages (send, read, schedule), Notes, Contacts, Mail (send, search, unread), Reminders, Calendar, Maps. Last push 2025-08 |
| [mattt/iMCP](https://github.com/mattt/iMCP) | 1,789 | Native Swift app (EventKit, Contacts, MapKit, MusicKit, Mail Envelope Index, chat.db, Voice Memos) | Calendar, Contacts, Home (helper), Location, Mail, Maps, Messages, Music, Notes (as Markdown), Phone, Reminders, **Shortcuts (list/run)**, Voice Memos (transcripts), Voicemail, Weather |
| [steipete/macos-automator-mcp](https://github.com/steipete/macos-automator-mcp) | 883 | AppleScript/JXA | `execute_script` and `get_scripting_tips` (knowledge base of hundreds of scripts) |
| [peakmojo/applescript-mcp](https://github.com/peakmojo/applescript-mcp) | 465 | AppleScript | Runs arbitrary AppleScript |
| [RafalWilinski/mcp-apple-notes](https://github.com/RafalWilinski/mcp-apple-notes) | 417 | JXA + local embeddings | RAG over Notes (stale since 2024-12) |
| [ashwwwin/automation-mcp](https://github.com/ashwwwin/automation-mcp) | 413 | AX/CGEvent | Mouse, keyboard and windows |
| [joshrutkowski/applescript-mcp](https://github.com/joshrutkowski/applescript-mcp) | 394 | AppleScript | Calendar, Messages, Mail, Notes, Finder, system |
| [mediar-ai/mcp-server-macos-use](https://github.com/mediar-ai/mcp-server-macos-use) | 355 | AX | Computer use |
| [carterlasalle/mac_messages_mcp](https://github.com/carterlasalle/mac_messages_mcp) | 335 | chat.db + AddressBook read-only; Messages.app to send | Read, search, conversations, attachments, send with elicitation approval, schedule |
| [FradSer/mcp-server-apple-events](https://github.com/FradSer/mcp-server-apple-events) | 228 | EventKit Swift CLI | Reminders, lists, subtasks, tags, Calendar CRUD. Alarms, recurrence and location are read-only. 30 s kill for headless hangs |
| [CursorTouch/MacOS-MCP](https://github.com/CursorTouch/MacOS-MCP) | 226 | AX | Computer use |
| [sweetrb/apple-notes-mcp](https://github.com/sweetrb/apple-notes-mcp) | 170 | AppleScript + **signed Shortcuts** + read-only NoteStore | Folders, tags, checklists, tables, pins, attachments, Markdown/HTML export, transcripts |
| [Cifero74/mcp-apple-music](https://github.com/Cifero74/mcp-apple-music) | 44 | Apple Music API | Catalog, library, playlists |
| [PsychQuant/che-ical-mcp](https://github.com/PsychQuant/che-ical-mcp) | 41 | EventKit Swift | 29 tools: events, reminders, "#tags", batch, conflicts, undo |
| [anipottsbuilds/imessage-mcp](https://github.com/anipottsbuilds/imessage-mcp) | 28 | chat.db | Search and read |
| [jwulff/apple-voice-memo-mcp](https://github.com/jwulff/apple-voice-memo-mcp) | 7 | CloudRecordings.db + `tsrp` | Voice Memos and transcripts |

What the field shows:
- **Demand is clear.** The general Apple-apps bundle has over 3k stars, and iMCP has 1.8k.
- **The best-maintained projects converge on one hybrid design:** EventKit and other native frameworks where they exist, read-only SQLite for Notes, Messages, Mail and Voice Memos, AppleScript for writes, and **Shortcuts for intents only Shortcuts exposes**. sweetrb/apple-notes-mcp is the clearest example.
- Calendar and Mail MCPs built only on AppleScript have few stars.

---

## 5. Implications for Psyche

1. **Calendar and Reminders: stay on EventKit** in the signed helper. Use full access for both, with the macOS 14+ keys from TN3152. Add Shortcuts calls only for Reminders **sections, groups and list edits** (new OS 27 actions) and for tags. EventKit can't add attendees, so make "invite attendee" a Mail or ICS step, or open Calendar's editor.
2. **Notes: use hybrid reads and writes.**
   - Reads come from `NoteStore.sqlite` (FDA, gzipped protobuf), with AppleScript as a fallback.
   - Writes for create, append and move go through AppleScript.
   - **Shortcuts handle Markdown create, section append, checklist append, tags and pin.** These exist only as intents, and macOS 27 added Markdown and section append.
3. **Mail: read from `Envelope Index` and `.emlx`** (FDA) for search, as iMCP does. Skip Spotlight, which no longer indexes Mail for third parties. Use AppleScript for send, flag, move and rules. Shortcuts Find Message is a backup.
4. **Messages: read `chat.db`** (FDA) and decode the typedstream `attributedBody`, since `text` is NULL on Tahoe and later. Send with AppleScript `participant`-of-service, or with the OS 27 Shortcuts Send Message, which supports groups. Gate every send behind user approval, as Muse and ChatGPT do.
5. **Contacts: use CNContactStore.** Skip notes unless Apple grants the entitlement. Limited access does not apply on macOS.
6. **Photos: use PhotoKit for reads and search.** Use Shortcuts for album operations, favorite, hide and enhance (OS 26/27 actions). macOS has no limited-library picker, so assume full access or nothing.
7. **Music: control Music.app with AppleScript, and use MusicKit only for catalog and library search.** MusicKit playback on macOS has known bugs (no AirPlay or volume control, plays don't update counts).
8. **Voice Memos, Freeform, Stocks, Weather lists, Clock, Focus, Books, Podcasts, Journal, Image Playground: use `shortcuts run`.** These have no usable framework, or the framework was removed (ImageCreator is gone in 27). Voice Memos transcripts can also come from the `tsrp` atom.
9. **Ship signed, prebuilt `.shortcut` files** with stable UUIDs and `Stop and Output` dictionary results. Call them by UUID with a hard timeout. Never use Ask or Alert steps, since they block the CLI. Run from the logged-in user's LaunchAgent context, not a daemon. sweetrb/apple-notes-mcp validates this pattern.
10. **Safari: use AppleScript for tabs and the current page, Shortcuts for the Reading List, and `History.db` (FDA) for history.** Optionally detect the Safari 27 `safaridriver --mcp` server for page automation. It is opt-in, has no personal data, and enterprise admins cannot block it.
11. **Home needs a Mac Catalyst sub-helper** (HomeKit has no native macOS API). Otherwise use the Shortcuts Control Home action.
12. **Adopt App Intents in Psyche itself,** with Notes and Reminders schemas and `IndexedEntity`. Psyche's own data then shows up in Siri and Spotlight. Apple has not exposed an MCP layer for App Intents, so don't plan around one.
13. **Foundation Models is optional:** use it for cheap local tasks such as classification and summarizing tool output. The 4k-token window is too small to serve as Psyche's main agent model.
14. **Risks:**
    - TCC prompts land on the *responsible process*, so the helper must own every grant.
    - Full Disk Access cannot be requested programmatically.
    - Private SQLite schemas break across OS updates (Messages `text` going NULL is one example).
    - Automation prompts come one per target app.
    - Shortcuts and Siri AI have server-side daily limits, and may become paid.
    - Siri and Shortcuts AI features are still beta and flaky.
    - Prompt injection through mail and message content (fence untrusted output, as mac_messages_mcp does).
    - Headless EventKit or Shortcuts calls can hang, so add timeouts everywhere.
