# Accessibility audit (v1.0) — 2026-10-20

This audit checks every screen and shared component against **WCAG 2.2 AA**. It is the work list for the v1.0 accessibility pass in [08-roadmap.md](08-roadmap.md). The rules that come out of it live in [ui-audit.md](ui-audit.md) under "Accessibility rules".

**How it was done**
- The UI kit (`packages/ui/src`), the composed app (`apps/web/src/shell`, `apps/web/src/compose`) and the viewers (`packages/viewers/src/react`) were read line by line.
- Contrast was computed with colorjs.io (WCAG 2.1 formula) against the default `#6e56cf` theme, in light and dark. Alpha and opacity values were blended over the background.
- The existing gates were reviewed:
  - the axe run over every story (`packages/ui/test/stories.test.tsx`);
  - the acceptance pass (`tests/acceptance/a11y/main-flows.test.tsx`);
  - the theme generator's contrast check (`packages/ui/src/theme/generate.ts`).

Nothing was tested with a real screen reader. That belongs to a manual VoiceOver pass before release, listed at the end.

Severity: **H** means it blocks a task or affects the whole app, **M** means a common path is degraded, and **L** means a detail or edge case.

## Whole-app problems

| # | Problem | WCAG | Sev | Status |
| --- | --- | --- | --- | --- |
| A1 | The toast renderer is never mounted in the composed app. Feed, Library, Goals, Inbox and Ideas call `toast()`, and those messages (including Undo) never appear. | 4.1.3, 3.3.1 | H | Open |
| A2 | `ThemeProvider` is not mounted in `PsycheApp`, so `data-reduce-motion` and high contrast are never applied. The Appearance settings for motion and contrast do nothing, and the avatar's typing animation ignores the OS setting. | 2.2.2, 2.3.3 | H | Open |
| A3 | The shipping shell has no `<main>` landmark and no skip link (`ShellApp.tsx`). The chat route has no h1. | 1.3.1, 2.4.1 | H | Open |
| A4 | The focus ring is `accent-8`, drawn at 50% on buttons and inputs: 1.5:1 to 2.3:1 against the background. | 1.4.11, 2.4.7 | H | Open |
| A5 | Semantic text tokens fail 4.5:1 in light mode: approval amber-11 (4.05 to 4.49), destructive tomato-11 on tomato-3 (4.19 to 4.33), accent-11 on accent-3 (4.39), gray-11 on gray-4 (4.48), gray-10 small text (3.5), and inactive tabs at 60% (4.15). In dark mode, links in accent-9 (3.50) and white on accent-10 (4.44) fail. | 1.4.3 | H | Open |
| A6 | Type and spacing tokens are px (`--spacing: 4px`, px font sizes), so the browser's text-size setting has no effect. Scaling relies on app zoom (`appearance.zoom`, 67% to 200%), which does meet 1.4.4. | 1.4.4 | M | Open (design) |

## Chat column

| # | Location | Finding | WCAG | Sev | Status |
| --- | --- | --- | --- | --- | --- |
| C1 | `chat/Thread.tsx` log + `blocks/MessageBlocks.tsx` | The streaming reply re-renders inside `role="log"` on every token, so screen readers re-announce fragments. | 4.1.3 | H | Open |
| C2 | `chat/ApprovalDock.tsx` | A new, sooner-expiring approval can replace the open card under the user's focus. | 3.2.2, 2.4.3 | H | Open |
| C3 | `ApprovalDock.tsx` | After an answer, focus falls to `body`. | 2.4.3 | M | Open |
| C4 | `ApprovalDock.tsx` | The live region wraps the whole card, so every arrival is read out in full. | 4.1.3 | M | Open |
| C5 | `blocks/ApprovalCard.tsx` | ⌘Return / ⌘D have no visible hint, and Ctrl is accepted but not declared. | 3.3.2, 2.1.1 | M | Open |
| C6 | `web/shell/ShellApp.tsx` | The app-wide approve/deny shortcut looks for `data-testid="approval-dock"`, which the kit dock doesn't carry. | 2.1.1 | M | Open |
| C7 | `ApprovalCard.tsx` | The status paragraph is mounted together with its text, so it often isn't announced. | 4.1.3 | M | Open |
| C8 | `blocks/ToolRun.tsx` | Running and failed state in the collapsed summary is shown only by a hidden dot. | 1.3.1, 1.4.1 | M | Open |
| C9 | `blocks/Receipt.tsx` | The `aria-label` replaces the visible outcome and time. | 1.3.1 | M | Open |
| C10 | `chat/Composer.tsx` | The `/` command menu has no combobox semantics. The textarea is `outline-none` with only a faint border change on focus. The mode hint isn't linked to the textarea. | 4.1.2, 2.4.7 | M | Open |
| C11 | `chat/MessageView.tsx`, `shell/ThreadList.tsx` | The ⋯ actions buttons stay invisible while their menu is open, and are unreachable on touch. | 2.4.7, 2.5 | M | Open |
| C12 | `chat/FollowUpQueue.tsx`, `Thread.tsx`, `Composer.tsx` | The X buttons are about 18 px. | 2.5.8 | M | Open |
| C13 | `agent/AgentHeader.tsx` | The model pill's accessible name doesn't contain its visible label. The run status live region sits on a button. | 2.5.3, 4.1.3 | M | Open |
| C14 | `web/shell/components/Chat.tsx` (fallback view) | `aria-live` wraps per-token streaming text. | 4.1.3 | M | Open |
| C15 | `ApprovalCard.tsx` | No warning before an approval expires. | 2.2.1 | L | Open (design) |
| C16 | `MessageView.tsx` | Cancelling or submitting an edit drops focus. | 2.4.3 | L | Open |
| C17 | `blocks/QuestionCard.tsx` | Several "Preview" buttons share one name. | 2.4.6 | L | Open |

## Toasts

| # | Location | Finding | WCAG | Sev | Status |
| --- | --- | --- | --- | --- | --- |
| T1 | `web/shell/store.ts` | Toasts close after 5 s, with no pause on hover or focus. Error toasts disappear too. | 2.2.1 | M | Open |
| T2 | `web/shell/components/Chrome.tsx` | Each toast is `role="status"` inside an `aria-live` container, so it is announced twice. Errors are shown by colour only. | 4.1.3, 1.4.1 | M | Open |
| T3 | `Chrome.tsx` | "Dismiss" buttons have no context. | 2.4.6 | L | Open |

## Custom widgets

| # | Location | Finding | WCAG | Sev | Status |
| --- | --- | --- | --- | --- | --- |
| W1 | `web/shell/components/Overlays.tsx` (⌘K palette) | Arrow-key selection is not exposed: no combobox, no `aria-activedescendant`. | 4.1.2 | H | Open |
| W2 | `Overlays.tsx` | The palette and shortcut sheet have no `aria-modal`, no focus trap and no focus return, and the sheet has no close button. | 2.4.3, 4.1.2 | M | Open |
| W3 | `web/shell/components/Panes.tsx` | The split and pop-out buttons are named by the glyphs "⧉" and "⇱". | 4.1.2 | H | Open |
| W4 | `Panes.tsx` | Pane tabs carry `role="tab"` without the tabs pattern. | 4.1.2 | M | Open |
| W5 | `Panes.tsx` | The resizers work only by pointer drag and are `aria-hidden`. | 2.1.1, 2.5.7 | M | Open |
| W6 | `web/compose/transcript-mode.tsx` | Radio labels show no focus and are about 20 px tall. | 2.4.7, 2.5.8 | M | Open |
| W7 | `settings/ShortcutRecorder.tsx` | `aria-labelledby` hides the current shortcut and the recording state. | 4.1.2 | M | Open |
| W8 | `settings/RowMoreMenu.tsx` | After the confirm dialog, focus goes to `body`. | 2.4.3 | M | Open |
| W9 | `settings/RadioTableRow.tsx` | The row role hides the radio group's position ("1 of 4"). | 1.3.1 | L | Open |
| W10 | `viewers/SheetEditor.tsx` | The inline `alertdialog` doesn't take focus. The Univer canvas has no role or label. | 4.1.2 | M | Open |
| W11 | `viewers/MarkdownEditor.tsx` | Diff add/remove may be colour-only, and "+3 −2" isn't spelled out. | 1.4.1 | M | Open |
| W12 | `viewers/MarkdownEditor.tsx`, `viewers/states.tsx` | `role="toolbar"` without arrow keys. | 4.1.2 | L | Open |
| W13 | `components/ui/tabs.tsx` | The tab panel can take focus but has `outline-none`. | 2.4.7 | M | Open |
| W14 | `screens/feed/FeedPostCard.tsx` | Citation links can't be told apart from text. | 1.4.1 | M | Open |
| W15 | `screens/files/FilesPane.tsx` | Disclosure lists, not a tree: acceptable. Truncated names lack a title. | 1.4.4 | L | Open |

## Landmarks and headings

| # | Location | Finding | Sev | Status |
| --- | --- | --- | --- | --- |
| L1 | `ShellApp.tsx` | No `<main>`, no skip link (A3). | H | Open |
| L2 | Chat route | No h1; cards start at h3. | M | Open |
| L3 | `screens/onboarding/OnboardingFlow.tsx`, `PsycheApp.tsx` | The step title is an h2 styled as an h1, and there is no `<main>`. | M | Open |
| L4 | `screens/goals/GoalPage.tsx` | The page has an h2 and no h1. | L | Open |

## Motion

| # | Location | Finding | Sev | Status |
| --- | --- | --- | --- | --- |
| M1 | `PsycheApp.tsx` | Reduce motion and high contrast do nothing (A2). | H | Open |
| M2 | `styles/index.css` | The accent change animates `:root` itself, which the reduced-motion selectors don't reach. | L | Open |
| M3 | `agent/ApprovalsPanel.tsx` | `scrollIntoView({behavior:"smooth"})` ignores reduced motion. | L | Open |
| M4 | `web/shell/shell.css` | Only the OS media query is honoured, not the app setting. | L | Open |
| M5 | `theme/ThemeProvider.tsx` `useReducedMotion` | Outside a provider it returns false and ignores the OS. | M | Open |

## Text scaling and target size

| # | Location | Finding | Sev | Status |
| --- | --- | --- | --- | --- |
| S1 | `styles/index.css` | Tokens are in px (A6). | M | Open (design) |
| S2 | `AgentHeader.tsx`, `ThreadList.tsx`, `FilesPane.tsx` | Open | M | Open (design) |
| S3 | `shell/Rail.tsx`, `AgentHeader.tsx`, `FilesPane.tsx`, `FeedPostCard.tsx` | 10 px text. | L | Open (design) |
| S4 | Lists and cards | Truncated text has no `title`. | L | Open |
| S5 | `MessageBlocks.tsx`, `ToolRun.tsx` | Targets are about 22 px tall. | L | Open |

## Contrast (default theme)

The pairs below fail AA. The fixes are token changes, listed with the old ratios.

| Pair | Light | Dark | Fix |
| --- | --- | --- | --- |
| Approval text amber-11 on gray-1/2/3, amber-2/3 | 4.05–4.49 | ≥ 10 | `--approval-text` → amber-12 in light (≥ 7) |
| Destructive tomato-11 on tomato-3; Badge destructive | 4.19–4.33 | ≥ 6 | `--danger-text` → tomato-12 on tinted surfaces |
| accent-11 on accent-3 (Badge accent) | 4.39 | 8.66 | Badge accent text → accent-12 |
| gray-11 on gray-4 (selected rows) | 4.48 | 6.94 | Selected rows use gray-12 text |
| gray-10 as small text | 3.49–3.58 | 4.10–4.40 | gray-10 text → gray-11 |
| Inactive tab text at 60% | 4.15 | 5.82 | Inactive tabs use `text-muted-foreground` |
| Link accent-9 (dark) | 5.25 | 3.50 | Links use accent-11 |
| White on accent-10 (primary hover, dark) | 6.26 | 4.44 | Hover keeps accent-9 and darkens the border |
| Focus ring accent-8 (50% on controls) | 1.48–2.31 | 1.62–3.02 | `--ring` → accent-9 at full opacity, 2 px (≥ 3:1 both modes) |
| Input border gray-7 | 1.54 | 2.05 | Text inputs get gray-8 borders. The 3:1 rule for an input's border is met by its label plus its focus ring; listed for the owner. |
| Pending check icon gray-8 | 1.81 | 2.78 | gray-9 (≥ 3:1) |

The theme generator's contrast check covers only five accent and gray pairs. Gating the semantic scales and the ring is part of this pass (see "Gates" below).

## Gates

- **Stories:** axe already runs on every story (`packages/ui/test/stories.test.tsx`). `region`, `landmark-one-main`, `page-has-heading-one` and `color-contrast` stay off there, because components render outside a page and jsdom can't compute colour.
- **Acceptance:** `tests/acceptance/a11y/main-flows.test.tsx` fails on any violation but checks only six surfaces. The plan:
  - runs the composed app's main screens with `region` and `landmark-one-main` on;
  - keeps a baseline file (`tests/acceptance/a11y/baseline.json`) that can only shrink: a new violation fails, and so does a baseline entry that no longer occurs.
- **Contrast:** extend the theme generator's check to cover the semantic scales (amber, tomato, grass, sky), the ring, and gray-11 on gray-1/3/4 in both modes. Real-browser contrast (axe in Playwright) stays with the desktop e2e suite.
- **Keyboard:** add keyboard-only tests for the chat column (Tab order, composer Shift+Enter, slash menu), Settings (a Tab sweep of a section, switches and radios by keyboard), onboarding (forward and back) and the approval card (arrow keys change the scope, ⌘Return and ⌘D, focus after answering).

## Design changes for the owner

These can't be fixed without a visible change. Each is listed in ui-audit.md's rules as the target.

1. **Text in rem.** Move type and spacing tokens to rem, so the browser's and the OS's text size apply. Fixed-height headers (`h-14`, the 52 px title bar) become minimum heights that grow, and 10 px labels become 12 px.
2. **Toasts.** Error toasts stay until dismissed, and others pause on hover or focus. Toasts need a visible error style that isn't colour-only, and a shortcut to reach them.
3. **Approval card.** Show the ⌘Return / ⌘D hint , give the card a fixed position so new approvals queue instead of swapping, and warn 60 s before expiry.
4. **Touch.** Hover-revealed ⋯ buttons on messages and thread rows are always visible on touch screens, or get a long-press menu.
5. **Focus rings.** Rings are solid, 2 px, accent-9, on every control. They read stronger than today's faint ring.
6. **Pane resizers.** Keyboard-operable separators, plus Split and Resize commands in the palette.
7. **Spreadsheet editor.** Add a table-mode alternative to the Univer canvas for screen-reader users.
8. **Feed citations.** Underline them, or use another non-colour cue.

## Still to do by hand

- A VoiceOver pass on macOS over onboarding, a chat with an approval, Settings, and the Files pane.
- A 200% text-only check in Safari once tokens are in rem.
- Real-browser contrast (axe in Playwright) in the desktop e2e suite, which needs Electron and isn't run per PR.
