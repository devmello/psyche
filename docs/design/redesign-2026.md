# Psyche redesign 2026: specification and implementation plan

Status: proposal v1 (2026-10-25), for the owner's sign-off. It applies to psyche-desktop (Electron 44) and psyche-web.

Companion documents:
- [motion.md](motion.md), the motion system
- [research/apple-and-reference-apps.md](research/apple-and-reference-apps.md) and [research/motion-systems.md](research/motion-systems.md), the sourced research notes with URLs and dates
- [../06-ui-design.md](../06-ui-design.md), which this document amends: §4 design language, §2.1 rail, §3.1 main window
- [../ui-audit.md](../ui-audit.md), the October 19 audit, now largely closed

**The owner's brief:** the app feels "kind of iffy" and "scrappy like an old Android app". It should be cohesive, Apple-like, high quality and animated, informed by research into modern app design and animation systems.

**The short answer:**
- The October polish wave fixed *components*. The app still feels scrappy because of four *system* problems:
  - everything sits on one flat surface
  - every region draws a hairline box
  - the chrome is as loud as the content
  - nothing moves
- This redesign changes the structure (one sidebar, a unified toolbar, materials), the type scale (macOS text styles), colour (restraint) and motion (springs). It then rebuilds the screens on top, in five parallel workstreams.

---

## 1. What makes the reference apps feel high quality

The research, condensed. Full citations are in the research notes.

| App | What it does that Psyche doesn't |
| --- | --- |
| **Apple, macOS 26** | **Text and type:** body text is 13 pt/16, not 15. Hierarchy comes from Title 1–3 and Headline weights, not colour. **Materials:** glass is only on the navigation and control layer, and content stays opaque ("Don't use Liquid Glass in the content layer"). Hard dividers are replaced by scroll-edge effects. Corners are concentric (inner radius = outer − padding). Sidebars float as inset panes. **Motion:** brief and cancellable, and nothing on frequent interactions. The default spring is critically damped (response 0.55, damping 1.0). |
| **Linear** | Three theme inputs (base, accent, contrast) generated in LCH, which give elevation surfaces automatically. The sidebar is "a few notches dimmer" than content, with smaller icons and muted inactive text. Fewer and softer dividers. "Structure should be felt not seen." "Don't compete for attention you haven't earned." |
| **Raycast** | No `cursor: pointer`, few hover highlights. An action bar that teaches shortcuts. No flicker on appear. Settings in their own window. |
| **Things 3** | Mostly white space, with colour as rare accents. Opening an item is a spatial card transition, not a page change. Type-to-jump. |
| **Superhuman** | Every interaction in under 100 ms (50 ms target). Minimal animation. Shortcut hints in the UI. ⌘K. |
| **Claude desktop, ChatGPT (Electron, 2026)** | Opaque warm-neutral canvas (Claude `#fcfcfb` / `#151515`), no vibrancy, a hidden title bar with custom traffic lights. Reviewers judged them on **structure and clarity before polish**: ChatGPT's nested panes were called "UX hell". |
| **Warp, Arc, Bear, Craft, Reflect, Notion Calendar** | Keyboard-first, a `?`/⌘/ shortcut list, custom-built rendering for speed, one strong idea per surface (Warp's blocks, Arc's sidebar). |

**What these apps have in common, and what Psyche adopts:**
1. One accent colour, used as a signal rather than a theme.
2. Chrome dimmer than content.
3. Opaque content, with translucency only in chrome.
4. Macintosh type sizes.
5. Speed as part of the look.
6. Short, critically damped, interruptible motion that is never on frequent actions.
7. Keyboard everywhere, with the shortcuts visible.

## 2. Audit: why the current app reads as scrappy

The evidence:
- 45 captures of the composed web client served by the mock Gateway (1440×900 and 390×844, light and dark)
- 22 Storybook captures at 1280×800 of the populated states
- a code survey of `packages/ui/src` and `apps/web/src/shell` on `origin/main` at `ba675177`

Captures were taken on 2026-10-25. The Electron e2e was not run, per the machine-load rule.

### 2.1 System-level problems (cross-cutting, highest impact)

| # | Problem | Evidence | Fix (section) |
| --- | --- | --- | --- |
| S1 | **One flat surface.** The rail, thread list, content, cards and settings panels all sit on `gray-1` / `gray-2`. Nothing reads as chrome versus content, so the window looks like a web page in a frame. | Every capture | Materials and surfaces (§3.4) |
| S2 | **Boxes everywhere.** Each region and card draws a 1 px gray-6 border. Settings nests a bordered card inside a bordered card inside a bordered table. Feed is a stack of outlined boxes. The approval card has an amber outline inside a dock with an outline. | Settings → Permissions; Feed; dentist thread | Elevation without borders, grouped inset lists (§3.5) |
| S3 | **Two sidebars.** A 56 px icon rail plus a 260 px thread list, each with its own border. That is two navigation columns where Mac apps have one source list. | Main window | One sidebar (§5.1) |
| S4 | **Type is iOS-sized and flat.** Body is 15 px everywhere, including chrome, while macOS chrome is 13. Hierarchy is mostly size jumps plus colour. Labels at 11 px uppercase compete with titles. Tracking isn't adjusted (SF needs −0.08 at 13 px, −0.23 at 15 and so on, which the web doesn't apply automatically). | Settings list 15 px, chat header | Type scale (§3.2) |
| S5 | **The accent is everywhere.** A 2 px violet ring around the composer at rest, violet radio dots, violet selected rows, violet "Try again" links, violet badges. Linear calls this competing for attention you haven't earned. | Composer, settings matrices | Colour restraint (§3.3) |
| S6 | **Nothing moves, and what does move jumps.** Motion is Tailwind `transition-colors`, `tw-animate-css` enter/exit on some primitives, and 13 spinners. Cards pop in, panes and sheets snap, and lists reflow without FLIP. Twelve files honour reduced motion, and the rest have no motion to reduce. | Code survey | Motion system ([motion.md](motion.md)) |
| S7 | **Two styling systems.** The shell (rail fallback, title bar, panes, splash, banners, toasts) is 716 lines of plain CSS in `apps/web/src/shell/shell.css` with its own `--shell-*` variables. The kit is Tailwind tokens. They drift (header heights, borders, focus). | `shell.css` | Tokens own everything (§7.2) |
| S8 | **Native conventions are missed.** `cursor: pointer` on controls. Always-visible thin scrollbars instead of overlay scrollers. Primary buttons sometimes on the leading side. Destructive confirmations as inline panels. A title bar showing a centred title over a toolbar-less window. Inactive windows look identical to active ones. | Captures | Window chrome (§4), conventions (§3.8) |
| S9 | **Error and empty states shout.** The error banner uses danger-red text for the whole sentence. Empty states are a gray sentence in a large void. | Feed, Goals and Settings error captures | States (§5.9) |
| S10 | **Phone width is cramped.** At 390 px the agent header overflows: the name truncates to "Wr…" and the model pill wraps onto two lines. The view toggle duplicates header controls. | `web-390-chat` | Compact layout (§5.10) |

### 2.2 Screen by screen

| Screen | What reads as scrappy | Apple conventions violated |
| --- | --- | --- |
| **Chat column + composer** | **Header and view controls:** the header is 56 px with a 40 px avatar plus a count badge overlapping it. A second 36 px "View: Normal / Thinking / Verbose" bar sits under the header, so two strips of chrome come before any content. **Messages:** user bubbles are gray-3 pills. Agent text runs full column width at 15 px. Timestamps sit right-aligned under every bubble. **Composer:** a 2 px accent-bordered box with a hint line, a send button and a stop square. It looks like a form field, not a floating control. **Empty chat:** a lone gray sentence. | Toolbar density (two bars). No scroll-edge treatment. The focus ring is drawn at rest. |
| **Tool / approval / question cards** | **Tool runs:** rows are aligned but each has a gray dot plus a "pending" label plus an icon. **Approval:** the card is a dense key–value table with an amber outline, a radio row, "Details", a binding hash, keyboard hints and two buttons. The primary "Allow with scope" is pale violet and reads as disabled. **Question card:** has its own border style. **"Waiting for your approval":** appears as a separate line under each tool run. | Alert/sheet button order is right (Deny leading), but there is no visual default. The card isn't concentric with the dock. |
| **Side chats / thread list** | A search field, a pen icon, "SIDE CHATS" in 11 px caps, and rows with amber dots and dates. **Row and selection:** the row height is 28–32 px, inconsistent with the settings list (36). The selected row is a gray-4 slab with no rounding inset. Archived is a text button. | Sidebar rows should follow the system sidebar sizes (small, medium or large). Selection should be a rounded inset pill using the accent when the window is key and gray when it isn't. |
| **Shell navigation** | **Rail:** 56 px icon-over-label stack (10 px labels), a hamburger at the bottom, and the Psyche mark missing. The rail item highlight is accent-3. **Page titles:** each screen has its own h1, so Feed, Goals and Settings repeat the title the rail already shows. **Title bar:** a 52 px drag bar showing just the thread title. | No unified toolbar. No sidebar show/hide control. Window title and toolbar are separate. |
| **Search** | A centred 80ch column with a big input. Results are grouped by headings. There's no preview and no keyboard affordance shown. | The ⌘K palette and Search look unrelated. |
| **Onboarding** | **Layout:** a left-aligned 896 px form beside a preview card, a numbered stepper and a 12-tile creature grid with borders. Back/Next sit below a rule. **Weight:** it reads like a settings form, not a first-run moment. | macOS 26 onboarding is bold, left-aligned and has a single focus. Too many controls are shown at once. |
| **Splash** | A centred mark that fades into the app. Fine, but the window paints `#fff` before React (no `backgroundColor`), so dark mode flashes. | Electron recommends `backgroundColor` matching the app's background. |
| **Settings** | **Layout:** a second in-page sidebar (20 items with icons) next to the rail. Each section is a bordered card stack. **Permissions:** the matrices are tables with radio columns and mono key labels. **Persona:** repeats the onboarding creature grid inside a card. **Error:** red text across the whole sentence. | **Window:** macOS settings are their own window (⌘,) with grouped inset rows (System Settings style). Here they are a route that hides the app. |
| **Feed** | **Posts:** bordered cards with a kind label in caps, a title and body, a sources row with letter monograms, and four icon buttons. **Rhythm and end:** the same treatment for every post, so there is no rhythm. The end marker is plain text. | Content is fine as cards. They need less outline and more air. |
| **Ideas** | **Cards:** each has evidence, effort and three buttons. The "Let's do it" button is primary on every card, so the screen is a wall of violet. | One primary per view, not per card. |
| **Goals** | **Layout and progress:** a split list and detail. Progress bars are a 4 px accent on gray. **Detail page:** a definition-list page with caps labels (MILESTONES, PLAN, TASKS). **Inferred goal:** a dashed accent box. | It works structurally but looks like a debug view. |
| **Library** | **Navigation and filters:** a tabs pill plus three native selects. **Cards:** file icons in boxes, a Task chip, tags, Open plus three icon actions. | Grid items should be thumbnails with a name underneath, as in Finder, with actions in a context menu. |
| **Persona / Soul & Memory** | **Layout:** the Agent sheet at `/agent/*` stretches four tabs across the full window width. **Editing:** Soul & Memory is a textarea editor with budget text. | A sheet shouldn't become a full-width page with stretched tabs. |
| **Inbox** | **Rows:** kind chips, Approve/Deny inline, and Open on every row. | Fine structurally; the noise level is the problem. |
| **Web at 390 px** | **Header overflow:** the header overflows, the persona name truncates and the model pill wraps. **Bottom tab bar:** 5 tabs with icon and label; the active tab gets an accent tile. | Phone conventions: a 44 px top bar, a single title, and a drawer for threads. |

## 3. Visual language

### 3.1 Principles (five)

1. **Content first; chrome felt, not seen.**
   - Chrome is dimmer, smaller and quieter than content: sidebar, toolbar and status.
   - Translucency belongs to chrome and content stays opaque (Apple Liquid Glass rule; Linear 2026).
2. **Native by default.**
   - macOS text styles, system font, overlay scrollers, trailing primary buttons, the arrow cursor.
   - Settings in their own window, inactive-window dimming, full keyboard access.
   - If AppKit does something a certain way, Psyche does it that way unless docs/06 says why not.
3. **One accent, earned.**
   - The persona accent marks only what the user acts on or where they are: the primary button, the current selection when the window is key, links, the focus ring.
   - Status uses the fixed semantic scales (approval amber, danger, success, info), never the accent.
4. **Motion explains, never decorates.**
   - The response comes first and arrives within 100 ms.
   - Movement is a critically damped, interruptible spring. Frequent actions don't animate.
   - Every animation has a reduced-motion form ([motion.md](motion.md)).
5. **Accessible is the baseline.**
   - WCAG 2.2 AA contrast.
   - Visible focus.
   - Every action reachable by keyboard and named for VoiceOver.
   - Reduce Motion, Reduce Transparency and Increase Contrast each change the rendering, not just the timing.

### 3.2 Grid and type

**Grid:** 8-point with a 4-point half step. The spacing scale is 2 · 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64. Tailwind's `--spacing: 4px` stays, so `p-2` = 8 px. Comfortable density is the default and compact density sets `--spacing: 3.5px` (unchanged).

**Font:**
- `system-ui, -apple-system, "SF Pro Text", "SF Pro", "Inter Variable", "Segoe UI", sans-serif` with `font-optical-sizing: auto`, so SF switches to Display optics at 20 pt and up.
- Mono: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`.
- Inter is self-hosted for Linux and the web only.

**Type scale: macOS text styles** (HIG Typography, change log 2025-12-16). Chrome uses the macOS sizes. Reading content (the chat transcript, feed posts, documents) uses a larger *reading* style, because a conversation is read like a document. Claude, ChatGPT and Notion read at 15–16.

| Token | macOS style | Size / line | Weight | Tracking | Used for |
| --- | --- | --- | --- | --- | --- |
| `text-large-title` | Large Title | 26 / 32 | 700 | +0.22 px | Onboarding headline, empty-state headline |
| `text-title-1` | Title 1 | 22 / 28 | 700 | −0.26 px | Page title (Feed, Goals, Library); settings window section title |
| `text-title-2` | Title 2 | 17 / 22 | 600 | −0.43 px | Card titles (feed post, goal, approval summary), sheet titles |
| `text-title-3` | Title 3 | 15 / 20 | 600 | −0.23 px | Group headers inside a page, dialog titles |
| `text-headline` | Headline | 13 / 16 | 600 | −0.08 px | Row titles, persona name in the toolbar, button labels on primary |
| `text-body` | Body | 13 / 18 | 400 | −0.08 px | All chrome: sidebar rows, settings rows, menus, form labels, buttons |
| `text-reading` | (Psyche) | 15 / 23 | 400 | −0.23 px | Chat messages, feed post bodies, Markdown documents, onboarding copy |
| `text-callout` | Callout | 12 / 16 | 400 | 0 | Secondary line in rows, help text under fields, timestamps |
| `text-subheadline` | Subheadline | 11 / 14 | 400 | +0.06 px | Metadata chips, keyboard hints, status lines |
| `text-caption` | Caption 1 | 11 / 14 | 500 | +0.06 px | Group labels. Sentence case, not caps; Apple stopped using small caps for sidebar headers |
| `text-mono` | — | 12 / 18 | 400 | 0 | Code, paths, command arguments (level 2 only) |

Notes:
- **Minimum size and line heights:** the minimum is 11 px, above Apple's 10, for web legibility and AA. Line heights are 2–4 px looser than AppKit's, because browsers don't clip glyphs the way AppKit does, and the extra lead reads better at 13 px.
- **Weights:** only 400, 500, 600 and 700. Apple advises against Ultralight, Thin and Light.
- **Uppercase:** the existing `text-label` (11/14 uppercase) is retired. Uppercase is only for the approval card's single "APPROVAL NEEDED" eyebrow, if anywhere.

### 3.3 Colour

**The model stays.** Psyche keeps docs/06 §4.8: OKLCH 12-step scales generated from a seed with a WCAG gate. What changes is *which tokens components may use*. Following Linear's three inputs (base, accent, contrast), components never touch raw steps. They use semantic roles that map onto steps per appearance, modeled on AppKit's semantic colours.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| `--canvas` | gray-1, tinted warm (`oklch(0.992 0.003 85)`, about `#fcfcfb`) | `oklch(0.195 0.003 85)` (about `#151515`) | Content background: chat, pages, settings window content |
| `--surface-sidebar` | material (§3.4); fallback `oklch(0.965 0.004 85)` | material; fallback `oklch(0.225 0.004 85)` | Sidebar, settings window sidebar |
| `--surface-raised` | `oklch(1 0 0)` | `oklch(0.245 0.004 85)` | Cards, the approval dock, grouped rows (level 1) |
| `--surface-overlay` | glass (§3.4); fallback `oklch(1 0 0)` | glass; fallback `oklch(0.27 0.004 85)` | Popovers, menus, palette, sheets (level 2–3) |
| `--label-primary` / `-secondary` / `-tertiary` / `-quaternary` | gray-12 / gray-11 / gray-10 at 70% / gray-9 at 55% | the same steps | Text and icons, in four levels like AppKit's label colours. Primary and secondary pass AA on every surface; tertiary is only for non-essential metadata ≥ 13 px at 3:1 |
| `--fill-primary` … `--fill-quaternary` | black at 9 / 6 / 4 / 2.5% | white at 14 / 10 / 7 / 4% | Control backgrounds, hover (quaternary → tertiary), pressed (secondary), selected rows when the window is inactive |
| `--separator` | black at 8% | white at 9% | Hairlines, only where grouping needs them (§3.5) |
| `--accent` | accent-9 | accent-9 (dark-tuned) | Primary buttons, key-window selection, links, focus ring (`--ring` = accent-8 at 60%) |
| `--approval`, `--danger`, `--success`, `--info` | fixed Radix amber / tomato / grass / sky (unchanged) | the same | Status only |

Rules:
- **Accent:**
  - The accent may fill at most one control per view: the primary action.
  - Selected sidebar rows are accent-tinted (`accent-a4` fill, label-primary text) when the window is key, and `fill-secondary` when it isn't. That is Apple's focused versus unfocused selection.
- **Errors:** the error state uses danger only for the icon and an optional leading word. The sentence stays label-primary.
- **Increase Contrast** (`prefers-contrast: more`, or Settings → High contrast): separators go to 20%, labels go one step darker, and materials become opaque with a 1 px `--separator` border. This is Apple's "black or white with a contrasting border".
- **Default seed:** stays `#6e56cf` (the moth's wing spots) so personas look continuous. Restraint fixes the "loud violet" effect; the hue doesn't need to change. The Appearance picker keeps its WCAG gate.

### 3.4 Materials ("glass") and fallbacks

Apple's rule: glass on the navigation and control layer only; never glass on glass; content is opaque. Electron has no Liquid Glass:
- PR #50415 (`setGlassEffect`) closed unmerged on 2026-06-30.
- The community `electron-liquid-glass` addon says "DO NOT USE IN PROD".

Amended 2026-10-25 by the Liquid Glass study ([research/liquid-glass.md](research/liquid-glass.md) §6), which is now the materials decision.

This Mac runs macOS 27, where WWDC26 made sidebars edge to edge again, made glass more opaque and gave every window one radius. That confirms chrome-only glass. `electron-liquid-glass` is not adopted: it places glass under the whole window, samples the desktop, and needs a transparent window.

Every glass surface is a `GlassSurface` with a fallback ladder: **native → refraction → css → opaque** (`resolveGlassImpl`).

| Surface | Desktop (Electron) | Web, Chromium | Web, Safari / Firefox |
| --- | --- | --- | --- |
| **Sidebar**, including the Settings window sidebar | Native `vibrancy: "sidebar"`, `visualEffectState: "followWindow"`, `transparent: false`, behind `appearance.vibrancy` (**off by default** until verified on macOS 27) | Opaque `--surface-sidebar` | Opaque |
| **Toolbar row** (52 px) | **No material.** Opaque canvas with a 24 px scroll-edge fade | Same | Same |
| **Toolbar control groups** (mode and model pills, bell, ⋯) | `ToolbarGroup` → `GlassSurface impl="refraction"` capsule | Refraction | CSS blur |
| **Composer** | `GlassSurface impl="refraction"`, radius = height / 2 | Refraction | CSS blur |
| **Popovers, menus, ⌘K palette** | `.material-glass` (the CSS rung, 72% tint, `blur(20px) saturate(1.6)`) | Same | Same |
| **Agent sheet, Settings sheets, dialogs** | Opaque `--surface-overlay` with `--elevation-3` and a dimming scrim, **no glass** | Same | Same |
| **Clear variant** | Only controls over media (image or video viewer, avatar crop), with a 35% dark dim behind labels | Same | CSS |

- **Tokens:**
  - `--material-glass` (CSS rung), `--material-glass-refraction` (50% overlay), `--material-glass-clear` (15%)
  - `--material-blur` (`blur(20px) saturate(1.6)`), `--material-blur-refraction` (`blur(10px) saturate(1.8)`), `--material-blur-clear`

  All of them become `--surface-overlay` / `none` under Reduce Transparency, Increase Contrast and an inactive window.
- **Opaque rung:** used under Reduce Transparency or Increase Contrast. Each comes from the media queries, the in-app setting, or macOS through `nativeTheme` in main, which also drops the native vibrancy layer. The rung also applies in an inactive window (`data-window-active="false"`), when the budget is exceeded, and when glass would stack on glass (a popover over the composer).
- **Budget:** at most two glass surfaces at once, never stacked (motion.md §5). A toolbar's control groups count as one container, because they never overlap. Measured: refraction costs the same GPU time as plain blur, and no variant drops frames at 120 Hz on an M5.
- **Corner radius:** no hard-coded window radius; the system draws it. Concentric inner radii come from `--radius-window` minus padding.
- **Electron floor:** ≥ 44.9.0 (the Tahoe WindowServer fix), pinned by a test.
- **Scroll edge:** where content scrolls under the toolbar or composer, a 24 px gradient mask fades it. This is Apple's "hard" scroll-edge style for macOS, and it replaces the 1 px border under the toolbar.

### 3.5 Shape, elevation, separators

**Radii** follow the concentric rule: inner radius = outer radius − padding. Ink stays on the 4 px grid.

| Token | px | Use |
| --- | --- | --- |
| `radius-xs` | 4 | Checkboxes, inline code, tag chips inside text |
| `radius-sm` | 6 | Small controls (h-6/h-7 buttons, segmented items), sidebar selection pill (row 28, inset 4 → about 6) |
| `radius-md` | 8 | Regular controls: buttons, inputs, selects, menu items |
| `radius-lg` | 12 | Cards, grouped row containers, the approval dock, popovers |
| `radius-xl` | 16 | Sheets, dialogs, the composer (it's a large control: capsule-like at 1 line) |
| `radius-full` | 9999 | Avatars, badges, pills, toggle tracks |

Large controls are capsules, as in macOS 26: the composer at one line, onboarding primary buttons and the toolbar pill group.

**Elevation:** borders become the exception.

| Level | What | Light | Dark |
| --- | --- | --- | --- |
| 0 | Canvas | `--canvas` | `--canvas` |
| 1 | Cards, grouped rows | `--surface-raised` + `0 0 0 0.5px var(--separator)` + `0 1px 2px black/4%` | `--surface-raised` + `0 0 0 0.5px white/8%` (surfaces step up; no shadow) |
| 2 | Popovers, menus, palette | glass + `0 0 0 0.5px black/10%` + `0 8px 24px black/12%` | glass + `0 0 0 0.5px white/12%` + `0 8px 24px black/40%` |
| 3 | Sheets, dialogs | glass/raised + `0 24px 64px black/18%` | + `0 24px 64px black/50%` |

**Separators** appear only where a grouped list needs them: between rows inside a grouped container, inset to the text start, with 0.5 px hairlines on 2× displays. There are no page-region borders. The sidebar meets the canvas through the material change, with no line.

### 3.6 Iconography

- **Set and sizes:** one set, Lucide, drawn at a stroke matched to the adjacent text weight:
  - 1.5 px at 16 px next to 13 px body text
  - 1.75 px at 20 px in the toolbar and sidebar
  - 2 px at 12–14 px inside badges
- **Mapping:** Lucide names follow docs/06 §4.6.
- **Colour:** icons in chrome are `--label-secondary`. Only the current sidebar item's icon takes the accent, and only when the window is key.
- **Status icons:** one glyph per state across the app, defined once in `components/status.tsx`. No coloured dot *plus* a label *plus* an icon.
- **Persona and avatar:** the persona emoji and avatar never appear as decoration in chrome. The avatar appears in the toolbar (28 px), on agent message runs (20 px) and in the agent sheet (64 px).

### 3.7 Density per surface

| Surface | Row / control height | Padding | Text |
| --- | --- | --- | --- |
| Sidebar | 28 px rows (macOS medium sidebar) | 8 px horizontal; selection inset 4 px | `text-body`; group labels `text-caption` |
| Toolbar | 52 px unified (traffic lights centred at y 19) | 12 px between groups; 28 px controls | `text-headline` title, `text-body` controls |
| Chat transcript | — | 24 px column gutter; 680 px max (`--prose-width` 68ch at 15 px); 20 px between runs | `text-reading` |
| Composer | 44 px at one line, grows to 40% of window height | 12 px | `text-reading` |
| Lists in pages (inbox, activity, library list) | 44 px two-line rows / 32 px one-line rows | 12 px | `text-body` + `text-callout` |
| Settings rows | 36 px grouped rows (System Settings) | 12 px horizontal; 20 px between groups | `text-body` |
| Cards (feed, ideas, goals) | — | 16 px; 12 px between cards | `text-title-2` + `text-reading` |
| Compact (web < 720 px) | 44 px touch targets (WCAG 2.5.8 needs 24 px; Apple's touch minimum is 44) | 16 px gutters | The same tokens |

### 3.8 Conventions checklist (native feel)

Every screen PR is reviewed against this list:
- [ ] No `cursor: pointer` on buttons, rows or menu items. Links keep it.
- [ ] Overlay scrollbars: `scrollbar-width: thin` stays for the web. On desktop, rely on macOS overlay scrollers (`scrollbar-gutter: stable` where layout must not jump).
- [ ] Primary action on the trailing side. Cancel or Deny leading. Destructive actions confirmed in a dialog, not inline.
- [ ] One primary (accent-filled) button per view.
- [ ] Hover highlights only on rows, toolbar buttons and list items; other controls rely on press feedback.
- [ ] Keyboard: every action has a menu item or shortcut. Shortcuts are shown in menus and tooltips (`⌘K`, `⌘N`, `⌘B`, `⌘,`, `⌘/`).
- [ ] Text in sentence case. No all-caps headers. No exclamation marks (docs/06 §4.12).
- [ ] Every string through the catalogue: `t()` / `useI18n`, A12.

## 4. Window chrome (Electron)

Current: `titleBarStyle: "hiddenInset"`, `trafficLightPosition {18, 19}`, a 52 px CSS drag bar (`TitleBar.tsx`), no vibrancy, no `backgroundColor`.

Target:

```
+-------------------+------------------------------------------------------------+
| (o)(o)(o)    [≡]  |  (av) Wren · Holding the 2:30 slot   [balanced v][Sonnet v] (bell) ... |  52 px unified toolbar
|                   |  ~~~~~~~~~~~~~~ scroll-edge fade (24 px) ~~~~~~~~~~~~~~~~~~ |
|  Chat             |                                                            |
|  Search           |            transcript (opaque canvas, 680 px column)       |
|  Feed          3  |                                                            |
|  Ideas            |                                                            |
|  Goals            |                                                            |
|  Library          |                                                            |
|                   |                                                            |
|  Threads      [+] |                                                            |
|  ◉ Main chat      |                                                            |
|    Dentist  •  2m |                                                            |
|    Lisbon      1h |        ╭──────────────────────────────────────────╮        |
|  › Archived (1)   |        │ Message Wren…                  (mic)(↑) │ glass  |
|  (av) Wren · ⚙    |        ╰──────────────────────────────────────────╯        |
+-------------------+------------------------------------------------------------+
  sidebar 248 px, vibrancy                content: opaque --canvas
```

- **Title bar style:**
  - `titleBarStyle: "hidden"` + `trafficLightPosition: { x: 20, y: 19 }`. This is what Claude desktop uses (`hidden`, about 16.5/16.5).
  - With `hidden`, the lights sit on the sidebar material, which is the macOS 26 look: the lights belong to the sidebar pane.
  - y 19 centres the 14 px lights in the 52 px toolbar row. Apple publishes no inset, so the toolbar height is measured at runtime and the position recomputed with zoom (`setWindowButtonPosition`), as Claude does.
- **Sidebar vibrancy:**
  - `vibrancy: "sidebar"`, `visualEffectState: "followWindow"` (inactive windows lose the material, as the HIG requires).
  - `transparent` stays false. The web contents' root background is transparent and the content column paints `--canvas`.
  - Only one vibrancy material is possible per window, which is why the toolbar and overlays use CSS glass.
- **Window background and inactive state:**
  - `backgroundColor`: the `--canvas` hex for the current appearance (light `#fcfcfb`, dark `#151515`), set from `nativeTheme` before `show`, to remove the white flash.
  - `data-window-active` on `<html>`, set from `focus`/`blur`. When inactive, the selection pill turns gray, the toolbar labels go to `--label-tertiary`, and the accent is removed from icons.
- **Unified toolbar:** the content column's toolbar is 52 px and carries:
  - the sidebar toggle (when collapsed)
  - the avatar and persona name
  - the status snippet
  - the mode and model pills, as one glass control group (concentric, `radius-full`)
  - the bell and ⋯

  The second "View" strip is removed: disclosure level moves into ⋯ and ⌃O. The drag region covers the toolbar's empty space only.
- **Sidebar collapse:** ⌘B and the toolbar button. When collapsed, the traffic lights stay and the toolbar starts at x 84.
- **Settings window:** ⌘, opens a separate `BrowserWindow`:
  - 720 × 560, resizable
  - its own sidebar with vibrancy
  - `titleBarStyle: "hidden"`, so the lights sit on the sidebar
  - route `/settings/:section`
  - The web client keeps Settings as an in-app route with the same layout.
- **Pop-outs and quick entry:** keep native frames (unchanged).

## 5. Screens

Wireframes are layout-level. Every string goes through the catalogue.

### 5.1 Sidebar: replaces the rail and the thread list

- **Structure:** one 248 px sidebar (resizable 220–320, persisted), a macOS source list.
  - **Destinations:** Chat, Search, Feed, Ideas, Goals, Library, each a 28 px row with a 16 px icon, the label, and an optional trailing count (`text-callout`, `--label-tertiary`).
  - **"Threads" group:**
    - a `text-caption` header, sentence case, with a trailing `+` (new side chat, ⌘N) and a filter field revealed by ⌘F or a click on the header
    - Main chat first, then side chats sorted by activity
    - each row: title, a trailing relative time (or a status glyph when running or waiting), and an incognito or channel glyph leading
    - "Archived (n)" as a disclosure row
  - **Footer:** the avatar (20 px), persona name and a settings gear (opens the Settings window) on one 44 px row. The bottom-menu items (Usage, Help) move into the gear's menu.
- **Selection:** a rounded inset pill (`radius-sm`, inset 4 px), `accent-a4` when key and `fill-secondary` when not. It moves with `layoutId` (motion.md §4.4).
- **Docs/06 change:** this replaces §2.1's "Rail (56 px)" and §3.1's separate thread list (260 px), and needs owner sign-off. The destinations and their order stay the same, and Muse's information architecture (rail items plus thread list) is kept in one column, as Mail and Notes do.

### 5.2 Chat column

- **Toolbar** (§4): avatar 28 px with the state ring, persona name in `text-headline`, the status snippet in `text-callout` `--label-secondary` (cross-fades at a fixed width), the mode and model pill group, the bell, and ⋯ (export, transcript view level, rename, fork).
- **Transcript:**
  - 680 px centred column, with runs 20 px apart.
  - **User messages:** right-aligned bubbles, `--fill-secondary`, `radius-xl`, max 80% of the column, `text-reading`.
  - **Agent messages:** no bubble. The 20 px avatar and name appear once per run, with the time on hover (tooltip) instead of under every message.
  - **Out-of-turn task messages:** a 0.5 px rule with the label "From task: Price watch", in `text-caption`.
- **Tool activity:** one collapsible row per run: a 16 px tool-family icon, "3 actions · browser, calendar", and a trailing status glyph.
  - Expanded rows are `text-body` with a leading icon, verb + target, and a trailing duration in `--label-tertiary`.
  - Status is one glyph: a spinner while running, a check, a cross, or a clock while waiting. There are no dots or labels.
  - Receipt ids and raw I/O stay at level 2.
- **Plan checklist:** pinned under the latest agent message. Each item has a 16 px circle that fills, with a check that draws on completion. The in-progress item's text is label-primary and the rest are secondary.
- **Empty chat:** never empty (docs/06 §4.13: `chat.greet` opens with the agent's first message). Before the greeting arrives, show the 64 px avatar, "Wren" in `text-title-2` and the tagline, centred at 40% height. Composer suggestions appear as three glass chips above the composer.
- **Composer:**
  - A floating glass capsule (`GlassSurface impl="refraction"`, radius = height / 2; §3.4), 680 px wide and 16 px above the window bottom, with the transcript scrolling beneath it through the scroll-edge fade.
  - **Contents:** attachments (+), the field in `text-reading`, dictation, and one Send/Stop button (28 px, accent fill only when there is text).
  - **States:** at rest, no ring. On focus, a 1 px `--ring` hairline inside the capsule, with no outer glow. Above the capsule sit the follow-up queue (glass chips) and the slash-command menu (level-2 popover).
  - **Growth:** it grows with `layout` (`spring.smooth`) up to 40% of the window height, then scrolls.
- **Jump to latest:** a 28 px glass pill centred above the composer.

### 5.3 Approval, question, wrap-up and receipt

- **Approval dock** (above the composer, opaque `--surface-raised`, level 1, with a 2 px amber leading edge, not a full outline):

```
╭────────────────────────────────────────────────────────────────╮
▌ Approval needed · expires in 28:41                          ⋯  │   text-caption amber + countdown (tabular)
▌ Send an email to jane.ortiz@example.com                        │   text-title-2
▌ Subject  Confirming Tuesday 2:30          Account  Gmail       │   two-column key/value, text-body / callout
▌ Body     3 paragraphs  View                                    │
▌ Wren · Dentist booking · balanced mode, writes ask             │   text-callout secondary
▌ ( Allow once  |  This task  |  This site  |  Always ▾ ) (Deny)  │   one segmented control; Deny preselected
▌                                         [ Deny ]  [ Allow ⌘↩ ] │   trailing primary; Deny leading
╰────────────────────────────────────────────────────────────────╯
```

  - **Fixed structure** (docs/06 §3.3): Deny is preselected, buttons are armed after 400 ms, Return does nothing, ⌘Return approves and ⌘D denies.
  - **What changes:**
    - The scope radios become one segmented control.
    - Binding details, raw ids and the hash move under ⋯ → "Details", a level-2 disclosure.
    - The primary is solid accent once armed. Before that it is `fill-secondary` with a 400 ms progress underline, so it never reads as "disabled forever".
    - Several pending approvals stack as a deck: the top card full, the others as 8 px peeking edges with a count, "2 more".
- **Answered:** the card morphs into the transcript's one-line result row (`layoutId`, `spring.emphasis`), with the receipt line underneath: "Sent to jane.ortiz@… · Gmail 18c4… · 10:07", a success glyph, and `text-callout`.
- **Question card:**
  - The same surface, with an accent-neutral border.
  - Chips are `fill-tertiary` capsules, and the selected chip is accent.
  - Answer is trailing primary and "Skip for now" is a plain button.
  - Once answered, the card collapses to one line per question with a Change link.
- **Wrap-up box:** a recap of up to 300 characters in `text-reading`, one question, and 1–2 buttons (the first is primary). It sits in the transcript as a level-1 card, not as a second dock.

### 5.4 Side chats

- **Creation:** a side chat is a thread in the sidebar, created with `+`, ⌘N, or "Continue in a side chat" from a message's ⋯.
- **Transition:** opening one crossfades the column. The toolbar title becomes the side-chat title, and a breadcrumb leading glyph shows that it was forked from Main chat.
- **Incognito:** a dashed avatar ring, and the accent swapped for gray inside the thread (`data-incognito`, already in the tokens).

### 5.5 Search and ⌘K

- **One surface:**
  - ⌘K opens a level-2 glass palette, 640 px wide and centred at 20% from the top.
  - Results are grouped by kind (Threads, Memory, Library, Feed, Goals, Actions), with the typed filter chips (`in:`, `type:`, `from:`) inline in the field.
  - A preview pane on the right shows the selected result once the window is at least 1080 px wide.
  - A footer shows the keyboard hints (↵ open, ⌘↵ open in a side chat, tab to filter).
- **The Search destination** is the same component, embedded full height in the content column for longer sessions.

### 5.6 Feed, Ideas, Goals

- **Shared page layout:**
  - A page title (`text-title-1`) in the toolbar row, not repeated in the content.
  - The content column at 680 px for Feed and 880 px for Ideas and Goals.
  - Cards at level 1 with no outline, 12 px apart.
- **Feed:**
  - Each post shows a kind line in `text-caption` (secondary), the title in `text-title-2`, and the body in `text-reading`.
  - Sources are favicons (16 px, rounded `radius-xs`) with names, plus a count.
  - Like, Save and Ask are ghost icon buttons that appear on hover or focus and are always visible on touch. Follow, Not interested and Hide are under ⋯.
  - The briefing post at the top is wider, with a 24 px padding hero.
  - The end marker is "That's it for today." in `text-callout`, centred with 48 px of space above.
- **Ideas:**
  - Each card shows the title, a "Because:" evidence line with source links, effort and approvals as callout metadata, and the recurring toggle with its cadence.
  - **"Let's do it" is a plain button on every card.** The only accent primary is on the card the user is focused on or hovering. This is the one-primary rule applied to a list.
- **Goals:**
  - **Split layout:** the list (sidebar-like, 280 px) and the goal page.
  - **Goal page:**
    - the title in `text-title-1`
    - the milestone stepper as a horizontal track with filled nodes, completing on `spring.emphasis`
    - plan / tasks / check-ins / watches as grouped rows (§5.8 style) instead of all-caps definition labels
  - **Inferred-goal candidates:** a level-1 card with a sparkle glyph and Confirm (primary) / Not a goal / Later.

### 5.7 Library and persona

- **Library:**
  - Sections are a segmented control in the toolbar (Documents, Images, Artifacts, Downloads, System files).
  - The grid is Finder-like: 160 px thumbnails (`radius-md`), the name under each thumbnail (2 lines max), and a source-task glyph.
  - Double-click opens the item. Space opens Quick Look on desktop. Actions are in the context menu and ⋯.
  - Filters are a single "Filter" popover button, not three native selects.
  - The list view is a table with 32 px rows.
  - A quarantined download carries an amber badge and its "Trust" action.
- **Persona (agent sheet):**
  - The agent sheet becomes a right-side sheet, 420 px, on opaque `--surface-overlay` with a scrim (no glass, §3.4), opened from the avatar, with its tabs as a segmented control under a header (64 px avatar, name, state, tagline).
  - The `/agent/*` routes render that same sheet over the chat, never as a full-width page.
  - Soul & Memory uses the file list as rows that open the Markdown editor in a level-3 sheet with Rich / Source / Diff.
  - The avatar picker (persona and onboarding) is a 6-column grid of 72 px tiles with the creature only. The selected tile gets an accent ring, with no inner radio.

### 5.8 Settings window

```
+----------------+------------------------------------------------------+
| (o)(o)(o)      |  Permissions                                          |  text-title-1 in a 52 px toolbar
| [Search]       |                                                       |
| ─ General      |  Default mode for new threads                         |
|   Model        |  ╭────────────────────────────────────────────────╮   |  grouped inset list (radius-lg)
|   Persona      |  │ Balanced     Reads run; writes ask first     ◉ │   |  36 px rows, separators inset
|   Appearance   |  │ Manual       Every action asks               ○ │   |
| ─ Access       |  │ Auto         Classifier asks on sensitive     ○ │   |
|   Permissions  |  ╰────────────────────────────────────────────────╯   |
|   Connectors   |  Gmail · read and act                                 |  text-title-3 group header
|   …            |  ╭────────────────────────────────────────────────╮   |
|                |  │ Read threads              [ Allow | Ask | Deny ]│  |  segmented per row
|                |  │ Send                      [ Allow | Ask | Deny ]│  |
+----------------+------------------------------------------------------+
```

- **Sidebar:** the 20 sections are grouped, as System Settings does:
  - General: Model & providers, Persona, Appearance, Voice & dictation, Usage
  - Access: Permissions, Connectors, MCP servers, Skills, Credentials, Computer use, Browser, File access
  - Devices: Devices & nodes, Channels, VM mode, Server & remote access
  - Privacy: Data controls
  - About
  - A search field at the top filters sections and settings.
- **Content:**
  - Every section is grouped inset lists: `--surface-raised`, `radius-lg`, 36 px rows, hairline separators inset to the text start.
  - Labels sit leading in `text-body` and controls trailing.
  - Help text is `text-callout` under its group.
  - Raw keys (`gmail.read`, `mcp__notion__search`) appear only in the row's ⋯ → "Show technical name".
- **Destructive actions** (reset, remove, revoke) open a confirmation dialog with the destructive button trailing in danger.

### 5.9 Onboarding and splash

- **Splash:**
  - The window opens with `backgroundColor` = `--canvas`.
  - The Psyche mark (48 px, `--label-tertiary`) fades in after 300 ms only if pairing hasn't finished.
  - Once pairing finishes, the mark and the app crossfade over `duration.medium`. There's no spinner.
- **Onboarding:**
  - **Layout:**
    - A single centred column, 560 px wide, on `--canvas`, with the Psyche mark at the top.
    - Five dots for the steps instead of a numbered stepper; the labels are announced to VoiceOver.
    - A `text-large-title` headline, bold and left-aligned (macOS 26 onboarding).
    - One decision per screen. Primary trailing, as a capsule (`radius-full`, 36 px); Back is a plain leading button.
  - **Steps:**
    1. Meet your agent: the avatar at 160 px with the tile grid below, then name and tagline.
    2. Connectors.
    3. Model.
    4. Where Wren works.
    5. Done: Wren's first message streams in the real chat behind a fading sheet.
  - **Transitions:** steps change with a horizontal 24 px slide plus a crossfade on `spring.gentle`, or a crossfade under reduced motion.

### 5.10 States

- **Empty:**
  - A 32 px Lucide icon in `--label-tertiary`, then one sentence in `text-reading` (`--label-secondary`), then one plain button.
  - Centred at 35% of the content height, never in a dashed box.
  - The copy follows docs/06 §4.13.
- **Loading:** skeletons in the content's shape after 150 ms (motion.md §4.7).
- **Error:** an inline row on `--surface-raised`. Its parts:
  - danger icon
  - **What failed.** (headline)
  - what Psyche did (body, secondary)
  - one plain button
  - Danger colour is only on the icon.
- **Offline:** a 32 px glass banner under the toolbar ("Psyche can't reach the Gateway. Tasks keep running; this window will reconnect.") with a reconnect countdown. The composer is disabled with its placeholder changed.

### 5.11 Compact (web < 720 px)

- **Top bar:** 44 px. It holds the leading threads-drawer button, the persona avatar (28 px) and name (truncate before the pills, never wrap), and a trailing ⋯ that contains the mode and model pickers, which have no room as pills.
- **Bottom tab bar:** Chat, Feed, Ideas, Goals, Library, as a glass bar, 49 px plus the safe area. The active tab is accent icon and label only, with no tile.
- **Sheets:** the agent sheet and Settings sections are bottom sheets with a grabber.
- **Composer:** pinned above the tab bar.

## 6. Component inventory: current → target

Ownership: A = tokens, motion and chrome; B = chat; C = shell, sidebar and search; D = onboarding, splash and settings; E = content screens (see §7.4).

| Component (packages/ui/src/…) | Current | Target | WS |
| --- | --- | --- | --- |
| `styles/index.css`, `theme-default.css`, `semantic.css` | Radix-style scales, shadcn mapping, old type roles | + semantic roles (§3.3), macOS type scale (§3.2), radii and elevation (§3.5), materials (§3.4), motion CSS variables generated from `motion/tokens.ts`, `reduced`/`high-contrast`/`window-inactive` variants | A |
| `motion/` (new) | stub `tokens.ts` (this PR) | tokens, `MotionProvider` (`LazyMotion` + `MotionConfig reducedMotion="user"`), `Presence`, `FadeIn`, `ListItem`, `useSpring` helpers, CSS generator script | A |
| `components/ui/button` | radius 8, fills, transition-colors | radius per size (sm 6, md 8, large capsule), no pointer cursor, instant press fill, `prominent` variant = accent, `plain` variant | A |
| `components/ui/input`, `textarea`, `native-select`, `select` | radius 8, gray-7 border | `fill-quaternary` well with a 0.5 px separator, focus ring hairline; select menus glass | A |
| `components/ui/popover`, `dropdown-menu`, `hover-card`, `tooltip`, `command` | shadow-level-2, `tw-animate-css` | glass level 2, `@starting-style` enter/exit (motion.md §4.2), 6 px item radius, 28 px items | A |
| `components/ui/dialog`, `alert-dialog`, `sheet`, `drawer` | shadow-level-3 | glass or raised level 3, `spring.gentle` / `snappy` via Motion, trailing primary | A |
| `components/ui/tabs`, `toggle-group` | pill tabs | segmented control with a `layoutId` indicator (`spring.micro`) | A |
| `components/ui/switch`, `checkbox`, `radio-group`, `progress`, `skeleton`, `badge`, `kbd`, `separator`, `scroll-area`, `table`, `card`, `label`, `sonner` | partly retuned in #155 | tokens only (`switch` knob springs, `progress` fills with `scaleX`, `skeleton` shimmer, `card` = level 1 without border, toasts glass + presence) | A |
| `components/page.tsx` | Page, PageHeader, EmptyState, ErrorState, LoadingCards | + `GroupedList` / `GroupedRow` (settings style), `Toolbar` slot API (title, leading, trailing), states per §5.10 | A |
| `components/status.tsx` (new) | — | one status-glyph component for task, tool and approval states | A |
| `shell/AppShell`, `Rail`, `ThreadList` | 56 px rail + 260 px list | `Sidebar` (§5.1) with destinations, threads group and footer; `ThreadList` becomes `ThreadGroup` inside it; `layoutId` selection | C |
| `shell/CommandPalette`, `screens/search/*` | separate palette and search screen | one `SearchSurface` used by ⌘K and the Search destination (§5.5) | C |
| `shell/ShortcutList`, `AppearanceProvider` | dialog; appearance attributes | glass sheet; adds `data-window-active` and reduced-transparency wiring | C (shortcuts), A (provider) |
| `agent/AgentHeader` | 56 px header + View strip | toolbar content (§5.2), status crossfade, pill group | B |
| `agent/AgentSheet`, `ActivityPanel`, `ApprovalsPanel`, `UpcomingPanel`, `SoulMemoryPanel` | sheet or full-width route | 420 px opaque right sheet with a scrim, header, segmented tabs, grouped rows (§5.7) | E |
| `avatar/Avatar` | states, loops | adds a 5 s idle stop and the 28 px toolbar size; loops honour reduced motion (unchanged art) | E |
| `chat/Thread`, `MessageView`, `WorkingIndicator`, `RunFailure`, `OfflineBanner` | flat transcript | §5.2 runs, hover times, task dividers, jump pill, list presence | B |
| `chat/Composer`, `FollowUpQueue`, `commands.ts` | bordered box | floating `GlassSurface` refraction capsule, layout growth, glass queue chips, slash popover (§5.2) | B |
| `chat/ApprovalDock`, `blocks/ApprovalCard`, `approval-details` | amber outline card + rows | §5.3 dock, segmented scope, deck stacking, `layoutId` morph to receipt | B |
| `blocks/QuestionCard`, `WrapUp`, `Receipt`, `ToolRun`, `Checklist`, `TaskCard`, `ArtifactCard`, `DiffBlock`, `Markdown`, `MessageBlocks`, `RelatedThreads`, `disclosure` | individually styled | §5.2 / §5.3 run rows, status glyphs, reading type, level 1 cards | B |
| `chat/ExportMenu` | dropdown | moves into the toolbar ⋯ menu | B |
| `screens/onboarding/*` | form wizard | §5.9 single-column steps, dots, capsule primary, step transitions | D |
| `screens/settings/*` (41 files) | in-app route with a second sidebar, bordered cards | Settings window (§5.8): `SettingsSidebar` grouped, `GroupedList` rows, `ActionMatrix` → segmented rows, technical names under ⋯ | D |
| `screens/feed/*` | outlined cards | §5.6 | E |
| `screens/ideas/*`, `screens/goals/*` | outlined cards, caps labels | §5.6 | E |
| `screens/library/*`, `screens/files/FilesPane` | tabs pill + selects + boxed cards | §5.7 Finder-like grid and table | E |
| `screens/inbox/*` | rows with chips and buttons | grouped rows, status glyphs, inline Approve/Deny only for approvals | E |
| `apps/web/src/shell/*` (`shell.css`, `TitleBar`, `Chrome`, `Panes`, `StartupSplash`, `Overlays`, `BrowserPane`) | 716 lines of plain CSS with `--shell-*` variables | `shell.css` shrinks to structure only (grid, drag regions), every colour, radius and shadow comes from kit tokens; `TitleBar` becomes the toolbar host; panes get §4.3 motion; splash per §5.9 | A (`TitleBar`, splash, `shell.css` tokens), C (`Chrome`, layout, panes) |
| `apps/desktop/src/main/window-options.ts`, `windows.ts` | `hiddenInset`, no vibrancy, no backgroundColor | `hidden`, `trafficLightPosition` recomputed, `vibrancy: "sidebar"` behind a setting, `backgroundColor` per appearance, the Settings window, `data-window-active` IPC | A (D owns the Settings window route content) |

## 7. Technical plan

### 7.1 Motion library: recommendation

**Use all three, each where it fits.** The measurements are in motion.md §5 and research §4.

| Option | Cost | Strengths | Weaknesses | Psyche uses it for |
| --- | --- | --- | --- | --- |
| CSS only (Tailwind transitions, `@starting-style`, `linear()` springs) | 0 KB JS | Compositor-run, zero runtime | No velocity hand-off; exits need tricks; no FLIP | Hover and press fills, popovers and menus (Base UI `data-open`), skeletons, pulses |
| **Motion 14.6** (`motion/react`, `LazyMotion` + `m`) | About 14.0 KiB gz initial + 17.7 KiB lazy `domAnimation`. `domMax` (layout and `layoutId`) about 45 KiB total, only in the chat and sidebar chunks. (Docs claim "~5 kB initial"; this was not reproduced on 14.6.0.) | Interruptible springs with velocity hand-off; `AnimatePresence`; FLIP layout; `layoutId`; WAAPI acceleration for opacity, transform, filter, clipPath and backgroundColor (oklch included); `reducedMotion="user"`; React 19 peer | JS cost; CSS-variable animations not accelerated | Sheets, panes, list presence, reorder, selection pill, approval → receipt, composer growth |
| React 19.3 `<ViewTransition>` | 0 KB beyond React | Route crossfades between arbitrary trees | Not interruptible; old view frozen; hit-testing blocked; reduced motion is manual | Route changes between destinations only |

**Tailwind 4 coexistence:**
- Tokens stay CSS custom properties in `@theme`.
- `motion/tokens.ts` is the source of truth. A build script (`pnpm --filter @psyche/ui gen:motion`) writes `styles/motion.css` with `--duration-*`, `--ease-*` and `linear()` springs.
- Tailwind's `--default-transition-duration` / `-timing-function` point at the tokens (already true since #155).
- `tw-animate-css` stays until every primitive has moved to `@starting-style`, then it is removed.

**Rejected:**
- **GSAP:** licence and size, and it isn't React-idiomatic.
- **react-spring:** smaller ecosystem, no `layoutId` equivalent.
- **The Liquid Glass addon:** "DO NOT USE IN PROD".

### 7.2 Token migration path

1. **Add, don't rename** (A1). The new semantic roles, the type scale, radii, elevation, materials and motion variables are added alongside the old tokens. The old names (`text-label`, `text-h1`…, `--card`, `shadow-level-*`) become aliases of the new ones, so nothing breaks.
2. **Primitives first** (A1). `components/ui/*` switch to the new roles in one PR, and every screen inherits the change.
3. **The shell CSS collapses** (A2). The `--shell-*` variables become aliases of kit roles, then the colour, border and shadow rules are deleted from `shell.css`.
4. **Screens migrate** (B–E), each in its own files, using only the new names. A lint test (motion.md §8 style) fails on old names *in files the PR touches*, so a migration never regresses.
5. **Aliases are removed** (A3, last). Once B–E have merged, one PR deletes the aliases and the `text-label` / `text-h*` roles.

### 7.3 Storybook visual baselines

- The baselines (`packages/ui/visual/__screenshots__`, 254 stories, darwin) are regenerated **per workstream, only for the story titles it owns**, with one worker, in the same PR:

  `pnpm --filter @psyche/ui build-storybook && pnpm --filter @psyche/ui exec playwright test -c visual/playwright.config.ts --update-snapshots --workers=1 -g "<Title prefix>/"`

- Title prefixes per workstream:
  - **A:** `Primitives/` (new stories for every `components/ui` primitive, light and dark), `Motion/`
  - **B:** `Chat/`, `Cards/`, `Blocks/`, `Agent/Header`
  - **C:** `Shell/`, `Screens/Search`
  - **D:** `Screens/Onboarding`, `Screens/Settings`
  - **E:** `Screens/Feed`, `Screens/Ideas`, `Screens/Goals`, `Screens/Library`, `Screens/Inbox`, `Agent/Sheet`, `Avatar/`
- A1 changes every story's look. It regenerates **all** baselines once, in its own commit, so later workstreams start from a fresh baseline.
- Every PR description carries before/after captures from those stories, uploaded to the `assets/ui-polish` branch as in the October wave.
- The composed-app captures come from the web client served by the mock Gateway in Chromium (no Electron locally). CI runs the Electron layout e2e.

### 7.4 Workstreams

**Merge order:**
1. A1 merges first; it is small and blocks nobody.
2. B, C, D and E then run in parallel on top of A1.
3. A2 (window chrome) runs in parallel with B–E, because it owns disjoint files.
4. A3 (alias removal and the final baseline sweep) is last.

Each workstream has disjoint file ownership and uses at most 2 subagents. Locally it runs only `vitest --maxWorkers=1` for its packages and typechecks only those packages. No Electron e2e runs locally, and no local models.

#### A: tokens, motion primitives, window chrome
- **Owns:**
  - `packages/ui/src/{styles,theme,motion,components}/**`
  - `packages/ui/src/shell/AppearanceProvider.tsx`
  - `packages/ui/scripts/**`
  - `apps/web/src/shell/{shell.css,components/TitleBar.tsx,components/StartupSplash.tsx}`
  - `apps/desktop/src/main/{window-options.ts,windows.ts}` and the preload's window-state bridge
- **PRs:**
  - **A1:** tokens, primitives, the motion module, generated CSS, the baseline regen.
  - **A2:** the window chrome.
    - `hidden` title bar, recomputed traffic lights, sidebar vibrancy behind `appearance.vibrancy`, `backgroundColor`, the Settings window shell.
    - `data-window-active`, reduced transparency, a dev-only 120 Hz probe.
  - **A3:** remove the aliases.
- **Definition of done:**
  - Every primitive has light, dark, high-contrast and reduced-motion stories.
  - `motion-tokens.test.ts` passes (formulas, no literals).
  - Axe passes on all primitive stories.
  - Contrast tests pass for every role pair in both appearances.
  - Vibrancy is verified on macOS 26 by the owner, with screenshots in the PR, or the default is flipped to off.
  - Bundle-size delta is reported (`motion` initial chunk ≤ 16 KiB gz).
- **Brief:**
  > You own Psyche's design-system foundation for the 2026 redesign. Read docs/design/redesign-2026.md (§3, §4, §6, §7) and docs/design/motion.md in full. In packages/ui, add the semantic colour roles, the macOS type scale, the radii and elevation, the materials and the motion tokens alongside the existing tokens, with the old names as aliases. Wire `packages/ui/src/motion/tokens.ts` into a `MotionProvider` (`LazyMotion` with async `domAnimation`, `MotionConfig reducedMotion="user"` with `spring.smooth`) and a generated `styles/motion.css`. Move every `components/ui` primitive to the new roles and to `@starting-style` enter/exit (glass for popovers and menus, segmented tabs with a `layoutId` indicator). Then, in a second PR, do the Electron window chrome: `titleBarStyle: "hidden"`, traffic lights at (20, 19) recomputed on zoom, `vibrancy: "sidebar"` with `visualEffectState: "followWindow"` behind an `appearance.vibrancy` setting (verify on macOS 26; default off if it renders grey), `backgroundColor` per appearance, `data-window-active`, Reduce Transparency and Increase Contrast fallbacks, a separate Settings `BrowserWindow` shell on ⌘,, and a dev-only rAF probe that logs refresh rate. Regenerate all Storybook baselines once in A1 with `--workers=1`. Every new string goes through `t()`. Meet WCAG 2.2 AA and give every animation a reduced-motion form. Run `vitest --maxWorkers=1` for packages/ui, apps/web and apps/desktop only. Don't run the Electron e2e or local models. Don't touch `~/.psyche` or `/Applications/Psyche.app`. Merge A1 before anyone else.

#### B: chat column, composer, tool / approval / question cards
- **Owns:**
  - `packages/ui/src/chat/**`
  - `packages/ui/src/blocks/**`
  - `packages/ui/src/agent/AgentHeader.tsx`
  - their stories and tests
  - the chat-slot part of `apps/web/src/compose/PsycheApp.tsx` (`KitChat` only)
- **Definition of done:**
  - §5.2–§5.3 implemented.
  - The approval fixed structure is intact: Deny first, 400 ms arming, ⌘↩ / ⌘D, every state.
  - Approval → receipt `layoutId` morph, with its reduced-motion crossfade.
  - The composer floats as a `GlassSurface impl="refraction"` capsule (§3.4) with a scroll edge.
  - Stories:
    - Chat thread: idle, streaming, approvals deck, answered, offline, compact width, reduced motion, dark
    - Every card state
  - Tests:
    - existing chat, approval and question tests green
    - a new test that streamed text never animates
    - the transcript stays bottom-anchored
- **Brief:**
  > You own the chat column for Psyche's 2026 redesign. Read docs/design/redesign-2026.md (§3, §5.2–§5.4, §6) and docs/design/motion.md, and build on workstream A's tokens and motion primitives (`packages/ui/src/motion`, `components/ui`). Rebuild the following:
  > - The agent header as toolbar content: 28 px avatar, name, status crossfade, the mode and model pill group, the bell and ⋯ (export and transcript view level move here; remove the separate "View" strip).
  > - The transcript: 680 px reading column, `text-reading` messages, times on hover, task dividers, one-row tool runs with status glyphs, a jump-to-latest pill.
  > - The composer as a floating glass capsule with layout growth.
  > - The approval dock as specified, keeping docs/06 §3.3's fixed structure (Deny first, 400 ms arming, ⌘↩ and ⌘D, scope as one segmented control, technical details under ⋯), plus the deck for several approvals and the `layoutId` morph into the receipt row.
  > - The question card, wrap-up box and receipt line.
  >
  > You own `packages/ui/src/{chat,blocks}/**`, `agent/AgentHeader.tsx` and `KitChat` in `apps/web/src/compose/PsycheApp.tsx`, and nothing else. Every animation needs its reduced-motion form, and every string goes through `t()`. Regenerate only the Chat/, Cards/, Blocks/ and Agent/Header Storybook baselines with `--workers=1`, and put before/after captures in each PR. Run only `vitest --maxWorkers=1` for packages/ui and apps/web. Don't run the Electron e2e or local models.

#### C: shell navigation, sidebar, thread list, side chats, search
- **Owns:**
  - `packages/ui/src/shell/**` except `AppearanceProvider.tsx`
  - `packages/ui/src/screens/search/**`
  - `apps/web/src/shell/{ShellApp.tsx,components/Chrome.tsx,components/Panes.tsx,components/Overlays.tsx,layout/**,keyboard.ts}`
  - the shell-slot wiring in `PsycheApp.tsx` (rail, `threadList`, section routing)
- **Definition of done:**
  - §5.1 sidebar: one column with destinations, the threads group and a footer. It is resizable, ⌘B collapses it, and it has the `layoutId` selection.
  - Side chats per §5.4.
  - §5.5 unified ⌘K and Search surface with preview.
  - Pane open and close per motion.md §4.3.
  - Route crossfade via `<ViewTransition>`.
  - Compact (§5.11) top bar, drawer and glass tab bar.
  - Stories: Shell main window (light, dark, inactive, collapsed, compact), Search.
  - Tests:
    - the keyboard map (docs/06 §4.11) intact
    - focus returns to the opener when a pane closes
    - the layout e2e assertions updated: one sidebar, header alignment
- **Brief:**
  > You own Psyche's navigation shell for the 2026 redesign. Read docs/design/redesign-2026.md (§3, §4, §5.1, §5.4, §5.5, §5.11, §6) and docs/design/motion.md, and build on workstream A's tokens and motion primitives. Replace the 56 px rail plus the 260 px thread list with one 248 px macOS-style sidebar. It has destinations (Chat, Search, Feed, Ideas, Goals, Library with counts), a "Threads" group (Main chat, side chats by activity, an incognito or channel glyph, Archived disclosure), and a footer with the persona and a settings gear. Make it resizable (220–320 px), collapsible with ⌘B, and give it a `layoutId` selection pill that's accent when the window is key and gray when it isn't. Merge the ⌘K palette and the Search destination into one search surface with grouped results, typed filters and a preview. Animate panes and the sidebar per motion.md §4.3, and crossfade route changes with React's `<ViewTransition>`, with a reduced-motion CSS rule. At under 720 px, use a 44 px top bar, a threads drawer and a glass bottom tab bar. You own `packages/ui/src/shell/**` (not `AppearanceProvider`), `packages/ui/src/screens/search/**`, and `apps/web/src/shell/{ShellApp.tsx,components/{Chrome,Panes,Overlays}.tsx,layout/**,keyboard.ts}` plus the shell-slot wiring in `PsycheApp.tsx`. Keep the docs/06 §4.11 keyboard map and focus rules intact. Regenerate only the Shell/ and Screens/Search baselines with `--workers=1`. Every string goes through `t()`. Run only `vitest --maxWorkers=1` for packages/ui and apps/web, and update `apps/desktop/e2e/layout.spec.ts` assertions without running them locally.

#### D: onboarding, splash content, settings
- **Owns:**
  - `packages/ui/src/screens/onboarding/**`
  - `packages/ui/src/screens/settings/**`
  - `apps/web/src/compose/{settings.tsx,onboarding.ts,model-setup.ts,permissions.tsx,passkeys.tsx,backups.tsx,logs.tsx,ZoomSetting.tsx,about.ts,helper.tsx}`
  - the Settings window's route content (A2 provides the window)
- **Definition of done:**
  - §5.9 onboarding: single column, dots, capsule primary, one decision per step, step transitions.
  - §5.8 settings: grouped sidebar with search, `GroupedList` rows, `ActionMatrix` as segmented rows, technical names under ⋯, destructive actions confirmed in dialogs.
  - Every section has a story in light and dark.
  - The existing settings and onboarding tests are green. `layout.spec` onboarding assertions are updated (column centred, Back/Next at the bottom).
- **Brief:**
  > You own onboarding and Settings for Psyche's 2026 redesign. Read docs/design/redesign-2026.md (§3, §5.8, §5.9, §5.10, §6) and docs/design/motion.md, and build on workstream A's tokens, the `GroupedList` / `GroupedRow` primitives and the motion module. Rebuild onboarding as a 560 px single column with the Psyche mark, step dots, a `text-large-title` headline, one decision per step, a trailing capsule primary and `spring.gentle` step transitions (crossfade when reduced). The avatar picker is a 72 px tile grid with an accent ring and no inner radios. Rebuild every Settings section (41 files) as System Settings-style grouped inset lists:
  > - a grouped, searchable section sidebar (General, Access, Devices, Privacy, About)
  > - 36 px rows, controls trailing, help text in callout
  > - permission matrices as one Allow/Ask/Deny segmented control per action, with raw keys only under ⋯ → "Show technical name"
  > - destructive actions in confirmation dialogs
  >
  > On desktop the Settings content renders in the separate Settings window that workstream A2 adds. On the web it stays the `/settings/:section` route with the same layout. You own `packages/ui/src/screens/{onboarding,settings}/**` and the settings and onboarding modules in `apps/web/src/compose/`. Every string goes through `t()`, and every control keeps its label and keyboard access. Regenerate only the Screens/Onboarding and Screens/Settings baselines with `--workers=1`. Run only `vitest --maxWorkers=1` for packages/ui and apps/web. Don't run the Electron e2e or local models.

#### E: feed, ideas, goals, library, inbox, persona and agent sheet, empty states
- **Owns:**
  - `packages/ui/src/screens/{feed,ideas,goals,library,inbox,files}/**`
  - `packages/ui/src/agent/**` except `AgentHeader.tsx`
  - `packages/ui/src/avatar/**`
  - the `screenRoute` / `agentRoute` functions in `PsycheApp.tsx`
- **Definition of done:**
  - §5.6–§5.7 and §5.10 implemented.
  - The agent sheet is a 420 px opaque sheet (no glass, §3.4) with a header and segmented tabs, and `/agent/*` renders it over the chat.
  - Library is a Finder-like grid and table with Quick Look on Space.
  - The milestone completes on `spring.emphasis` with a reduced form.
  - The empty, loading and error states follow §5.10 on every screen.
  - Stories: every screen in populated, empty, loading, error, dark and compact states.
  - Tests: the existing screen tests are green.
- **Brief:**
  > You own Psyche's content screens and the agent sheet for the 2026 redesign. Read docs/design/redesign-2026.md (§3, §5.6, §5.7, §5.10, §6) and docs/design/motion.md, and build on workstream A's tokens, page primitives and motion module.
  > - **All screens:** each page title sits in the toolbar row; content is in a 680/880 px column; level-1 cards have no outlines.
  > - **Feed:**
  >   - kind line, title in `text-title-2`, body in `text-reading`
  >   - favicon sources
  >   - ghost Like/Save/Ask on hover or focus, with the rest under ⋯
  >   - a briefing hero and the end marker
  > - **Ideas:** one accent primary at a time.
  > - **Goals:** split list and page, a milestone track that completes on `spring.emphasis`, grouped rows instead of caps labels.
  > - **Library:** a Finder-like 160 px thumbnail grid and a 32 px table, a filter popover instead of native selects, a context menu, Quick Look on Space.
  > - **Inbox:** grouped rows with status glyphs.
  > - **Agent sheet:** a 420 px glass right sheet with a 64 px header and segmented tabs; `/agent/*` renders the sheet over the chat, never full width.
  > - **States:** apply §5.10's empty, loading and error states everywhere.
  >
  > You own `packages/ui/src/screens/{feed,ideas,goals,library,inbox,files}/**`, `packages/ui/src/agent/**` (not `AgentHeader.tsx`), `packages/ui/src/avatar/**` and the `screenRoute`/`agentRoute` functions in `PsycheApp.tsx`. Every string goes through `t()`. Every animation has its reduced-motion form, and avatar loops stop after 5 s idle. Regenerate only the baselines for your screen titles with `--workers=1`. Run only `vitest --maxWorkers=1` for packages/ui and apps/web. Don't run the Electron e2e or local models.

### 7.5 Shared-file rules

- **`PsycheApp.tsx`:** B owns `KitChat`, C owns the shell slots, and E owns `screenRoute` / `agentRoute`. Keep hunks inside those functions; the integrator merges them in order.
- **`packages/ui/src/index.tsx` exports:** each workstream adds its own lines and must not reorder others'.
- **i18n catalogues:** each workstream adds keys only in its own message file (`messages/chat.ts`, `shell.ts`, `settings.ts`, `screens.ts`, `design.ts` for A). New files are fine.
- **Docs:** docs/06 is amended by A3 in one PR at the end. Until then this document wins wherever they disagree.

## 8. Accessibility (part of the system, not a pass)

- **Contrast:**
  - WCAG 2.2 AA: 4.5:1 for text under 18.66 px bold or 24 px regular, and 3:1 for large text and UI component boundaries (SC 1.4.11).
  - Every role pair is tested in both appearances and in high contrast (A1's contrast test).
  - Tertiary labels are only for non-essential text, at 3:1 or better.
- **Focus:**
  - A 2 px `--ring` outline, offset 2 px, on every focusable control. It is never animated and never removed.
  - In lists, the focused row gets the selection fill plus an inset ring (the HIG uses a row highlight for focus in lists).
  - SC 2.4.11, Focus Not Obscured: the floating composer and toolbar reserve scroll padding, so a focused element is never hidden under glass.
- **Keyboard:** the docs/06 §4.11 map, plus:
  - ⌘, for Settings
  - ⌘F to filter threads
  - Space for Quick Look in Library
  - arrow keys in the sidebar and grids
  - every ⋯ menu reachable with Shift+F10 or the context-menu key
- **VoiceOver:**
  - Landmarks: sidebar (`nav`, "Sidebar"), toolbar (`toolbar`), transcript (`log` with `aria-live="polite"` on new agent runs only), composer (`form`).
  - Approval cards are `role="group"` labelled by their summary.
  - Status glyphs carry text.
  - The avatar state is spoken: "Wren, working".
- **Targets:** at least 24 × 24 px (SC 2.5.8). Compact web targets are 44 px.
- **Motion:** [motion.md](motion.md) §7 gives every animation a reduced-motion form. Avatar and working loops stop within 5 s, or pause on reduced motion (SC 2.2.2).
- **Reduce Transparency:** `prefers-reduced-transparency: reduce` and Appearance → Reduce transparency make every material opaque.
- **Increase Contrast:** `prefers-contrast: more` applies the §3.3 rules.

## 9. Decisions the owner should confirm

1. **One sidebar instead of the rail plus the thread list** (§5.1). This amends docs/06 §2.1 and §3.1.
2. **Settings in their own window on desktop** (§4, §5.8). The web client keeps the route.
3. **13 px chrome and 15 px reading text** (§3.2). This replaces the 15 px everywhere from docs/06 §4.2.
4. **Native sidebar vibrancy, default on, behind a setting.** It falls back to opaque if it misbehaves on macOS 26 (§3.4).
5. **Adding `motion@14.6` as a dependency.** About 14 KiB gz initial plus lazy chunks (§7.1).

## Sources

The key sources are below. Every fact in §1–§4 is cited, with its date, in [research/apple-and-reference-apps.md](research/apple-and-reference-apps.md) and [research/motion-systems.md](research/motion-systems.md).

**Apple Human Interface Guidelines:**
- Typography (2025-12-16): https://developer.apple.com/design/human-interface-guidelines/typography
- Materials (2025-09-09): https://developer.apple.com/design/human-interface-guidelines/materials
- Sidebars (2026-06-08): https://developer.apple.com/design/human-interface-guidelines/sidebars
- Toolbars (2025-12-16): https://developer.apple.com/design/human-interface-guidelines/toolbars
- Windows (2025-06-09): https://developer.apple.com/design/human-interface-guidelines/windows
- Motion (2025-09-09): https://developer.apple.com/design/human-interface-guidelines/motion
- Focus and selection (2023-10-24): https://developer.apple.com/design/human-interface-guidelines/focus-and-selection

**Apple, other:**
- WWDC25 219 "Meet Liquid Glass": https://developer.apple.com/videos/play/wwdc2025/219/
- WWDC25 356 "Get to know the new design system": https://developer.apple.com/videos/play/wwdc2025/356/
- WWDC25 310 "Build an AppKit app with the new design": https://developer.apple.com/videos/play/wwdc2025/310/
- Apple newsroom, new software design (2025-06-09): https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/

**Electron:**
- BaseWindow options (fetched 2026-10-25): https://www.electronjs.org/docs/latest/api/structures/base-window-options
- Custom window styles: https://www.electronjs.org/docs/latest/tutorial/custom-window-styles
- Liquid Glass PR #50415 (closed 2026-06-30): https://github.com/electron/electron/pull/50415
- electron-liquid-glass: https://github.com/Meridius-Labs/electron-liquid-glass
- Tahoe GPU fix (2025-10-10): https://appleinsider.com/articles/25/10/10/update-your-slack-discord-clients-the-electron-tahoe-gpu-slowdown-bug-is-fixed
- MDN `backdrop-filter` (2026-04-20): https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter

**Reference apps:**
- Linear: https://linear.app/now/how-we-redesigned-the-linear-ui (2024-03-28) and https://linear.app/now/behind-the-latest-design-refresh (2026-03-12)
- Raycast: https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast (2026-05-14)
- Superhuman: https://blog.superhuman.com/superhuman-is-built-for-speed/ (2022-06-28)
- Things 3, MacStories review (2017-05): https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/
- ChatGPT Electron app reception: https://mjtsai.com/blog/2026/07/10/ (2026-07-10)
- Claude desktop: local inspection of `/Applications/Claude.app` on 2026-10-25

**Motion, accessibility and performance:** see [motion.md](motion.md) § Sources.
