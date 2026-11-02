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
People            ⌘4
──────────
Threads …
──────────
persona · gear (What can you do?, Settings ⌘,, Usage, Help)
```

The compact tab bar (under 720 px) has the same four: Chat, Home, Library, People; Search is in
the top bar.

### 3.1 Home (`/home`)

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
| `/feed`, `/feed/<id>` | `/home#today` |
| `/feed/instructions` | `/home/instructions` (Home with the brief's instructions sheet open) |
| `/ideas` | `/home#suggestions` |
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

1. **Home and People** (this doc, `app-routes.ts`, the two pages composed from existing
   components, ⌘K entries, the app guide). Mergeable alone: the old pages still exist.
2. **Navigation** (after `shell-chrome` merges, since it edits the sidebar): the five places,
   the Search row, the tab bar, ⌘1–⌘4, the redirects in §3.4, the Overview losing Upcoming and
   Pinned, Soul & Memory's People row, onboarding text and the app guide naming the new places.
3. **Cleanup**: dead code from the removed pages, stories, and the visual baselines that changed.

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
