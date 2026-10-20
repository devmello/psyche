# Psyche — UI Design

Status: draft v0.1 (2026-10-18). Companion documents: [00-vision-and-principles.md](00-vision-and-principles.md), [02-architecture.md](02-architecture.md), [03-feature-spec.md](03-feature-spec.md), [04-data-model.md](04-data-model.md), [05-security-and-permissions.md](05-security-and-permissions.md), [07-tech-decisions.md](07-tech-decisions.md).

References. *(muse notes, Qn)* = `research_notes/.../meta_muse_app.md`; *(claude notes, Qn)* = `claude_desktop_and_peers.md`; *(blocks notes, section)* = `models_memory_mcp_ui_feed.md`; *(harness notes, KQn)* = `opendots_openclaw_harnesses.md`; *(arch §n)* = `02-architecture.md`. Where the notes are silent the text says so and labels the choice **Psyche decision**. Component names follow the architecture document.

---

## 1. Purpose and design principles

### 1.1 Purpose

This document specifies the screens, components, states and design language of **psyche-desktop** (Electron shell) and **psyche-web** (the same React UI served by the Gateway) *(arch §3)*. The UI renders typed Gateway events deterministically *(arch §4.2)*, so Gateway field names are repeated wherever a screen depends on them.

### 1.2 Principles

| # | Principle | In the UI |
| --- | --- | --- |
| 1 | One messaging-like conversation | A persistent main chat plus side chats; light messages; no dashboard chrome. Muse asked "How would this work if you were talking to another human?" *(muse notes, Q5)*. |
| 2 | Calm | Interrupt only when a result is new or needs input; proactive output lands in Feed, Ideas and the inbox. Muse: messages must be "worth the interruption" *(muse notes, Q5)*. |
| 3 | Progressive disclosure, three levels | Status line → action list → raw tool I/O, cycled with one shortcut everywhere. Muse's emoji → task list → raw logs *(muse notes, Q4)*; Claude's Normal / Thinking / Verbose *(claude notes, Q1)*. |
| 4 | Deterministic UI only for approvals and credentials | Approval cards and credential prompts are host-rendered, fixed in structure and button order, never inside a message. Muse: "fixed UI for structured approval cards … and for secure credential storage" *(muse notes, Q4)*. |
| 5 | Generative UI with fixed structure | Feed posts, Idea cards, Goal pages and artifact cards keep a fixed element order; the model fills the content *(muse notes, Q2)*. |
| 6 | Proactivity is batched and confirmable | Feed is a bounded batch with an end marker; Ideas and inferred Goals need a tap; no external write without an ApprovalRequest *(arch §4.11)*. |
| 7 | Everything the agent knows is a file you can open | `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, daily notes, `interests.md`, skills and the audit log open from the UI *(arch §4.8)*; Muse: "We want you to be able to see the markdown files Muse writes" *(muse notes, Q1)*. |

Two rules apply everywhere. **The client never decides**: the desktop renders ApprovalRequests and relays answers; it holds no secrets *(arch §5)*. **Two voices**: the agent speaks as its persona; the application speaks as Psyche (§4.12).

---

## 2. Information architecture

### 2.1 Left rail

Muse's Mac app has a left rail with Chat, Search, Feed, Ideas, Goals and Library and a two-bar bottom menu whose only named entry is Settings *(muse notes, Q1)*.

| Item | Opens | Notes |
| --- | --- | --- |
| Chat | Thread list + main chat | Default |
| Search | Unified search *(arch §4.12)* | Also ⌘K |
| Feed | Daily brief and scheduled briefings | Unread badge |
| Ideas | Candidate tasks and automations | New-candidate badge |
| Goals | Goals by category | |
| Library | Documents, images, artifacts, downloads, system files | Muse has a "System Files" section |
| Bottom menu | Settings, Usage, Help | **Psyche decision**; Usage shows the ledger and percent-remaining meter *(arch §4.4)* |

### 2.2 Thread list

One persistent main chat plus side chats, as in Muse (pencil-and-note icon for a new side chat, three-dot menu per thread) *(muse notes, Q1)* and OpenMuse (rename, archive, restore) *(harness notes, KQ1 1i)*.

| Action | Behaviour |
| --- | --- |
| New side chat (pencil-and-note, ⌘N) | `createdFrom: chat`; titled by the utility model until renamed |
| Fork from a message (⋯ → Continue in a side chat) | Seeded with the transcript up to that message, as Claude's `hand_off_to_session` *(claude notes, Q1)* |
| Rename, search | Click the title; filter field above the list |
| Archive / restore | "Archived (n)" group; the main chat cannot be archived; deletion lives under Data controls because it does not delete what was learned (as Muse's Help Center notes *(muse notes, Q4)*) |
| Export (⋯ → Markdown / JSON / HTML) | Tool calls collapsed, receipts included |
| Incognito | Memory-only, expires after 24 h *(arch §4.8)*; dashed avatar ring |

Rows show title, last line, time, a status dot for a running or waiting Task, and a channel icon.

### 2.3 Agent header and agent sheet

The header holds the avatar and a one-line snippet of current work. Clicking the avatar opens the **agent sheet** with four tabs — **Activity** (§3.14), **Approvals** (§3.15), **Upcoming** (§3.16), **Soul & Memory** (§3.17) — matching Muse's four icons behind the avatar *(muse notes, Q1)* and OpenMuse's "tap the avatar to see activity, reviews and receipts" *(harness notes, KQ1 1f)*. Side sheet on wide windows, bottom sheet on narrow ones.

### 2.4 Panes

Panes sit beside the chat, per thread; they split, resize, pop out and close. The agent drives them through `view.*` RPC, mirroring Claude's `ccd_view` tools *(arch §5; claude notes, Q1)*. Panes: Browser (⌘⇧B; §3.5), Terminal (⌃`; §3.6), Files (§3.7), Editor and Diff (a file, or a "+12 −1" change indicator; §3.8), Plan (a Plan artifact; §3.2), Tasks / Activity (§3.14), Subagents (view-only transcripts *(arch §4.3)*), Artifact (§3.7), VM display (§3.23). As in Claude, headers drag to reposition, edges drag to resize, ⌘\ closes. Two panes side by side at ≥ 1440 px, otherwise one with a tab strip; closing a pane never stops a Task.

### 2.5 Palette, quick entry, menu bar, inbox

**⌘K** searches the unified index and lists actions (open a thread or pane, `/model`, `/schedule`, settings) *(arch §4.12)*. **Quick entry** is a floating window on a global hotkey (§3.21); the **menu-bar item** shows status, usage and pending approvals (§3.22) *(arch §5)*; the **notification inbox** is a bell over the durable typed inbox (§3.20).

### 2.6 Settings sections

Model & providers, Persona, Connectors, Permissions, Computer use, File access, Devices & nodes, Channels, Credentials, Appearance, Voice & dictation, Data controls, Server & remote access, Usage, About. Muse documents Computer use, File system access, Permissions, Devices, Data controls, Connectors, Wallet and Secure store *(muse notes, Q1)*; the rest are Psyche additions.

### 2.7 Route and screen map

Routes are shared by psyche-desktop and psyche-web and used for pop-out windows and notification deep links; each reads its own method family *(arch §11)*.

| Route | Screen |
| --- | --- |
| `/chat`, `/chat/:threadId`, `/chat/:threadId/pane/:paneId` | Main chat, a thread, a pop-out pane |
| `/search?q=`, `/feed`, `/feed/instructions`, `/ideas` | Search; Feed; "What should I write about"; Ideas |
| `/goals`, `/goals/:goalId`, `/library/:section` | Goals list; goal page; Library section |
| `/agent/activity[/:taskId]`, `/agent/approvals`, `/agent/upcoming`, `/agent/soul` | Agent sheet tabs and task detail |
| `/settings/:section`, `/onboarding/:step`, `/inbox`, `/quick`, `/vm` | Settings, onboarding, inbox; quick entry and VM window (desktop only) |

---

## 3. Screen-by-screen specifications

### 3.0 Shared states

| State | Rule |
| --- | --- |
| Empty | One sentence in Psyche's voice plus one primary action. |
| Loading | Skeletons in the shape of the content, after 150 ms. |
| Streaming | Text streams through the sanitizing renderer; plan, approval, question, artifact and receipt blocks arrive as typed events and are inserted whole *(arch §4.2)*. |
| Error | What failed, what Psyche did, one next step; a user-selected model fails visibly rather than falling back *(arch §4.4)*. |
| Offline | Banner: "Psyche can't reach the Gateway. Tasks keep running; this window will reconnect." Composer disabled; on reconnect the client refreshes from `stateVersion` *(arch §11)*; approval cards stay stale until re-issued. |

### 3.1 Main window

```
+----+-----------+--------------------------------+-----------------+
|Rail| Threads   | (av) Wren - Holding the 2:30   | Browser    . [] x|
|Chat| [search]  |  You 10:02  Book the dentist   | [acme.com] [+]  |
|Srch| Main chat |  Wren 10:02 Three slots work.. | ( Clicking Book )|
|Feed| SIDE CHATS|  > 3 actions - browser, calendar| +-------------+ |
|Idea|  Dentist  |  [x] Find [ ] Hold [ ] Confirm | | live page   | |
|Goal|  Lisbon   | +----------------------------+ | +-------------+ |
|Libr| >Archived | | Approval needed - fill cred | | [Take control]  |
|Set |           | +----------------------------+ | [Stop the task] |
|Use | [+ side]  | [+] Message Wren    [mic][send] | Open in window  |
+----+-----------+--------------------------------+-----------------+
```

Inventory: rail (56 px), thread list (260 px; ⌘B toggles it as in Claude *(claude notes, Q1)*), chat column (min 480 px), pane area. Header: avatar with state ring, persona name, status snippet (opens the current Task at level 1), counters, permission-mode pill (manual / balanced / auto / plan *(arch §4.6)*), model pill, bell, ⋯.

### 3.2 Chat message anatomy

```
  You  10:02                              [ Book the dentist next week ]
  (av) Wren  10:02
  Three slots work with your Tuesday block. Holding the earliest.
  > 3 actions - browser, calendar                           (level 1)
    10:03 browser  read acme.com/appointments   ok  12s  r-102
  [x] Find slots  [ ] Hold slot  [ ] Confirm              (plan, pinned)
  v Sent to jane.ortiz@example.com - Gmail id 18c4.. - 10:07  (receipt)
  -- from task: Price watch -------------------------------------------
  (av) Headphones dropped to $189.                       (out of turn)
  [Queued: "also check Thursday" (followUp) x]           (follow-up queue)
  [> quoting: "Three slots work..."] [ + ] Message Wren...   [mic][send]
```

| Element | Rendering |
| --- | --- |
| User message | Right-aligned light bubble (gray-3). Muse removed heavy bubbles and puts the agent at the top *(muse notes, Q5)*. |
| Agent, system messages | Agent: no bubble; 20 px avatar, name and time per run; out-of-turn thoughts from background Tasks get a divider "from task: <title>" (Muse keeps bubbles for the same reason). System: centered, small, gray-11, Psyche's voice. |
| Tool call | Collapsed: icon, verb + target, outcome dot, duration; runs fold into "3 actions · browser, calendar". Level 0 hides rows; level 2 shows raw I/O, provenance chip, receipt link; ⌃O cycles, as Claude's view modes *(claude notes, Q1)*. Secrets show as `{{cred:name}}` placeholders *(arch §4.7)*. |
| Plan checklist | Pinned under the latest agent message from `update_plan`, one item in progress, distinct from the approved Plan artifact *(arch §4.3)*; Claude pins its list the same way. |
| Approval, question, artifact cards | Approval: never a message, a dock above the composer (§3.3). Question: from `ask_user` (§3.4). Artifact: title, type, thumbnail, Open, Save to Library; artifacts appear in chat and exist outside it *(muse notes, Q4)*. |
| Receipt line | One compact line after every external write with the provider id; uncertain outcomes read "outcome unknown · not retried" *(arch §4.5)*. |
| Follow-up queue | Strip above the composer with mode (steer / followUp / interrupt) and remove *(arch §4.2)*; OpenMuse has "a visible follow-up queue" *(harness notes, KQ1 1c)*. |
| Reply-to quote | Hover → Reply; quote chip in the composer; the sent message carries a two-line quote with a jump link. **Psyche decision**. |
| Wrap-up box, export menu | Recap ≤ 300 chars, one question, 1–2 buttons from `wrap_up` (limits from Claude's tool *(claude notes, Q5)*); ⋯ → Export: Markdown / JSON / HTML. |

Composer: attachments, `/` commands (`/model`, `/schedule`, `/forget`, `/incognito`), dictation, one Send/Stop pill.

### 3.3 Approval card

Renders an ApprovalRequest `{id, kind, summary, details, bindingHash, requestedAt, expiresAt, surfaces[]}` *(arch §4.6)*.

```
+----------------------------------------------------------------+
| [shield] Approval needed                       expires in 28:41 |
| Send an email as you                                            |
|   To       jane.ortiz@example.com  (exact recipient)            |
|   Subject  Confirming Tuesday 2:30     Body  3 paragraphs [View]|
|   Account  Gmail - you@gmail.com                                |
| Requested by  Wren - task "Dentist booking" (from chat)         |
| Why asked     balanced mode; write; turn read untrusted content |
| ( ) Allow once        ( ) Allow for this task                   |
| ( ) Allow for this site  acme.com                               |
| ( ) Always allow  until [30 days v]      (o) Deny               |
| Binding sha256:9f2c..  any change above voids this card         |
|                                      [Deny]   [Allow with scope] |
+----------------------------------------------------------------+
```

| Part | Spec |
| --- | --- |
| Summary, details | Verb + object from `summary`; key–value rows from `details`, kind-specific (below). |
| Scope radio | Allow once / Allow for this task / Allow for this site / Always allow (with expiry) / Deny — Muse's exact options *(muse notes, Q4)* — mapped to grant scopes `once`, `task`, `site`, `always`. **Psyche decision**: the `session` scope is an expiry choice under Always allow ("until this session ends", 1 h, 24 h, 30 days, until revoked); "this site" hides when the target has no origin. |
| Default and keys | Deny preselected. Return does nothing; ⌘Return approves with the selected scope; ⌘D denies. OpenClaw's Mac app: "Return alone does not approve" *(harness notes, KQ2 2h)*. |
| Countdown, who, why | `expiresAt` − now, default 30 min then denied *(arch §4.5)*, danger color under 60 s; persona, Task title, `createdFrom`, channel sender; the Broker's reason (mode, side-effect class, taint). |
| Buttons | Deny left, Allow right; disabled for 400 ms after the card appears; never move while visible (**Psyche decision**). |
| Surfaces, states | "Also sent to: iPhone, Telegram"; first answer wins; purchases and credential fills need Touch ID. States: pending, answered elsewhere, expired, voided, stale after restart. |

Binding details shown in full, by kind: `exec` — argv, cwd, env names (OpenClaw binds always-allow to argv and cwd *(harness notes, KQ2 2k)*); `email.send` — exact recipients, subject, body hash (OpenMuse review screens "retain the exact recipient" *(harness notes, KQ1 1f)*); `credential.fill` — item, bound and current origin, fields; `purchase` — merchant, amount, line items (Muse shows "the exact purchase details each time" *(muse notes, Q4)*); `write_file` — path and diff; `mcp__<server>__<tool>` — full argument preview, trust tier, `tools/list` hash *(arch §4.9)*; `node.invoke` — app, action, tier. The card lives in the thread's dock, the Approvals tab, the inbox, OS notifications and chat channels.

### 3.4 Question card

From `ask_user` *(arch §4.3)*, following Claude's `AskUserQuestion`: 1–4 questions, header ≤ 12 characters, 2–4 options with label, description and optional preview, optional multi-select, an "Other" free-text row *(claude notes, Q5)*. Muse's clarifications are documented only as free text *(muse notes, Q4)*, so chips are a **Psyche decision**.

```
+----------------------------------------------------------+
| (av) Wren needs two answers before continuing            |
| SLOT    Which slot should I hold?                        |
|   (o) Tue 2:30  recommended - fits your focus block      |
|   ( ) Wed 9:00      ( ) Thu 4:15                         |
|   ( ) Other: [________________]                          |
| NOTIFY  Who gets the confirmation? (pick any)            |
|   [x] You   [ ] Sam   [ ] Nobody                         |
|                               [Answer]   [Skip for now]  |
+----------------------------------------------------------+
```

| Rule | Spec |
| --- | --- |
| Chips vs list | Chips when every label ≤ 24 chars and no option has a description or preview; otherwise a list with a preview disclosure (previews render in the artifact sandbox). Multi-select uses checkboxes with "pick any"; Other answers with free text. |
| Recommended first | At most one option per question, listed first with a reason; preselected only for single-select. |
| Timeout | None; background input requests wait indefinitely and appear in Upcoming / Activity *(arch §4.5)*. Psyche never auto-submits, unlike Claude's optional idle timer. |
| Keys, answered state | 1–9 pick options (Claude uses 1–9 for menu items *(claude notes, Q1)*), Tab between questions, ⌘Return answers; the card collapses to one line per question with Change until the run consumes it. |

### 3.5 Browser pane

Embedded WebContentsViews on the desktop, Playwright sidecar screencast in server mode *(arch §5, §8)*.

```
+--------------------------------------------------------------+
| [acme.com - Appointments] [gmail.com] [+]      ... [] [pop] x |
| ( > Typing in "Preferred date" )                agent profile |
| +----------------------------------------------------------+ |
| |            live page  [accent outline on field]          | |
| +----------------------------------------------------------+ |
| [ Take control ]  [ Stop the task ]     Open in window | Full |
+--------------------------------------------------------------+
```

| Element | Spec |
| --- | --- |
| Tab strip, highlight | One tab per agent tab; popups and OAuth open as agent tabs. Acted-on elements get a 2 px accent outline for 600 ms. |
| Status pill | Current action in present progressive; "Paused: you have control" during Take control. Muse: "A status pill at the top shows the current action" *(muse notes, Q1)*. |
| Take control | Toggle. On: agent input paused, accent frame border; user interaction turns it on implicitly; release resumes. Muse: "Take control of the browser" to log in or type; the agent pauses when the user takes over *(muse notes, Q1, Q4)*. |
| Stop the task | Cancels the owning Task; authority revoked at once; in-flight requests reconcile by receipt *(arch §4.5)*. |
| Close (x), Open in window, Full, ⋯ | Close hides the pane only, with the toast "Browser closed. 'Dentist booking' keeps running" (Muse: "The X closes the display, but the task keeps running"); pop out or fill the window; menu: Clear browsing data, Real Chrome mode, Show replay. |
| Site-permission prompt | "Let Wren act on acme.com?" Allow once / Always allow / Deny (Claude's per-site labels *(claude notes, Q2)*); Always allow creates a `site` grant. |
| Credential-fill prompt | On a login form or `credentials.request`: "I'll type it myself" (default; turns Take control on and focuses the field), "Fill from vault once", "Fill from vault for this site", "Deny". Vault options need Touch ID and show item, bound origin and current origin; the model sees only the placeholder *(arch §4.7)*. |
| Download toast, CAPTCHA | "Downloaded invoice.pdf to Library → Downloads (quarantined)". A CAPTCHA turns Take control on; it is never attempted. |

States: no tabs, loading, acting, paused, blocked origin (the user may browse; the agent's tools stay off), offline. Secrets are masked after a fill.

### 3.6 Terminal pane

```
+----------------------------------------------------------+
| [shell 1] [+]   container - network: none   ~/workspace  |
| (av) $ npm test                                receipt r-110|
| exit 0 - 4.2 s - 2 files changed                          |
+----------------------------------------------------------+
```

xterm over node-pty inside the per-task container, or the host shell only when `exec_host` is on *(arch §9)*. Agent-run commands carry the avatar glyph and a receipt link; an approved interactive PTY shows "Wren has the keyboard" and Esc returns it. Receipt strip: exit code, duration, files changed; interrupted commands are `uncertain`. ⌃` toggles the pane, as in Claude *(claude notes, Q1)*. No backend: "No sandbox backend is available. Psyche never falls back to the host shell."

### 3.7 Files pane and viewers

```
+---------------+------------------------------------------+
| ~/Documents ro| permission-slip.pdf   12 fields - 2 need you|
| ~/Projects rw |  [page]  Child name  [Ada Lin     ] agent  |
| /workspace    |          Allergies   [            ] you    |
| Library  (1)  |                    [Apply fill] [Discard]  |
+---------------+------------------------------------------+
```

Tree of granted folders (ro / rw), the thread's `/workspace` and the Library, with inline previews *(arch §5)*, as in Claude *(claude notes, Q1)*. An unshared folder shows a Share button that raises a folder-grant ApprovalRequest.

| Viewer | Library | UI |
| --- | --- | --- |
| PDF | PDF.js 6, self-hosted worker *(blocks notes, PDF)* | Thumbnails, search, selection. Form-field highlights: AcroForm fields the agent proposes to fill are outlined in accent with values in a side list; the user edits, then Apply writes a filled copy and a receipt (OpenMuse's form values → filled copy → reviewed reply pipeline *(harness notes, KQ1 1c)*). |
| Spreadsheet, DOCX, PPTX, images | SheetJS CE + TanStack Table view, Univer edit; docx-preview / mammoth; LibreOffice or `qlmanage` thumbnails; native with zoom | Sheet tabs; Layout / Text toggle; thumbnail grid; masked regions hatched. |
| Code, CSV, JSON | CodeMirror 6 edit, Shiki 4 read | Line comments attach to the next message, as in Claude. |
| Email preview | Sanitized HTML in the artifact sandbox | Remote images blocked until "Load remote images"; provenance `untrusted` *(blocks notes, artifacts)*. |
| Artifacts | `sandbox="allow-scripts"` srcdoc iframe on a separate origin, strict CSP *(arch §5)* | Title, version history, Export, Open in window; private unless exported *(muse notes, Q4)*. |

### 3.8 Markdown editor

```
| SOUL.md   [Rich | Source | Diff]   6.2k / 20k   Save  Discard |
| # Core truths                                                 |
| - I say what I do not know.                                   |
```

Rich / Source / Diff in one toggle (MDXEditor ships it; CodeMirror 6 is the source editor *(blocks notes, Markdown editors)*). Raw Markdown is canonical; Rich never rewrites untouched lines. Diff compares against the last save, or against the agent's proposed edit when opened from an `edit_file` approval. Save / Discard are explicit, as in Claude's file editor *(claude notes, Q1)*; saving a workspace file posts a system message. Persona files show budget meters (20k per file, 4k for `USER.md`) *(arch §4.2)*; `MEMORY.md` notes that dreaming rewrites it nightly. Code files open in CodeMirror without Rich.

### 3.9 Feed

Bounded daily brief of 5–10 posts plus scheduled briefings *(arch §4.11)*. Muse's Feed is short posts on a schedule with heart and comment; "You control what it writes about" *(muse notes, Q2)*.

```
+--------------------------------------------------------------+
| Feed      Today - 7 posts   [What should I write about] [Schedule]
| +----------------------------------------------------------+ |
| | BRIEFING 07:00  Two things before your 10:00             | |
| | Sources (3) Calendar - Gmail - acme.com [1][2][3]         | |
| | [Follow: dentists] [Not interested] [Hide acme.com]       | |
| | [Like] [Save] [Ask Wren]                                  | |
| +----------------------------------------------------------+ |
| | ROBOTICS - exploration slot ...                           | |
|               That's it for today. Next brief 07:00.          |
+--------------------------------------------------------------+
```

| Element | Spec |
| --- | --- |
| Post card | Kind label (briefing, reminder, suggestion, watch result, news cluster), title, body with citation markers, source cluster row with favicons and count, feedback row *(blocks notes, feeds)*. |
| Feedback | Follow topic, Not interested, Hide source, Like, Save (Discover-style vocabulary); written to the interest ledger at once with an undo toast. |
| Exploration slot, end marker | One or two labelled posts per batch; "That's it for today", a Pulse-style bound. |
| Instructions editor, schedule | "What should I write about" opens `workspace/interests.md` in the Markdown editor (natural language, as Muse's configuration is conversational); briefings are automations edited as in Upcoming. |
| Ask Wren | Opens a side chat seeded with the post; undocumented for Muse, **Psyche decision**. |

States: first run ("No brief yet. Generate the first one, or wait until 07:00"; Muse's new accounts may need to generate a first feed *(muse notes, Q1)*), generating, per-source failure rows.

### 3.10 Ideas

Cards with evidence, effort and Let's do it / Edit / Dismiss; accepted ideas become Tasks or automations *(arch §4.11)*. Muse: "Tap one and it builds it", with a recurring toggle in the "Let's do it" popup *(muse notes, Q3)*; OpenMuse ideas carry evidence *(harness notes, KQ1 1c)*.

```
+----------------------------------------------------------+
| Cancel the unused streaming subscription                 |
| Because: 3 charges in Gmail, no logins in 90 days        |
| Effort ~10 min - needs 1 approval (email)                |
| [ ] Make recurring: monthly subscription audit           |
|              [Let's do it]  [Edit]  [Dismiss v]          |
+----------------------------------------------------------+
| Skill draft: "Weekly expense export"  [View SKILL.md]    |
| Because: you did these 4 steps 3 times this month        |
+----------------------------------------------------------+
```

Evidence links to its source; effort shows minutes and the approvals needed; the recurring toggle creates an automation; Edit opens the brief in a side-chat composer; Dismiss offers Not now / Not interested / Never from this source, feeding the acceptance model. Skill drafts stay drafts until approved *(arch §13)*. Batches arrive in scheduled windows.

### 3.11 Goals

Category, milestones, plan, linked Tasks, check-in cadence, watches; inferred goals are candidates for one-tap confirmation *(arch §4.11)*. Muse's Goals tab shows everything tracked with plans per goal, in categories such as health, finance and career *(muse notes, Q3)*; its detail view is undocumented, so the page is a **Psyche decision**.

```
+------------------+-------------------------------------------+
| HEALTH           | Run a half marathon in May           [...]|
|  > Half marathon | Milestones [x] 5k [x] 10k [ ] 15k [ ] 21k |
|    Sleep 7h      | Plan      12-week plan (PDF) - edit       |
| FINANCE          | Tasks     3 done - 1 running              |
|    Emergency fund| Check-ins Mon 08:00 - last: on track      |
| +--------------+ | Watches   registration page - price       |
| |Inferred goal?| | Notes     (Markdown)                      |
| |[Confirm][Not | |                                           |
| | a goal][Later]| |                                           |
+------------------+-------------------------------------------+
```

List rows show title, next check-in and a milestone progress bar; the plan is an artifact (Muse produced a 24-week marathon plan as a PDF); check-ins arrive as `reminder` notifications. The confirm card shows "Because:" evidence with Confirm / Not a goal / Later; nothing is created before Confirm. Delete needs a typed confirmation.

### 3.12 Library

Tabs: Documents, Images, Artifacts, Downloads, System files; grid or list with type, source Task and date filters.

| Section | Contents | Actions |
| --- | --- | --- |
| Documents, Images, Artifacts | Files the agent made or received *(arch §12)*; artifacts with versions | Open, Reveal, Share, Quick Look (mac helper), Send to chat; Update by name, Export |
| Downloads | Quarantined until opened *(arch §5)* | Opening requires a click; "Trust this file" clears the badge |
| System files | `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`, daily notes, `interests.md`, skills, `DREAMS.md`, audit months | Open in editor; audit read-only; Muse's Library has a "System Files" section *(muse notes, Q1)* |

Every item carries a Task chip linking to the action that produced it.

### 3.13 Search

```
| [ in:feed type:pdf from:alice  dentist                    ] |
| THREADS (3)  Dentist booking - "...three slots work..."      |
| MEMORY (1)   2026-10-16 - "prefers morning appointments"  owner|
| LIBRARY (2)  permission-slip.pdf                             |
```

A first-class rail item (Muse's Mac rail has Search *(muse notes, Q1)*) over one index spanning threads, tasks, memory, Library, Feed, Ideas, Goals and indexed connector caches, with typed filters *(arch §4.12)*. Results group by kind with a provenance chip for memory; opening a result lands in the pane it belongs to.

### 3.14 Activity

Tasks most recent first; tap a task to see every action *(muse notes, Q1)*; each Task has an ordered action log with three disclosure levels *(arch §4.5)*.

```
+--------------------------------------------------------------+
| Activity          [Running 1] [Needs you 2] [All]             |
| * Dentist booking       running - Holding the 2:30 slot       |
| ! Tax letter            awaiting approval - send email        |
|   Price watch           automation - last run NO_REPLY        |
+--------------------------------------------------------------+
| Dentist booking   from chat - 10:02 - attempt 1  [Pause][Cancel]|
| level: [status | actions | raw]                               |
| 10:02 browser  open acme.com/appointments   ok   r-101        |
| 10:05 approval credential.fill acme.com     waiting           |
+--------------------------------------------------------------+
```

Rows: status glyph, title, status text, `createdFrom`, lease owner when remote; controls Pause / Resume / Cancel / Retry. Level 1 is the action list with receipt links, level 2 raw I/O with provenance chips and the Broker's decision; replay shows screencast frames when retention is on *(arch §8)*; the evaluator line reads done / reopened / escalated.

### 3.15 Approvals queue

```
| NEEDS YOU (2)   [full approval cards, newest first]              |
| DEFERRED (1)    Price watch wanted to email you - [Run with approval]|
| RECENT          Approved on iPhone - Denied - Expired ...        |
| STANDING GRANTS 14 - [Review in Permissions]                     |
```

Deferred holds approvals that unattended runs could not ask for *(arch §4.3)*; Recent covers 7 days with who answered where; Standing grants link to the ledger of `site`, `session` and `always` grants with expiry and use counters *(arch §4.6)*, as OpenClaw's Control UI does *(harness notes, KQ2 2n)*.

### 3.16 Upcoming

Muse's Upcoming holds reminders and scheduled tasks, where recurring tasks are edited *(muse notes, Q1, Q3)*.

```
| Morning brief      weekdays 07:00  main      last: delivered  [Run now][Pause]|
| Subscription audit monthly 1st    isolated  last: NO_REPLY   [Edit]          |
| Watch: headphones  every 6 h      price < $200  last: $219   backoff 2x      |
| Reminder: call Sam Thu 17:00  [Snooze][Done]    Heartbeat  every 45 min       |
```

Rows show the schedule as a sentence, session target (main / isolated / named), delivery target, last outcome including `NO_REPLY`, next run, and Run now / Pause / Edit / Delete *(arch §4.11)*; watches show condition, last observation and backoff; after sleep a banner reports coalesced runs. The editor offers presets and a natural-language field.

### 3.17 Soul & Memory

The fingerprint tab *(muse notes, Q1)*: edit the files directly, browse daily notes, search, pause, incognito, import, export, reset *(arch §4.8)*.

```
+--------------------------------------------------------------+
| Soul & Memory                                 [Search memory] |
| FILES  SOUL.md  IDENTITY.md  USER.md  MEMORY.md  AGENTS.md    |
| DAILY  2026-10-18  10-17  10-16 ... [all]                     |
| (editor: Rich | Source | Diff)                                |
| Memory: On [Pause]   Incognito side chat [Start]              |
| [Import memory] [Export everything] [Reset Wren...]           |
+--------------------------------------------------------------+
```

| Element | Spec |
| --- | --- |
| File tabs, daily notes | Markdown editor with budget meters; `IDENTITY.md` fields (name, creature, vibe, tagline, emoji) also render as a form; Muse's Identity file "sets your Muse's name, creature, vibe or tag line". Daily notes in a calendar strip. |
| Memory search | Provenance chips; "Why is this believed?" calls `memory_explain`; "Forget…" stages a retraction through `forget` and lists what else will go. |
| Pause, incognito | Pause stops flushes and dreaming writes and shows a "Memory paused" chip in every thread; incognito starts a memory-only side chat. |
| Import, export, reset | Imported entries arrive as `untrusted` and are never promoted automatically (Muse has "Import memory" under Data controls *(muse notes, Q4)*); "Download your data" exports threads, files, memory and the audit log; Reset needs a typed confirmation and lists which folders go. |

### 3.18 Settings screens

**Model & providers**: provider rows with key status (a vault reference, never the key), model roles, a "tool-calling check" badge, RAM guidance *(arch §4.4)*. **Persona**: name, creature, vibe / tagline, emoji, avatar preview with "Describe a change" in natural language (Muse's pencil-icon edit *(muse notes, Q5)*). **Connectors**: directory with trust tiers, status, scopes, last used *(arch §4.9)*; connect flows ask read-only vs read-and-act (Muse asks whether to read mail only or also send *(muse notes, Q4)*); Disconnect and Remove are separate, as in Claude *(claude notes, Q6)*.

**Permissions**

```
+--------------------------------------------------------------+
| Default mode for new threads  (o) balanced ( ) manual ( ) auto|
| Gmail (read-and-act)      Allow  Ask  Deny                    |
|   read threads             (o)   ( )  ( )                     |
|   send                     ( )   (o)  ( )                     |
|   delete                   ( )   ( )  (o)                     |
| Notion (read-only)  tools/list hash ok                        |
| Browser origins  acme.com rw - always, expires 2026-11-17 [x]  |
| Folders  ~/Documents ro   ~/Projects/psyche rw                |
| Grants ledger 14  [Review]    Hard prohibitions  [Show]       |
+--------------------------------------------------------------+
```

Per-connector action matrices with Allow / Ask / Deny per action, as on Muse's Notion connector screen *(muse notes, Q1, Q4)*; MCP keys as `mcp__<server>__<tool>`; a changed `tools/list` hash shows "Grants revoked" *(arch §4.9)*; hard prohibitions listed read-only.

**Computer use**

```
| Accessibility: granted   Screen Recording: denied [Open System Settings] |
| app          Off  Read only  Read and interact                           |
| Mail         ( )    ( )        (o)        Safari   read-only (fixed)     |
| Notes        ( )    (o)        ( )        Terminal click-only (fixed)    |
| 1Password    Off (fixed)                  Esc stops computer use         |
```

TCC rows with a denied badge; per-app tiers Off / Read only / Read and interact, prompted on first use *(arch §6)*, the same three values Muse's Mac apps use *(muse notes, Q1)*; fixed caps as locked rows (browsers read-only, terminals and IDEs click-only, password managers and banking Off).

**File access**: folder grants ro / rw; VirtioFS shares in VM mode, read-only by default. **Devices & nodes**: paired devices with scopes, pending pairings with the challenge fingerprint, nodes with capabilities and last seen *(arch §7, §11)*.

**Channels**

```
| Telegram  connected  dmPolicy (o) pairing ( ) allowlist ( ) open ( ) disabled |
|   Pending (2 of 3)  @sam_k  code 48-21  expires 41m   [Approve] [Ignore]     |
|   Allowlist  you (owner), partner     Groups  Family (requireMention on)      |
| Identity links  Telegram @you = iMessage +1 555.. = owner   Designated: Partner|
```

`dmPolicy: pairing | allowlist | open | disabled`, codes expiring in 1 h with at most 3 pending per channel, group allowlists with `requireMention`, identity links, designated people whose approvals route to the owner *(arch §4.10)*; mechanics from OpenClaw *(harness notes, KQ2 2f)*. Choosing `open` warns.

**Credentials**

```
| Credentials        storage: Psyche vault (Touch ID) [v]            |
| name          kind     bound to        last used  uses             |
| github-login  login    github.com      2 h ago    14               |
| stripe-link   payment  Link wallet     never      0                |
| [Add item] [Connect 1Password] [Connect Bitwarden]  fill default: once |
```

Vault list with kind, origin binding, last used, use count; backend switch (Psyche vault / system keychain / external manager) *(arch §4.7)*; adding a payment item explains that raw card numbers are refused; values are never displayed. Muse has a Secure store and a Wallet *(muse notes, Q1)*.

**Appearance**: theme (auto / light / dark), gray family, density, accent picker with a live preview of the generated 12-step scales and the WCAG result for the text steps, reduce motion (§4.8–4.10); on the desktop, zoom (`appearance.zoom`, 67–200 %, default 100, "Actual size"): View → Zoom In / Out write the same setting and the app applies it on launch, so a stray ⌘+ never persists silently. **Voice & dictation**: push-to-talk key, toggle mode, system-wide hotkey, engine; Muse's Mac app dictates while the function key is held *(muse notes, Q1)*. **Data controls**: pause memory, replay retention, transcript recall, export, delete threads, reset; no training toggle, unlike Muse's on-by-default "Help improve our AI models" *(muse notes, Q4)*, because there is no telemetry. **Server & remote access**: bind address, Tailscale / proxy status, passkeys, sandbox health, VM controls. **Usage**: tokens, cost, per-thread and per-automation breakdown, percent-remaining meter. **About**: versions, `psyche doctor`, logs.

### 3.19 Onboarding

```
| 1 Meet your agent   2 Permissions   3 Connectors   4 Model   5 Where   6 Done |
| Name [Wren       ]  suggestions: Juno - Moss - Pip   or keep "Psyche"         |
| Creature  [a small grey moth with lantern eyes          ]  (av preview)      |
```

| Step | Content |
| --- | --- |
| 1 Meet your agent | Name with suggestions or "Keep 'Psyche'"; creature in natural language or from the bundled set; vibe / tagline. Writes `IDENTITY.md`; `BOOTSTRAP.md` starts *(arch §4.8)*. Muse offers names or keeps "Muse" *(muse notes, Q5)*. |
| 2 Permissions | Accessibility ("lets Wren click, type and use apps"), Screen Recording, Notifications, each Allow / Skip; Muse's wizard asks for both, each skippable *(muse notes, Q1)*. |
| 3 Connectors | One at a time; read-only vs read-and-act; "decide now which accounts to connect" (Muse's Help Center advice *(muse notes, Q4)*). |
| 4 Model & provider | Cloud key or subscription, OpenRouter, or local with RAM guidance; runs the tool-calling check. Muse has no picker *(muse notes, Q0)*. |
| 5 Where Wren works | Local Mac or VM mode with its defaults and what the guest can see *(arch §10)*. |
| 6 Done | Main chat opens with the agent's first message. |

### 3.20 Notifications

Kinds: `approval`, `input_needed`, `task_done`, `task_failed`, `proactive`, `briefing`, `reminder` *(arch §4.12)*; Muse's reduce to approval, task finished, suggestion, briefing or reminder *(muse notes, Q4)*.

```
| Inbox (3)                                                        |
| ! Approval  Send email to jane.ortiz@..  28:41  [Approve][Deny]  |
| ? Input     Trip to Lisbon - which dates?          [Answer]      |
| v Done      Subscription audit - 1 cancelled       [Open]        |
```

| Kind | In-app row | OS notification (mac helper, with actions) |
| --- | --- | --- |
| approval | Summary, countdown, inline Approve / Deny; purchases and fills open the full card | Approve / Deny; `authenticationRequired` for purchases and fills *(arch §4.6)*; time-sensitive |
| input_needed | Headers, Answer | Answer; text reply for one free-text question |
| task_done / task_failed | Result or reason, Open / Retry | Open, Retry |
| proactive, briefing, reminder | Title and evidence; "Brief ready"; Done / Snooze | Passive and batched; reminders carry Done / Snooze 1 h |

One notification per Task per state change; stale ones are marked after a restart; every row deep-links to a route.

### 3.21 Quick entry

```
| (av) Wren - idle                            [main chat v] |
| [ Ask or tell Wren...                                ][>] |
| last: "Holding the 2:30 slot" - 1 approval waiting        |
```

Frameless floating window on a global hotkey *(arch §5)*; **Psyche decision**: default ⌥Space, OpenClaw's Quick Chat key *(harness notes, KQ2 2h)*; Claude's key is undocumented *(claude notes, Q1)*. Target selector (main chat or a side chat); the reply streams into a collapsed strip; a pending approval is only a link to the full card.

### 3.22 Menu-bar item

```
| (moth) Wren - working on 1 task         |
| Usage  62% remaining - $0.41 today      |
| Needs you  Send email to jane.ortiz..   |
| Open Psyche  New side chat  Quick entry |
| Pause agent  Stop all tasks             |
| Gateway: running (launchd)              |
```

Template icon with the avatar state; the usage meter mirrors Muse's percent-remaining meter and adds estimated cost *(arch §4.4; muse notes, Q0)*; the Gateway row exists because the window can close while work continues.

### 3.23 VM window

```
| VM: work-mac   ( > Opening Mail )   [Take control]  [Snapshot v] [Fresh Mac]|
| +----------------------------------------+ Shared: ~/Documents ro          |
| |          guest display                 | Clipboard: on   Guest Gateway ok |
| +----------------------------------------+ Limits: 1 guest, NAT only       |
```

Guest display streamed from the helper with the browser pane's Take control affordance *(arch §10)*; shared folders, clipboard toggle, snapshots with "Fresh Mac" reset; a limits strip (one guest, NAT only). States: creating, provisioning, running, saved, error.

### 3.24 Web / server variant and narrow width

psyche-web differs only by capability: the browser pane shows the sidecar's screencast with Take control over CDP; the terminal is a PTY in the sandbox; dictation runs on the Gateway or in the browser; Web Push carries no auth-required actions, so purchases and fills are answered in the UI or on a paired Mac; quick entry, menu bar and VM are absent; auth is a paired device or a passkey *(arch §11)*.

```
| < Dentist booking   (av) Wren  [search] |
|  You: Book the dentist next week         |
| | Approval needed - fill cred  [Open]  | |
| [+] Message Wren...               [send] |
| [Chat] [Feed] [Ideas] [Goals] [Library]  |
```

Below 720 px the rail becomes a bottom tab bar with Chat, Feed, Ideas, Goals and Library, the five tabs Muse shows on phones *(muse notes, Q1)*; Search moves to the top bar; the thread list is a drawer; the agent sheet is a bottom sheet; panes open full screen one at a time; approval cards pin above the composer.

---

## 4. Design language

The notes contain no colors, type, spacing, radii, dark-mode behaviour or motion for Muse *(muse notes, Q1, Q5)*; this section is **Psyche's own** except where cited.

### 4.1 Layout grid and breakpoints

| Token | Value |
| --- | --- |
| Base unit | 4 px (`--spacing: 4px`, Tailwind v4 convention *(blocks notes, theming)*); 8 px vertical rhythm |
| Rail / thread list / chat / pane | 56 px / 260 px / min 480 px, prose 68ch / min 360 px |
| Breakpoints | compact < 720 (§3.24); medium 720–1079 (icon rail, list as overlay, one pane as a tab below the chat); wide 1080–1439 (one pane beside the chat); x-wide ≥ 1440 (two panes); minimum window 900 × 600 |

### 4.2 Typography

System stack `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Inter, sans-serif` (Inter self-hosted on Linux); mono `"SF Mono", Menlo, "JetBrains Mono", ui-monospace`. Scale: body 15/22, small 13/18, caption 12/16, label 11/14 uppercase; h1 24/30, h2 20/26, h3 16/22 at weight 600; mono 13/20. The interface is text-heavy, as reviewers describe Muse *(muse notes, Q5)*; type carries hierarchy, color does not.

### 4.3 Spacing and radius

Spacing 2, 4, 8, 12, 16, 24, 32, 48 px. Radius base `--radius: 10px` (shadcn's 0.625rem default *(blocks notes, theming)*): sm 6, md 8, lg 10, xl 14, full. Cards 10, inputs 8, chips and avatars full, user bubble 16, panes 0.

### 4.4 Elevation

Level 0 (page, panes): gray-1. Level 1 (cards, approval dock): gray-2 with a 1 px gray-6 border, no shadow. Level 2 (popovers, menus, status pill): shadow 0 4 16 / 12% in light, gray-3 with a gray-7 border in dark. Level 3 (sheets, dialogs, quick entry): shadow 0 12 40 / 20%. Dark mode steps surfaces up instead of deepening shadows.

### 4.5 Motion

| Element | Spec |
| --- | --- |
| Durations | 120 ms hover and toggles, 200 ms cards, 320 ms sheets and panes; `cubic-bezier(.2,.8,.2,1)` |
| Avatar loops | Idle: breathing scale 1.00–1.02 over 4 s. Working: the creature types on a tiny laptop, two-frame loop at 1.5 Hz (as Muse's avatars do *(muse notes, Q5)*). Needs-you: still, pulsing accent ring 1.2 s, count badge. Error: still, desaturated, danger badge. Paused / incognito: dashed ring. |
| Status pill, cards | 160 ms text crossfade at fixed width; cards enter with fade + 8 px rise 200 ms and exit with fade 120 ms; approval cards enter without rise and never shift layout; the in-progress checklist item has a moving 1 px underline |
| Reduced motion | `prefers-reduced-motion` or the Appearance switch: loops become static frames, working is shown by pill text and a badge, transitions become 0 ms opacity changes |

### 4.6 Iconography

Lucide, 1.75 px stroke, 16 / 20 / 24. The icons Muse documents keep their meaning *(muse notes, Q1)*: `lightbulb` for Ideas (Muse's light-bulb), `circle-check` for Goals (check-mark), `fingerprint` for Soul & Memory, `pencil` to edit the persona, `square-pen` for a new side chat (pencil-and-note), `menu` for the bottom menu (two-bar hamburger), `ellipsis` for overflow (three dots). Psyche's own: `message-circle` / `search` / `newspaper` / `library` for the rail, `list-checks` / `shield-check` / `calendar-clock` for Activity / Approvals / Upcoming, `hand` for Take control, `square` for Stop, `receipt`, `shield-alert` for untrusted provenance, `eye-off` for incognito.

### 4.7 The avatar system

| Aspect | Spec |
| --- | --- |
| Default creature | An original pale moth with accent-colored wing spots (the mythological Psyche has wings); Muse's default "Jolly" is cream-colored with beady black eyes *(muse notes, Q5)* and OpenMuse bundles a warm tan capybara *(harness notes, KQ1 1j)*. |
| User-described creature | The onboarding sentence or a later "Describe a change" goes to the configured image model when one exists; otherwise the user picks from 12 bundled SVG creatures (whether Muse uses an image model is unconfirmed; **Psyche decision**). Prompt and render live in `IDENTITY.md` and `library/images/avatar/`; the emoji is the fallback on image-less channels. |
| Sizes, states | 20 inline, 28 phone header, 40 desktop header, 64 agent sheet, 160 onboarding. States idle, working, needs-you, error, paused / incognito, offline, derived from Tasks and the Gateway connection, never set by the model. A delegated persona gets a distinct ring and the label "delegated" *(arch §4.10)*. |

### 4.8 Color system

| Rule | Spec |
| --- | --- |
| Tokens and scales | OKLCH CSS variables, as shadcn v4 and Tailwind v4 emit them *(blocks notes, theming)*: `--accent-1..12`, `--gray-1..12`, alpha variants, P3 overrides, `--accent-contrast`. Radix semantics: 1–2 backgrounds, 3–5 component states, 6–8 borders and rings, 9–10 solids, 11–12 text. |
| Generation | From the user's seed with the open Radix generator (colorjs.io, bezier easing, APCA-chosen text color), once per appearance; the seed lands on step 9. |
| Appearance | light / dark / auto via `data-theme` and `color-scheme`; auto follows `prefers-color-scheme`. |
| Contrast gate | WCAG 2: step 11 ≥ 4.5:1 and step 12 ≥ 7:1 on step 2; `--accent-contrast` ≥ 4.5:1 on step 9; failing seeds are nudged in lightness and the picker says so. APCA Lc is advisory only (WCAG 3 is undecided; the APCA licence is restrictive). |
| Semantic tokens | `--approval` (amber: dock border, needs-you ring, countdowns), `--danger` (tomato: Deny, destructive, failed), `--success` (grass: receipts, done), `--info` (sky: system messages), `--untrusted` (amber outline on provenance chips); fixed Radix scales, not seed-derived, so Deny never looks like the brand. Incognito threads replace the accent with gray. |

### 4.9 Component inventory

shadcn/ui v4 on Base UI (the default base since July 2026) with Tailwind v4.3, plus assistant-ui primitives *(blocks notes, UI kits; arch §3.1)*. Thread, messages and composer come from assistant-ui's `Thread`, `ThreadList`, `Message` and `Composer` over an AG-UI / data-stream runtime bound to `chat.*` events. Tool rows, the plan checklist and receipt lines use `Collapsible`, `Badge`, `Checkbox` and `HoverCard`; the approval card uses `Card`, `RadioGroup`, `Select`, `Button` and `Progress`; the question card uses `ToggleGroup`, `RadioGroup` / `Checkbox` and `Input`. The agent sheet is `Sheet` / `Drawer` with `Tabs`; panes use `react-resizable-panels`; the palette is `Command`; toasts are `Sonner`; matrices are TanStack `Table`. The editor is MDXEditor over CodeMirror 6; viewers are PDF.js 6, SheetJS + TanStack Table, Univer, docx-preview, Shiki and the sandboxed iframe.

### 4.10 Theming API

```
settings.appearance { theme, accentSeed, gray, density, reduceMotion }
   -> settings.changed event (Gateway -> every paired client)
   -> generateScales(seed, gray, appearance)
   -> <style id="psyche-theme">
        :root { --accent-1..12; --accent-a1..12; --accent-contrast; --gray-1..12 }
        :root[data-theme="dark"] { ... }
        @supports (color: color(display-p3 1 1 1)) { @media (color-gamut: p3) { ... } }
      </style>
```

shadcn names are mapped once and never regenerated: `--primary: var(--accent-9)`, `--primary-foreground: var(--accent-contrast)`, `--ring: var(--accent-8)`, `--border: var(--gray-6)`, `--foreground: var(--gray-12)` *(blocks notes, theming)*. `@theme inline` exposes the scales as Tailwind utilities; `@property` registers the solid steps so an accent change animates in 200 ms; density sets `--spacing` to 3.5 or 4 px. The theme is per owner and identical in psyche-web.

### 4.11 Accessibility

Keyboard map, modeled on the Claude desktop shortcuts *(claude notes, Q1)*; † marks Psyche additions.

| Shortcut | Action |
| --- | --- |
| ⌘K † | Command palette |
| ⌘N / ⌘W | New side chat / close thread view or pop-out |
| ⌘B | Toggle thread list |
| ⌃Tab | Cycle threads |
| ⌘; | Fork from selection into a side chat |
| Esc | Stop the run; release Take control; globally stop computer use (consumed so page content cannot dismiss it *(arch §6)*) |
| ⌃O | Cycle disclosure level: status → actions → raw |
| ⌘⇧B / ⌘⇧D / ⌃` | Browser / Diff / Terminal pane |
| ⌘⇧M / ⌘⇧I | Permission mode / model picker |
| ⌘⇧A / ⌘⇧P † | Agent sheet → Activity / Approvals |
| ⌘\ / ⌘/ | Close focused pane / shortcut list |
| 1–9 | Select a menu or question option |
| ⌘Return | Approve with selected scope; answer a question; submit a line comment |
| ⌘D † | Deny the focused approval |
| ⌥Space † | Quick entry (global) |
| Hold fn † | Push-to-talk dictation; Muse dictates while the function key is held *(muse notes, Q1)* |

Focus: a new approval card moves focus to its heading and announces through a polite live region unless the user is typing; closing a pane returns focus to its opener; sheets trap focus. Approval cards are `role="group"` labelled by the summary; the status pill is `aria-live="polite"`; avatar state is also text. High contrast: borders step 8, text step 12, 2 px solid focus rings.

### 4.12 Copywriting voice

| Rule | Example |
| --- | --- |
| Short, specific, second person | "Wren needs your login for acme.com", not "Credentials are required to proceed." |
| The agent speaks as the persona; system UI speaks as Psyche | Agent messages use the persona's name and the Soul's tone; banners, settings and errors say "Psyche can't reach the Gateway" and name the persona only as a subject. |
| Approval summaries name the exact target | "Send an email to jane.ortiz@example.com"; "Run `npm install` in ~/Projects/psyche". |
| Errors: what happened, what Psyche did, what you can do | "The model returned an error (rate limited). Psyche did not fall back because you chose this model. Try again or pick another." |
| No exclamation marks, no "Oops", no system apologies; receipts are facts; proactive items carry a "Because:" line | |

### 4.13 Empty and error states

Every screen follows §3.0: an empty state is one sentence in Psyche's voice plus one action ("No tasks yet."; "Nothing needs you."; "Ideas come from your goals, conversations and connected accounts."; "Tell Wren a goal in chat, or add one here."), and an error names what failed, what Psyche did and one next step ("The nightly job didn't run (Mac was asleep). Next: 06:00."; "No sandbox backend is available. Psyche never falls back to the host shell."). The main chat is never empty: it opens with the agent's first message from `BOOTSTRAP.md`.

---

## 5. Where Psyche deliberately differs

| Topic | Muse | Claude desktop | Psyche | Why |
| --- | --- | --- | --- | --- |
| Where approvals appear | Sentinel delivers them in the client UI, "not via their conversation" *(muse notes, Q4)* | Permission cards in the transcript area *(claude notes, Q5)* | Always outside the message stream: dock, Approvals tab, inbox, OS notifications, channels | A card that scrolls away is missed or mistaken for model text |
| Receipts | An audit trail exists *(muse notes, Q4)* | No receipt line in chat | A visible receipt line after every external write | *(arch §2)*; OpenMuse's review → receipt contract *(harness notes, KQ1 1g)* |
| Credential fill | A client UI captures the password into secure storage *(muse notes, Q4)* | 1Password fills in Chrome; the agent refuses to type secrets *(claude notes, Q2)* | "I'll type it myself" is the default; vault fill is opt-in per fill or per site | "Log in yourself" before "fill from vault" *(arch §4.7)* |
| Search | A Mac rail item *(muse notes, Q1)* | Transcript search and a palette *(claude notes, Q1)* | First-class rail item over one index | Makes "everything is a file" usable *(arch §4.12)* |
| Side chats | Persistent *(muse notes, Q1)* | Side chat "isn't saved to disk" *(claude notes, Q1)* | Persistent and forkable; incognito is the explicit ephemeral option | Privacy is a choice, not a default loss |
| Feed cadence | Undocumented *(muse notes, Q2)* | No feed | 5–10 posts, end marker, labelled exploration | Anti-doomscroll default *(blocks notes, feeds)* |
| Inferred goals | Infers goals "not said out loud" *(muse notes, Q3)* | None | Candidates needing a tap | *(arch §2)* |
| Training and telemetry | "Help improve our AI models" on by default *(muse notes, Q4)* | n/a | No toggle, no telemetry unless enabled | Nothing to send |
| Take control | Explicit control *(muse notes, Q1)* | Implicit; none documented *(claude notes, Q2)* | Implicit on interaction plus an explicit toggle with a visible paused state | The user should see whose keyboard it is |
| Gateway lifetime | Cloud VM continues when the app closes *(muse notes, Q4)* | Local sessions need the app open *(claude notes, Q4)* | Menu-bar item shows the Gateway running after the window closes | OpenClaw's Gateway pattern *(harness notes, KQ2 2h)* |

---

## 6. Open questions and gaps

Undocumented in the sources, so Psyche defines its own:

- Muse's exact colors, typography, spacing, radii, dark mode and motion are described nowhere; Meta's screenshots are uncaptioned *(muse notes, Q1, Q5)*. Section 4 is Psyche's.
- Muse's clarifying questions appear only as free text; no source shows chips *(muse notes, Q4)*. §3.4 follows Claude's `AskUserQuestion` schema plus Psyche's chip rule.
- Muse's approval card visuals, Goals detail view, check-in rendering, inferred-goal acceptance, Feed post schema and cadence, avatar creation flow, and iPad and WhatsApp layouts are undocumented *(muse notes, Q1–Q5)*.
- Claude's chat conversation controls (branching, export, reply-to), plan pane rendering and quick-entry hotkey are undocumented or inferred *(claude notes, Q1, Q5)*.

Decisions the architecture document should reflect or confirm:

1. The `session` grant scope is an expiry choice under "Always allow"; the Broker should accept `{scope: "always", expiresAt: <session end>}` or map it to `session`.
2. Approval buttons are disabled for 400 ms after a card appears; the Gateway should reject earlier answers for a given `id`.
3. `ask_user` carries no timeout; background input requests wait indefinitely.
4. `threads.*` needs `fork {threadId, messageId}`, and `threads.list` should return activity counts.
5. Receipts need a short client-visible id and a provider id string; notifications need a `route` field.
6. A `settings.changed` event carrying appearance settings is required so every paired client re-themes.
7. The default quick-entry hotkey ⌥Space may conflict with other utilities; onboarding should offer ⌃⌥Space.
8. The ranking job must mark which Feed posts came from exploration slots.

Open for the design itself: how to show subagents in the chat column without noise; whether the terminal pane belongs in the narrow web layout; whether the delegated-persona ring is enough to tell an owner's and a designated person's threads apart; the bundled creature set's art direction; and whether to adopt the shadcn-hosted AI Elements components after November 2026 *(blocks notes, UI kits)*.
