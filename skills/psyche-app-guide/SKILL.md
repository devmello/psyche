---
name: psyche-app-guide
description: How Psyche's own app works - every screen, Settings section, slash command, permission mode and approval card, with exact names and where to find them. Use for "how do I...", "where is...", "can you..." questions about Psyche itself (settings, the Feed, automations, the Library, the browser, permissions), and offer to open the screen with app_navigate.
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
4. If the owner asks to *do* the thing (change the setting, create the automation), do it with your normal tools and approvals when you can; settings that decide what runs commands, or what is allowed without asking, are the owner's to change in the UI.
5. If this guide does not cover it, say so. Do not invent screens, labels or settings. The app changes; if a label here is not on screen, trust the screen.

The sidebar's gear opens Settings (⌘,).

## Routes for `app_navigate`

| Screen | Route |
| --- | --- |
| Chat | `/chat` |
| Search | `/search` |
| Feed | `/feed` |
| Ideas | `/ideas` |
| Goals | `/goals` |
| Library | `/library/documents` (also `/library/images`, `/library/artifacts`, `/library/downloads`, `/library/system`) |
| Overview | `/overview` |
| Inbox | `/inbox` |
| Agent sheet | `/agent/approvals`, `/agent/activity`, `/agent/upcoming`, `/agent/soul` |
| What can you do? | `/can-do` |
| Run setup again | `/onboarding` |
| Settings | `/settings/<section>` |

Settings sections (`/settings/…`): `model`, `persona`, `connectors` (also `connectors/mcp`, `connectors/add-mcp`), `skills`, `specialists`, `permissions`, `computer-use`, `browser`, `files`, `vm`, `devices`, `channels`, `credentials`, `appearance`, `notifications`, `voice`, `mail`, `daily`, `data`, `people`, `server`, `usage`, `about`.

## The sidebar and chat

**Sidebar** (⌘B toggles it, ⌥⌘B switches full and compact): destinations Chat, Search, Feed, Ideas, Goals, Library (with counts), then the Threads list (side chats, automations' chats and subagents are marked), and a footer with the persona and a gear ("Settings and help"). The gear menu has **What can you do?**, **Settings** (⌘,), **Usage** and **Help** (the About section). Overview opens from the persona.

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

## Feed, the daily brief, wrap-up, follow-ups

**Feed** (`/feed`): the brief, news, watch results, reminders and suggestions as posts. Each post has Like, **Ask about this**, Follow topic, Not interested, Hide source, and Sources. "Review and approve" opens an action Psyche proposes. The feed's instructions sheet is `/feed/instructions`.

**Morning brief and evening wrap-up**: Settings → Daily. **Morning brief** switch and **Time** (default 08:00); **Preview now** generates one immediately. **Evening wrap-up** switch. **Where it shows up**: Notify me (quiet hours hold it), Also send over Messages. **Follow-ups**: Track follow-ups and How much to track (things you promised or are waiting on). Psyche only reads for the brief.

How to set the brief time: Settings → Daily → Morning brief → Time. Open `/settings/daily`.

## Tasks, automations, and task → automation

**Automations** are scheduled runs. Ways to create one:
- Say it in chat ("every weekday at 9am check my UCSC Canvas for new assignments and notify me") or use `/schedule when and what`. Psyche recognises a repeatable routine, plans it, does a trial run with you, then shows ONE card, **Schedule "title"?**, listing every schedule, **What it does**, **Will ask you to approve**, how it notifies. **Schedule** creates the linked runs; **Not now** creates nothing. It can offer to save the steps as a skill afterwards.
- Settings → Daily → Automations: **Describe the automation**, **Preview**, then confirm with **Create** (starters under **Starters**). Each automation can be Paused/Resumed, Edited, Deleted.
- Settings → Skills and What can you do? cards ("Add: Morning brief at 7:30 on weekdays").

For a site that needs a login (Canvas, a portal), first sign in once in the Psyche browser and choose **Stay signed in** (see Browser). Automations use that sign-in only on the sites you chose. Each run can still ask for approvals the card listed; a run that cannot ask parks and waits.

Where to see them: `/overview` → **Upcoming** (next runs) and **Recent runs**; `/agent/upcoming`. A run's Timeline opens from Recent runs. **Goals** (`/goals`) holds longer aims; tell Psyche a goal in chat or add one there. Background work (tasks) shows in the chat as task cards and in Overview → Now & next.

## Library and artifacts

`/library/documents`. Sections: **Documents** (documents, audio, video, recordings), **Images**, **Artifacts**, **Downloads**, **System files**. Artifacts are what Psyche makes for you: documents, sheets, slides, and `/research` reports (a cited report). Open an item to view or edit it; "Open in editor" opens it beside the chat. Ask "make a sheet of…" in chat and the result lands under Artifacts. Documents can be exported or revised by asking.

## The Browser

Psyche browses in its own window by default (Settings → Browser: Psyche profile). When a task signs in to a site, a prompt asks **Stay signed in to {site}?** (**Stay signed in**) and **Save login to Psyche vault?** (**Save login**, or **Never for this site**). Settings → Browser → **Signed-in sites** lists them; **Sign out / forget** removes one. Saved logins live in Settings → Credentials (the vault; values are never shown, Psyche fills them after you approve). Other Browser settings: **Open links in** (Ask each time, Psyche browser, Default browser), **Real-Chrome mode** (a separate Chrome profile only Psyche uses, for sites needing 1Password or extensions; each task asks first with Touch ID or a passkey), **Web Bot Auth** (sign requests).

## Activity and the audit

`/overview` is "{persona} & you": **Now & next**, **Activity**, **Growth**, **People & projects**, **Built for you**, **Specialists**, **Upcoming**, **Recent runs** (pick a period and filter all / failed / automation / chat). Open a run for its Timeline. The agent sheet (`/agent/approvals`, `/agent/activity`) lists open Approvals and Questions, Decided recently, Standing permissions, and Soul & Memory. After a turn changes your files or items, a chip ("Changed 2 files") shows what changed, and the audit view lists changes; receipts and the audit log stay even if you delete a chat.

## Settings, every section

Settings opens from the gear or ⌘, at the left a searchable list in groups. Route `/settings/<id>`.

**General**
- **Model & providers** (`model`): add a provider (API key, subscription via a signed-in CLI, or local), check the endpoint, see tools/vision/reasoning badges, and pick models. A model you pick is used as chosen; if it fails Psyche says so.
- **Persona** (`persona`): name, tagline, emoji, creature and avatar, "Show thinking while it works". Tone lives in SOUL.md.
- **Appearance** (`appearance`): Theme (Auto follows the system), Gray family, Accent color; applies to every paired device.
- **Notifications** (`notifications`): **Quiet hours** switch with **Quiet from** and **Quiet until**; notifications are held but still land in the inbox.
- **Voice & dictation** (`voice`): dictation key, Talk with Psyche, Ask about my screen.
- **Mail & meetings** (`mail`): accounts, inbox digest, follow-ups, writing style, scheduling, meeting prep and notes; one switch for everything.
- **Daily** (`daily`): morning brief, evening wrap-up, follow-ups, automations (above).
- **Usage** (`usage`): tokens and cost, counted locally. Also in the gear menu.

**Access**
- **Permissions** (`permissions`): **Default mode for new threads**, **Connector actions** (Allow / Ask / Deny each), **Browser origins** (sites allowed without asking), shared **Folders**, and the **Grants ledger** where you can revoke any "Always allow".
- **Connectors** (`connectors`): **Add connector** (Mail, Calendar, Notes, Slack and others), **Add MCP server**. Disconnect pauses one, Remove deletes it. Sign in again when it shows "Sign in again". Command-type MCP servers and running commands need the sandbox: **Set up the sandbox** installs or locates **srt** (Install with Psyche, or point to a path); the same **Set up sandbox** button appears on a command approval card. Installing asks you to confirm.
- **Skills** (`skills`): the installed skills; each shows what it asks for. Installing or updating goes through a trust card. "Made by {persona}" marks skills it wrote.
- **Specialists** (`specialists`): the background helpers (researcher, coder and others).
- **Credentials** (`credentials`): the vault. Storage (Psyche vault with Touch ID, System keychain, External manager), fill default (ask every fill / once per site), Items with **Add item**.
- **Computer use** (`computer-use`): which Mac apps Psyche may operate; macOS permissions (Accessibility and others).
- **Browser** (`browser`): above.
- **File access** (`files`): folders Psyche may see (read only, or read and write with changes shown in the Diff pane), **Run commands on this Mac** (each command still asks first), VM shares.

**Devices**
- **VM mode** (`vm`), **Devices & nodes** (`devices`), **Channels** (`channels`: where people reach Psyche and who is allowed), **Server & remote access** (`server`).

**Privacy**
- **Data controls** (`data`): this is Memory. **Pause memory**, **Transcript recall**, **How memory is recalled** (Markdown only, or Markdown plus embeddings), how long to keep thinking and task replays, Export everything, Delete threads, reset memory. Everything stays on this machine.
- **People & projects** (`people`): the people and projects Psyche tracks, with privacy controls.

**About** (`about`): versions, data folder (Reveal in Finder), **Run checks** (Gateway, sandbox, permissions, vault), Open logs, and **Run setup again** (walks the first-run setup again; finished steps are skipped).

## Onboarding

First run walks through: about you, the model (key saved to the vault with **Save to vault**), memory, daily habits, sandbox and First wins. Re-run any time: Settings → About → **Run setup again** (`/onboarding`). "What can you do?" stays in the gear menu.

## Permissions and approval cards

**Modes** (per thread: `/mode`, or the default in Settings → Permissions):
- **manual**: asks before every action.
- **balanced**: reads run; risky actions (to people, money) ask first.
- **auto**: acts on its own; needs an Auto-capable model (pick one with `/model`).
- **plan**: read-only; plans without acting.

**Approval cards** appear in the chat and in `/agent/approvals`. Scopes: **Allow once**, **Allow for this task**, **Allow for this site**, **Allow for this session**, **Always allow** (shown under Settings → Permissions → Grants ledger, revocable). A folder request asks which folder to share. Running a command without the sandbox offers only Allow once and asks you to type a word; **Set up sandbox** is the better path.

**Lifted floors**: some actions (sending, deleting, spending) always ask. On such a card you can choose to lift the floor: **Allow without asking?** names the consequence (messages can't be unsent, deleted items may not be recoverable, payments may not be refundable); confirm with **Allow without asking**. It still asks after reading untrusted content, and every time in Manual mode.

**Why it asks again (taint)**: if a turn read untrusted content (a web page, an email, a file from outside), the card says "this turn read untrusted content" and offers only Allow once, because that content could be steering the action. A tool that changed its tool list since you approved it has its grants revoked and asks again until you re-approve it in Connectors.

Answered cards collapse to a one-line summary of the decision.

## Common questions

- *Check my UCSC Canvas at 9am every day*: sign in to Canvas once in the Psyche browser and choose Stay signed in, then say it in chat or use Settings → Daily → Automations; confirm the Schedule card. Offer `/settings/daily`.
- *Change the brief time*: Settings → Daily → Morning brief → Time. `/settings/daily`.
- *Stop notifications at night*: Settings → Notifications → Quiet hours. `/settings/notifications`.
- *Switch model*: `/model` in chat, or Settings → Model & providers. `/settings/model`.
- *Make it ask less*: `/mode`, or Settings → Permissions → Default mode; for one action, lift its floor on the card.
- *Revoke an Always allow*: Settings → Permissions → Grants ledger → Revoke. `/settings/permissions`.
- *Forget something*: `/forget subject`, or Settings → Data controls.
- *Share a folder*: Settings → File access → Share a folder. `/settings/files`.
- *Where did that report go?*: Library → Artifacts. `/library/artifacts`.
- *See what you did today*: Overview → Activity, or Recent runs. `/overview`.
