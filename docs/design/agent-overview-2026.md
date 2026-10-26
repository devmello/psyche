# Agent overview 2026: a slim agent sheet and a "You & Psyche" screen

Status: proposal (docs only). It amends `redesign-2026.md` §5.7 (persona and the agent sheet) and `run-trace-2026.md` §3.3 and §3.6 (where the Timeline and mission control live). Companion to `chat-experience-2026.md` (the Card shell) and `motion.md`.

## 1. Problem

The agent sheet (420 px, opened from the avatar) packs five tabs into one segmented control: Activity, Approvals, Upcoming, Soul & Memory and Growth. The owner's screenshot shows four problems:

- **The control overflows.** "Soul & Memory" and "Growth" run into the sheet's edge. Five labelled segments don't fit in 420 px. Apple's limit of about five segments assumes short labels and a wide window.
- **The tabs mix two jobs.** Approvals and Soul & Memory are things you act on. Activity, Upcoming and Growth are things you look at.
- **Activity is a long flat list.** "Next up" is eight identical rows, nearly all automations, with relative times from "in 1 min" to "on Nov 1". The "Recent" filters and the search field are squeezed in below it.
- **Nothing shows value.** No surface answers "how has Psyche been useful to me?"

The owner's direction: keep only Approvals and Soul & Memory (and maybe Upcoming) in the sheet. Merge Activity, Upcoming and Growth into one overview screen that shows how Psyche has been useful, including:

- your growth together
- the map, charts and graphs Psyche built
- your activity

It has to look and feel excellent.

## 2. Research summary

Two research passes informed this spec:

- **Agent side panels and inspectors:** Apple HIG, ChatGPT and Claude memory, Raycast, Linear, Cursor and Notion.
- **"Your usage / insights" pages:** Spotify Wrapped, Screen Time, GitHub, Duolingo, Oura, Whoop, Raycast Wrapped and AI usage pages.

Sources are listed at the end. Items marked *kb* come from background knowledge, not a page we read.

### 2.1 Side panels

| Finding | Source | What we take |
|---|---|---|
| Segmented controls top out at about 5 to 7 segments in wide UIs and 5 on iPhone. Never use them for actions. When a tab bar can't hold the sections, move the less-used ones elsewhere. | Apple HIG (segmented controls, sidebars) | Two segments in a 420 px sheet, never more. |
| Cursor raised its right sidebar's minimum width so its chat tabs would stop scrolling, and users complained it squeezed the editor. | Cursor forum | Overflowing tabs force a wider panel. Fix the information architecture instead. |
| Memory is a list of facts. Each fact shows provenance (explicit vs inferred), a date, edit and delete. The list also has "clear all", an on/off switch, and a "not exhaustive" note. | OpenAI Memory FAQ; Anthropic memory | This already matches Soul & Memory. Keep it and give it room. |
| Approvals sit at the top, render only when there are any, carry a count badge on the opener, and offer inline approve and deny. | Raycast; triage-agent patterns | The Approvals segment is the sheet's default whenever anything is waiting. |
| A one-line pinned status (state, current task, next item) beats a status tab. | Synthesis | A "Now / next" line in the sheet header. |

### 2.2 Insights pages

| Product | Pattern | What we take |
|---|---|---|
| Screen Time *kb* | A hero total, then one bar chart with a Day / Week toggle, then categories, then a "vs last week" line, with drill-down on each bar | One period selector drives the whole page. Bars for daily totals. |
| GitHub contributions and Pulse *kb* | A 52 × 7 heatmap in 4 to 5 buckets with a legend, exact counts on hover, and a period selector over plain counts | A heatmap for consistency over months. Counts, never "value". |
| Oura / Whoop | One score explained by named contributors against your own baseline. The baseline takes about 2 weeks to learn. Weekly, monthly and 6-month trends. | Show the contributors (raw counts) and **skip the composite score**. Hold back comparisons until there is a baseline. |
| Raycast Wrapped | Opened from a command. Stored locally. Section by section. Shows nothing below 14 days of data. | Have a minimum-history empty state instead of thin charts. Keep it local and private. |
| Spotify Wrapped | Each card holds one idea, told as a personal narrative | Lead with a sentence built from the data. Leave out the share and FOMO mechanics. |
| Duolingo *kb* | The streak is the hero | **Avoid it**: streak guilt doesn't suit an assistant. |
| Copilot "time saved" | 60% of 2,898 engineers report saving under 1 hour, and satisfaction tracks time saved only weakly (r = 0.34). Critics call the vendors' figures proxies that ignore review and bugs. | **No "time saved" number.** Measured durations and counts are defensible. Estimates are not. |

Cross-cutting rules we adopt:

1. **Hierarchy:** a sentence, then 3 to 4 tiles, then the primary chart, then breakdowns, then lists.
2. **No more than four KPIs above the fold.**
3. **One period** (Week / Month / All) for every section, with the exact date range shown.
4. **Every number opens the items behind it.** This is the strongest honesty device.
5. **Deltas are relative to the previous period.** Show "—" when there is no previous period, never "+∞%".
6. **Narrative is templated from numbers we computed.** The model never writes a figure.
7. **No colour-only encoding.** The heatmap ramp has its own dark-mode version.

## 3. Information architecture

```
Before                                   After
──────                                   ─────
Agent sheet                              Agent sheet (slim)
 ├ Activity (mission control, Timeline)   ├ Now / next line  ─────────┐
 ├ Approvals                              ├ Approvals (+ questions)   │ "Open overview"
 ├ Upcoming                               └ Soul & Memory             │
 ├ Soul & Memory                                                      ▼
 └ Growth                                Overview screen  /overview   "Wren & you"
                                          ├ Summary (sentence + 4 tiles)
                                          ├ Now & next (running, needs you, next 3)
                                          ├ Activity over time (bars / heatmap)
                                          ├ Growth (lessons, metrics, milestones, weekly card)
                                          ├ People & projects (map + list)
                                          ├ Built for you (artifacts, charts)
                                          ├ Specialists (latest results)
                                          ├ Upcoming automations (full list, pause/snooze)
                                          └ Recent runs (filter, search) → Timeline
                                         Timeline  /overview/run/<runId>[?step=]
```

**Names:**

- The sidebar destination is **Overview**, a short, stable label for navigation.
- The page title is **"{persona} & you"**, e.g. "Wren & you". It is personal, and it follows a persona rename because it reads the persona name.
- The run inspector keeps the name **Timeline** (run-trace §3.1).

## 4. The slim agent sheet

### 4.1 Layout (420 px modal, 400 px docked; unchanged)

```
┌──────────────────────────────────────────────┐
│ (🦉64)  Wren                               ✕ │
│         Idle · next: Check for new mail 1 min│   ← Now / next line (one line, truncates)
│         Open overview →                      │   ← link button, text-callout
├──────────────────────────────────────────────┤
│ [ Approvals  2 ] [ Soul & Memory ]           │   ← 2-segment control, full width
├──────────────────────────────────────────────┤
│ Needs you                                    │
│ ┌ Card ────────────────────────────────────┐ │
│ │ ⏸ Pay the dentist invoice   $84 · Mail   │ │
│ │ Because: invoice from Dr Lee …           │ │
│ │                  [Deny]  [Approve]       │ │
│ └──────────────────────────────────────────┘ │
│ Questions (1)                                │
│ ┌ Card ── "Which calendar for Lisbon?" ────┐ │
│ Standing permissions ▸                       │   ← disclosure (grants.list / revoke)
└──────────────────────────────────────────────┘
```

**Now / next line.** One line in `text-callout`, `--label-secondary`. It shows one of:

- *Working:* "Working on Book flights · 0:42", with a live duration and the step's status line in a tooltip.
- *Waiting:* "Waiting for you · 2 approvals".
- *Idle:* "Idle · next: {automation} {relative}". The data comes from `automations.upcoming`, limit 1.
- *Paused:* "Memory paused" or "Automations paused", when either is paused.

Clicking the line opens the run's Timeline on the Overview, or the Overview's Now & next section. "Open overview" is always present, and a ⌘-click opens it without closing the sheet.

**The two segments.** These are **Approvals** and **Soul & Memory**. Two segments leave about 190 px per label at 420 px, which fits every locale we ship in our estimate. This still needs checking against the real catalogue in O9. If a locale's label doesn't fit, it uses the short key `agent.sheet.soul.short` ("Memory").

- **Approvals** shows a count badge (approvals plus questions). It is the default segment whenever that count is above zero. Otherwise the sheet opens on the segment used last, persisted per device.
- **Approvals content:**
  - "Needs you": pending approvals as `ApprovalCard`s
  - Questions
  - a "Standing permissions" disclosure with grants and revoke
  - a quiet "Decided recently ▸" disclosure covering the last 7 days, with a link to the full history on the Overview
  - empty state: "Nothing needs you." plus one line on what will appear here
- **Soul & Memory content:** unchanged from today's panel (the persona file, memory files, people section, daily notes, pause / export / reset). It finally gets the full height of the sheet.

**Routes:**

- `/agent/approvals` and `/agent/soul` stay.
- `/agent/activity`, `/agent/upcoming` and `/agent/growth` **redirect** to `/overview#now`, `/overview#upcoming` and `/overview#growth`.
- `/agent/activity/run/<id>` redirects to `/overview/run/<id>`, keeping `?step=`.
- `agentSheetRoute` keeps parsing the old paths so links in old notifications and in Feed posts keep working.

## 5. The Overview screen

### 5.1 Page frame

- **Page:** a content page like Ideas and Goals (redesign §5.6). The column is 1040 px wide and centred, with 24 px gutters at ≥ 1100 px window width.
- **Section rhythm:** each section is a `Card` (`variant="framed"`) with a `title`, an optional `meta` (e.g. "Last 30 days") and up to two `actions` (e.g. "See all"). Sections are 16 px apart. Sections never nest cards: rows inside a section are plain list rows.
- **Toolbar row:**
  - the page title "{persona} & you" in `text-title-1`
  - right-aligned: a period control **Week / Month / All time** (3 segments, maps to `7d / 30d / all`)
  - the exact range in `text-callout` below the title ("Oct 20 – 26", "Sep 27 – Oct 26", "Since Aug 3")
  - the period persists in the URL (`?period=7d`) so links reproduce the view
- **Section anchors:** `#now`, `#activity`, `#growth`, `#people`, `#built`, `#specialists`, `#upcoming` and `#recent`. A sticky in-page jump bar (a quiet text-link row, not tabs) appears after the user scrolls past the summary. It is hidden below 720 px.

### 5.2 Wireframe: desktop (≥ 1100 px)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Wren & you                                                  [ Week | Month | All time ] │
│ Sep 27 – Oct 26                                                                          │
│                                                                                          │
│ This month Wren finished 46 tasks and ran 212 automations for you. You taught it         │
│ 9 lessons, and 31 of 34 drafts went out unchanged.                                       │ ← templated
│                                                                                          │
│ ┌ Tasks done ──────┐ ┌ Automations run ─┐ ┌ Approvals ───────┐ ┌ Lessons learned ─┐      │
│ │ 46        ▁▃▅▂▇▅ │ │ 212       ▅▅▆▅▇▆ │ │ 18 decided       │ │ 9          ▁▁▃▂▅ │      │
│ │ +12 vs last mo.  │ │ 98% ok · 4 failed│ │ 16 ✓  2 ✕        │ │ 3 confirmed      │      │
│ └──────────────────┘ └──────────────────┘ └──────────────────┘ └──────────────────┘      │
│                                                                                          │
│ ┌ Now & next ──────────────────────────────────────────────────────────── #now ──────┐   │
│ │ ● Book flights to Lisbon       Comparing 3 flights           0:42  ▁▃▅▂▇           │   │
│ │ ⏸ 2 approvals waiting                                         Open approvals →     │   │
│ │ ○ Check for new mail · in 1 min   ○ Meeting prep · in 14 min   ○ Daily brief · 9:00 │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌ Activity ───────────────────────────────────────── Tasks · Automations · Chat ─────┐   │
│ │  ▇                                                                                 │   │
│ │  ▇ ▅       ▇           ▅                       stacked daily bars (Week/Month)     │   │
│ │  ▇ ▅ ▃ ▅ ▂ ▇ ▅ ▃ ▁ ▂ ▅ ▅ ▇ ...                 or heatmap calendar (All time)       │   │
│ │  Busiest day: Tue Oct 14 · 23 runs        Wren worked 14 h 20 m (measured run time)│   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌ Growth ─────────────────────────────┐ ┌ People & projects ───────────────────────┐     │
│ │ 9 learned · 4 refined · 3 confirmed │ │        (Ana)    (Lisbon trip)            │     │
│ │ Drafts sent as is   91%  ↑ from 78% │ │   (Dr Lee)  ( YOU )   (Q4 board deck)    │     │
│ │ Approvals unchanged 88%  ↑ from 80% │ │        (Sam)     (Acme)                  │     │
│ │ Repeat corrections   2   ↓ from 5   │ │ 14 people · 6 projects · 5 open loops    │     │
│ │ This week's lessons (3)  Review →   │ │ Ana 31 · Q4 board deck 22 · Sam 17 …     │     │
│ │ ◆ Oct 21 First skill from a routine │ │                              See all →   │     │
│ └─────────────────────────────────────┘ └──────────────────────────────────────────┘     │
│                                                                                          │
│ ┌ Built for you ───────────────────────────────────────────────── 12 this month ─────┐   │
│ │ [chart thumb] [doc thumb] [sheet thumb] [code thumb]                    See all →  │   │
│ │ Q4 revenue    Lisbon plan  Budget 2026  scrape.py                                  │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌ Specialists ───────────────────────────────────────────────── 7 results ───────────┐   │
│ │ Researcher · "Lisbon hotels under €200"  ✓ done · 3 findings        Open →         │   │
│ │ Analyst · "Q3 spend by vendor"           ◐ partial · 2 findings     Open →         │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌ Upcoming ────────────────────────────── 8 automations ─────────────────────────────┐   │
│ │ Today        Check for new mail   every 5 min   usually 4 s   ▁▁▂▁▃   ⏸  ⋯         │   │
│ │              Meeting prep         in 14 min     usually 40 s  ▂▃▂▂▂   ⏸  ⋯         │   │
│ │ Tomorrow     Ideas: nightly mining 2:00 · Daily brief 9:00 · Inbox digest 10:00    │   │
│ │ This week    Memory dreaming Mon · What I learned this week Sat Nov 1              │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│ ┌ Recent runs ───────────────────────── [All | Failed | Automations | Chat] [⌕ search]┐   │
│ │ ✓ Task                           3 min 11 s · 9 steps                   3:23 AM  › │   │
│ │ ✕ Sync Notion tasks              Stopped at step 3                     10:15 AM  › │   │
│ │ …                                                         Show more (cursor paged) │   │
│ └────────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Between 720 and 1100 px, sections are full width (Growth above People) and the tiles stay at 4 across down to 880 px, then wrap 2 × 2.

### 5.3 Wireframe: compact (< 720 px, web and narrow windows)

```
┌──────────────────────────────┐
│ Wren & you                   │
│ [ Week | Month | All ]       │
│ This month Wren finished 46  │
│ tasks …                      │
│ ┌ Tasks 46 ┐ ┌ Autom. 212 ┐  │   2 × 2 tiles, sparklines hidden < 360 px
│ ┌ Appr. 18 ┐ ┌ Lessons 9  ┐  │
│ Now & next (stacked rows)    │
│ Activity (last 14 days bars, │
│  heatmap = last 17 weeks,    │
│  scrolls horizontally inside │
│  the card, starting at today)│
│ Growth                       │
│ People & projects (list only;│
│  map behind "Show map")      │
│ Built for you (2-col grid)   │
│ Specialists · Upcoming ·     │
│ Recent runs                  │
└──────────────────────────────┘
```

The Timeline at compact width is a full-screen page with a back button, the same as panes today (chat-experience §canvas).

### 5.4 Sections in detail

Each section lists its data and its honest-number rules. "Period" means the selected 7d / 30d / all window. "Previous" means the window of equal length immediately before it. All-time has no previous window, so it shows no deltas.

**Summary (sentence and four tiles)**

- **The sentence** is chosen from a small set of ICU templates over the computed totals. A clause is dropped when its number is 0. For example, with no lessons the sentence ends after the tasks clause. The model never writes it.
- **Tasks done:**
  - a count of runs with `kind ∈ {task, chat}` and `status = done` in the period
  - a sparkline of the daily counts
  - a delta vs previous
  - clicking it opens Recent runs filtered to done tasks in the period
- **Automations run:**
  - a count of automation runs
  - a success rate shown as "98% ok · 4 failed"
  - clicking "4 failed" filters Recent runs to failed automations
- **Approvals:**
  - decided in the period, split into approved, denied and expired, with icons and words (not colour alone)
  - clicking it opens the Approvals sheet's "Decided recently" view
- **Lessons learned:**
  - `growth.summary.lessons.learned` for the window
  - the subline is the confirmed count
  - clicking it scrolls to Growth
- **What we don't show:** no "time saved", no composite score, no tokens or cost on this page. Cost stays in Usage (Settings and the sidebar's usage footer), which is a different question: "what does Psyche cost?" Measured working time ("Wren worked 14 h 20 m", the sum of run wall time) appears once, as a footnote in the Activity card, labelled "measured run time". It is not a tile, because it measures effort, not benefit.

**Now & next**

- One row per running run, using the existing `MissionControl` row (status glyph, current step, live duration, sparkline).
- Then one row "N approvals waiting" that opens the sheet on Approvals. It is hidden when the count is 0.
- Then the next three items from `automations.upcoming`, inline.
- **Empty:** "Nothing running." plus the next item. This replaces the sheet's long "Next up" list. The full list lives in Upcoming further down.

**Activity over time**

- **Week / Month:** stacked daily bars by kind (Tasks, Automations, Chat), with a legend that doubles as a filter (toggle a series).
  - Hovering or focusing a bar shows the exact counts and measured time.
  - Clicking a bar filters Recent runs to that day.
- **All time:** a calendar heatmap of runs per day with 5 buckets. The bucket edges are quantiles of the owner's own non-zero days, so a light user still sees contrast. The legend shows the real ranges ("1–3, 4–8, …").
- **Facts under the chart:**
  - "Busiest day: {date} · {n} runs"
  - "Wren worked {duration} (measured run time)"
  - "Most-run automation: {title} · {n}×"

**Growth**

- Reuses `GrowthPanel`'s pieces against the page's window:
  - the lesson counts (learned / refined / confirmed / forgotten)
  - the five metrics with `rate` and `previousRate` ("↑ from 78%"). Each opens its `evidence` ids in a popover list.
  - milestones as dated facts (◆ marker, no confetti)
  - the week-grouped timeline behind "See all lessons"
- The weekly "What I learned" card appears here as a row: "This week's lessons (3) · Review". It opens the same `GrowthCardItems` in a sheet. The Feed post stays as it is.
- The Growth tab's own window toggle is removed because the page period drives it.

**People & projects**

- **The map:** a deterministic radial "constellation" in SVG (no force simulation, so the same data always gives the same picture). "You" sits at the centre, ringed by the top 12 entities by interactions in the period.
  - The ring distance encodes recency of the last interaction. There are three rings: this week, this month, earlier.
  - The node size encodes the interaction count, in 3 sizes.
  - The shape encodes the kind: a circle for a person, a rounded square for a project or org.
  - A badge shows open loops.
  - Hovering or focusing a node shows its `EntitySummary` subtitle and counts. Clicking opens the entity in Soul & Memory's people section, using `/agent/soul?entity=`.
  - **Honesty:** edges are only drawn between "you" and an entity. We don't invent links between entities. Entity–entity edges from `memory.entities.get` are a possible later addition and need an aggregate.
- **Under the map:**
  - the counts from `memory.graph.status` ("14 people · 6 projects · 5 open loops")
  - a ranked line "Ana 31 · Q4 board deck 22 · …"
  - "See all" opens the people list
- **Accessibility:** the map has an equivalent list, which is shown by default at compact width and via "Show as list" elsewhere.
- **Empty or graph paused:** "Psyche maps the people and projects you work with as mail, calendar and chats come in." plus "Connect mail" when no source is enabled.

**Built for you**

- `artifacts.list` (limit 8, newest first), filtered to the period by `updatedAt` and rendered as a thumbnail grid using `ArtifactCard` in its compact `preview` form.
- Charts (`type = chart`) render their real `ChartView` thumbnail. This is "the charts and graphs Psyche built for you".
- The count in `meta` comes from the aggregate in §6.
- Clicking opens the artifact in the canvas pane of its thread. "See all" opens Library → Artifacts.

**Specialists**

- `specialists.jobs` with status in done / partial / failed, newest 3, as `SpecialistResultCard` in its collapsed form (role, title, status, findings count, usage line).
- The `meta` is the count of results in the period.
- The section is hidden entirely when specialists are not enabled (`specialists.list` has no enabled role).

**Upcoming**

- The full list of enabled automations from `automations.upcoming`, **grouped by day**: Today / Tomorrow / This week / Later.
  - Frequent automations are collapsed to one row with their cadence ("every 5 min"). This fixes the screenshot's flat list of eight.
  - Rows reuse `UpcomingRow`: usual duration plus a last-10 sparkline, and pause / snooze / ⋯ (`automations.update`).
  - The lessons and delivery sentences stay in each row's ⋯ details.
- Paused automations sit under a "Paused (n) ▸" disclosure.

**Recent runs**

- Today's Recent list moves here unchanged (All / Failed / Automations / Chat, search by title), cursor-paged via `runs.list`.
- Rows open the Timeline at `/overview/run/<runId>`. The Timeline replaces the page body with a back link ("← Wren & you"). It gets the full width, which the waterfall needs (run-trace §3.3 was cramped in the 420 px sheet).

### 5.5 States

- **New user** (`insights.summary.firstActivityAt` is null or less than 7 days ago):
  - No tiles and no charts.
  - A level-1 hero card says "Wren is getting to know you". The body explains: "In a week you'll see what Wren did for you, what it learned, and the people and projects it's keeping track of." It shows up to three "Try" chips: "Ask Wren to plan your week", "Set up a morning brief", "Connect your mail". Each chip is a real action.
  - Below it, Now & next and Upcoming render normally, because they're useful from day one.
  - Seven days matches the `first_week` milestone.
- **Sparse period** (a week with no runs):
  - Tiles show "0" and a delta.
  - The chart shows an empty axis with the caption "Nothing this week."
  - No zero-filled sparklines: a sparkline needs 2 or more non-zero points.
- **Loading:** skeletons in the shape of each section, revealed per section. The summary and the sentence wait for `insights.summary`. Other sections load independently.
- **Error:** an inline `StatusPill` in the section header ("Couldn't load · Retry"). Only that section fails, never the whole page.
- **Offline / gateway down:** the page shows the last cached data, with a "Last updated 10:42" note in the toolbar.

### 5.6 Visual system

- **Tokens:** only existing tokens.
- **Chart colours:**
  - a 3-hue categorical set for Tasks / Automations / Chat: `--accent`, `--success` and `--label-tertiary` fills (if `--success` reads as "good", a new neutral chart hue token is added in O3), validated for 3:1 contrast against `--surface-raised` in both themes
  - a 5-step sequential ramp for the heatmap from `--accent-a2` to `--accent-a9`, with a separate dark-mode ramp
  - status always pairs a glyph with a word
- **Type:**
  - tile numbers: `text-title-1`, tabular figures
  - deltas: `text-caption` with an arrow glyph and the word ("+12 vs last month"). Deltas are not coloured red or green, because more tasks isn't good or bad.
  - Growth metrics, which have a direction, use `--success-text` / `--label-secondary` and never red.
- **Motion** (motion.md):
  - sections fade and rise once on first load (`spring.gentle`)
  - numbers don't count up
  - bars grow on period change with a 150 ms height tween
  - all of it is off under reduce motion
- **Density:** tiles are 96 px tall. Rows in Upcoming and Recent are 32 px. Cards use 20 px padding.

### 5.7 Accessibility

- **Each chart is a `figure` with a `figcaption`** (the facts line) and a visually hidden data table.
  - Bars and heatmap days are reachable with arrow keys (a roving tabindex) and announce "Tue Oct 14: 23 runs, 18 tasks, 5 automations".
  - Enter applies the day filter.
- **The map** has the list equivalent (§5.4). Nodes are focusable in rank order.
- **Tiles** are links whose accessible name includes the number and the delta.
- **Contrast:** 4.5:1 for text and 3:1 for chart marks against the card, in both themes.
- **Axe:** runs via the stories test. Visual baselines are taken in light, dark and `ar` (RTL).

### 5.8 Localisation

- **Strings:**
  - new strings go in `packages/ui/src/i18n/messages/overview.ts` as `overview.*` keys, plus `agent.sheet.now.*` and `agent.sheet.openOverview`
  - all ten locales are translated in the same PR as the English, and the catalogue falls back to English per id
  - sentences, counts and durations are ICU plural messages, and numbers use `Intl.NumberFormat`
  - dates use `Intl.DateTimeFormat` in the user's time zone, which is sent to the gateway as `timeZone`
- **RTL (`ar`):**
  - the time axis mirrors (newest on the left), the common bidirectional-UI convention for time series; this needs confirming with an `ar` reader during O9
  - the heatmap's week columns mirror
  - sparklines mirror too
- **Long labels:** tiles allow a two-line label, and the period control uses short keys.

## 6. Data

### 6.1 What exists

| Section | Methods (exist today) |
|---|---|
| Now & next | `runs.list {status:[running]}`, `approvals.list`, `questions.list`, `automations.upcoming` (in the protocol and mock, no UI caller yet) |
| Growth | `growth.summary {window: 7d\|30d\|all}` with lessons, metrics (with `previousRate` and `evidence`), milestones and timeline; `memory.lessons.*` |
| People | `memory.graph.status` (counts, sources), `memory.entities.search` (`EntitySummary.lastInteractionAt`, `openLoops`) |
| Built for you | `artifacts.list` (paged, newest first), `artifacts.get`, `ArtifactCard`, `ChartView` |
| Specialists | `specialists.list`, `specialists.jobs` |
| Upcoming | `automations.upcoming`, `automations.list`, `automations.update` |
| Recent / Timeline | `runs.list` (cursor, `since`, filters), `runs.get`, `runs.steps`, … |

### 6.2 What's missing, and the one addition

Counting a month of runs, approvals, artifacts or per-entity interactions means paging list methods (`runs.list` caps at 100 per page) on every page view. Some numbers can't be derived on the client at all:

- interactions per entity in a window
- the previous period's totals

So we add **one read-only method**, computed with SQL on the gateway from tables that already exist (runs, approvals, artifacts and versions, specialist jobs, graph interactions). It needs no migration.

```ts
// packages/protocol/src/methods/insights.ts   (new; version bump minor)
"insights.summary": {
  params: { window: GrowthWindow /* "7d" | "30d" | "all" */, timeZone?: string },
  result: {
    window: GrowthWindow,
    range: { from: IsoDateTime, to: IsoDateTime },
    firstActivityAt: Nullable<IsoDateTime>,      // drives the new-user state
    totals: InsightTotals,
    previous: Nullable<InsightTotals>,           // null for "all"
    days: Array<{                                // ≤ 366; "all" returns the last 53 weeks
      date: "YYYY-MM-DD",
      runs: { task: int, chat: int, automation: int },
      failed: int,
      wallMs: int,
    }>,
    topEntities: Array<{ entityId: Id, kind: EntityKind, name: string,
                         interactions: int, lastInteractionAt: IsoDateTime, openLoops: int }>, // ≤ 12
  }
}
InsightTotals = {
  runs: { task: int, chat: int, automation: int, subagent: int },
  runsDone: int, runsFailed: int,
  wallMs: int,                                    // sum of measured run wall time (endedAt − startedAt)
  approvals: { approved: int, denied: int, expired: int },
  artifacts: { created: int, versions: int, charts: int },
  specialists: { done: int, partial: int, failed: int },
  busiestDay: Nullable<{ date: string, runs: int }>,
  topAutomation: Nullable<{ automationId: Id, title: string, runs: int }>,
}
```

- **Events:** there is no new event. The UI store invalidates `insights.summary` on the events that already invalidate its inputs: `run.*`, `approval.*`, `artifact.*`, `growth.updated` and `memory.graph.*`. Refetches are debounced by 2 s.
- **Swift:** the new method only. It adds no enum values, so no Swift switch site changes. Run `pnpm protocol:gen`.
- **Privacy:** local only, never sent anywhere. It respects incognito: runs from incognito threads are excluded, the same as memory.
- **Mock gateway:** fixtures for a new user (day 2), a typical month, and a heavy all-time year. Stories and baselines use these.

## 7. Implementation plan (small PRs, each green on every CI check)

| # | PR | Contents | Depends |
|---|---|---|---|
| O1 | `insights.summary` | Protocol + codegen; gateway compose module (SQL, tests against the in-memory db); mock gateway fixtures; `useInsights(window)` hook + store invalidation | — |
| O2 | Overview shell + navigation | `/overview` route in `screenRoute`; `RailItem` "overview" + `destinationFor`; sidebar row; ⌘K action; page frame, period control (URL state), section anchors and jump bar; new-user state; English strings | — (renders sections behind data from O1 as they land) |
| O3 | Chart primitives | `components/charts/`: `StatTile` (number, delta, `Sparkline`), `StackedBars`, `CalendarHeatmap`, chart `figure` + hidden table helper, keyboard model; stories incl. RTL and dark; pure layout/bucketing tests | — |
| O4 | Summary + Activity | Sentence templates, 4 tiles, Activity card | O1, O2, O3 |
| O5 | Now & next + Upcoming + Recent + Timeline route | Reuse `MissionControl` rows / `UpcomingRow`, day grouping + cadence collapse; Recent list moves; `/overview/run/<id>`; redirects from `/agent/activity…` | O2 |
| O6 | Slim sheet | 2 segments, Now / next line, "Open overview", Approvals "Decided recently", route redirects for `upcoming`/`growth`, ⌘K agent actions updated; remove Activity/Upcoming/Growth tab bodies from the sheet | O5 |
| O7 | Growth + People map | Growth section from `GrowthPanel` parts (window from page), weekly card row; `PeopleMap` (radial, deterministic) + list equivalent | O1, O2 |
| O8 | Built for you + Specialists | Artifact grid with chart thumbs; specialist result rows | O1, O2 |
| O9 | Locales + baselines | All ten locales for `overview.*`/`agent.sheet.*` (if not done per PR), Storybook baselines (light, dark, `ar`, compact) for `Overview/*` and `Agent/Sheet` | all |

Rules:

- **Card shell:** sections use `Card` from `blocks/card.tsx`, and `packages/ui/src/overview/` is added to `card-chrome-lint`'s scanned folders.
- **Tests:** vitest runs with `--maxWorkers=1`. Typecheck only the changed packages.
- **Baselines:** Agent and Overview story groups only, `--workers=1`.
- **Branches:** O2, O3 and O1 can run in parallel because they touch disjoint files. O6 is the only PR that edits `AgentSheet.tsx` beyond its route table.

## 8. Decisions to confirm

1. **Names:** the sidebar label is "Overview" and the page title is "{persona} & you". Alternatives: "Insights", "Psyche & you" fixed.
2. **The sheet keeps two segments, Approvals and Soul & Memory, plus a Now / next line.** Upcoming leaves the sheet entirely and moves to the Overview, grouped by day.
3. **The Timeline moves to `/overview/run/<id>`** at full width. Old `/agent/activity/run/<id>` links redirect.
4. **There is no "time saved" or value score anywhere.** Value is shown as real counts with deltas, plus measured run time as a labelled footnote.
5. **One new read-only method, `insights.summary`,** for aggregates, previous-period totals and per-entity interactions. There is no migration and no new events.
6. **The people map is a deterministic radial constellation** with "you" at the centre and the top 12 entities. It draws no inferred entity–entity edges and has a list equivalent.
7. **The new-user threshold is 7 days of activity** before tiles and charts appear. Until then a "getting to know you" state shows, with Now & next and Upcoming still live.
8. **Navigation:** Overview is a sidebar destination after Library, with a ⌘K action. The sidebar footer's avatar opens the Overview, and the chat toolbar avatar still opens the sheet.

## Sources

- Apple HIG: [segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls), [sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- Cursor forum: [configurable minimum width for the right sidebar](https://forum.cursor.com/t/allow-configurable-minimum-width-for-the-right-sidebar/156036)
- OpenAI: [Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq), [how memory uses past conversations](https://help.openai.com/en/articles/10303002-how-does-memory-use-past-conversations)
- Anthropic: [memory announcement](https://www.anthropic.com/news/memory), [support article](https://support.claude.com/en/articles/11817273)
- Raycast: [AI chat manual](https://manual.raycast.com/ai/ai-chat.md), [Raycast Wrapped changelog](https://www.raycast.com/changelog/macos-v1/1-104-0)
- Linear: [changelog, priority inbox and agent panel](https://linear.app/changelog/2026-09-03-priority-inbox)
- Notion: [sidebar](https://www.notion.com/help/sidebar)
- Oura: [readiness score](https://support.ouraring.com/hc/en-us/articles/360025589793), [blog](https://ouraring.com/blog/readiness-score/)
- Whoop: [trend views](https://www.whoop.com/at/de/thelocker/track-progress-with-new-trend-views/), [weekly performance assessment](https://whoop.com/thelocker/new-weekly-performance-assessment)
- Spotify Wrapped analyses: [Essey](https://medium.com/@chris.essey/why-spotify-wrapped-is-a-genius-marketing-campaign-a2cd10c70d09), [Psychologs](https://www.psychologs.com/the-psychology-behind-your-spotify-wrapped/)
- Copilot time-saved critiques: [arXiv 2602.03593](https://arxiv.org/pdf/2602.03593), [DevClass](https://devclass.com/2024/05/14/github-research-reports-high-copilot-satisfaction-from-enterprise-devs-but-others-doubt-productivity-gains/), [Zenhub](https://www.zenhub.com/blog-posts/is-github-copilots-biggest-productivity-threat-bad-project-management)

The code facts in §6 come from the repository at `e331a918`.
