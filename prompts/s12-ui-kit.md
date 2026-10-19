# Session S12 — UI kit

You are building Psyche (read `README.md`). You are session **S12 — UI kit**: `packages/ui`, the React components and screens that the desktop and web shells host: message blocks, approval and question cards, Feed/Ideas/Goals/Library/Search/Activity/Soul & Memory/Settings screens, the avatar system and theming. Work in your own worktree on branch `ws/s12-ui-kit`. You own `packages/ui/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/06-ui-design.md` (all; it is your spec: wireframes, element inventories, states, design language, tokens, components, keyboard map, accessibility, copy voice)
3. `docs/02-architecture.md` §4.2 step 5 (structured blocks arrive as typed events), §4.6 (approval scopes), §4.11 (feed/ideas/goals semantics)
4. `docs/04-data-model.md` §9.1 (message blocks) and the wire shapes for ApprovalRequest, Notification, FeedPost, Idea, Goal
5. `docs/03-feature-spec.md` rows E4, E8, F3, C4 (UI), O6, O8, O9, P7, S1 (UI), R2, R3, U1
6. `docs/07-tech-decisions.md` ADR-013 (shadcn v4 on Base UI, assistant-ui, Tailwind 4, OKLCH + Radix-style scales; exclusions)
7. Protocol types; the mock Gateway and fixtures in `packages/testing`
8. Research: `models_memory_mcp_ui_feed.md` "UI kits/theming/shells" (assistant-ui, shadcn v4, Radix color algorithm) and "Feed/ideas/goals" (feedback vocabulary); `meta_muse_app.md` Q1, Q4, Q5 (what Muse's surfaces look like)

## Mission (M1)
- **Foundation**: Tailwind 4, shadcn/ui v4 (Base UI), assistant-ui primitives for the thread; design tokens as CSS variables in OKLCH; a theme generator that turns a user-picked seed color into 12-step accent and gray scales for light and dark (Radix algorithm: seed at step 9, APCA/WCAG check), semantic tokens (approval, danger, success, info); density and reduced-motion support; Storybook (or Ladle) with every component in every state; visual regression snapshots.
- **Message blocks** (renderers for every block type in `docs/04` §9.1): streamed sanitized Markdown (Streamdown or equivalent; code via Shiki), collapsed/expandable tool calls with three disclosure levels, plan block, pinned checklist, **approval card** (summary, bound details, scope radio Allow once / for this task / for this site / Always with expiry / Deny, countdown, requester; disabled/expired/decided states), **question card** (1–4 questions, chips or list, multi-select, Other, previews, recommended first), artifact cards (email preview, file preview via `packages/viewers` slots, browser preview, PDF, finance, itinerary), receipt line, task card with live status, wrap-up box (recap + one question + buttons), follow-up queue, reply quote, export menu.
- **Agent header and sheet**: avatar with states (idle / working typing loop / needs you / error), one-line status snippet, sheet with Activity (task list → actions → raw), Approvals queue, Upcoming, Soul & Memory (file editor host using the Markdown editor from `packages/viewers`, daily-notes browser, search, pause, incognito, import, export, reset with typed confirmation).
- **Screens**: Feed (post cards with citations and clusters, feedback controls, instructions editor, schedule), Ideas (cards with evidence, effort, Let's do it / Edit / Dismiss, recurring toggle), Goals (list by category, goal page with milestones/plan/linked tasks/check-ins/watches, confirm-inferred-goal card), Library (grid/list, filters, Quick Look hook, tags), Search (results grouped by type with filters), Activity, Upcoming, Notifications inbox, Settings (every section in `docs/06`, including the Permissions matrices, Computer-use tiers, Credentials list, Appearance picker, Channels pairing requests, Connectors directory), Onboarding flow (name, creature, vibe/tagline, permissions walkthrough, model choice, first connector), thread list and sidebar components, command palette.
- **Avatar system**: bundled set of original creature illustrations (commission or generate original art; do not copy Meta's "Jolly"), size variants, animation loops honoring reduced motion, generated-avatar slot for M2.
- **Accessibility**: keyboard operation, focus management, labels for cards, high contrast; the keyboard map from `docs/06`.
- **Data layer**: typed hooks over the Gateway WS client (`useThread`, `useApprovals`, `useTasks`, `useFeed`…) built against the protocol and the mock Gateway; optimistic updates with `stateVersion` reconciliation.

## Out of scope
Electron windows/panes (S11), viewer internals (S13; you consume them), Gateway logic.

## Definition of done
- Storybook covering every block, card, screen and state; axe accessibility checks in CI; visual regression baseline; theme generator unit tests (contrast gate for 20 random seeds in both modes); hooks tested against the mock Gateway (streaming, approval decide, question answer, stateVersion refresh).
- README: component catalogue, token reference, how shells embed the kit; `docs/status/s12.md`.

## Suggested subagents
One for tokens/theme generator, one for message blocks and cards, one for screens, one for hooks/data layer, one for accessibility review.

## M2 follow-ons
Generated avatars, Library detail views, settings for VM mode and designated persons, replay scrubber for browser recordings, mobile-width polish for the web shell.
