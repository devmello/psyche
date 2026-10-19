# Psyche — UI Design

Status: draft v0.1 (2026-10-18). Companion documents: [00-vision-and-principles.md](00-vision-and-principles.md), [02-architecture.md](02-architecture.md), [03-feature-spec.md](03-feature-spec.md), [04-data-model.md](04-data-model.md), [05-security-and-permissions.md](05-security-and-permissions.md), [07-tech-decisions.md](07-tech-decisions.md).

References. *(muse notes, Qn)* = `research_notes/.../meta_muse_app.md`; *(claude notes, Qn)* = `claude_desktop_and_peers.md`; *(blocks notes, section)* = `models_memory_mcp_ui_feed.md`; *(harness notes, KQn)* = `opendots_openclaw_harnesses.md`; *(arch §n)* = `02-architecture.md`. Where the notes are silent the text says so and labels the choice **Psyche decision**. Component names (Gateway/psyched, psyche-desktop, mac helper, node, Permission Broker, ApprovalRequest, grant scopes, Credential Broker, placeholder, Task, receipt, panes, Take control, dmPolicy, automations, Upcoming, Activity) follow the architecture document.

---

## 1. Purpose and design principles

### 1.1 Purpose

This document specifies the screens, components, states and design language of **psyche-desktop** (Electron shell) and **psyche-web** (the same React UI served by the Gateway) *(arch §3)*. The UI renders typed Gateway events deterministically instead of parsing prose *(arch §4.2)*, so Gateway field names are repeated wherever a screen depends on them.

### 1.2 Principles

| # | Principle | In the UI |
| --- | --- | --- |
| 1 | One messaging-like conversation | A persistent main chat plus side chats; light messages; no dashboard chrome. Muse's guiding question: "How would this work if you were talking to another human?" *(muse notes, Q5)*. |
| 2 | Calm | Interrupt only when a result is new or needs input; proactive output lands in Feed, Ideas and the inbox. Muse: messages must be "worth the interruption" *(muse notes, Q5)*. |
| 3 | Progressive disclosure, three levels | Status line under the avatar → the Task's action list → raw tool I/O, cycled with one shortcut everywhere. Muse's emoji → task list → raw logs *(muse notes, Q4)*; Claude's Normal / Thinking / Verbose *(claude notes, Q1)*; *(arch §4.5)*. |
| 4 | Deterministic UI only for approvals and credentials | Approval cards and credential prompts are host-rendered, fixed in structure and button order, never inside a message. Muse: "fixed UI for structured approval cards … and for secure credential storage" *(muse notes, Q4)*; *(arch §4.6)*. |
| 5 | Generative UI with fixed structure | Feed posts, Idea cards, Goal pages and artifact cards keep a fixed element order; the model fills the content. Muse's "generative UI" *(muse notes, Q2)*. |
| 6 | Proactivity is batched and confirmable | Feed is a bounded batch with an end marker; Ideas and inferred Goals need a tap; no external write without an ApprovalRequest *(arch §2, §4.11)*. |
| 7 | Everything the agent knows is a file you can open | `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, daily notes, `interests.md`, skills and the audit log open from the UI *(arch §4.8)*; Muse: "We want you to be able to see the markdown files Muse writes" *(muse notes, Q1)*. |

Two rules apply everywhere. **The client never decides**: the desktop renders ApprovalRequests and relays answers; it holds no secrets and no model keys *(arch §5)*. **Two voices**: the agent speaks as its persona; the application speaks as Psyche (§4.12).

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
| Bottom menu | Settings, Usage, Help | **Psyche decision**: Usage shows the ledger and percent-remaining meter *(arch §4.4)*; Help opens docs, `psyche doctor`, logs |

### 2.2 Thread list

One persistent main chat plus side chats, as in Muse (pencil-and-note icon for a new side chat, three-dot menu per thread) *(muse notes, Q1)* and OpenMuse (rename, archive, restore) *(harness notes, KQ1 1i)*.

| Action | Behaviour |
| --- | --- |
| New side chat (pencil-and-note, ⌘N) | `createdFrom: chat`; titled by the utility model until renamed |
| Fork from a message (⋯ → Continue in a side chat) | Seeded with the transcript up to that message, as Claude's `hand_off_to_session` *(claude notes, Q1)* |
| Rename, search | Click the title; filter field above the list |
| Archive / restore | "Archived (n)" group; the main chat cannot be archived; deletion lives under Data controls because deleting a thread does not delete what was learned (Muse's Help Center says the same *(muse notes, Q4)*) |
| Export (⋯ → Markdown / JSON / HTML) | Tool calls collapsed, receipts included; Claude exposes `export_transcript` |
| Incognito | Memory-only, expires after 24 h *(arch §4.8)*; dashed avatar ring |

Rows show title, last line, time, a status dot for a running or waiting Task, and a channel icon for channel-originated threads.

### 2.3 Agent header and agent sheet

The header holds the avatar and a one-line snippet of current work. Clicking the avatar opens the **agent sheet** with four tabs, matching Muse's four icons behind the avatar (task list most recent first, approvals, upcoming, fingerprint for Soul and memory) *(muse notes, Q1)* and OpenMuse's "tap the avatar to see activity, reviews and receipts" *(harness notes, KQ1 1f)*: **Activity** (§3.14), **Approvals** (§3.15), **Upcoming** (§3.16), **Soul & Memory** (§3.17). Side sheet on wide windows, bottom sheet on narrow ones; each tab is a route.

### 2.4 Panes

Panes sit beside the chat, per thread; they split, resize, pop out and close. The agent drives them through `view.*` RPC, mirroring Claude's `ccd_view` tools *(arch §5; claude notes, Q1)*.

| Pane | Opened by | Spec |
| --- | --- | --- |
| Browser | `browser.*` call, ⌘⇧B, a link | §3.5 |
| Terminal | ⌃`, agent request with approval | §3.6 |
| Files | ⋯ → Files, a path in chat | §3.7 |
| Editor / Diff | A file; a "+12 −1" change indicator | §3.8 |
| Plan | A Plan artifact from plan mode | §3.2 |
| Tasks / Activity | Header, a task chip | §3.14 |
| Subagents | ⋯ → Subagents | View-only transcripts *(arch §4.3)* |
| Artifact | An artifact card | §3.7 |
| VM display | VM mode | §3.23 |

Claude precedent: drag headers to reposition, drag edges to resize, ⌘\ closes, panes pop out *(claude notes, Q1)*. Two panes side by side at ≥ 1440 px, otherwise one with a tab strip; closing a pane never stops a Task.

### 2.5 Palette, quick entry, menu bar, inbox

**⌘K** searches the unified index and lists actions (open a thread or pane, `/model`, `/schedule`, settings) with the Search filters *(arch §4.12)*. **Quick entry** is a floating window on a global hotkey (§3.21). The **menu-bar item** shows status, usage and pending approvals (§3.22) *(arch §5)*. The **notification inbox** is a bell over the durable typed inbox (§3.20) *(arch §4.12)*.

### 2.6 Settings sections

Model & providers, Persona, Connectors, Permissions, Computer use, File access, Devices & nodes, Channels, Credentials, Appearance, Voice & dictation, Data controls, Server & remote access, Usage, About. Muse's documented settings hold Computer use, File system access, Permissions, Devices, Data controls, Connectors, Wallet and Secure store *(muse notes, Q1)*; the rest exist because Psyche is model-agnostic, self-hosted and multi-channel.

### 2.7 Route and screen map

| Route | Screen | Data |
| --- | --- | --- |
| `/chat`, `/chat/:threadId` | Main chat, a thread | `threads.*`, `chat.*` |
| `/chat/:threadId/pane/:paneId` | Pop-out pane | `view.*`, `browser.*`, `sandbox.*` |
| `/search?q=` | Search | `search.*` |
| `/feed`, `/feed/instructions` | Feed; "What should I write about" | `feed.*`, `workspace/interests.md`, `automations.*` |
| `/ideas` | Ideas | `ideas.*` |
| `/goals`, `/goals/:goalId` | Goals list, goal page | `goals.*`, `tasks.*` |
| `/library/:section` | Library | `library.*` |
| `/agent/activity`, `/agent/activity/:taskId` | Activity, task detail | `tasks.*`, `audit.*` |
| `/agent/approvals`, `/agent/upcoming`, `/agent/soul` | Approvals, Upcoming, Soul & Memory | `approvals.*`, `grants.*`, `automations.*`, `memory.*` |
| `/settings/:section` | Settings | `settings.*` + the section's family |
| `/onboarding/:step` | Onboarding | `settings.*`, `connectors.*`, `nodes.*` |
| `/inbox` | Notification inbox | `notifications.*` |
| `/quick`, `/vm` | Quick entry, VM window | desktop only |

---

## 3. Screen-by-screen specifications

### 3.0 Shared states

| State | Rule |
| --- | --- |
| Empty | One sentence in Psyche's voice plus one primary action; no illustration larger than the avatar. |
| Loading | Skeletons in the shape of the content, after 150 ms. |
| Streaming | Text through the sanitizing streaming renderer; plan, approval, question, artifact and receipt blocks arrive as typed events and are inserted whole *(arch §4.2, §5)*; the composer pill becomes Stop. |
| Error | What failed, what Psyche did, one next step. A user-selected model fails visibly rather than falling back *(arch §4.4)*. |
| Offline | Banner: "Psyche can't reach the Gateway on 127.0.0.1:7979. Tasks keep running; this window will reconnect." Composer disabled; after reconnect the client refreshes from `stateVersion` *(arch §11)*; approval cards are stale until re-issued *(arch §4.6)*. |

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

Inventory: rail (56 px), thread list (260 px, ⌘B toggles it as in Claude *(claude notes, Q1)*), chat column (min 480 px, 68ch prose), pane area, optional status bar. Header: avatar with state ring, persona name, status snippet, counters ("2 awaiting you"), permission-mode pill (manual / balanced / auto / plan *(arch §4.6)*, ⌘⇧M), model pill (⌘⇧I), bell, ⋯. The snippet opens the current Task at level 1. In VM mode the header reads "inside VM: <name>".

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
| User message | Right-aligned light bubble (gray-3, radius 16, one 4 px corner). Muse removed heavy bubbles and puts the agent at the top *(muse notes, Q5)*. |
| Agent message | No bubble; 20 px avatar, name and time per run. Out-of-turn thoughts from background Tasks get a divider "from task: <title>" (Muse keeps bubbles for the same reason). |
| System message | Centered, small, gray-11, Psyche's voice. |
| Tool call | Collapsed: icon, verb + target, outcome dot, duration; runs fold into "3 actions · browser, calendar". Level 0 hides rows; level 2 shows raw I/O (128 KB cap), provenance chip, receipt link. ⌃O cycles, as Claude's view modes *(claude notes, Q1)*. Secrets show as `{{cred:name}}` placeholders *(arch §4.7)*. |
| Plan checklist | Pinned under the latest agent message from `update_plan`, one item in progress, distinct from the approved Plan artifact *(arch §4.3)*; Claude pins its list the same way. |
| Approval, question, artifact cards | Approval: never a message, a dock above the composer (§3.3). Question: from `ask_user` (§3.4). Artifact: title, type, thumbnail, Open, Save to Library; artifacts appear in chat and exist outside it *(muse notes, Q4)*. |
| Receipt line | One compact line after every external write with the provider id; uncertain outcomes read "outcome unknown · not retried" *(arch §4.5)*. |
| Follow-up queue | Strip above the composer with mode (steer / followUp / interrupt) and remove *(arch §4.2)*; OpenMuse has "a visible follow-up queue" and "send/stop in one input pill" *(harness notes, KQ1 1c)*. |
| Reply-to quote | Hover → Reply; quote chip in the composer; the sent message carries a two-line quote with a jump link. **Psyche decision**. |
| Wrap-up box, export menu | Recap ≤ 300 chars, one question, 1–2 buttons from `wrap_up` (limits from Claude's tool *(claude notes, Q5)*). ⋯ → Export: Markdown / JSON / HTML with tool I/O and receipt toggles. |

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
| Scope radio | Allow once / Allow for this task / Allow for this site / Always allow (with expiry) / Deny — Muse's exact options *(muse notes, Q4)* — mapped to grant scopes `once`, `task`, `site`, `always`. **Psyche decision**: the `session` scope is an expiry choice under Always allow ("until this session ends", 1 h, 24 h, 30 days, until revoked). "This site" hides when the target has no origin. |
| Default and keys | Deny preselected. Return does nothing; ⌘Return approves with the selected scope; ⌘D denies. OpenClaw's Mac app approves with Command-Return; "Return alone does not approve" *(harness notes, KQ2 2h)*. |
| Countdown, who, why | `expiresAt` − now, default 30 min then denied *(arch §4.5)*, danger color under 60 s. Persona, Task title, `createdFrom`, channel sender; the Broker's reason (mode, side-effect class, taint, matrix rule). |
| Buttons | Deny left, Allow right; disabled for 400 ms after the card appears; never move while visible (**Psyche decision**). |
| Surfaces, states | "Also sent to: iPhone, Telegram"; first answer wins; purchases and credential fills need Touch ID here and `authenticationRequired` on OS notifications. States: pending, answered elsewhere, expired, voided ("arguments changed"), stale after restart. |

Binding details shown in full, by kind: `exec` — argv, cwd, env names, backend, network mode (OpenClaw binds always-allow to argv and cwd *(harness notes, KQ2 2k)*); `email.send`, `messages.*` — exact recipients, subject, body hash with viewer, account (OpenMuse review screens "retain the exact recipient" *(harness notes, KQ1 1f)*); `credential.fill` — item, bound origin, current origin, fields; `purchase` — merchant, amount, line items, payment rail (Muse shows "the exact purchase details each time" *(muse notes, Q4)*); `browser.navigate` on a new origin in a tainted turn — origin, read-only vs read-write; `write_file` / `edit_file` — path and diff summary; `calendar.*` — calendar, exact event, change; `mcp__<server>__<tool>` — server, tool, full argument preview, trust tier, `tools/list` hash *(arch §4.9)*; `node.invoke` — node, app, action, tier.

The card lives in the thread's dock, the Approvals tab, the inbox, OS notifications with Approve / Deny, and chat channels.

### 3.4 Question card

From `ask_user` *(arch §4.3)*, following Claude's `AskUserQuestion`: 1–4 questions, header ≤ 12 characters, 2–4 options with label, description and optional preview, optional multi-select, an "Other" free-text row *(claude notes, Q5)*. Muse's documented clarifications are free text; no source shows chips *(muse notes, Q4)*, so chips are a **Psyche decision**.

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
| Chips vs list | Chips when every label ≤ 24 chars and no option has a description or preview; otherwise a list with a preview disclosure. |
| Recommended first | At most one option per question, listed first with a reason; preselected only for single-select. |
| Multi-select, Other | Checkboxes with "pick any"; free text answers with the text. |
| Preview | Sanitized Markdown or HTML in the artifact sandbox (§3.7). |
| Timeout | None; background input requests wait indefinitely and appear in Upcoming / Activity *(arch §4.5)*. Psyche never auto-submits, unlike Claude's optional idle timer. |
| Keys | 1–9 pick options (Claude uses 1–9 for menu items *(claude notes, Q1)*), Tab between questions, ⌘Return answers. |
| Answered | Collapses to one line per question with Change until the run consumes it. |

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
| Tab strip, highlight | One tab per agent tab; popups and OAuth open as agent tabs; profile name shown. Acted-on elements get a 2 px accent outline for 600 ms. |
| Status pill | Current action in present progressive; "Paused: you have control" during Take control. Muse: "A status pill at the top shows the current action" *(muse notes, Q1)*. |
| Take control | Toggle. On: agent input paused, accent frame border; user interaction turns it on implicitly; release resumes. Muse: "Take control of the browser" to log in or type; the agent pauses when the user takes over *(muse notes, Q1, Q4)*. |
| Stop the task | Cancels the owning Task; authority revoked at once; in-flight requests reconcile by receipt *(arch §4.5)*. Muse's label. |
| Close (x) | Closes the pane only; toast "Browser closed. 'Dentist booking' keeps running; reopen from the task." Muse: "The X closes the display, but the task keeps running". |
| Open in window, Full, ⋯ | Pop out or fill the window; menu: Clear browsing data, Real Chrome mode, Show replay, Copy page as Markdown. |
| Site-permission prompt | "Let Wren act on acme.com?" Allow once / Always allow / Deny; Always allow creates a `site` grant. Claude's per-site card uses the same labels *(claude notes, Q2)*. |
| Credential-fill prompt | On a detected login form or `credentials.request`: "I'll type it myself" (default; turns Take control on and focuses the field), "Fill from vault once", "Fill from vault for this site", "Deny". Vault options need Touch ID and show item, bound origin, current origin; the model sees only the placeholder *(arch §4.7)*. |
| Download toast, CAPTCHA | "Downloaded invoice.pdf (240 KB) to Library → Downloads (quarantined)". A CAPTCHA turns Take control on with the pill "A CAPTCHA needs you"; never attempted. |

States: no tabs, loading, acting, paused, blocked origin (the user may browse, the agent's tools stay off), offline. Secrets are masked in screenshots, page text and replays after a fill.

### 3.6 Terminal pane

```
+----------------------------------------------------------+
| [shell 1] [+]   container - network: none   ~/workspace  |
| (av) $ npm test                                receipt r-110|
| exit 0 - 4.2 s - 2 files changed                          |
+----------------------------------------------------------+
```

xterm over node-pty inside the per-task container, or the host shell only when `exec_host` is on *(arch §5, §9)*. Agent-run commands carry the avatar glyph and a receipt link; user input has none. An approved interactive PTY shows "Wren has the keyboard"; Esc returns it. Receipt strip: exit code, duration, files changed, "stdout capped at 128 KB"; interrupted commands are `uncertain`. ⌃` toggles the pane, as in Claude *(claude notes, Q1)*. No backend: "No sandbox backend is available. Psyche never falls back to the host shell."

### 3.7 Files pane and viewers

```
+---------------+------------------------------------------+
| ~/Documents ro| permission-slip.pdf   12 fields - 2 need you|
| ~/Projects rw |  [page]  Child name  [Ada Lin     ] agent  |
| /workspace    |          Allergies   [            ] you    |
| Library  (1)  |                    [Apply fill] [Discard]  |
+---------------+------------------------------------------+
```

Tree of granted folders (ro / rw), the thread's `/workspace` and the Library, with inline previews *(arch §5)*, as Claude's files pane *(claude notes, Q1)*. An unshared folder shows "Not shared with Wren" and a Share button that raises a folder-grant ApprovalRequest.

| Viewer | Library | UI |
| --- | --- | --- |
| PDF | PDF.js 6, self-hosted worker *(blocks notes, PDF)* | Thumbnails, search, selection. Form-field highlights: AcroForm fields the agent proposes to fill are outlined in accent with values in a side list; the user edits, then Apply writes a filled copy and a receipt (OpenMuse's requested form values → filled copy → reviewed reply pipeline *(harness notes, KQ1 1c)*). |
| Spreadsheet | SheetJS CE + TanStack Table view, Univer edit | Sheet tabs, frozen header; export writes a new file. |
| DOCX, PPTX, images | docx-preview / mammoth; LibreOffice or `qlmanage` thumbnails; native with zoom | Layout / Text toggle; thumbnail grid; masked regions hatched. |
| Code, CSV, JSON | CodeMirror 6 edit, Shiki 4 read | Line comments attach to the next message, as in Claude. |
| Email preview | Sanitized HTML in the artifact sandbox | Remote images blocked until "Load remote images"; provenance `untrusted` *(blocks notes, artifacts)*. |
| Artifacts | `sandbox="allow-scripts"` srcdoc iframe on a separate origin, strict CSP *(arch §5)* | Title, version history, Export, Open in window; postMessage resize; private unless exported *(muse notes, Q4)*. |

### 3.8 Markdown editor

```
| SOUL.md   [Rich | Source | Diff]   6.2k / 20k   Save  Discard |
| # Core truths                                                 |
| - I say what I do not know.                                   |
```

Rich / Source / Diff in one toggle (MDXEditor ships it; CodeMirror 6 is the source editor *(blocks notes, Markdown editors)*). Raw Markdown is canonical; Rich never rewrites untouched lines. Diff compares against the last save, or against the agent's proposed edit when opened from an `edit_file` approval. Save / Discard are explicit, as in Claude's file editor *(claude notes, Q1)*; saving a workspace file posts a system message so the agent's next turn sees it. Persona files show budget meters (20k per file, 60k total, 4k for `USER.md`) *(arch §4.2)*; `MEMORY.md` notes "written nightly by dreaming at 03:00; your edits are merged" *(arch §4.8)*. Code files open in CodeMirror without Rich.

### 3.9 Feed

Bounded daily brief of 5–10 posts plus scheduled briefings *(arch §4.11)*. Muse's Feed: short posts on a schedule, heart and comment, "You control what it writes about" *(muse notes, Q2)*.

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
| Post card | Kind label (briefing, reminder, suggestion, watch result, news cluster), title, body with citation markers, source cluster row with favicons and count, feedback row. Multi-source clusters with citations are the expected presentation *(blocks notes, feeds)*. |
| Feedback | Follow topic, Not interested, Hide source, Like, Save (Discover-style vocabulary); written to the interest ledger at once with an undo toast. |
| Exploration slot, end marker | One or two labelled posts per batch; "That's it for today", a Pulse-style bound. |
| Instructions editor, schedule | "What should I write about" opens `workspace/interests.md` in the Markdown editor (natural language, not a matrix, as Muse's configuration is conversational); briefings are automations edited as in Upcoming. |
| Ask Wren | Opens a side chat seeded with the post. Whether Muse's comment does this is undocumented; **Psyche decision**. |

States: first run ("No brief yet. Generate the first one, or wait until 07:00" — Muse's new accounts may need to generate a first feed *(muse notes, Q1)*), generating (skeletons), per-source failure rows.

### 3.10 Ideas

Cards with evidence, effort and Let's do it / Edit / Dismiss; accepted ideas become Tasks or automations *(arch §4.11)*. Muse: "Tap one and it builds it"; a "Let's do it" popup with a recurring toggle *(muse notes, Q3)*; OpenMuse ideas carry source evidence with edit / accept / dismiss *(harness notes, KQ1 1c)*.

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

Evidence links to the source message, email, goal or memory entry; effort shows minutes and the approvals the plan will need; the recurring toggle creates an automation; Edit opens the brief in a side-chat composer; Dismiss offers Not now / Not interested / Never from this source, feeding the acceptance model. Skill drafts show the proposed `SKILL.md` and stay drafts until approved *(arch §13)*. Batches arrive in scheduled windows.

### 3.11 Goals

Category, milestones, plan, linked Tasks, check-in cadence, watches; inferred goals are candidates for one-tap confirmation *(arch §4.11)*. Muse's Goals tab shows everything tracked with plans per goal, categories such as health, finance, career, relationships and productivity, and deletion via a three-dot menu with confirmation *(muse notes, Q3, Q1)*. No source shows Muse's goal detail view; the page is a **Psyche decision**.

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

List rows show title, next check-in and a milestone progress bar. The plan is an artifact (Muse produced a 24-week marathon plan as a PDF). Check-ins arrive as `reminder` notifications and short agent messages. The confirm card shows "Because:" evidence with Confirm / Not a goal / Later; nothing is created before Confirm. Delete needs a typed confirmation.

### 3.12 Library

```
| Library  [Documents] [Images] [Artifacts] [Downloads (1)] [System files] |
| invoice.pdf  quarantined  from task "Tax letter"  [Open] [Reveal] [Share]|
```

| Section | Contents | Actions |
| --- | --- | --- |
| Documents, Images | Files the agent made or received *(arch §12)* | Open, Reveal, Share and Quick Look via the mac helper, Send to chat; "Set as avatar" for creature renders |
| Artifacts | HTML / React with versions | Open, Update by name, Export |
| Downloads | Quarantined until opened *(arch §5)* | Opening requires a click; "Trust this file" clears the badge |
| System files | `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`, daily notes, `interests.md`, skills, `DREAMS.md`, audit months | Open in editor; audit read-only. Muse's Library has a "System Files" section *(muse notes, Q1)* |

Every item carries a Task chip linking to the action that produced it.

### 3.13 Search

```
| [ in:feed type:pdf from:alice  dentist                    ] |
| THREADS (3)  Dentist booking - "...three slots work..."      |
| MEMORY (1)   2026-10-16 - "prefers morning appointments"  owner|
| LIBRARY (2)  permission-slip.pdf                             |
```

A first-class rail item (Muse's Mac rail has Search *(muse notes, Q1)*) over one index spanning threads, tasks, memory, Library, Feed, Ideas, Goals and indexed connector caches, with typed filters *(arch §4.12)*. Results group by kind with the match in context and a provenance chip (`owner` / `agent` / `untrusted` / `system`) for memory; opening a result lands in the pane it belongs to. Empty: a note that transcript recall (`sessions_search`) is opt-in.

### 3.14 Activity

Tasks most recent first; tap a task to see every action *(muse notes, Q1, Q4)*; each Task has an ordered action log with three disclosure levels *(arch §4.5)*.

```
+--------------------------------------------------------------+
| Activity          [Running 1] [Needs you 2] [All]             |
| * Dentist booking       running - Holding the 2:30 slot       |
| ! Tax letter            awaiting approval - send email        |
| ? Trip to Lisbon        awaiting input - dates                |
|   Price watch           automation - last run NO_REPLY        |
+--------------------------------------------------------------+
| Dentist booking   from chat - 10:02 - attempt 1  [Pause][Cancel]|
| level: [status | actions | raw]                               |
| 10:02 browser  open acme.com/appointments   ok   r-101        |
| 10:05 approval credential.fill acme.com     waiting           |
| Replay 14 frames - Receipts 4 - Evaluator not yet run         |
+--------------------------------------------------------------+
```

Rows: status glyph, title, status text, `createdFrom`, lease owner when remote. Controls: Pause / Resume / Cancel / Retry. Level 0 is the avatar's status line; level 1 the action list with receipt links; level 2 raw I/O, provenance chips and the Broker's decision record. Replay shows screencast frames when retention is on *(arch §8)*; the evaluator line reads done / reopened with gaps / escalated *(arch §4.3)*. Channel requests appear here as Tasks.

### 3.15 Approvals queue

```
| NEEDS YOU (2)   [full approval cards, newest first]              |
| DEFERRED (1)    Price watch wanted to email you - [Run with approval]|
| RECENT          Approved on iPhone - Denied - Expired ...        |
| STANDING GRANTS 14 - [Review in Permissions]                     |
```

Deferred holds approvals that unattended runs could not ask for *(arch §4.3)*. Recent covers 7 days with who answered on which surface; older history is the audit log. Standing grants link to the ledger of `site`, `session` and `always` grants with expiry and use counters *(arch §4.6)*. OpenClaw's Control UI keeps an approvals ledger close to the conversation too *(harness notes, KQ2 2n)*.

### 3.16 Upcoming

Muse's Upcoming holds reminders and scheduled tasks, where recurring tasks are edited *(muse notes, Q1, Q3)*.

```
| Morning brief     weekdays 07:00  main     last: delivered  [Run now][Pause]|
| Subscription audit monthly 1st   isolated last: NO_REPLY   [Edit]          |
| Watch: headphones  every 6 h     price < $200  last: $219  backoff 2x      |
| Reminder: call Sam  Thu 17:00    [Snooze][Done]                             |
| Heartbeat          every 45 min  09:00-21:00  at most one notification      |
```

Rows show the schedule as a sentence, session target (main / isolated / named), delivery target, last outcome including `NO_REPLY`, next run, and Run now / Pause / Edit / Delete / scratch notes *(arch §4.11)*. Watches show condition, last observation and backoff. A banner after sleep: "Your Mac slept through 2 runs; they were coalesced into one at 09:14". The editor offers presets (hourly, daily, weekdays, weekly, manual) and a natural-language field rendered back as a sentence for confirmation.

### 3.17 Soul & Memory

The fingerprint tab *(muse notes, Q1)*: edit the files directly, browse daily notes, search, pause, incognito, import, export, reset *(arch §4.8)*.

```
+--------------------------------------------------------------+
| Soul & Memory                                 [Search memory] |
| FILES  SOUL.md  IDENTITY.md  USER.md  MEMORY.md  AGENTS.md    |
| DAILY  2026-10-18  10-17  10-16 ... [all]                     |
| (editor: Rich | Source | Diff)                                |
| Memory: On [Pause]   Incognito side chat [Start]              |
| Dreaming nightly 03:00 - last diary entry 03:04               |
| [Import memory] [Export everything] [Reset Wren...]           |
+--------------------------------------------------------------+
```

| Element | Spec |
| --- | --- |
| File tabs, daily notes | Markdown editor with budget meters; `IDENTITY.md` fields (name, creature / avatar prompt, vibe, tagline, emoji) also render as a form. Muse's Identity file "sets your Muse's name, creature, vibe or tag line"; all three files can be edited or deleted directly. Daily notes in a calendar strip; flushed entries marked. |
| Memory search | Provenance chips; "Why is this believed?" calls `memory_explain`; "Forget…" stages a retraction through `forget` and lists what else will go. |
| Pause, incognito | Pause stops flushes and dreaming writes and shows a "Memory paused" chip in every thread header; incognito starts a memory-only side chat. |
| Import, export, reset | Imported entries arrive as `untrusted` and are never promoted automatically (Muse offers "Import memory" under Data controls *(muse notes, Q4)*); "Download your data" exports threads, files, memory and the audit log *(arch §4.12)*; Reset needs a typed confirmation and lists which folders go (Muse's "Reset Muse" is irreversible). |

### 3.18 Settings screens

**Model & providers**: provider rows with key status (a vault reference, never the key), roles (primary, fallbacks, utility, embedding, vision, speech), a "tool-calling check" badge ("chat only" when it failed), RAM guidance *(arch §4.4)*. **Persona**: name, creature, vibe / tagline, emoji, avatar preview with "Describe a change" in natural language (Muse's pencil-icon edit *(muse notes, Q5)*) or "Pick from set"; writes `IDENTITY.md`. **Connectors**: directory with trust tiers (bundled / verified / unknown), status, scopes, last used *(arch §4.9)*; connect flows ask read-only vs read-and-act (Muse asks whether to read mail only or also send *(muse notes, Q4)*); Disconnect and Remove are separate, as in Claude *(claude notes, Q6)*.

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

Per-connector action matrices with Allow / Ask / Deny per action, as on Muse's Notion connector screen *(muse notes, Q1, Q4)*; MCP keys shown as `mcp__<server>__<tool>`; a changed `tools/list` hash shows "Grants revoked: tool list changed" *(arch §4.9)*; hard prohibitions listed read-only *(arch §4.6)*.

**Computer use**

```
| Accessibility: granted   Screen Recording: denied [Open System Settings] |
| app          Off  Read only  Read and interact                           |
| Mail         ( )    ( )        (o)        Safari   read-only (fixed)     |
| Notes        ( )    (o)        ( )        Terminal click-only (fixed)    |
| 1Password    Off (fixed)                  Esc stops computer use         |
```

TCC rows with a denied badge; per-app tiers Off / Read only / Read and interact, prompted on first use *(arch §6)*; Muse's Mac apps use the same three values *(muse notes, Q1)*. Fixed caps as locked rows: browsers read-only, terminals and IDEs click-only, password managers and banking Off.

**File access**: folder grants ro / rw; VirtioFS shares in VM mode, read-only by default. **Devices & nodes**: paired devices with scopes, pending pairings with the challenge fingerprint, nodes with capabilities and last seen *(arch §7, §11)*.

**Channels**

```
| Telegram  connected  dmPolicy (o) pairing ( ) allowlist ( ) open ( ) disabled |
|   Pending (2 of 3)  @sam_k  code 48-21  expires 41m   [Approve] [Ignore]     |
|   Allowlist  you (owner), partner     Groups  Family (requireMention on)      |
| iMessage  via Mac node  Full Disk Access granted                              |
| Identity links  Telegram @you = iMessage +1 555.. = owner                     |
| Designated people  Partner (iMessage) - delegated persona, approvals to you   |
```

`dmPolicy: pairing | allowlist | open | disabled`, codes expiring in 1 h with at most 3 pending per channel, group allowlists with `requireMention`, identity links, designated people *(arch §4.10)*; mechanics copied from OpenClaw *(harness notes, KQ2 2f)*. Choosing `open` shows a warning sheet.

**Credentials**

```
| Credentials        storage: Psyche vault (Touch ID) [v]            |
| name          kind     bound to        last used  uses             |
| github-login  login    github.com      2 h ago    14               |
| stripe-link   payment  Link wallet     never      0                |
| [Add item] [Connect 1Password] [Connect Bitwarden]  fill default: once |
```

Vault list with kind, origin binding, last used, use count; backend switch (Psyche vault / system keychain / external manager) *(arch §4.7)*; adding a payment item explains that raw card numbers are refused and only Stripe Link pairing exists; values are never displayed. Muse's settings have a Secure store and a Wallet *(muse notes, Q1)*.

**Appearance**: theme (auto / light / dark), gray family, density, accent picker with a live preview of the generated 12-step scales and the WCAG result for the text steps, reduce motion (§4.8–4.10). **Voice & dictation**: push-to-talk key, toggle mode, system-wide hotkey, engine, output voice; Muse's Mac app dictates while the function key is held *(muse notes, Q1)*. **Data controls**: pause memory, replay retention, transcript recall, export, delete threads, reset; no training toggle because there is no telemetry unless the operator enables it *(arch §2)*, unlike Muse's on-by-default "Help improve our AI models" *(muse notes, Q4)*. **Server & remote access**: bind address, Tailscale / proxy status, passkeys, sandbox backend health, VM controls. **Usage**: tokens by kind, cost estimates, per-thread and per-automation breakdown, percent-remaining meter. **About**: versions, `psyche doctor`, logs.

### 3.19 Onboarding

```
| 1 Meet your agent   2 Permissions   3 Connectors   4 Model   5 Where   6 Done |
| Name [Wren       ]  suggestions: Juno - Moss - Pip   or keep "Psyche"         |
| Creature  [a small grey moth with lantern eyes          ]  (av preview)      |
| Vibe / tagline  [dry, warm, says what it doesn't know     ]                   |
```

| Step | Content |
| --- | --- |
| 1 Meet your agent | Name with suggestions or "Keep 'Psyche'"; creature in natural language or from the bundled set; vibe / tagline. Writes `IDENTITY.md`; `BOOTSTRAP.md` starts *(arch §4.8)*. Muse offers names or keeps "Muse" and lets users style their avatar *(muse notes, Q5)*. |
| 2 Permissions | Accessibility ("lets Wren click, type and use apps"), Screen Recording, Notifications, each Allow / Skip; first app tiers. Muse's wizard asks for both, each skippable *(muse notes, Q1)*. |
| 3 Connectors | One at a time; read-only vs read-and-act; "decide now which accounts to connect" (Muse's Help Center advice *(muse notes, Q4)*). |
| 4 Model & provider | Cloud key or subscription, OpenRouter, or local with RAM guidance; runs the tool-calling check. Muse has no picker *(muse notes, Q0)*. |
| 5 Where Wren works | Local Mac or VM mode with its defaults and what the guest can see *(arch §10)*. |
| 6 Done | Main chat opens with the agent's first message from `BOOTSTRAP.md`. |

### 3.20 Notifications

Kinds: `approval`, `input_needed`, `task_done`, `task_failed`, `proactive`, `briefing`, `reminder` *(arch §4.12)*; Muse's reduce to approval, task finished, proactive suggestion, briefing or reminder *(muse notes, Q4)*.

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
| proactive, briefing | Title and evidence; "Brief ready" | Passive, batched |
| reminder | Text, Done, Snooze | Done, Snooze 1 h |

One notification per Task per state change, de-duplicated; stale ones are marked after a restart; every row deep-links to a route in §2.7.

### 3.21 Quick entry

```
| (av) Wren - idle                            [main chat v] |
| [ Ask or tell Wren...                                ][>] |
| last: "Holding the 2:30 slot" - 1 approval waiting        |
```

Frameless floating window on a global hotkey *(arch §5)*; **Psyche decision**: default ⌥Space, OpenClaw's Quick Chat key *(harness notes, KQ2 2h)*; Claude's quick-entry key is undocumented *(claude notes, Q1)*. Target selector (main chat, new or recent side chat); the reply streams into a collapsed strip with "Open in Psyche"; a pending approval is only a link to the full card.

### 3.22 Menu-bar item

```
| (moth) Wren - working on 1 task         |
| Usage  62% remaining - $0.41 today      |
| Needs you  Send email to jane.ortiz..   |
| Open Psyche  New side chat  Quick entry |
| Pause agent  Stop all tasks             |
| Gateway: running (launchd)              |
```

Template icon with the avatar state; the usage meter mirrors Muse's percent-remaining meter and adds estimated cost *(arch §4.4; muse notes, Q0)*; the Gateway row exists because the window can close while work continues *(arch §2 principle 7)*.

### 3.23 VM window

```
| VM: work-mac   ( > Opening Mail )   [Take control]  [Snapshot v] [Fresh Mac]|
| +----------------------------------------+ Shared: ~/Documents ro          |
| |          guest display                 | Clipboard: on   Guest Gateway ok |
| +----------------------------------------+ Limits: 1 guest, NAT only       |
```

Guest display streamed from the helper with the browser pane's Take control affordance *(arch §5, §10)*; shared folders, clipboard toggle, snapshots with "Fresh Mac" reset; a limits strip (two guests per host, NAT only, no nested virtualization, host logged in with an unlocked keychain). States: creating (IPSW install progress), provisioning, running, saved, error.

### 3.24 Web / server variant and narrow width

psyche-web differs only by capability: the browser pane shows the sidecar's screencast and Take control sends input over CDP; the terminal is a PTY in the sandbox; dictation runs on the Gateway (whisper.cpp) or in the browser; notifications are Web Push without auth-required actions, so purchases and fills are answered in the UI or on a paired Mac; quick entry, menu bar and VM are absent; auth is a paired device or a passkey behind HTTPS *(arch §11)*.

```
| < Dentist booking        (av) Wren   [search] |
|  You: Book the dentist next week               |
|  Wren: Three slots work ...                    |
| +--------------------------------------------+ |
| | Approval needed - fill credential  [Open]  | |
| +--------------------------------------------+ |
| [+] Message Wren...                     [send] |
| [Chat] [Feed] [Ideas] [Goals] [Library]        |
```

Below 720 px the rail becomes a bottom tab bar with Chat, Feed, Ideas, Goals and Library, the five tabs Muse shows on phones *(muse notes, Q1)*; Search moves to the top bar; the thread list is a drawer; the agent sheet is a bottom sheet; panes open full screen one at a time; approval cards pin above the composer; question chips wrap.

---

## 4. Design language

The notes contain no colors, type, spacing, radii, dark-mode behaviour or motion for Muse *(muse notes, Q1, Q5)*; this section is **Psyche's own** except where cited.

### 4.1 Layout grid and breakpoints

| Token | Value |
| --- | --- |
| Base unit | 4 px (`--spacing: 4px`, Tailwind v4 convention *(blocks notes, theming)*); 8 px vertical rhythm |
| Rail / thread list / chat / pane | 56 px / 260 px / min 480 px, prose 68ch / min 360 px, default split 55:45 |
| Breakpoints | compact < 720 (§3.24); medium 720–1079 (icon rail, list as overlay, one pane as a tab below the chat); wide 1080–1439 (one pane beside the chat); x-wide ≥ 1440 (two panes) |
| Minimum window | 900 × 600 |

### 4.2 Typography

System stack `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Inter, system-ui, sans-serif`; psyche-web on Linux self-hosts Inter. Mono: `"SF Mono", Menlo, "JetBrains Mono", ui-monospace`. Scale: body 15/22, small 13/18, caption 12/16, label 11/14 uppercase with +0.04em tracking; h1 24/30, h2 20/26, h3 16/22 at weight 600; mono 13/20 in panes, 12/18 inline. The interface is text-heavy, as reviewers describe Muse *(muse notes, Q5)*; type carries hierarchy, color does not.

### 4.3 Spacing and radius

Spacing 2, 4, 8, 12, 16, 24, 32, 48 px. Radius base `--radius: 10px` (shadcn's 0.625rem default *(blocks notes, theming)*): sm 6, md 8, lg 10, xl 14, full. Cards 10, inputs 8, chips full, user bubble 16 with one 4 px corner, panes 0, avatar full.

### 4.4 Elevation

| Level | Use | Light | Dark |
| --- | --- | --- | --- |
| 0 | Page, panes | gray-1 | gray-1 |
| 1 | Cards, approval dock | gray-2 + 1 px gray-6, no shadow | gray-2 + 1 px gray-6 |
| 2 | Popovers, menus, status pill | gray-1 + shadow 0 4 16 / 12% | gray-3 + 1 px gray-7 |
| 3 | Sheets, dialogs, quick entry (`vibrancy: hud`) | gray-1 + shadow 0 12 40 / 20% | gray-2 + shadow |

### 4.5 Motion

| Element | Spec |
| --- | --- |
| Durations | 120 ms hover and toggles, 200 ms cards, 320 ms sheets and panes; `cubic-bezier(.2,.8,.2,1)` |
| Avatar loops | Idle: breathing scale 1.00–1.02 over 4 s. Working: the creature types on a tiny laptop, two-frame loop at 1.5 Hz (Muse's avatars type on tiny laptops *(muse notes, Q5)*). Needs-you: still, pulsing accent ring 1.2 s, count badge. Error: still, desaturated, danger badge. Paused / incognito: dashed ring. |
| Status pill, cards | 160 ms text crossfade at fixed width; cards enter with fade + 8 px rise 200 ms and exit with fade 120 ms; approval cards enter without rise and never shift layout |
| Plan checklist | Checkbox fill 160 ms; the in-progress item has a moving 1 px underline, 1.6 s loop |
| Reduced motion | `prefers-reduced-motion` or the Appearance switch: loops become static frames, working is shown by pill text and a badge, transitions become 0 ms opacity changes |

### 4.6 Iconography

Lucide, 1.75 px stroke, 16 / 20 / 24. Icons Muse documents keep their meaning *(muse notes, Q1)*:

| Meaning | Lucide | Muse |
| --- | --- | --- |
| Chat / Search / Feed | `message-circle` / `search` / `newspaper` | |
| Ideas | `lightbulb` | light-bulb |
| Goals | `circle-check` | check-mark |
| Library | `library` | media folder |
| Soul & Memory | `fingerprint` | fingerprint |
| Edit persona | `pencil` | pencil |
| New side chat | `square-pen` | pencil-and-note |
| Bottom menu / overflow | `menu` / `ellipsis` | two-bar hamburger / three dots |
| Activity / Approvals / Upcoming | `list-checks` / `shield-check` / `calendar-clock` | |
| Take control / Stop | `hand` / `square` | |
| Open in window / pop out | `external-link` / `picture-in-picture-2` | |
| Receipt / untrusted / incognito | `receipt` / `shield-alert` / `eye-off` | |

### 4.7 The avatar system

| Aspect | Spec |
| --- | --- |
| Default creature | An original pale moth with accent-colored wing spots (the mythological Psyche has wings). Muse's default "Jolly" is cream-colored with beady black eyes *(muse notes, Q5)*; OpenMuse bundles a warm tan capybara *(harness notes, KQ1 1j)*; Psyche copies neither. |
| User-described creature | The onboarding sentence or a later "Describe a change" goes to the configured image model when one exists; otherwise the user picks from 12 bundled SVG creatures. Whether Muse uses an image model is unconfirmed; **Psyche decision**. Prompt and render live in `IDENTITY.md` and `library/images/avatar/` *(arch §4.8)*; the emoji is the fallback on image-less channels. |
| Sizes, states | 20 inline, 28 phone header, 40 desktop header, 64 agent sheet, 160 onboarding. States idle, working, needs-you, error, paused / incognito, offline, derived from Tasks and the Gateway connection, never set by the model. A delegated persona keeps the creature with a distinct ring and the label "delegated" *(arch §4.10)*. |

### 4.8 Color system

| Rule | Spec |
| --- | --- |
| Tokens and scales | OKLCH CSS variables, as shadcn v4 and Tailwind v4 emit them *(blocks notes, theming)*: `--accent-1..12`, `--gray-1..12`, alpha variants, P3 overrides under `@supports`, `--accent-contrast`. Radix semantics: 1–2 backgrounds, 3–5 component states, 6–8 borders and rings, 9–10 solids, 11–12 text. |
| Generation | From the user's seed with the open Radix generator (colorjs.io, bezier easing, APCA-chosen text color), once per appearance; the seed lands on step 9; gray family chosen separately. |
| Appearance | light / dark / auto via `data-theme` and `color-scheme`; auto follows `prefers-color-scheme`. |
| Contrast gate | WCAG 2: step 11 ≥ 4.5:1 and step 12 ≥ 7:1 on step 2; `--accent-contrast` ≥ 4.5:1 on step 9. Failing seeds are nudged in lightness and the picker says so. APCA Lc is advisory only (WCAG 3's method is undecided; the APCA package licence is restrictive). |
| Semantic tokens | `--approval` (amber: dock border, needs-you ring, countdowns), `--danger` (tomato: Deny, destructive, failed), `--success` (grass: receipts, done), `--info` (sky: system messages), `--untrusted` (amber outline on provenance chips). Fixed Radix scales, not seed-derived, so Deny never looks like the brand. Incognito threads replace the accent with gray. |

### 4.9 Component inventory

shadcn/ui v4 on Base UI (the default base since July 2026) with Tailwind v4.3, plus assistant-ui primitives *(blocks notes, UI kits; arch §3.1)*.

| Psyche component | Built from |
| --- | --- |
| Rail, thread list | custom + `Tooltip`, `Badge`, `ScrollArea`, `ContextMenu` |
| Thread, messages, composer | assistant-ui `Thread`, `ThreadList`, `Message`, `Composer` over an AG-UI / data-stream runtime bound to `chat.*` events |
| Tool call rows, plan checklist, receipt line | `Collapsible`, `Badge`, read-only `Checkbox`, `HoverCard` |
| Approval card | `Card`, `RadioGroup`, `Select` (expiry), `Button`, `Progress` (countdown) |
| Question card | `Card`, `ToggleGroup` (chips), `RadioGroup` / `Checkbox`, `Input` (Other) |
| Agent sheet, panes, palette, toasts | `Sheet` / `Drawer`, `Tabs`, `react-resizable-panels`, `Command` (cmdk), `Sonner` |
| Settings and matrices | `Form`, `Switch`, `Select`, `Slider`, `Table` (TanStack); custom accent picker with `Popover` |
| Editor and viewers | MDXEditor over CodeMirror 6; PDF.js 6, SheetJS + TanStack Table, Univer, docx-preview, Shiki, sandboxed iframe |

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

shadcn names are mapped once and never regenerated: `--primary: var(--accent-9)`, `--primary-foreground: var(--accent-contrast)`, `--ring: var(--accent-8)`, `--accent: var(--accent-3)`, `--border: var(--gray-6)`, `--foreground: var(--gray-12)`, `--muted-foreground: var(--gray-11)` *(blocks notes, theming)*. `@theme inline` exposes the scales as Tailwind utilities; `@property` registers the solid steps so an accent change animates in 200 ms (0 ms under reduced motion); density sets `--spacing` to 3.5 or 4 px and shifts the type scale one step. The theme is per owner and served identically to psyche-web.

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
| ⌘⇧B / ⌘⇧D | Browser pane / Diff pane |
| ⌘⇧M / ⌘⇧I | Permission mode / model picker |
| ⌃` | Terminal pane |
| ⌘⇧A / ⌘⇧P † | Agent sheet → Activity / Approvals |
| ⌘\ | Close focused pane |
| ⌘/ | Shortcut list |
| 1–9 | Select a menu or question option |
| ⌘Return | Approve with selected scope; answer a question; submit a line comment |
| ⌘D † | Deny the focused approval |
| ⌥Space † | Quick entry (global) |
| Hold fn † | Push-to-talk dictation; Muse dictates while the function key is held *(muse notes, Q1)* |

Focus: a new approval card moves focus to its heading and announces through a polite live region unless the user is typing; closing a pane returns focus to its opener; sheets trap focus. Screen readers: approval cards are `role="group"` labelled by the summary and described by the binding rows; the scope radio is labelled "How long should this be allowed?"; the status pill is `aria-live="polite"`; avatar state is also text ("Wren is working"). High contrast (OS or Appearance): borders step 8, text step 12, 2 px solid focus rings, semantic colors at step 11 on step 2.

### 4.12 Copywriting voice

| Rule | Example |
| --- | --- |
| Short, specific, second person | "Wren needs your login for acme.com", not "Credentials are required to proceed." |
| The agent speaks as the persona | Agent messages use the persona's name and the Soul's tone; the agent never calls itself Psyche. |
| System UI speaks as Psyche | Banners, settings, errors, empty states: "Psyche can't reach the Gateway." The persona appears only as the subject ("Wren will open pages here"). |
| Approval summaries name the exact target | "Send an email to jane.ortiz@example.com"; "Run `npm install` in ~/Projects/psyche"; "Fill github-login on github.com". |
| Errors: what happened, what Psyche did, what you can do | "The model returned an error (rate limited). Psyche did not fall back because you chose this model. Try again or pick another." |
| No exclamation marks, no "Oops", no system apologies; receipts are facts; proactive items carry a "Because:" line | |

### 4.13 Empty and error states

| Screen | Empty | Typical error |
| --- | --- | --- |
| Main chat | The agent's first message from `BOOTSTRAP.md` | Model error with provider and model ref; Retry, Change model |
| Feed / Ideas / Goals | "No brief yet…"; "Ideas come from your goals, conversations and connected accounts."; "Tell Wren a goal in chat, or add one here." | Per-source failures; "The nightly job didn't run (Mac was asleep). Next: 06:00."; watch backoff |
| Activity / Approvals / Upcoming | "No tasks yet."; "Nothing needs you."; "No automations. Create one with /schedule or from an Idea." | "Resumed on another worker"; stale card after restart; coalesced-runs banner |
| Browser / Terminal / Library | "Wren will open pages here when a task needs the web."; "Press ⌃` to open a shell."; "Files Wren makes or receives appear here." | Blocked origin; no sandbox backend, never a host fallback; quarantined file needs "Trust this file" |

---

## 5. Where Psyche deliberately differs

| Topic | Muse | Claude desktop | Psyche | Why |
| --- | --- | --- | --- | --- |
| Where approvals appear | Sentinel delivers them in the client UI, "not via their conversation", though one guide says "in chat or by notification" *(muse notes, Q4)* | Permission cards in the transcript area *(claude notes, Q5)* | Always outside the message stream: dock, Approvals tab, inbox, OS notifications, channels | Principle 4; a card that scrolls away is missed or mistaken for model text |
| Receipts | An audit trail exists *(muse notes, Q4)* | No receipt line in chat | A visible receipt line after every external write | *(arch §2 principle 4)*; OpenMuse's review → receipt contract *(harness notes, KQ1 1f, 1g)* |
| Credential fill | A client UI captures the password into secure storage *(muse notes, Q4)* | 1Password fills in Chrome; the agent refuses to type secrets *(claude notes, Q2, Q3)* | "I'll type it myself" is the default; vault fill is opt-in per fill or per site | "Log in yourself" before "fill from vault" *(arch §4.7)* |
| Search | A Mac rail item *(muse notes, Q1)* | Transcript search and a palette *(claude notes, Q1)* | First-class rail item over one index | One index makes "everything is a file" usable *(arch §4.12)* |
| Model choice | One model, no picker *(muse notes, Q0)* | Model and effort pickers *(claude notes, Q1)* | Per-thread picker; strict failure, no silent fallback | Model-agnostic *(arch §4.4)* |
| Side chats | Persistent *(muse notes, Q1)* | Side chat "isn't saved to disk" *(claude notes, Q1)* | Persistent and forkable; incognito is the explicit ephemeral option | Privacy is a choice, not a default loss |
| Feed cadence | Undocumented *(muse notes, Q2)* | No feed | 5–10 posts, end marker, labelled exploration | Anti-doomscroll default *(blocks notes, feeds)* |
| Inferred goals | Infers goals "not said out loud" *(muse notes, Q3)* | None | Candidates needing a tap | *(arch §2 principle 10)* |
| Training and telemetry | "Help improve our AI models" on by default *(muse notes, Q4)* | n/a | No toggle, no telemetry unless enabled | Nothing to send *(arch §2 principle 9)* |
| Take control | Explicit control *(muse notes, Q1)* | Implicit; none documented *(claude notes, Q2)* | Implicit on interaction plus an explicit toggle with a visible paused state | The user should see whose keyboard it is |
| Gateway lifetime | Cloud VM continues when the app closes *(muse notes, Q4)* | Local sessions need the app open *(claude notes, Q4)* | Menu-bar item shows the Gateway running after the window closes; usage shown as percent and cost | *(arch §2 principle 7)*; OpenClaw's Gateway pattern *(harness notes, KQ2 2h)* |

---

## 6. Open questions and gaps

Undocumented in the sources, so Psyche defines its own:

- Muse's exact colors, typography, spacing, radii, dark mode and motion are described nowhere; Meta's screenshots are uncaptioned *(muse notes, Q1, Q5)*. Section 4 is Psyche's.
- Muse's clarifying questions appear only as free text; no source shows chips *(muse notes, Q4)*. §3.4 follows Claude's `AskUserQuestion` schema *(claude notes, Q5)* plus Psyche's chip rule.
- Muse's approval card visuals, Goals detail view, check-in rendering, inferred-goal acceptance, Feed post schema and cadence, whether a Feed comment opens a side chat, the avatar creation flow, and the iPad and WhatsApp layouts are undocumented *(muse notes, Q1–Q5)*.
- Claude's chat conversation controls (branching, export, reply-to) were not retrievable, the plan pane's rendering is inferred, and the quick-entry hotkey is undocumented *(claude notes, Q1, Q5)*.

Decisions the architecture document should reflect or confirm:

1. The `session` grant scope is an expiry choice under "Always allow"; the Broker should accept `{scope: "always", expiresAt: <session end>}` or map it to `session`.
2. Approval buttons are disabled for 400 ms after a card appears; the Gateway should reject answers that arrive sooner for a given `id`.
3. `ask_user` carries no timeout; background input requests wait indefinitely.
4. `threads.*` needs `fork {threadId, messageId}`, and `threads.list` should return activity counts (running / awaiting input / awaiting approval).
5. Receipts need a short client-visible id and a provider id string; notifications need a `route` field for deep links.
6. A `settings.changed` event carrying appearance settings is required so every paired client re-themes.
7. The default quick-entry hotkey ⌥Space may conflict with other utilities; onboarding should detect this and offer ⌃⌥Space.
8. The ranking job must mark which Feed posts came from exploration slots.

Open for the design itself: how to show subagents in the chat column without noise; whether the terminal pane belongs in the narrow web layout; whether the delegated-persona ring is enough to keep an owner's and a designated person's threads apart; the bundled creature set's art direction; the keyboard map on non-US layouts; and whether to adopt the shadcn-hosted AI Elements components once the standalone registry is deprecated at the end of November 2026 *(blocks notes, UI kits)*.
