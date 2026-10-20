# @psyche/ui

**Owner:** S12 (`prompts/s12-ui-kit.md`). Feature ids: E4, E8 (cards), F3, C4 (UI), O6/O8/O9 (screens), P7 (screen), S1 (UI), R2, R3, U1 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md). Spec: [docs/06-ui-design.md](../../docs/06-ui-design.md).

The React kit that psyche-desktop and psyche-web host: message blocks, approval and question cards, the agent header and sheet, every screen, the avatar system, theming and typed Gateway hooks. It renders typed Gateway data deterministically and never decides anything itself (UI design §1.2): approvals are answered with this surface's single-use token, credentials are never shown, model output is sanitized.

## Entry points

| Import | What |
| --- | --- |
| `@psyche/ui` | Components, screens, hooks, theme (everything below) |
| `@psyche/ui/theme` | Theme generator and `ThemeProvider` only |
| `@psyche/ui/data` | `GatewayClient` interface, `GatewayProvider`, hooks, store |
| `@psyche/ui/testing` | `MockGateway` (protocol-validating, no network) |
| `@psyche/ui/styles.css` | The stylesheet (Tailwind 4 source; see below) |

## How shells embed the kit

```tsx
import "@psyche/ui/styles.css"; // from a CSS pipeline with @tailwindcss/vite
import { AppShell, GatewayProvider, ThemeProvider, UiSlotsProvider, appearanceFromSettings } from "@psyche/ui";

<GatewayProvider client={myGatewayClient}>
  <ThemeProvider settings={appearanceFromSettings(settings)}>
    <UiSlotsProvider value={{ navigate, renderEditor, renderPreview, renderSandboxed, persona }}>
      <AppShell route={route} onNavigate={navigate} panes={<Panes />}>
        {screenForRoute(route)}
      </AppShell>
    </UiSlotsProvider>
  </ThemeProvider>
</GatewayProvider>
```

1. **Gateway**: implement `GatewayClient` (`request(method, params, {idempotencyKey})`, `subscribe(listener)`, `connectionState()`, `onConnectionState()`) over the shell's WS client. Events carry `seq` and `stateVersion`; the store refreshes on gaps and reconnects. The kit adds idempotency keys for side-effecting methods.
2. **Stylesheet**: the shell's Vite config needs `@tailwindcss/vite`; importing `@psyche/ui/styles.css` scans the kit's sources (`@source "../"`). The CSP must allow `style-src 'unsafe-inline'` (the theme is injected as `<style id="psyche-theme">`). Shiki runs on its JavaScript regex engine, so no `wasm-unsafe-eval` is needed.
3. **Theme**: pass `appearance.*` settings to `ThemeProvider`; it regenerates scales on `settings.changed`.
4. **Slots** (`UiSlotsProvider`): `navigate(route)` for the routes in UI design §2.7, `openArtifact` / `openLibraryItem` / `openTask` / `openReceipt`, and the `packages/viewers` (S13) renderers: `renderPreview` (thumbnails and previews), `renderSandboxed` (option previews, email bodies in the artifact sandbox), `renderEditor` (the Rich / Source / Diff Markdown editor). Without slots the kit falls back to plain text and a textarea.
5. **Routing and panes** stay with the shell: `AppShell` takes `route`, `onNavigate`, the screen for non-chat routes as children and the pane area as `panes`.

## Component catalogue

Every item has stories (`pnpm --filter @psyche/ui storybook`).

- **Blocks** (`src/blocks`), one per block type in data model §9.1: `Markdown` (Streamdown, sanitized, safe link schemes only, no images, Shiki code), `ToolRun` / `ToolCallRow` (three disclosure levels, ⌃O), `Checklist` (pinned under the latest agent message), `PlanCard`, `ApprovalCard` (+ `ApprovalDetails` by kind), `QuestionCard`, `ArtifactCard`, `FileCard`, `ReceiptLine`, `TaskCard`, `WrapUpBox`; `MessageBlocks` dispatches a message's blocks and resolves ids through the hooks.
- **Chat** (`src/chat`): `ChatThread` (assistant-ui external-store runtime: viewport, list, composer primitives), `MessageView`, `ApprovalDock` (approvals live here, never in the message stream), `FollowUpQueue`, `Composer` (reply quote, queue mode while the agent works, Send / Stop), `ExportMenu`, `OfflineBanner`.
- **Agent** (`src/agent`): `AgentHeader`, `AgentSheet` / `AgentSheetBody` with `ActivityPanel`, `ApprovalsPanel`, `UpcomingPanel`, `SoulMemoryPanel`; `useAgentStatus` derives the avatar state from tasks, approvals, questions and the connection.
- **Shell** (`src/shell`): `AppShell`, `Rail` (bottom tab bar when compact), `ThreadList`, `CommandPalette` (⌘K), `ShortcutList` (⌘/), `useShortcuts` and the `SHORTCUTS` keyboard map from UI design §4.11.
- **Screens** (`src/screens`): Feed, Ideas, Goals, Library, Search, Notifications inbox, Settings (every section in §3.18), Onboarding.
- **Avatar** (`src/avatar`): `Avatar` (sizes 20 / 28 / 40 / 64 / 160; idle, working, needs-you, error, paused, incognito, offline; delegated ring; reduced motion → static frame plus badge; an `imageSrc` slot for M2 generated avatars) and 12 original SVG creatures (`CREATURES`, the pale moth by default) with idle and two-frame typing poses.
- **Primitives** (`src/components/ui`): shadcn/ui v4 base-nova components on Base UI 1.9, vendored and converted to relative imports.

## Tokens

Colors are OKLCH CSS variables (UI design §4.8):

| Token | Meaning |
| --- | --- |
| `--accent-1..12`, `--accent-a1..12`, `--accent-contrast`, `--accent-surface` | Seed-derived accent scale (1–2 backgrounds, 3–5 component states, 6–8 borders and rings, 9–10 solids, 11–12 text) |
| `--gray-1..12`, `--gray-a1..12` | Gray family (auto-tinted, neutral, slate, mauve, sage, olive, sand) |
| `--amber-*`, `--tomato-*`, `--grass-*`, `--sky-*` | Fixed Radix scales |
| `--approval`, `--danger`, `--success`, `--info`, `--untrusted` (+ `-text`, `-surface`, `-border`) | Semantic tokens; never seed-derived, so Deny never looks like the brand |
| shadcn names (`--primary`, `--border`, `--ring`, …) | Mapped once to the scales (§4.10) |
| `--spacing` (4 px, 3.5 px compact), `--radius` (10 px), `--ease-psyche`, `--duration-*` | Layout, radius, motion |

Tailwind utilities exist for each (`bg-accent-9`, `text-gray-11`, `border-approval-border`, …). Root attributes: `data-theme` (light / dark), `data-density`, `data-reduce-motion`, `data-contrast` (high contrast: borders step 8, text step 12, 2 px rings).

### Design system rules (UI design §4)

Screens inherit the look from these; do not hand-roll a card, header or select.

| Area | Rule | Use |
| --- | --- | --- |
| Type (§4.2) | h1 24/30, h2 20/26, h3 16/22 at 600; body 15/22, small 13/18, caption 12/16, label 11/14 uppercase, mono 13/20 | `text-h1` `text-h2` `text-h3` `text-body` `text-small` `text-caption` `text-label` `text-mono` (the older `text-2xl`…`text-xs` aliases map to the same sizes) |
| Spacing (§4.3) | 4 px base; 2, 4, 8, 12, 16, 24, 32, 48 | `gap-2` `p-4` `gap-6` …; pages use 24 px gutters and a 24 px rhythm (`Page`) |
| Radius (§4.3) | cards 10 (`rounded-lg`), inputs and buttons 8 (`rounded-md`), chips and avatars full, sheets and dialogs 14 (`rounded-xl`), panes 0 | `Card`, `Input`, `NativeSelect`, `Button`, `Badge` already follow it |
| Elevation (§4.4) | 0: page (gray-1); 1: cards and the approval dock, gray-2 with a 1 px gray-6 border, no shadow; 2: popovers, menus (`shadow-level-2`); 3: sheets, dialogs (`shadow-level-3`); dark mode steps surfaces up instead of deepening shadows | `Card` / `.elevation-1`; popovers, selects, menus and dialogs already carry their level |
| Motion (§4.5) | 120 ms hover and toggles (every `transition-*` utility's default), 200 ms cards (`animate-psy-rise`, `animate-psy-fade`), 320 ms sheets; `ease-psyche`; reduced motion makes all of it 0 ms | |
| Icons (§4.6) | Lucide, 1.75 px stroke (set globally on `svg.lucide`), 16 / 20 / 24 | |
| Semantic chips (§4.8) | `Badge` variants `approval`, `success`, `danger`, `info`, `muted`, `accent`; never a raw hue | |
| Incognito (§4.8) | `data-incognito="true"` on a thread's root swaps the accent for gray | |
| Pages (§3.0, §4.13) | `Page` (centred column, `wide` 880 px, `prose` 68ch, `full`), `PageHeader` (h1, facts, one sentence, actions), `SectionLabel`, `EmptyState` (optional icon, one sentence, one action), `ErrorState`, `LoadingCards` | `components/page.tsx` |
| Times (§4.12) | `formatRelative`: "41 min ago", "5 h ago", "yesterday", "4 days ago", then "Oct 2" | `lib/format.ts` |

**Theme generator** (`generateTheme({accentSeed, gray})`): Radix-style 12-step scales per appearance in OKLCH with colorjs.io; the seed lands on step 9, steps 1–8 ease with bezier curves, text on step 9 is chosen with APCA (advisory), and a binding WCAG 2 gate (step 11 ≥ 4.5:1 and step 12 ≥ 7:1 on step 2, contrast text ≥ 4.5:1 on step 9) nudges failing seeds and reports it in `nudged`. Outputs sRGB-mapped and P3 values and alpha scales. `pnpm --filter @psyche/ui gen:theme` regenerates the default theme CSS.

## Data layer

`GatewayStore` keeps normalized collections fed by events: streaming deltas, blocks inserted whole (on a placeholder message when needed), approvals with this surface's answer tokens, and so on. A `seq` gap or a reconnect reruns every registered loader; list results never overwrite an entity an event touched after the list was requested (stateVersion reconciliation); after a reconnect, pending approval cards are stale until the Gateway re-issues them. Mutations may carry optimistic overlays, dropped when the request settles. Hooks: `useThread`, `useThreads`, `useApprovals`, `useApproval`, `useQuestion`, `useQuestions`, `useTasks`, `useTask`, `useReceipt`, `useArtifact`, `useLibrary`, `useLibraryItem`, `useFeed`, `useIdeas`, `useGoals`, `useGoal`, `useNotifications`, `useSettings`, `useAutomations`, `useSearch`, `useMemoryFile`, `useConnection`, `useGatewayQuery` (generic), `useCall`.

## Tests

- `pnpm --filter @psyche/ui test` (Vitest, jsdom; runs in CI): theme generator (contrast gate over 20 seeded random seeds in both modes, alpha compositing, P3 output), fixtures validated against every protocol schema, hooks against `MockGateway` (streaming, approval answer, question answer, gap refresh, reconnect, optimistic rollback, follow-up queue), screen behaviour, and **every story rendered and checked with axe-core**.
- `pnpm --filter @psyche/ui build-storybook && pnpm --filter @psyche/ui test:visual`: Playwright screenshots of every story in light and dark against per-platform baselines in `visual/__screenshots__` (`test:visual:update` rewrites them). Needs a browser, so it is not in CI yet; locally it uses the installed Chrome.

## What is stubbed or missing

See [docs/status/s12.md](../../docs/status/s12.md): protocol gaps (task origin on messages, plan entity, Broker reason, usage summary, …), the Broker expiry choices under "Always allow", and items that wait on other sessions (viewers, panes, OS permission prompts).

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol`; viewers come in through slots.
