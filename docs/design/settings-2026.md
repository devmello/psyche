# Settings 2026: Essentials first, one home per setting

Status: §1–6 built in #1113 (`claude/settings-2026`); §7 in the stacked `claude/settings-essentials`
PR, 2026-11-02. Owner asleep; decisions below are the session's own and easy to revisit.

## 1. What was wrong

Settings had grown to **25 flat sections** in five sidebar groups. An inventory of every control
(about 140 labelled keys plus RPC-backed controls) found the same concept in several places:

| Concept | Where it appeared | Keys / calls |
|---|---|---|
| Search sources and search settings | At the bottom of *Model & providers*, far from the sources; *Everything memory* had its own source list that only works for sources Search indexes | `search.*`, `search.sources`, `memory.everything.sources` |
| Shared folders | *File access* (editor), *Connectors → Files on this Mac* (second editor), *Permissions → Folders* (read-only copy) | `permissions.policy.folders` |
| Run commands on this Mac | *File access* and *Connectors → Terminal* (same switch twice) | `permissions.policy.exec.execHostEnabled` |
| Export | *Data controls → Export everything* and *People & projects → Export* (same `memory.export` call) | `memory.export` |
| Memory switches | Pause memory, transcript recall, recall mode and Learning sat in *Data controls*, away from the memory sections | `memory.recall.mode`, `data.transcriptRecall`, `teaching.*` |
| Dangerous actions | Delete threads and Reset memory sat between ordinary groups | `threads.delete`, `memory.reset` |

The sidebar search only matched section names and 103 of 138 labelled keys (35 keys, including all
`search.*`, `ui.*`, `teaching.*`, `screenAsk.*` and `widgets.*`, found no section), and it could
only open a section, not the setting.

The full inventory (per-section control tables, every overlap, controls without a one-line
explanation, every deep link) is kept with the session notes; the table above is the part that
drove changes.

## 2. The new structure

Nine pages, ordered by how often people need them. Each page is a column of **panes**; a pane is
one of the old sections, kept whole, so its settings, stories and tests stay where they were.

| Page (`/settings/<id>`) | Panes, in order (each also a route) |
|---|---|
| **General** `general` | Appearance `appearance` · Persona `persona` · Notifications `notifications` · Voice & dictation `voice` |
| **Models** `model` | Model & providers `model` · Usage `usage` |
| **Connectors & sources** `connectors` | Connectors `connectors` · Search `search` (new) · Mail & meetings `mail` · Channels `channels` |
| **Memory** `memory` | Memory review `memory` · Remembering & learning `learning` (new) · Everything memory `everything` · People & projects `people` |
| **Routines & skills** `daily` | Daily `daily` · Skills `skills` · Specialists `specialists` |
| **Permissions** `permissions` | Approval rules `permissions` · Computer use `computer-use` · Browser `browser` · File access `files` · Credentials `credentials` · VM mode `vm` |
| **Privacy & data** `data` | Privacy & data `data` |
| **Devices** `devices` | Devices & nodes `devices` · Server & remote access `server` |
| **About** `about` | About `about` |

- A page's id is its first pane's id where it has one, so `/settings/model` opens the top of
  Models either way. Only `general`, `search` and `learning` are new ids
  (`APP_SETTINGS_SECTIONS` in `packages/protocol/src/app-routes.ts`).
- **Every old id still works.** `/settings/files` opens Permissions scrolled to File access;
  `/settings/people` opens Memory at People & projects. Unknown ids open General (was Models).
  `/settings/mcp` and `/settings/connectors/{mcp,add-mcp}` behave as before.
- The shell's `sections` override is keyed by **pane** id, so the composed app's overrides
  (File access with a native picker, Data with Backups, About with logs…) keep working unchanged.
- The sidebar lists the nine pages; the open page lists its panes under it (the one at the top of
  the content is marked as you scroll). Choosing a pane scrolls to it and puts its id in the URL.

Heading levels: the page title is the h2 in the display serif (24 px); a pane on a multi-pane page
is an h3 in the serif at 20 px with a hairline above it; groups step down to h4. Single-pane pages
(Privacy & data, About) keep the pane as the h2.

## 3. Decisions on the duplicates

1. **Search has one home**: *Connectors & sources → Search* holds Search sources, Semantic search
   (with re-rank, query reading, encrypt the index) and Web search. Removed from Model & providers.
2. **Everything memory sources stay** (they are a distinct choice: what Psyche *learns facts from*),
   but each one Search does not index now says "Search doesn't index this yet, so there is nothing
   to learn from" with **Turn on in Search**, which opens `/settings/search`. The nightly pass only
   reads the index (everything-memory-2026 §5), so this makes the dependency visible instead of
   showing two unrelated lists.
3. **Folders and Run commands have one editor**: *Permissions → File access*. Connectors' *Files on
   this Mac* and *Terminal* cards stay (people look for them there; `find_capability` points there)
   but now show the shared folders and whether running commands is on, with **Open File access**.
   The read-only Folders group in Approval rules is gone (File access is on the same page).
4. **One export**: *Privacy & data → Export everything* (it already includes `graph.json` and the
   cards). People & projects says so and links there.
5. **Memory switches live on the Memory page**: a new *Remembering & learning* pane holds Pause
   memory, Transcript recall, How memory is recalled and Learning. Privacy & data keeps retention
   ("How long things are kept"), Maps, Widgets in chat and Export.
6. **Dangerous actions are separate**: Privacy & data ends with a **Delete and start over** section
   under a hairline (Delete threads, Reset memory). Typed confirmation is unchanged.
7. **Permissions pane renamed "Approval rules"** so the page and its first pane don't share a name.
8. The **encrypt-memory switch stays hidden** (EM9b); the panel can still render it, and the
   connected section still passes no `store`.

Also fixed while in there: the **Relationship nudges** group (#1098) was passed to People &
projects but never rendered; it now shows. Stale prose ("Settings → Data", "Devices & nodes",
"Semantic search under Model & providers"…) names the new paths.

## 4. Search inside Settings

Type in **Search settings**: results replace the sidebar and list pages, panes and single settings
(every labelled key, by its plain label), each with where it opens ("Connectors & sources ›
Search"). Every word must match; labels starting with the query rank first. Return opens the
first result, Escape clears. Opening a setting scrolls its row to the middle and tints it briefly
(no tint under Reduce motion). Rows are found by `data-setting-key`, which the shared
`SwitchField`, `RadioField` and `TextSetting` now set from their `settingKey`. A unit test fails
when a labelled key has no pane (`paneForKey`).

## 5. Not changed, on purpose

- **Keys and RPCs**: no key was renamed, moved or migrated; only where the UI shows them.
- **Quiet hours** exist twice by design: `notifications.quietHours.*` (when Psyche may interrupt)
  and Everything memory's schedule quiet hours (when the nightly pass may run). Different
  meanings; left as is.
- **Follow-ups** in Daily and Mail are different jobs (promises from everything vs unanswered
  mail). Kept; both are one page apart.
- **Per-connector permissions** are set in Approval rules (most connectors) and on Apple
  connectors' cards in Connectors. Merging them needs a design for the Apple capability cards.

## 6. Follow-ups found by the inventory (resolved)

Fixed in the follow-up PR ("every Settings button does something, or is gone"):

- **Dead buttons.** The composed app passed none of `usage`, `server`, `onRunDoctor`,
  `onExportReady`, `onDisconnect`, `onRemove`, `onReconnect`. Each section now reaches the Gateway
  itself when the shell gives nothing: Connectors call `connectors.disconnect`, resume the sign-in
  for **Sign in again**, and remove a custom connector (`connectors.removeCustom`; other kinds have
  no remove, so their rows don't offer it). Usage reads `usage.summary` (this month, today, the
  last 7 days by model). Server builds its status from the bind setting, `passkeys.list` and
  `sandbox.status`, says plainly that remote-access status isn't reported, and **Set up** opens the
  remote-access guide. About's **Run checks** runs real checks (Gateway answers, a model is picked,
  the sandbox is available, memory isn't paused). **Export everything** saves the zip as a
  download when the shell has no save of its own.
- **Desktop add-MCP link.** The Settings window keeps a view (`connectors/add-mcp`), and opens on
  Essentials by default.
- **Keys nothing read.** `permissions.mode` is now read: a new thread starts in the owner's default
  mode (`auto` only with an allowlisted model, else balanced). The rest had no reader anywhere, so
  their controls are gone rather than left as switches that do nothing: vault storage and fill
  default (Credentials), transcript recall (Memory), the Image model role (and Persona's "redrawn"
  claim that relied on it), the backup schedule (Backups), VM shares (Access), VM clipboard and
  credentials (VM mode), and Server's VM start/stop (no Gateway method; VM mode is that pane).
  The keys stay in the protocol; a control comes back when its reader exists.

Still open: quiet hours twice (different meanings, §5), and about 75 controls explained only by
their group's description.

## 7. Essentials, safe defaults, and access by asking

The owner's direction (2026-11-02): "The entire app needs to be cleaned up, simple, intuitive, but
still powerful. It cannot be so confusing that people don't even know what to do for beginners,
yet it should offer so much capability that people who are advanced can adjust settings on their
own. If this means changing some settings to be by default toggled, and having an easy section for
settings at the top while allowing you to still modify everything individually, do that. But things
like adding access to files is complicated to do through settings. The models should just be able
to request access and that should just remember and always work depending on what type of
permission they give."

**Essentials** (`/settings/essentials`) is the first page and where Settings opens; an unknown id
also lands there. It holds the five choices a newcomer makes, each written to the same key or call
as its detailed pane, with **More** opening that pane:

| Group | What it changes | Default |
|---|---|---|
| Model | shows the primary model and whether its provider answers; **Set up a model** (amber, the page's one filled button) when none | none until set up |
| What Psyche may read | Mail, Messages, Notes, Calendar, Reminders, Files (`search.sources.configure`) | all off |
| How often Psyche asks first | `permissions.mode` (Balanced, Manual, Auto) | Balanced |
| When Psyche may interrupt you | Quiet hours (`notifications.quietHours.enabled`), Morning brief (`daily.brief.enabled`) | quiet hours **on**, brief off |
| Memory | Let Psyche remember our chats (`memory.pause`) | on |

Nothing on Essentials is its only home: power users change everything, and more, in the pages
below. Essentials repeats a setting on purpose (a shortcut), which is the one exception to "one home
per setting"; each row writes the same key, so the two can never disagree.

**Defaults changed.** Only one, where it is clearly safe: **quiet hours are on by default**,
22:00–08:00 (`NOTIFICATION_SETTING_DEFAULTS`, read by `quietHoursFromSettings`). Notifications in
that window wait in the inbox; approvals marked time-sensitive still come through. An owner who set
the switch keeps their choice (only an unset key reads the default). Considered and left as they
are: search sources (reading mail or messages must be the owner's choice), the morning brief (it
costs model calls), semantic search (it downloads a model and uses RAM, which the owner prefers to
keep low), and anything touching taint, credential entry or the financial and destructive floors.

**Access by asking.** #1111 made "the agent asks, you answer once, it is remembered" the main path
(`request_folder_access` and the approval scopes, kept in the broker) and added `access.list` /
`access.revoke`. Settings now follows it: the File access pane is renamed **Access** and opens with
**What Psyche can reach**, one list of every shared folder and standing grant, each marked
**Always**, **This chat** or **For now** (folders also read only or read and write, changeable for
the always-kept ones), with **Revoke**. Adding a folder by hand moved under a folded **Add a folder
yourself** (a typed path, or the Mac's folder chooser), described as usually not needed. Run
commands on this Mac and VM shares stay below it. The route id stays `files`, so old links work.

**Model for search** (Search pane, from #1115): `search.model.engine`, **Your utility model**
(default, unchanged) or **Apple on-device model**, shown only when `models.appleStatus` reports a
connected Mac helper. Its status reads Ready on this Mac, Needs Apple Intelligence (amber only
when it is the chosen model), Getting ready, or Not available on this Mac (then it can't be
chosen). Switching the jobs off stays with their own switches under Semantic search, so there is
no third "off" choice here.

Not changed here: the Grants ledger in Approval rules stays as the history (with use counts and
revoked grants); the current list lives in Access.
