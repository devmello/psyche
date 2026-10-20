# UI audit — 2026-10-19

The user tried the app and said the UI looks basic and scraped together. This audit compares every screen with its section in [06-ui-design.md](06-ui-design.md) and ranks the gaps by how visible they are. It is the work list for the UI polish wave.

**Sources**
- The composed desktop app, captured by `apps/desktop/e2e/layout.spec.ts` (PR #131) at 1440×900 and 1280×800, with the web client at 390 px.
- The kit's Storybook visual baselines (`packages/ui/visual/__screenshots__`, 254 stories at 960×720).
- The code: `apps/web/src/shell`, `apps/web/src/compose` and `packages/ui/src`.

Before screenshots live on the `assets/ui-polish` branch (`baseline/` = the app, `ds/` = the stories).

## The short version

1. **The real app does not render the kit's shell.** `PsycheApp` hosts S11's structural stand-ins (`apps/web/src/shell/components/Chrome.tsx` and `shell.css`), which were built "until S12's kit lands".
   - **Rail:** text only, with no Lucide icons and no badges.
   - **Thread list:** shows titles only. It has no filter, no last line, time, status dot or channel icon, no "Side chats" group, no Archived group, and an outlined "+ Side chat" pill where the spec has a pencil-and-note icon.
   - **Title bar:** repeats the thread title and shows a permanent green "connected" chip.

   The kit's own `Rail`, `ThreadList` and `AppShell` already match §2.1, §2.2 and §3.1 (icon rail, thread filter, grouped side chats, Archived (n), status dots). They are just not mounted.
2. **Five of the six rail screens are placeholders in the real app.** Search, Feed, Ideas, Goals and Library render "This screen arrives with the UI kit." The kit has finished screens for all of them, and the Inbox, but `PsycheApp` only routes `/agent/*`. Settings is wired in open PR #104.
3. **The chat column is noisy where it should be calm (§1.2 principle 2).**
   - One approval shows up four times: an inline chip, a wrap-up question, a dock row and the full dock card.
   - Receipts print raw provider keys.
   - The composer always shows a native "Send [after this turn]" select.
4. **The primitives ignored §4.** Cards were radius 14 with a ring, inputs and buttons radius 10, popovers used a stock shadow. Native `<select>`s appear in eight files. Relative times read "409 h 7 min ago". A Tabs variant bug laid Library's tabs out sideways. The primitives, relative times and the Tabs bug are fixed in the design-system PR #155; the selects stay with the screen PRs.
5. **Each screen invented its own page.** Page widths range from 68ch to 80ch to full width, some pages are left-aligned and some centred, Search has no visible title, headers are hand-rolled, and rows carry too many outlined buttons. #155 adds `Page`, `PageHeader`, `SectionLabel` and `EmptyState`; the screens still have to adopt them.

## Ranked gaps

The Vis column is how visible the gap is: H = seen on first launch or on every screen, M = seen on a common path, L = seen on a detail or edge state.

| # | Vis | Screen (spec) | Gap | Where |
| --- | --- | --- | --- | --- |
| 1 | H | Main window chrome (§2.1, §2.2, §3.1) | The stand-in rail and thread list described in point 1 above; the kit's `Rail` / `ThreadList` are not used | `apps/web/src/shell/components/Chrome.tsx`, `shell.css` |
| 2 | H | Search, Feed, Ideas, Goals, Library (§3.9–3.13) | The real app shows a placeholder; the kit screens are not routed | `apps/web/src/compose/PsycheApp.tsx` |
| 3 | H | Title bar (§3.0, §4.12) | Repeats "Main chat" and shows a permanent "connected" chip. The spec states offline only, as a banner. | `TitleBar.tsx`, `PsycheApp.tsx` |
| 4 | H | Agent header (§2.3, §3.1) | In the real app it shows just avatar, "Wren" and a 15 px gray "Idle". The permission-mode pill, model pill, counters and ⋯ are missing; the kit story has them, but the shell does not pass the props. | `PsycheApp.tsx`, `agent/AgentHeader.tsx` |
| 5 | H | Web at 390 px (§3.24) | The bottom tab bar is text with no icons. There is no top bar with back, thread drawer and search. The header avatar is 40 px instead of 28. | `Chrome.tsx`, `shell.css`, `AgentHeader.tsx` |
| 6 | H | Chat thread (§3.2, §3.3) | One approval is shown four times. The dock card takes about two-thirds of the column. | `chat/Thread.tsx`, `chat/ApprovalDock.tsx`, `blocks/MessageBlocks.tsx` |
| 7 | H | Composer (§3.2) | A permanent native "Send [after this turn]" select; the queue mode belongs in the follow-up strip | `chat/Composer.tsx` |
| 8 | H | Library (§3.12) | The tab list was laid out beside the grid (fixed in #155). Filters are native selects, and each card mixes Open, an eye icon, Reveal and an unlabelled chat icon. | `screens/library/LibraryScreen.tsx` |
| 9 | H | Feed (§3.9) | The feedback row is three outlined and three ghost buttons and wraps to two lines. Spec: Like / Save / Ask as ghost icons, Follow / Not interested / Hide under ⋯. | `screens/feed/FeedPostCard.tsx` |
| 10 | H | Lists everywhere (§4.12) | "409 h 7 min ago", "next in 334 h 48 min" (fixed in #155) | `lib/format.ts` |
| 11 | M | Receipts (§3.2) | Should be one line: "Sent to X · Gmail id 18c4… · 10:07". Today it prints raw keys (`gmailThreadId`, `status 200`) in mono and repeats "outcome unknown". | `blocks/Receipt.tsx` |
| 12 | M | Tool rows (§3.2) | The tool name is shown as mono text instead of an icon; outcome dots and durations are not aligned; `r-101` ids are green mono at level 1 | `blocks/ToolRun.tsx` |
| 13 | M | Approval card (§3.3, §4.4) | The whole card is filled amber; the spec wants gray-2 with an amber border. Level-2 ids (Sandbox id, Credential id, Tab id, the full 64-char hash) are shown at level 1. Expiry is a native select offering "90 days", which is not a spec option. | `blocks/ApprovalCard.tsx`, `blocks/approval-details.tsx` |
| 14 | M | Agent sheet (§2.3, §4.7) | No sheet header (64 px avatar, name, status). Task detail sits flush at x = 0 with every outcome in amber, and has no Retry or Resume. Approvals badge says 8 while the panel says 6. | `agent/AgentSheet.tsx`, `ActivityPanel.tsx`, `ApprovalsPanel.tsx` |
| 15 | M | Upcoming (§3.16) | An outlined Run now on every row. Missing: delivery target, next-run sentence, Snooze / Done for reminders. | `agent/UpcomingPanel.tsx` |
| 16 | M | Soul & Memory (§3.17) | Raw mono textarea with no Rich / Source / Diff modes. Daily notes are two links rather than a strip. Pause, Import, Export and Reset sit below the fold. | `agent/SoulMemoryPanel.tsx` |
| 17 | M | Search (§3.13) | The h1 is sr-only. No filter chips, per-kind icons or match highlight. | `screens/search/SearchScreen.tsx` |
| 18 | M | Inbox (§3.20) | Kind labels in eight hues. "Mark read" and "• Unread" on every row. Approve sits left of Deny, the reverse of the approval card. | `screens/inbox/InboxScreen.tsx` |
| 19 | M | Goals (§3.11) | The inferred-goal evidence wraps centred with an orphaned ";". The Plan chip looks disabled. | `screens/goals/*` |
| 20 | M | Settings (§3.18) | Permission matrices list raw keys (`gmail.read`, `mcp__notion__search`) where the spec has "read threads" / "send". Native selects in four sections. Channels exposes `dmPolicy` and `requireMention`. Connectors' empty state shows the primary action twice. | `screens/settings/*` |
| 21 | M | Onboarding (§3.19) | No brand mark. Connectors offers Next with nothing connected and no "Skip for now". The model field is a free-text mono input. The creature grid has a radio inside each tile (two controls for one choice). | `screens/onboarding/*` |
| 22 | M | Agent header (§3.1) | The snippet reads "Needs you: 8 items" rather than the current work. The model pill shows the raw id. The mode pill looks disabled. | `agent/AgentHeader.tsx` |
| 23 | L | Ideas (§3.10) | "Make recurring" has no cadence label and shows on automation ideas too | `screens/ideas/IdeaCard.tsx` |
| 24 | L | Artifacts, plan (§3.2) | Generic glyph instead of a thumbnail; "Approved" as plain text instead of a badge | `blocks/ArtifactCard.tsx`, `blocks/Checklist.tsx` |
| 25 | L | Question card (§3.4) | Accent border, unlike every other level-1 card | `blocks/QuestionCard.tsx` |
| 26 | L | Appearance (§3.18) | Each swatch has its own radio | `screens/settings/AppearanceSection.tsx` |

## Cross-cutting rules for the screen PRs

- **Pages:** wrap every rail screen in `Page` + `PageHeader` (#155). Lists and grids use `wide` (880 px), reading columns use `prose` (68ch), split views use `full`. Headers show the title, the facts, one sentence and at most two actions.
- **One primary action per row.** The rest are ghost buttons or go under ⋯ (`DropdownMenu`). Outlined buttons are for secondary actions in forms.
- **Raw ids, hashes, tool names and config keys belong at disclosure level 2** or in a "Details" disclosure, never in a row's first line.
- **Semantic colours only:** success, danger, approval, info, through `Badge` variants. No rainbow kind labels, and not amber for every state.
- **No browser-default controls:** `NativeSelect` or `Select`; one control per choice.
- **Empty states:** one sentence, one action, the screen's Lucide icon (§4.6 names them).
- **Copy:** persona names for agent actions, "Psyche" for system text; no config keys in labels (§4.12).

## Screen groups for the follow-up PRs

Each group owns disjoint files, so the groups can run in parallel.

| Group | Owns | Ranked gaps |
| --- | --- | --- |
| A. Shell chrome and composed app | `apps/web/src/shell/**`, `apps/web/src/compose/**`, `apps/desktop/e2e/layout.spec.ts` | 1–5 |
| B. Chat column and cards | `packages/ui/src/chat/**`, `packages/ui/src/blocks/**`, `packages/ui/src/agent/AgentHeader.tsx` | 6, 7, 11–13, 22, 24, 25 |
| C. Rail screens | `packages/ui/src/screens/{search,feed,ideas,goals,library,inbox}/**` | 8, 9, 17–19, 23 |
| D. Agent sheet, Settings, Onboarding | `packages/ui/src/agent/**` except `AgentHeader.tsx`, `packages/ui/src/screens/{settings,onboarding}/**` | 14–16, 20, 21, 26 |

Open PRs that touch the same files, to merge or rebase around: #104 (Settings route, `PsycheApp`, `Chrome.tsx`), #126 and #151 (`chat/Thread.tsx`, `MessageView`, `Composer`, the thread list), #131 (`TitleBar`, `OnboardingFlow`, `AgentHeader`, `layout.spec.ts`), #141 (Settings folder grants).

## Consistency pass, 2026-10-20 (S11)

This pass covers screens added after the polish wave: Credentials, the Files pane, Computer use, Voice & dictation, Models & providers, Skills, Browser and VM mode. Library had nothing new to review. Each screen was checked against the cross-cutting rules above, with Permissions, Connectors and Data controls as the baseline.

### Fixed

- **#365 — Credentials, Browser and the Files pane**
  - Credentials:
    - Each header has one primary action. Import and the password managers moved under a "More ways to add" menu.
    - The empty list is an `EmptyState` with one action, and a search with no match offers "Clear search".
    - Slugs moved off the row and into the item sheet. Values use sentence case, and inline forms follow the Group rhythm.
  - Browser had its hint rendered twice; the duplicate is gone. The DevTools port and the profile path moved into a Details disclosure.
  - Files pane: errors read "Psyche couldn't …" with "Try again". The empty preview is an `EmptyState` and the share action is primary.
- **This PR — Computer use, Voice, Models, Skills and VM mode**
  - Computer use and Skills: agent actions use the persona's name instead of "the agent".
  - Computer use: an empty app list shows the notice instead of an empty table under its column headers.
  - Voice:
    - Key labels match: "Right Option" and "Right Command", in both the description and the radios.
    - Spelled "the Psyche helper".
  - Models:
    - "Add a provider" is primary and also serves as the empty state's action.
    - The vault reference left the row text.
    - Errors read "Psyche couldn't …".
  - Skills:
    - Cancel is a ghost button and Remove is a ghost button beside the one "Review update".
    - Severities are shown in words.
    - The update chip uses a semantic tone.
  - VM mode:
    - Shares say "read only" or "read and write".
    - The failure notice says what happens next.
    - Values use sentence case.
    - Guest cards match Connectors' cards.
    - `nodes.list` and `devices.list` errors now reach the load gate.

### Still open (needs a decision or a larger change)

1. **Raw keys in write errors.** `settings/shared.tsx` names the raw setting key, as in "Psyche couldn't save vault.backend". This breaks §4.12 in every section, and fixing it needs a key-to-label map.
2. **Matrix radios.** Computer use and `ActionMatrix` use raw `<input type="radio">` per cell. Choose a kit `RadioGroupItem` per cell or one `NativeSelect` per row, and apply it to both.
3. **Model names.** Models & providers shows `m.ref` (the provider/model id) as the label everywhere. Human labels would move the ref to disclosure level 2. Separately, `models.list` errors are swallowed in favour of settings, and the chat-only confirm is a hand-rolled alert outside the frame.
4. **The Files pane and `Page`.** Decide whether a split-view pane is exempt from `Page`/`PageHeader`. §4.6 names no icon for it; this pass uses `FileText` for the empty preview. Loading in the tree is still plain "Loading…" text, not `LoadingCards`.
5. **Naming.** It's open whether "Psyche Chrome profile" should carry the persona's name instead.
6. **Facts value casing.** This pass used sentence case in Credentials and VM mode. Write it into the rules.
7. **Destructive rows.** Connectors pairs an outline Disconnect with a destructive Remove. Either accept that as the pattern for destructive rows or move Remove under ⋯.
8. **Skills trust card.** The content hash and commit are at level 1, and tool names appear on row line 3. Both belong in a Details disclosure, with a count on the row.
9. **Voice hotkey.** The field is free text, and a conflicting shortcut is shown only as muted description text. Options: a shortcut recorder, and an approval-tone hint for the conflict.
10. **Credential detail.** Approval ids appear in the uses table. That's acceptable at level 2, but they could read "Approved" with the id in a tooltip.

**Decision 2 (matrix radios):** done. `settings/RadioTableRow.tsx` makes each matrix row one radio group of kit `RadioGroupItem`s. Each item is labelled "row: column", and the arrow keys move within the row. Computer use and `ActionMatrix` both use it.
