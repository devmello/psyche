# Fewer places: consolidating the app (2026)

Status: decided 2026-11-02 (overnight, owner asleep; decisions are recorded in §6 so they can be
reversed one by one). Keeps the ink direction (`docs/design/redesign-2026.md`, the unslop and
polish passes merged in #1038–#1105).

## 1. The problem

The owner's words: "There is so much going on … there are lot of small features which get big
pages, but in reality can be combined into a dashboard … Like the search just working and being
command K is intuitive and easy." Psyche's founding principle is that it is simple and just
works, and the sidebar no longer says that.

Today the sidebar has **ten** destinations (six always shown, four under a folded **More**),
plus Settings, plus the agent sheet, plus pages only the palette reaches. Each feature that
shipped got its own page, even when that page holds three cards.

## 2. Audit (what exists, 2026-11-02)

| Destination | Route | What it is | Who uses it | Verdict |
| --- | --- | --- | --- | --- |
| Chat | `/chat[/<id>]` | The main thread and side chats; the agent sheet opens over it | Everything | **Keep, top level** |
| Inbox | `/inbox` | Notifications: needs-you first (approvals, questions), then today, earlier | Gateway writes `Notification.route`; the bell in the chat header opens it | Small. The needs-you part is what matters day to day. **Needs-you → Home; the full list stays as a page** |
| Search | `/search` | The ⌘K surface at full height | The palette is the same surface | Duplicate of ⌘K. **Sidebar row opens ⌘K; page stays for deep links** |
| Feed | `/feed`, `/feed/instructions` | The daily brief: a bounded list of posts with an end marker | `feed.list` / `feed.mark_read` / `feed.explain` agent tools, morning brief routine | Core content, but it is "today", not a place. **→ Home "Today" section** |
| Ideas | `/ideas` | Proposed things to do (usually 0–5 cards) | `ideas.*` tools, ideas routine, notifications link `/ideas` | Thin page. **→ Home "Suggestions" section** |
| Goals | `/goals[/<id>]` | Tracked goals by category, inferred-goal cards, a goal page with milestones | `goals.*` tools | List is thin; the goal page is real. **List → Home "Goals" section; `/goals/<id>` page stays** |
| Scheduled | `/scheduled[?tab=runs]` | Automations and Psyche's routines; Runs tab | `automations.*`, `scheduled.*` | Real management page. **Off the sidebar; reached from Home "Coming up", each automation, ⌘K** |
| Library | `/library/<section>` | Documents, images, artifacts, downloads, system | Files tools | **Keep, top level** |
| Memory | `/agent/soul` (agent sheet tab) | Persona files, notes, people & projects, daily notes, memory controls | Memory tools | People were buried here. **People → own page; the rest stays in the sheet** |
| Overview | `/overview[/run/<id>]` | "{persona} & you": summary ledger, Now & next, activity chart, growth, people map, built for you, specialists, Upcoming, Recent runs, pinned widgets | Run Timeline links, notification routes `/overview/run/<id>` | A good stats page, but it also held the actionable bits (Upcoming, pinned widgets). **Actionable bits → Home; the page stays as "{persona} & you", off the sidebar** |
| What can you do? | `/can-do` | Capabilities | Gear menu, palette | Keep where it is |
| Settings | `/settings/<section>` | Owned by `settings-redesign` | — | Not touched here |
| Agent sheet | `/agent/approvals`, `/agent/soul` | Approvals and Soul & Memory beside the chat | Avatar, ⌘⇧P | Keep |
| Relationship nudges | (no page) | Feed cards and a row on the person page | `nudges.*` | **Also a Home "Keep in touch" card and a section on People** |
| Pinned widgets | (top of Overview) | Up to 6 live widgets pinned from chats | `widgets.pin` | **→ top of Home** |

Nothing the agent relies on loses data or a protocol method: every change below is in the UI.
`feed.*`, `ideas.*`, `goals.*`, `nudges.*`, `notifications.*`, `scheduled.*` and `widgets.*`
stay exactly as they are.

## 3. The target

Five places, and ⌘K for everything:

```
Search            ⌘K   (opens the palette; it is not a page)
Chat              ⌘1
Home              ⌘2   amber count = things that need you
Library           ⌘3
Memory            ⌘4   (was People; see the note below)
──────────
Threads …
──────────
persona · gear (What can you do?, Settings ⌘,, Usage, Help)
```

The compact tab bar (under 720 px) has the same four: Chat, Home, Library, Memory; Search is in
the top bar.

> **2026-11-02, later:** the fourth place is **Memory** (`/memory`), which took People's row and
> keeps its page as the People chip. `/people*` and `/agent/soul?entity=` show Memory in place, and
> the agent sheet's tab is now **Soul**. Still five places, still ⌘4
> ([memory-everything-2026.md](memory-everything-2026.md) §6, built as MW1).

### 3.1 Home (`/home`)

> The layout below (two columns of framed cards) is superseded by [home-2026.md](home-2026.md): one
> column, ruled sections, purpose lines, short lists. What Home answers is unchanged.

One page that answers "what needs me, and what is coming". Title **Home** in the display serif,
the date as meta. Sections are framed cards (the Overview's `Card` variant), and a card that has
nothing to say is not drawn, so a quiet day is a short page.

Wide (≥ 960 px of content): two columns, a reading column and a 320 px side column.

| Main column | Side column |
| --- | --- |
| **Needs you** (approvals and questions, amber; "All notifications" → `/inbox`) | **Coming up** (next runs; "Scheduled" → `/scheduled`) |
| **Pinned** widgets | **Goals** (tracked goals as rows; "Add a goal", rows open `/goals/<id>`) |
| **Today** (the daily brief's posts; Instructions, Schedule) | **Keep in touch** (up to three nudges) |
| **Suggestions** (ideas and inferred goals) | **{persona} & you** (one line and a link to `/overview`) |

Narrow: one column in the order above, main column first.

Rules: one accent per view (the primary action of the first card that has one); amber only for
Needs you; no new chart; every card reuses the component its old page used, so the behaviour
(accept an idea, confirm a goal, answer an approval, like a post) is the same code.

### 3.2 People (`/people`)

The People & projects list that lived in Soul & Memory (search, People / Projects /
Suggestions / Waiting on), at page width, with **Keep in touch** above it when nudges are on.
`/people?entity=<id>` opens a person's card. Soul & Memory keeps a row that opens People.

### 3.3 ⌘K is the way in

The palette already searches everything. It now also lists every page (including the ones off
the sidebar: Scheduled, Notifications, Goals, {persona} & you, full Search, Soul & Memory) and the
common actions: New chat, New incognito chat, New automation, Add a goal, Feed instructions,
Scheduled runs, Approvals, Memory review, every Settings and Library section. Typing a page's
old name ("feed", "ideas", "inbox", "overview") finds its new home through the keywords.

### 3.4 Old links keep working

| Old | Goes to |
| --- | --- |
| `/feed`, `/feed/<id>` | `/home#today` (shown in place) |
| `/feed/instructions` | `/home/instructions` (Home with the brief's instructions sheet open) |
| `/ideas` | `/home#suggestions` (shown in place) |
| `/agent/upcoming` (already redirected) | `/home#coming-up` |
| `/agent/soul?entity=<id>` | `/people?entity=<id>` |
| `/inbox`, `/goals[/<id>]`, `/scheduled`, `/search`, `/overview[...]` | unchanged (pages, just off the sidebar) |

`app_navigate` (`packages/protocol/src/app-routes.ts`) gains `/home` and `/people` and keeps
every old route, so a model that learned the old names still opens the right thing.

## 4. What goes away

- The sidebar's **More** group and its remembered open state.
- The Ideas page (`IdeasView` stays as the Home section's body).
- The Feed page as a destination (`FeedView` stays as the Home section's body).
- Upcoming and Pinned on the Overview (they are on Home now; the Overview links there).
- People & projects inside Soul & Memory (a row that opens People instead).
- ⌘5 and ⌘6.

## 5. Delivery

1. **Home and People** (#1109): this doc, `app-routes.ts`, the two pages composed from existing
   components, ⌘K entries, the app guide. Mergeable alone: the old pages still exist.
2. **Navigation** (after `shell-chrome`'s #1107, which rewrote the sidebar): the five places, the
   Search row, the tab bar, ⌘1–⌘4, the old routes in §3.4 shown in place, the Overview losing
   Upcoming and Pinned, ⌘K listing every page plus New automation and Add a goal
   (`/goals?add=1`), "Pin to Home", copy that said "in the Feed", and the app guide.
3. **Cleanup**: the Ideas page and the Feed page layout, unused rail message ids, stories, and
   the visual baselines that changed.

How an old route is handled: `legacyRedirect` (`packages/ui/src/home/redirects.ts`) maps it,
and the shell renders the new place for it **in place** instead of navigating. Navigating would
push history, and Back would land on the old route and bounce forward again.

## 6. Decisions (and why)

1. **Chat stays the landing page; Home is ⌘2.** Psyche is a chat-first agent and the main thread
   is what people open it for. Home is one keystroke away and carries the amber count, so needs-
   you items are never missed.
2. **"Home", not "For you" or "Today".** One plain word that every app uses; "Today" undersells
   goals and people, "For you" reads like a feed.
3. **Feed becomes a section, Inbox stays a page.** The brief is today's content and belongs on
   the dashboard. Notifications are a history (and the target of OS notifications), so the full
   list keeps a page; only what needs you is on Home.
4. **The Overview stays a page, renamed nowhere.** It is the one rich chart and the run
   Timelines (`/overview/run/<id>` is in notifications and the protocol), so moving it would
   break the most links for the least gain. It is "{persona} & you", linked from Home.
5. **Scheduled and Goals stay as pages, off the sidebar.** They are management screens with real
   depth (run history, milestones). Home shows their next step; the page is one click away.
6. **People is top level, Memory is not.** People are what the owner looks up; the persona files
   and memory controls are tuning, and the avatar, Settings → Memory review and ⌘K reach them.
7. **Search is not a page in the sidebar.** The row opens ⌘K, which is the same surface.
   `/search` remains for links and "open in full search".
8. **No protocol or gateway change** beyond allowing `/home` and `/people` in `app_navigate`.
   Old notification routes (`/ideas`, `/feed`) redirect in the UI, so the Gateway can keep
   writing them; switching the Gateway to the new routes is a later, optional tidy-up.
9. **Old routes render in place, the URL is not rewritten.** `/feed` stays in the address bar
   while Home shows; the sidebar marks Home. This keeps Back working and costs nothing, since
   nothing reads the URL back except the router.
10. **Pages off the sidebar keep Home marked** (`destinationFor`): Scheduled, Notifications,
    Goals and the Overview are all reached from a Home section, so the selection says where you
    came from. Search and Settings mark nothing.
11. **One accent on Home**: the first Approve when something waits on you, otherwise the first
    idea's Do it. Inferred goals and nudges use outline buttons on Home (their own pages keep
    the accent), and Home's sidebar count is amber, the only count the sidebar shows now.

## 7. Simple first, powerful one step away

The owner, 2026-11-02: "The entire app needs to be cleaned up, simple, intuitive, but still
powerful. It cannot be so confusing that people don't even know what to do for beginners, yet it
should offer so much capability that people who are advanced can adjust settings on their own."

This is the rule every surface follows from now on:

1. **One obvious starting point.** Home opens with a single field, "Ask {persona} anything",
   that sends to the main chat and opens it. Nothing else on the page competes with it for a
   first-time owner.
2. **A first visit says what to try.** Until anything has been said, the field has a few
   starters under it: Plan my week, Set up a morning brief, Tell {persona} about you, and What
   can you do?. They disappear once the owner has a conversation.
3. **Empty states say the next step.** Every empty section either names what to do ("Tell
   {persona} one in chat, or add it here") or is not drawn at all. No blank cards.
4. **Advanced surfaces are reachable, never in the way.** Run Timelines and the activity
   ledger (the Overview), Scheduled with its run history, all notifications, Soul & Memory and
   Memory review live in Home's quiet **More** list and in ⌘K, not in the sidebar. Settings
   keeps every knob for owners who want them (`settings-redesign` owns its structure).
5. **Access is granted when Psyche asks.** Files, folders and connectors are not a setup task.
   When the agent needs one it asks, the owner approves in the approval card, and the grant is
   remembered by type (this folder, this connector, this kind of action). So no beginner
   surface asks the owner to "connect" anything up front: the Overview's "Connect your mail"
   starter is gone, and Home's starters never mention access. Settings still lists every grant
   to review or revoke.
6. **New features follow the same path.** A small feature becomes a Home section, a ⌘K action
   or a row under More. It does not get a sidebar row or its own page unless it is a place
   people go every day.

