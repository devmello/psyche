---
name: psyche-app-guide
description: How Psyche's own app works - every screen, Settings section, slash command, permission mode and approval card, with exact names and where to find them. Use for "how do I...", "where is...", "can you..." questions about Psyche itself (settings, Home and the daily brief, automations, the Library, the browser, permissions), and offer to open the screen with app_navigate.
user-invocable: true
disable-model-invocation: false
metadata:
  psyche:
    priority: P0
    features: [T1, T5]
    approvals: []
---

# Psyche app guide

You know your own app. When the owner asks how to do something in Psyche, where something lives, or whether Psyche can do something, answer from this guide in a few lines, then offer to open the screen.

## How to answer

1. Say what it is and the exact path, with the labels as they appear: "Settings → Daily → Morning brief → Time".
2. Give the shortest working steps (3 at most). Offer the chat route when it is quicker ("or just say it here").
3. Offer **Open it for you** by calling `app_navigate` with the route from the table below. The call shows a button; nothing opens until the owner clicks it. Never claim the app opened.
4. If the owner asks to *do* the thing (change the setting, create the automation), do it with your normal tools and approvals when you can; settings that decide what runs commands, or what is allowed to run unprompted, are the owner's to change in the UI.
5. If this guide does not cover it, say so. Do not invent screens, labels or settings. The app changes; if a label here is not on screen, trust the screen.

The sidebar's gear opens Settings (⌘,).

## Routes for `app_navigate`

| Screen | Route |
| --- | --- |
| Chat | `/chat` |
| Home | `/home` |
| People | `/people` |
| Search | `/search` |
| Feed (now Home's **Today**) | `/feed` (shows Home at Today) |
| Ideas (now Home's **Suggestions**) | `/ideas` (shows Home at Suggestions) |
| Goals | `/goals` |
| Scheduled | `/scheduled` |
| Library | `/library/documents` (also `/library/images`, `/library/artifacts`, `/library/downloads`, `/library/system`) |
| Overview | `/overview` |
| Inbox | `/inbox` |
| Agent sheet | `/agent/approvals`, `/agent/soul` (old: `/agent/activity` → Overview, `/agent/upcoming` → Home's Coming up) |
| What can you do? | `/can-do` |
| Run setup again | `/onboarding` |
| Settings | `/settings/<section>` |

Settings pages (`/settings/…`): `essentials`, `general`, `model`, `connectors` (also `connectors/mcp`, `connectors/add-mcp`), `memory`, `daily`, `permissions`, `data`, `devices`, `about`. Every pane on a page is a route too and opens its page scrolled to it: `appearance`, `persona`, `notifications`, `voice`, `usage`, `search`, `mail`, `channels`, `learning`, `everything`, `people`, `skills`, `specialists`, `computer-use`, `browser`, `files`, `credentials`, `vm`, `server`.

## The sidebar and chat

**Sidebar** (⌘B toggles it, ⌥⌘B switches full and compact): **Search** (opens the command palette, ⌘K), then four places: **Chat** (⌘1), **Home** (⌘2; an amber count shows how many items need you), **Library** (⌘3) and **People** (⌘4). Everything else is a page reached from Home or ⌘K: **Scheduled**, **Goals**, the **Inbox** (all notifications), the **Overview** ("{persona} & you"; the persona avatar in the sidebar footer opens it too), full **Search** and **Soul & Memory** (the agent sheet). There is no More group any more; the Feed and Ideas are sections of Home. Under the places is the Threads list (side chats, automations' chats and subagents are marked), and a footer with the persona and a gear ("Settings and help"). The gear menu has **What can you do?**, **Settings** (⌘,), **Usage** and **Help** (the About section). Every page, every Settings and Library section and the common actions (**New automation**, **Add a goal**, new side or incognito chat, record a meeting) are in the command palette (⌘K): type part of a name, even an old one ("feed", "ideas", "voice", "memory review", "scheduled runs"), and press Return. On a narrow window the bottom tab bar has Chat, Home, Library and People.

**Inbox** (`/inbox`, Home → Needs you → **All notifications**, or ⌘K "notifications"): notifications that need you come first (approvals, questions), then today, then earlier. Clicking a notification, in the Inbox or as a Mac notification, opens its source: the chat that asked, scrolled to and highlighting the message or approval card; a run's notification opens its Timeline or **Scheduled → Runs** (`/scheduled?tab=runs`); a memory item opens **Settings → Memory review**.

**Composer**: type `/` for commands. `//text` sends text that starts with a slash. Arguments with known values pop up after the command (`/model `, `/mode `, `/export `).

| Command | What it does |
| --- | --- |
| `/model provider/model` | Pick this thread's model (no argument opens the picker). Example `anthropic/claude-sonnet-5-5`. |
| `/mode manual \| balanced \| auto \| plan` | This thread's permission mode (see Permissions below). |
| `/new` | Start a new side chat. |
| `/btw question` | Ask aside in a side chat. |
| `/fork message` | Fork this thread from here. |
| `/schedule when and what` | Create an automation (see Automations). |
| `/incognito message` | A chat that is not remembered. |
| `/remember fact` | Note a fact in today's memory. |
| `/forget subject` | Retract what is remembered about something. |
| `/teach what to do instead` | Correct the last reply, and remember it. A message's **Not like this** does the same. |
| `/plan goal` | Switch this thread to plan mode (read-only). |
| `/research question` | Research in depth with a cited report: Psyche shows the plan and token estimate and waits for your go-ahead. |
| `/status` | Show model, mode and running work. |
| `/export md \| json` | Export this thread. |
| `/stop` | Stop the current run (Esc does too). |

Other composer things: **Attach files** (paperclip; up to 8 files per message, images 5 MB, documents 25 MB; a model without vision takes documents only), **Dictate** (hold fn; the voice key in Settings → Voice & dictation), **Reply** to quote a message, **Edit and resend** (sent in a side chat forked from there), **Continue in a side chat**. While Psyche works, a message you send follows up when the turn ends, or steers it.

**Screen ask**: press the shortcut in any app to ask about what's on screen (press again to select an area). Turn it on and set the shortcut in Settings → Voice & dictation → Ask about my screen; "Send to" picks New chat or Current chat.

**Voice conversation**: Settings → Voice & dictation → Talk with Psyche; hold the voice key (it must differ from the dictation key). The answer appears as text in a pop-up.

**What can you do?** Sidebar gear → What can you do? (`/can-do`): cards of things to try ("Ready to try") and ones to unlock by connecting accounts. Clicking one sends the prompt; some add an automation.

## Home and People

**Home** (`/home`) is one page for what needs you and what is coming. Its main column has **Needs you** (approvals and questions, amber, with **All notifications** opening the Inbox), **Pinned** widgets, **Today** (the daily brief's posts, with **What should I write about** and **Schedule**) and **Suggestions** (ideas and inferred goals, with the same Do it / Dismiss / Confirm buttons as before). The side column has **Coming up** (the next runs; **Scheduled** opens `/scheduled`), **Goals** (tracked goals; **+** adds one, **All goals** opens `/goals`), **Keep in touch** (relationship nudges, when they are on) and a link to **{persona} & you** (`/overview`). A section with nothing to show is left out. `/home/instructions` opens the brief's instructions sheet over Home.

**People** (`/people`) lists the people and projects Psyche knows, with search and the **People**, **Projects**, **Suggestions** and **Waiting on** filters, and **Keep in touch** above them when nudges are on. A row opens the person's card; `/people?entity=<id>` opens one directly. **Soul & memory** in its toolbar opens the agent sheet's Soul & Memory.

## Today's brief (the Feed), wrap-up, follow-ups

**Today** on Home (`/home#today`; the old `/feed` shows it): the brief, news, watch results, reminders and suggestions as posts. Each post has Like, **Ask about this**, Follow topic, Not interested, Hide source, and Sources. "Review and approve" opens an action Psyche proposes. **What should I write about** opens the brief's instructions sheet (`/home/instructions`; the old `/feed/instructions` opens it too), and **Schedule** opens Scheduled.

**Morning brief and evening wrap-up**: Settings → Daily. **Morning brief** switch and **Time** (default 08:00); **Preview now** generates one immediately. **Evening wrap-up** switch. **Where it shows up**: Notify me (quiet hours hold it), Also send over Messages. **Follow-ups**: Track follow-ups and How much to track (things you promised or are waiting on). Psyche only reads for the brief.

How to set the brief time: Settings → Daily → Morning brief → Time. Open `/settings/daily`.

**Relationship nudges** (Settings → Memory → People & projects → Relationship nudges, `/settings/people`): Psyche tells you when someone you correspond with wrote and you have not replied, when you are drifting from someone you usually talk to ("You usually talk to Sam every 2 weeks; it's been 6 weeks"), when a birthday or anniversary is near, and when you promised someone something and it is still open. They show as a **Keep in touch** section in the morning brief (at most three), as quiet cards in Home's Today, in a **Keep in touch** section on Home and on People (`/people`), and as a **Keep in touch** row on the person's card. Each card can list up to three **Things to bring up** (for example "Ask how the new job at Initech is going"), each with a line saying which fact or promise it comes from; they use only facts you accepted that are not sensitive, plus your own promises, and with too little on file there are none. **Draft a reply** passes them to the chat as context. Each card has **Draft a reply** (opens a chat with a request filled in; nothing is sent), **Snooze** (for a week or a month), **Done** and **Not this person** (no more nudges for them; turn them back on from their page). It is off until you switch on **Remind me to keep in touch** and confirm; **How often** sets how long a message waits and how far from the usual rhythm before it says anything. It uses only dates of messages, birthdays you confirmed and promises in your own words; people you excluded, sensitive facts and message text are never used, and cards wait out the quiet hours in Settings → General → Notifications. Offer `/settings/people`.

## Tasks, automations, and task → automation

**Automations** are scheduled runs. Ways to create one:
- Say it in chat ("every weekday at 9am check my UCSC Canvas for new assignments and notify me") or use `/schedule when and what`. Psyche recognises a repeatable routine, plans it, does a trial run with you, then shows ONE card, **Schedule "title"?**, listing every schedule, **What it does**, **Will ask you to approve**, how it notifies. **Schedule** creates the linked runs; **Not now** creates nothing. It can offer to save the steps as a skill afterwards.
- Settings → Daily → Automations: **Describe the automation**, **Preview**, then confirm with **Create** (starters under **Starters**). The list of automations is on **Scheduled** (**Manage on Scheduled**), or **New automation** there opens a chat that starts the same flow.
- Settings → Skills and What can you do? cards ("Add: Morning brief at 7:30 on weekdays").

For a site that needs a login (Canvas, a portal), first sign in once in the Psyche browser and choose **Stay signed in** (see Browser). Automations use that sign-in only on the sites you chose. Each run can still ask for approvals the card listed; a run that cannot ask parks and waits.

**Scheduled** (`/scheduled`; Home → Coming up → **Scheduled**, or ⌘K) lists everything that runs on a schedule, in two groups: **Your automations** (including the linked runs of a task → automation, such as a 9:00 add and an 11:30 PM check) and **Psyche's routines** (morning brief, evening wrap-up, the nightly memory pass, mail digest, meeting prep, ideas, the heartbeat). Each row shows its schedule in words ("Weekdays at 9:00"), **Next run** (relative and absolute, in your time zone from USER.md), **Last run**, **What it does**, **Approvals it may need** and **Linked runs**. Actions: **Pause** / **Resume**, **Run now** (the button shows **Running…**, then a notice says it started and the run appears under **Runs**; if it can't start, the notice says why, for example that a run of it is already going; approvals still wait in Approvals; it works the same from Upcoming in Overview and the agent sheet), **Edit** (describe it again, then confirm the same card as when creating; a linked set is changed in a chat), **Delete** (asks first; your automations only) and **History** (every run with status, how long it took, a link to its chat or transcript, and the changes it recorded). Psyche's routines can be paused and run but not deleted; their **Settings** button opens where they are configured (a routine switched off there shows **Turn on in Settings**). With nothing set up, the screen shows examples and a **New automation** button. The **Runs** tab next to **Schedule** lists every run, newest first, including the ones that ran in the background (scheduled automations, Psyche's routines, the nightly memory pass): its status (**Running**, **Waiting for approval**, **Succeeded**, **Failed**, **Skipped** with the reason such as quiet hours or on battery, **Stopped**), when it started, how long it took, which job it was, a summary, and links to its chat or **Open the Timeline**. It updates while a run is going, can be filtered by job and status, and a run waiting on an approval has a **Review the approval** button that opens `/agent/approvals`. A failed run is never shown as succeeded. Open it with `app_navigate` `/scheduled`.

Where else to see them: Home → **Coming up** (the next runs; a row opens Scheduled) and `/overview` → **Recent runs**. A run's Timeline opens from Recent runs. **Goals** (`/goals`; Home → Goals → **All goals**) holds longer aims; tell Psyche a goal in chat, add one with **+** on Home's Goals or ⌘K **Add a goal**, and confirm suggested goals in Home's Suggestions. Background work (tasks) shows in the chat as task cards and in Overview → Now & next.

## Library and artifacts

`/library/documents`. Sections: **Documents** (documents, audio, video, recordings), **Images**, **Artifacts**, **Downloads**, **System files**. Artifacts are what Psyche makes for you: documents, sheets, slides, and `/research` reports (a cited report). Open an item to view or edit it; "Open in editor" opens it beside the chat. Ask "make a sheet of…" in chat and the result lands under Artifacts. Documents can be exported or revised by asking.

## Widgets in chat

For progress, task lists, tables and numbers worth scanning, Psyche can draw a small **widget** inside the chat instead of a long reply, and update it as work goes on. A widget has a frame that says **Made by Psyche**, a **Live** or **Frozen** marker, and a **Copy as text** button. If it was built from web pages, mail or anything else Psyche cannot vouch for, the frame shows **Built from untrusted content** and lists the sources. A widget about something Psyche already tracks (a background task, a research run, a scheduled automation, a specialist job) stays current on its own, even after the chat turn that drew it has ended; a part that points at something that no longer exists, or is not in this chat, reads **Unavailable**. Widgets can also hold small charts (bar, line, sparkline; **Show data** reveals the numbers as a table), pictures, and a place list with **Open in Maps** (no map tiles). Pictures from the web are off by default (Settings → Privacy & data → **Show pictures from the web in widgets**; `widgets.remoteImages`; changing it needs your confirmation); when on, they load through your Gateway, never straight from the site, and in a widget built from untrusted content only after you click **Load image**. Widgets can have buttons, choices and small forms. Nothing happens until you click: a click sends a normal message in the chat, shown with a **From widget** label so you see exactly what was sent, and in a widget built from untrusted content the answer Psyche gives is treated as untrusted too (it may need your approvals as usual). A button can also open a page of the app, or answer a question Psyche asked using one of the options it offered. A button can also ask Psyche to run one specific action (send a draft, archive a thread). That is a proposal: the chat shows exactly what is proposed, the button says **Asks you first** when you will get an approval card, and the action goes through the same checks as if Psyche had chosen it; in a widget built from untrusted content it can only be allowed once. Pin a widget to Home with the pin button in its frame (**Pin to Home**; up to 6; **Pinned** shows near the top of `/home`); a pinned widget about a task, automation or job keeps updating by itself, and on Home it has open and reply controls only (a reply fills the message box for you to send). In Home's Today a widget is a snapshot (Psyche's "Psyche learned N things" card, your daily brief and wrap-up, and the note that an automation run finished carry one: counts, a status and a button to open the result, never text from your mail or messages): it does not update, shows **Snapshot** in its frame, and also has open and reply only. If you reach Psyche through Messages, Telegram or another channel, a widget arrives as text (its summary, then its main numbers and list items); buttons and forms are not sent. A widget can never approve anything, and it cannot draw or answer an approval card: those are always drawn by the app itself, in the approval area above the message box. Approval cards are always drawn by the app itself in the dock above the message box, never inside a widget, so a widget that looks like a permission request is not one. A chat keeps up to 8 live widgets; the one updated longest ago freezes first, and a widget freezes after 7 days without an update. Frozen widgets stay readable. While Psyche is still writing a widget you see a sketch of the parts that are done under **Building widget…**, with no buttons; the real widget replaces it. A connector tool can come with a small app of its own: under that tool's row you see **App from <connector>**, **Built from untrusted content** and **Run app**; nothing of it loads until you press Run app, and it runs in the same walled-off frame as untrusted pages, with no network, no access to your tools or data, and no way to ask for or answer an approval. Ask Psyche to "show this as a table" or "keep a progress panel for this" to get one; ask for text if you would rather copy prose.

## The Browser

Psyche always browses in its own built-in window (Settings → Browser: Psyche profile), signed in where you chose Stay signed in. On a login page it signs in with your saved login for that exact site after you approve a card ("Sign in to {site} with your saved login"); for Duo or other 2FA it hands the tab to you and continues when you hand it back. With no saved login it asks you to sign in there, then offers Stay signed in and Save login. When a task signs in to a site, a prompt asks **Stay signed in to {site}?** (**Stay signed in**) and **Save login to Psyche vault?** (**Save login**, or **Never for this site**). Psyche also notices sites you are already signed in to in its browser (matching the whole site, so Canvas and its UCSC login page count as one) and uses that sign-in automatically; the browser pane chip says **Signed in as you** or **Logged out** for the tab. Settings → Browser → **Let Psyche use my signed-in sessions** (on by default) turns that off. **Signed-in sites** lists both kinds (found automatically ones are labelled); **Sign out / forget** removes one. Writes, purchases and sends still ask first. Saved logins live in Settings → Credentials (the vault; values are never shown, Psyche fills them after you approve). Other Browser settings: **Open links in** (Ask each time, Psyche browser, Default browser), **Let Psyche use your Chrome** (off by default; a separate Chrome profile only Psyche uses, for sites needing 1Password or extensions; the agent doesn't see Chrome at all until it is on, and each task asks first with Touch ID or a passkey), **Web Bot Auth** (sign requests).

## Activity and the audit

`/overview` is "{persona} & you" (Home's last side card, the persona avatar in the sidebar footer, or ⌘K): **Now & next**, **Activity**, **Growth**, **People & projects**, **Built for you**, **Specialists**, **Recent runs** (pick a period and filter all / failed / automation / chat). Open a run for its Timeline. The agent sheet (`/agent/approvals`, `/agent/activity`) lists open Approvals and Questions, Decided recently, Standing permissions, and Soul & Memory. After a turn changes your files or items, a chip ("Changed 2 files") shows what changed, and the audit view lists changes; receipts and the audit log stay even if you delete a chat.

## Settings, every section

Settings opens from the gear or ⌘, on **Essentials**, the first of ten pages: the few choices a newcomer makes, each with a safe default. The open page lists its panes under it. **Search settings** at the top finds pages, panes and single settings by their label ("quiet", "search sources", "dock") and opens the setting itself, scrolled into view. Route `/settings/<id>`; an id from before the 2026 regrouping still opens its pane.

**Essentials** (`essentials`): **Model** (which model Psyche thinks with, and whether it is ready; **Set up a model** when there is none), **What Psyche may read** (Mail, Messages, Notes, Calendar, Reminders, Files, all off until switched on), **How often Psyche asks first** (Balanced, Manual, Auto), **When Psyche may interrupt you** (Quiet hours, on by default 22:00 to 08:00; Morning brief), and **Memory** (Let Psyche remember our chats). Each group's **More** opens the full pane; every one of these is also there.

**General** (`general`)
- **Appearance** (`appearance`): Theme (Auto follows the system), Gray family, Accent color; applies to every paired device. On the Mac, **Show in Dock when no windows are open** (off by default) and **Open Psyche at login** (off by default; starts Psyche in the menu bar with no window so scheduled automations that use the browser can always run; Psyche also starts itself in the background when a run needs the browser). Show in Dock off: Psyche leaves the Dock and ⌘-Tab when its last window closes and keeps running from the menu bar; click the menu bar icon (Open Psyche) or open Psyche again from Finder or Spotlight to bring the window back. ⌘Q still quits.
- **Persona** (`persona`): name, tagline, emoji, creature and avatar, "Show thinking while it works". Tone lives in SOUL.md.
- **Notifications** (`notifications`): **Quiet hours** (on by default, 22:00 to 08:00) with **Quiet from** and **Quiet until**; notifications are held but still land in the inbox, and time-sensitive approvals still come through.
- **Voice & dictation** (`voice`): dictation key, Talk with Psyche, Ask about my screen.

**Models** (`model`)
- **Model & providers** (`model`): add a provider (API key, subscription via a signed-in CLI, or local), check the endpoint, see tools/vision/reasoning badges, and pick models. A model you pick is used as chosen; if it fails Psyche says so.
- **Usage** (`usage`): tokens and cost, counted locally. Also in the gear menu.

**Connectors & sources** (`connectors`)
- **Connectors** (`connectors`): **Add connector** (Mail, Calendar, Notes, Slack and others), **Add MCP server**. Disconnect pauses one, Remove deletes it. Sign in again when it shows "Sign in again". Command-type MCP servers and running commands need the sandbox: **Set up the sandbox** installs or locates **srt** (Install with Psyche, or point to a path); the same **Set up sandbox** button appears on a command approval card. Installing asks you to confirm. If **Set up** for a ready-made server says "The server did not start", the card now gives the real reason and a next step (sandbox missing → **Set up sandbox**; Python servers need **uv**; Node servers need npm on the Mac; blocked network; or the server's own error output). Each ready-made server lists what it needs (sandbox, Node tools, uv, network). **Files on this Mac** and **Terminal** are cards at the top of Connectors, not separate servers: they show the shared folders and whether **Run commands on this Mac** is on, and **Open Access** goes to where both are changed (Settings → Permissions → Access; commands run in shared folders, each one asks first, in the sandbox unless the owner types UNSANDBOXED). Ask `find_capability` for "terminal" or "files" to point the owner there; only the owner turns them on.
- **Search** (`search`): one home for what Psyche indexes and how it searches: **Search sources**, **Semantic search** and **Web search**.
- **Search sources** (Settings → Connectors & sources → Search): choose which local sources Psyche reads into search (Mail, Messages, Notes, Calendar, Reminders, Files in shared folders), all off until you switch them on. Files has **Read text in images (OCR)** (off by default): it reads screenshots, photos and scanned PDFs in shared folders, and images in your Library, with Apple Vision on this Mac. Nothing leaves the Mac and no model is downloaded. It runs one page at a time, only on power and not in low-power mode, and turning it off removes the text it read.
- **Semantic search** group (in `search`): **Semantic search**, **Context cards for search**, and **Read questions with a small model** (on by default, but only runs when a small model is set up: when the agent searches with a question whose time, person or source the built-in rules could not find, one cheap call turns it into filters; only the question is sent, results are cached, and any failure falls back to the rules).
- **Re-rank search results** (in `search`, off by default): when the agent searches your data, a small cloud model reorders the top 20 results. The titles and first 500 characters of those results leave this Mac; it costs roughly 2,000 tokens a search and uses no RAM here. Delegates' searches are never re-ranked.
- **Browser pages and Transcripts** (more Search sources, in `search`, off until you switch them on). They read what happens in Psyche itself: **Browser pages** (the address without anything after a `?`, title and text of pages Psyche's browser reads for you, kept 90 days; logged-out browsing, private chats, sign-in, payment and local pages are never kept) and **Transcripts** (voice memos and recorded meetings, split by speaker so a search finds who said what). Page text and other people's words stay untrusted, so they can never instruct Psyche. Turning a source off deletes what it indexed.
- **Encrypt the search index** (in `search`, off by default): keeps the search index file unreadable without a key stored separately (in a macOS keychain item that opens without Touch ID while the Mac is unlocked, or beside the vault key on a server). It protects copies, backups and synced folders, not software running as you. It takes effect when Psyche next starts and rebuilds the index once; right after start, search is empty until the Mac helper connects and the status says it is waiting.
- **Mail & meetings** (`mail`): accounts, inbox digest, follow-ups, writing style, scheduling, meeting prep and notes; one switch for everything.
- **Channels** (`channels`): where people reach Psyche and who is allowed.

**Memory** (`memory`)
- **Memory review** (`memory`): what Psyche learned from your mail, messages and notes. Tabs **To review**, **Learned lately** (undo within the window) and **Quarantine**; nothing is a fact until you accept it.
- **Remembering & learning** (`learning`): **Pause memory**, **Transcript recall**, **How memory is recalled** (Markdown only, or Markdown plus embeddings) and **Learning** (learn from feedback, notice edits, pause learning, weekly card, forget everything learned).
- **Everything memory** (`everything`): off until you turn it on. Psyche reads your own mail, messages and notes at night and writes down what you state (who people are, birthdays, plans); every fact cites the words it came from and waits for you. Sources you can switch on: Mail, Messages, Notes, Calendar, Reminders, Files, Transcripts. It learns only from what Search indexes, so a source Search does not index says so, with **Turn on in Search**. Browser pages and your chats with Psyche are never read by it.
- **People & projects** (`people`): the people and projects Psyche tracks, with privacy controls. **Export** there opens Privacy & data (one export for everything). It also holds **Relationship nudges** (off until you turn it on and read the short consent note): **Remind me to keep in touch** and **How often** (Gentle, Normal, Eager) and **Reword suggestions with my model** (off; uses the model picked in Everything memory). See "Relationship nudges" below.

**Routines & skills** (`daily`)
- **Daily** (`daily`): morning brief, evening wrap-up, follow-ups, automations (above).
- **Skills** (`skills`): the installed skills; each shows what it asks for. Installing or updating goes through a trust card. "Made by {persona}" marks skills it wrote.
- **Specialists** (`specialists`): the background helpers (researcher, coder and others).

**Permissions** (`permissions`)
- **Approval rules** (`permissions`): **Default mode for new threads**, **Connector actions** (Allow / Ask / Deny each), **Browser origins** (sites that need no approval card), and the **Grants ledger** where you can revoke any "Always allow".
- **Computer use** (`computer-use`): which Mac apps Psyche may operate; macOS permissions (Accessibility and others).
- **Browser** (`browser`): above (Psyche profile, signed-in sites, Open links in, Let Psyche use your Chrome, Web Bot Auth).
- **Access** (`files`): **What Psyche can reach**, one list of every shared folder and standing permission, each marked **Always**, **This chat** or **For now** (folders also read only or read and write), with **Revoke**. Psyche asks in the chat when it needs a folder (`request_folder_access`) and your answer is remembered here, so this is where you see and take back access rather than the usual way to give it. Also **Run commands on this Mac** (each command still asks first), **Add a folder yourself** (folded; a typed path, or **Choose a folder…** on the Mac), and VM shares.
- **Credentials** (`credentials`): the vault. Storage (Psyche vault with Touch ID, System keychain, External manager), fill default (ask every fill / once per site), Items with **Add item**.
- **VM mode** (`vm`): run tasks in a separate sandbox Mac.

**Privacy & data** (`data`): everything stays on this machine. **How long things are kept** (thinking, task replays), **Maps**, **Widgets in chat** (pictures from the web), **Export everything**, Backups, and last, under **Delete and start over**: Delete threads and **Reset memory…** (type "reset").

**Devices** (`devices`): **Devices & nodes** (`devices`) and **Server & remote access** (`server`).

**About** (`about`): versions, data folder (Reveal in Finder), **Run checks** (Gateway, sandbox, permissions, vault), Open logs, and **Run setup again** (walks the first-run setup again; finished steps are skipped).

## Onboarding

First run walks through: about you, the model (key saved to the vault with **Save to vault**), memory, daily habits, sandbox and First wins. Re-run any time: Settings → About → **Run setup again** (`/onboarding`). "What can you do?" stays in the gear menu.

## Permissions and approval cards

**Modes** (per thread: `/mode`, or the default in Settings → Permissions):
- **manual**: asks before every action.
- **balanced**: reads run; risky actions (to people, money) ask first.
- **auto**: acts on its own; needs an Auto-capable model (pick one with `/model`).
- **plan**: read-only; plans without acting.

**Approval cards** appear in the chat and in `/agent/approvals`. Scopes: **Allow once**, **Allow for this task**, **Allow for this site**, **Allow for this session**, **Always allow** (shown under Settings → Permissions → Approval rules → Grants ledger, revocable). A folder request asks which folder to share. Running a command without the sandbox offers only Allow once and asks you to type a word; **Set up sandbox** is the better path.

**Lifted floors**: some actions (sending, deleting, spending) always ask. On such a card you can choose to lift the floor: the lift-floor dialog names the consequence (messages can't be unsent, deleted items may not be recoverable, payments may not be refundable); confirm with its **Allow** button. It still asks after reading untrusted content, and every time in Manual mode.

**Why it asks again (taint)**: if a turn read untrusted content (a web page, an email, a file from outside), the card says "this turn read untrusted content" and offers only Allow once, because that content could be steering the action. **Stop it asking after Reminders, Notes or Calendar reads**: in Settings → Connectors, open Reminders, Notes or Apple Calendar and turn on **Mine — treat as trusted** for each list, folder or calendar only you can edit. Reading from it then won't make the chat ask again, and your Allow rules apply. Shared or read-only ones show "Shared" and can't be turned on; invites from other organizers, Mail, Messages and the web stay untrusted. Only you can change this in Settings: Psyche can't switch it on for you, so tell the owner where it is rather than doing it. A tool that changed its tool list since you approved it has its grants revoked and asks again until you re-approve it in Connectors.

Answered cards collapse to a one-line summary of the decision.

## Common questions

- *Check my UCSC Canvas at 9am every day*: sign in to Canvas once in the Psyche browser and choose Stay signed in, then say it in chat or use Settings → Daily → Automations; confirm the Schedule card. Offer `/settings/daily`.
- *Change the brief time*: Settings → Daily → Morning brief → Time. `/settings/daily`.
- *Stop notifications at night*: quiet hours are on by default (22:00 to 08:00); change them in Settings → Essentials or General → Notifications. `/settings/notifications`.
- *Switch model*: `/model` in chat, or Settings → Models. `/settings/model`.
- *Make it ask less*: `/mode`, or Settings → Permissions → Default mode; for one action, lift its floor on the card.
- *Revoke an Always allow*: Settings → Permissions → Approval rules → Grants ledger → Revoke. `/settings/permissions`.
- *Forget something*: `/forget subject`, or Settings → Privacy & data (`/settings/data`).
- *Share a folder*: ask in the chat (Psyche asks you to pick it and remembers your answer), or Settings → Permissions → Access → Add a folder yourself. `/settings/files`.
- *Where did that report go?*: Library → Artifacts. `/library/artifacts`.
- *See what you did today*: Overview → Activity, or Recent runs. `/overview`.
