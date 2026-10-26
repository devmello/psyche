# Psyche motion system

Status: proposal v1 (2026-10-25). It is part of [redesign-2026.md](redesign-2026.md) and replaces docs/06 §4.5 once accepted. Sources are listed at the end; [research/motion-systems.md](research/motion-systems.md) has the full notes with dates.

The constants live in `packages/ui/src/motion/tokens.ts` (a stub in this PR; workstream A wires it). Every number in this document comes from that file. Never hand-type a duration or curve in a component.

## 1. Rules

1. **Motion explains a change of place or state; it never decorates.** Apple: "Don't add motion for the sake of adding motion" (HIG Motion). If you can't say what the animation explains, delete it.
2. **The response comes first and the animation follows.** The UI updates state within one frame of input. Superhuman's rule is under 100 ms per interaction, with a 50 ms target. Animation can never delay a click target, focus, or the next keystroke.
3. **Everything that moves is interruptible.** Movement uses springs, which retarget from the current position *and velocity* (WWDC23 "Animate with springs"). Fixed-duration tweens are only for opacity and colour, which have no velocity to preserve.
4. **Frequent interactions get no motion.**
   - This covers hover, typing, the caret, list selection by keyboard, scrolling, and sending a message.
   - They get an instant colour or fill change, or at most a 100 ms colour tween.
   - Apple: "Generally avoid adding motion to UI interactions that occur frequently."
5. **No bounce in chrome.** Springs are critically damped (bounce 0) by default. A small bounce (≤ 0.15) is allowed only for the two "emphasis" moments in §4.4. Apple's guidance is that bounce above about 0.4 feels exaggerated in UI. Psyche's ceiling is 0.15.
6. **Every animation has a reduced-motion form.** Under `prefers-reduced-motion: reduce` or the Appearance switch, movement (x/y/scale/size) becomes an opacity crossfade of at most 150 ms. Loops become static frames. Blur transitions are removed (WCAG's motion definition no longer exempts blur). See §7.
7. **Compositor-only.** Animate `transform`, `opacity`, and (sparingly) `filter` / `clip-path`. Never animate `width`, `height`, `top/left`, `box-shadow`, `border-radius`, `backdrop-filter`, or a CSS custom property. When layout must change, use FLIP (Motion `layout`) or a crossfade.

## 2. Tokens

### 2.1 Durations (tweens: opacity, colour, fills)

| Token | ms | Use |
| --- | --- | --- |
| `duration.instant` | 0 | Press fills, selection, reduced-motion movement |
| `duration.micro` | 100 | Hover and focus colour, icon tint, checkbox fill |
| `duration.short` | 150 | Fades in and out, popover/menu enter, tooltip, skeleton → content |
| `duration.medium` | 220 | Card opacity on enter, toast enter, route crossfade |
| `duration.long` | 320 | Sheet/dialog backdrop and other large fades only (movement uses springs) |
| `duration.exitFactor` | ×0.7 | Exits run at 70% of their enter duration (exits should finish early) |
| `duration.skeletonDelay` | 150 | No loading UI at all before this (docs/06 §3.0) |
| `duration.staggerStep` | 20 | Per-item list stagger. Capped at 5 items (100 ms total), then simultaneous |

### 2.2 Easing (tweens only)

| Token | Curve | Use |
| --- | --- | --- |
| `ease.standard` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Default for colour/opacity. It is the existing `--ease-psyche` |
| `ease.enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | Things appearing: decelerates hard and settles quietly |
| `ease.exit` | `cubic-bezier(0.4, 0, 1, 1)` | Things leaving: accelerates away |
| `ease.linear` | `linear` | Progress bars, shimmer, the working spinner |

### 2.3 Springs (anything that moves or resizes)

The design parameters are SwiftUI's perceptual `duration` and `bounce`. The physics values use mass 1 and Apple's conversion, which reproduces Apple's own `Spring(duration: 0.5, bounce: 0.3)` → k 157.9, c 17.6 example:
- stiffness k = (2π/duration)²
- damping c = 4π(1 − bounce)/duration

Motion's `visualDuration` is the SwiftUI duration divided by 1.2, read from `motion-dom@14.6.0`'s spring generator. Settle times below are simulated to 1%.

| Token | duration / bounce | k | c | ζ | Motion `visualDuration` / `bounce` | Settles | Use |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `spring.micro` | 0.20 / 0 | 987.0 | 62.83 | 1.00 | 0.167 / 0 | ≈ 0.28 s | Switch knob, segmented-control and tab indicator, sidebar selection pill |
| `spring.snappy` | 0.30 / 0.10 | 438.6 | 37.70 | 0.90 | 0.250 / 0.10 | ≈ 0.31 s | Popover/menu scale-in, disclosure chevrons, card enter rise |
| `spring.smooth` (default) | 0.35 / 0 | 322.3 | 35.90 | 1.00 | 0.292 / 0 | ≈ 0.45 s | Layout moves (FLIP), list insert/reorder, pane open/close, composer growth |
| `spring.gentle` | 0.50 / 0 | 157.9 | 25.13 | 1.00 | 0.417 / 0 | ≈ 0.60 s | Sheets, the agent sheet, onboarding step changes, sidebar collapse |
| `spring.emphasis` | 0.45 / 0.15 | 195.0 | 23.74 | 0.85 | 0.375 / 0.15 | ≈ 0.40 s | Only two places: approval card → receipt, and a goal milestone completing |
| `spring.interactive` | 0.15 / 0.14 | 1754.6 | 72.05 | 0.86 | 0.125 / 0.14 | ≈ 0.20 s | Pointer-driven drags (pane resize, drag to reorder), following the hand |

`spring.smooth` is set globally as `<MotionConfig transition>`. That replaces Motion's own defaults (x/y k 500 / c 25 ≈ ζ 0.56, which is far too bouncy for chrome).

For comparison: Material 3's standard spatial default (k 700, ζ 0.9) sits between `micro` and `snappy`. Its expressive springs (ζ 0.6–0.8) are bouncier than anything here, on purpose: Psyche follows Apple's critically damped default (SwiftUI `Animation.default` is response 0.55, damping 1.0).

### 2.4 CSS forms

Workstream A generates CSS custom properties from `tokens.ts`. CSS can't hand off velocity, so it is used only where interruption is rare:
- `--duration-*`
- `--ease-*`
- `--spring-snappy` / `--spring-smooth` as `linear()` approximations, with their settle times as `--spring-*-duration`. Chromium 113+ supports `linear()`, and Motion can emit duration-based springs as CSS.

## 3. What animates and what never does

| Never animates | Animates |
| --- | --- |
| Typing, the caret, and text selection | Things entering or leaving: cards, rows, toasts, popovers, sheets, panes |
| Streamed tokens never move or scale. They are released one frame at a time and may fade in by opacity only (§4.6) | A change of place: selection pill, tab indicator, list reorder, sidebar collapse, approval → receipt |
| Scroll position, except "jump to latest" (smooth scroll ≤ 300 ms; instant under reduced motion) | A change of state that needs noticing: status dot colour, check-mark draw, milestone fill |
| Hover except colour/fill (no lift, no scale, no shadow growth) | Progress: determinate bars, the working indicator |
| Window resize, and layout during a horizontal resize (Motion blocks it anyway) | Route changes: a 150–220 ms crossfade, never a slide |
| The approval card's position once shown (docs/06 §3.3: buttons never move). It fades in in place | — |
| Numbers that the user must read precisely (countdowns, costs). They update in place with `tabular-nums` | — |
| Anything over 5 s that loops alongside other content, unless it can be paused (WCAG 2.2.2). The avatar loops stop after 5 s idle and on reduced motion | — |

## 4. Choreography

### 4.1 Lists and cards
- **Enter:**
  - opacity 0 → 1 over `duration.medium` with `ease.enter`
  - y 8 px → 0 on `spring.snappy`
  - stagger 20 ms per item, up to 5 items (initial load only; never on incremental inserts during streaming)
- **Insert later** (a new message, a new feed post): the item fades in, and the items around it move with Motion `layout` on `spring.smooth`. Nothing jumps.
- **Exit:**
  - opacity → 0 over 105 ms (`short` × 0.7) with `ease.exit`, without movement
  - the gap closes with `layout` on `spring.smooth`
  - Wrap removals in `AnimatePresence mode="popLayout"`.
- **Reorder** (thread list by activity): `layout` on `spring.smooth`, with a single list `LayoutGroup`.

### 4.2 Popovers, menus, tooltips, the command palette
- **Enter:**
  - origin is the anchor side (`--transform-origin` from Base UI)
  - scale 0.97 → 1 on `spring.snappy`
  - opacity over `duration.short` with `ease.enter`
- **Exit:** opacity only, 105 ms. There's no scale on exit, because exits must never draw the eye.
- **Implementation:** CSS `@starting-style` + `transition-behavior: allow-discrete` on Base UI's `data-open`/`data-closed` (Chrome 117+). No JS is needed. Tooltips have a 500 ms open delay and a 0 ms close.
- **Palette (⌘K):** the same enter. Results update instantly, with no animation per keystroke.

### 4.3 Sheets, dialogs, panes, the sidebar
- **Sheet / agent sheet:** slides in from its edge (x 100% → 0) on `spring.gentle`. The backdrop fades over `duration.long`. Exit is the same spring in reverse, and is interruptible: a second ⌘⇧A mid-open reverses it from where it is.
- **Dialog / alert:** opacity + scale 0.98 → 1 on `spring.snappy`. The backdrop fades 0 → 20% black over `duration.medium`. Alerts never slide.
- **Pane open/close:** the pane column animates its *x* from off-edge on `spring.smooth`. The chat column reflows with `layout` (FLIP) and is never animated by width. Closing a pane is the reverse, and focus returns to the opener immediately.
- **Sidebar collapse (⌘B):** the sidebar translates −100% on `spring.gentle` while the content column reflows with `layout`. Labels don't fade separately.

### 4.4 Shared-layout moves (`layoutId`)
- **Sidebar selection pill:** the selected row's highlight moves to the new row (`layoutId="sidebar-selection"`) on `spring.micro`. Keyboard ↑/↓ moves it instantly, following rule 4.
- **Thread list → thread:** no shared element. The chat column crossfades its content over `duration.short` while the header title updates in place. Moving a thread row into the header would be motion for its own sake, and it happens many times a day.
- **Approval card → receipt** (emphasis):
  - When an approval is answered, the dock card's shell (`layoutId="approval-<id>"`) collapses into the one-line result row in the transcript on `spring.emphasis`. The receipt then appears in the same row.
  - This makes "your decision went *here*" visible, once per approval.
  - Reduced motion: the card fades out over 150 ms and the row fades in.
- **Goal milestone complete** (emphasis): the check-mark draws (SVG `stroke-dashoffset`, 200 ms) and the progress bar fill animates `scaleX` on `spring.emphasis`. Reduced motion: an instant fill and a 150 ms opacity on the mark.
- **Segmented controls and tabs:** the indicator moves with `layoutId` on `spring.micro`.

### 4.5 Navigation between rail screens
- Use React 19.3's `<ViewTransition>` (stable since 2026-09-09) around the content column, with a 180 ms root crossfade and a 4 px y on the incoming page.
- Only route changes use it. It doesn't apply to back/forward (popstate), which React skips anyway.
- **Reduced motion:** a `@media (prefers-reduced-motion: reduce)` rule sets the view-transition animation to opacity only, at 120 ms. React does not do this for you.
- **Why it's limited:** a view transition freezes the old screen as an image and blocks hit-testing during the update, so it's kept short and never used inside the chat column.

### 4.6 Streaming text and the working state
- Streamed text is paced, not animated in space. `useSmoothText` (`lib/smooth-text.ts`) releases deltas once per animation frame at a rate that follows the backlog (catch-up time constant 90 ms, floor 90 chars/s) and drains the tail within 250 ms of the end of the stream. Each newly arrived word fades in by opacity only (140 ms, `ease-out`; no transform, blur or slide, which jank). Finished blocks are memoized and never re-render. Under reduced motion the text appears at once with no fade. The block-level cards that arrive whole (plan, approval, question, artifact, receipt) use the list enter (§4.1).
- The "Wren is working…" line uses one shared opacity pulse: 1.2 s period, 40% → 100%, linear. The avatar's working loop (two frames at 1.5 Hz, docs/06 §4.5) runs only while a task runs, and stops at the end of the run. Under reduced motion both are static, and the state is carried by the text.
- New messages don't push the viewport: the transcript stays anchored to the bottom only when the user is already within 72 px of it (docs/06 §3.2). Otherwise a "jump to latest" pill fades in.

### 4.7 Loading
- **Under 150 ms:** nothing.
- **From 150 ms, until the content arrives:** a skeleton in the shape of the content (rows, cards). It shimmers with a 1.5 s linear gradient sweep, `opacity` only through a `mask-image` translate. Skeleton → content is a 150 ms crossfade, with no layout shift (skeletons reserve the real size).
- **Spinners** appear only inside the control that started an in-place action (a button showing "Connecting…"), never as a page or section loader.
- **Indeterminate long work** (model check, backup): a determinate bar if progress is known. Otherwise the working-line pulse.

### 4.8 Press, hover and focus
- **Hover:** a background fill (`--fill-quaternary` → `--fill-tertiary`) over `duration.micro`. There is no hover on plain text links except the underline, and no `cursor: pointer` on controls (Raycast's native-feel rule; macOS uses the arrow).
- **Press:** fills step one level darker instantly (`duration.instant`), with no scale. The one exception is large tappable tiles (avatar picker, idea cards), which may scale to 0.985 on `spring.micro`. Mac buttons don't shrink.
- **Focus:** the ring appears instantly and is never animated, because it must be visible the moment focus lands.

### 4.9 Steps and the Timeline (run trace)
The run trace ([run-trace-2026.md](run-trace-2026.md) §3.7) follows one rule: only the step that is running moves. Everything else enters, settles and stops. The kit's primitives carry it.

| Element | Primitive | Full motion | Reduced motion |
| --- | --- | --- | --- |
| New step row | `StepRow enter` | `fadeRise` (`spring.snappy`, opacity `duration.medium`) | Appears in place |
| Status change | `StatusGlyph morph` | Glyph crossfade over `duration.short`; a new ✓ scales 0.8 → 1 on `spring.micro`; never on first render | Swaps in place |
| Running label | `StepRow` | `psy-shimmer` mask, removed when the step ends | Static (global rule), the glyph's label says "Running" |
| Elapsed time | `LiveDuration` | Ticks once a second on one shared clock (`useTicker`, `TICK_MS` = 1000), tabular numbers, never animated or announced | Same |
| Live bar | `Bar` | Laid out once to the end of the track, then grows with `transform: scaleX` on the shared clock, `transform 1000ms linear` between ticks | Steps once a second |
| Idle gap | `GapBreak` | Static ⌇; the real length on hover | Same |
| Playhead | `Playhead` | Follows the pointer 1:1, no spring | Same |
| Live sparkline | `Sparkline live` | Redraws at most once a second; each new bucket slides in from the end over `duration.medium` (transform) | Redraws in place |
| Static sparkline | `Sparkline` | Draws in once on `spring.gentle` | Drawn |
| Log → summary row (T2) | — | Height and opacity on `spring.smooth` | Crossfade, 120 ms |
| Summary glyph → Timeline header (T2, T3) | — | Shared `layoutId` | Crossfade |
| Replay play (T3) | — | Bars grow at playback speed | Advances one step every 600 ms |

- Everything animates transform and opacity only. The sparkline path is the one SVG redraw, capped at 1 Hz.
- Live updates batch to one render per animation frame; the Gateway coalesces progress to 4 per second per step (run-trace §4.4).
- Bars use the `--trace-*` colours (`styles/design.css`), each at least 3:1 on the canvas in both appearances (the contrast gate). Wait and queue segments are hatched (`psy-trace-wait`); a helper's bar is striped (`psy-trace-helper`), so kind never relies on colour alone.

## 5. Performance budget

- **Frame budget:** 8.3 ms at 120 Hz. Keep main-thread work per animated frame under 4 ms. Springs are time-based, so they look identical at 60 Hz, which matters for the web client in Safari, where WebKit caps page rendering at about 60 fps.
- **Run off the main thread:** Motion 14.6 runs opacity, transform, independent `x`/`y`/`scale`, `filter`, `clipPath` and `backgroundColor` on WAAPI (hardware-accelerated). Avoid what forces the main thread: `onUpdate`, `repeatType: "mirror"`, damping 0, `transformTemplate`.
- **`will-change`:** never in stylesheets. Motion manages it.
- **Glass:**
  - At most **two** glass surfaces visible at once, never stacked. A toolbar's control groups count as one container, because they never overlap; in practice that's the toolbar groups plus the composer, or plus one popover. The Liquid Glass study measured three small surfaces at +8–15% of one core at 120 Hz on an M5, with refraction costing the same GPU time as plain blur (research/liquid-glass.md §6.3).
  - Blur radius ≤ 24 px.
  - Never animate the blur.
  - Never scroll a large blurred region's backdrop every frame; the scroll edge effect is a static gradient mask, not a live blur, where possible.
- **Measuring 120 Hz:** workstream A adds a dev-only probe that logs rAF deltas next to `screen.getPrimaryDisplay().displayFrequency`. Chromium's ProMotion bug (40202100) is fixed, but nobody has documented Electron reaching 120 Hz, so it must be measured on the owner's Mac.
- **Budget for adding motion:** Motion's `LazyMotion` + `m` with `domAnimation` loaded async is about 14 KiB gzip at first render plus a 17.7 KiB lazy chunk. Use `domMax` (about +14 KiB more) only in the chunks that use `layout`/`layoutId`: the chat column and the sidebar. These are measured on motion@14.6.0 in research §4.

## 6. Implementation map

| Need | Tool |
| --- | --- |
| Hover, focus, press fills, colour changes | Tailwind `transition-colors` with `--duration-micro` / `--ease-standard` (the token defaults) |
| Popover, menu, tooltip, select, dialog enter/exit | CSS `@starting-style` + `allow-discrete`, replacing `tw-animate-css` classes primitive by primitive |
| Interruptible enter/exit, sheets, panes, drag | Motion `m` + `AnimatePresence` inside `LazyMotion` (`domAnimation`, async) |
| Layout moves, `layoutId`, list reorder | Motion `layout` / `layoutId` (`domMax`, loaded only where used) |
| Route crossfade | React `<ViewTransition>` around the content column |
| Skeleton shimmer, working pulse | CSS keyframes on `opacity` / `mask-position` |
| Reduced motion | `<MotionConfig reducedMotion="user">` (drops transform/layout, keeps opacity) + the `reduced:` variant + `@media (prefers-reduced-motion)` for CSS and view transitions |

## 7. Reduced-motion table

All of this applies when the OS has Reduce Motion on or Appearance → Reduce motion is set (`data-reduce-motion="true"`). The global rule keeps `opacity` transitions at `--duration-short` and drops every other transition property, so the fades below survive; it does not zero all transitions.

| Animation | Default | Reduced |
| --- | --- | --- |
| Card / row enter | fade + 8 px rise (`snappy`) | fade 150 ms |
| Exit | fade 105 ms + `layout` close | fade 105 ms, gap closes instantly |
| Popover / menu | scale 0.97 + fade | fade 150 ms |
| Sheet / agent sheet | slide (`gentle`) + backdrop | fade 150 ms (sheet and backdrop together) |
| Dialog | scale 0.98 + fade | fade 150 ms |
| Pane / sidebar collapse | slide + FLIP reflow | instant reflow, pane fades 150 ms |
| Selection pill / tab indicator | `layoutId` move (`micro`) | jumps instantly |
| Approval → receipt | `layoutId` morph (`emphasis`) | card fades out, row fades in, 150 ms each |
| Milestone complete | stroke draw + `scaleX` fill (`emphasis`) | instant fill, mark fades 150 ms |
| Route change | 180 ms crossfade + 4 px y | 120 ms crossfade |
| Working pulse, avatar loops | 1.2 s pulse; 1.5 Hz two-frame loop | static frame; state shown as text and a badge |
| Skeleton shimmer | 1.5 s sweep | static skeleton |
| Jump to latest | smooth scroll ≤ 300 ms | instant |
| Glass blur | static (never animated) | static; also opaque under Reduce Transparency |

## 8. Tests that hold the system

- A unit test in `packages/ui/test/motion-tokens.test.ts` checks every spring's k and c against the formula, and that every animated component reads tokens instead of literals. A biome rule or grep test bans `duration-[0-9]`, `cubic-bezier(` and `transition-all` outside `styles/` and `motion/`.
- Every animated component has a Storybook story rendered with `motion:reduced`. The axe and story test asserts that nothing has a `transform` animation running under reduced motion.
- A layout-shift check: the composed-app e2e (CI only) records CLS while streaming a fixture conversation and opening a pane. The budget is 0.

## Sources

- Apple HIG Motion (change log 2025-09-09): https://developer.apple.com/design/human-interface-guidelines/motion
- Apple HIG Accessibility, Reduce Motion (2025-06-09): https://developer.apple.com/design/human-interface-guidelines/accessibility
- WWDC18 "Designing Fluid Interfaces": https://developer.apple.com/videos/play/wwdc2018/803/
- WWDC23 "Animate with springs": https://developer.apple.com/videos/play/wwdc2023/10158/
- SwiftUI `Spring` and the `.smooth` / `.snappy` / `default` animations (fetched 2026-10-25): https://developer.apple.com/documentation/swiftui/spring, https://developer.apple.com/documentation/swiftui/animation/default
- Material 3 motion tokens, androidx (2026-08-05): https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/StandardMotionTokens.kt
- Motion docs, fetched 2026-10-25:
  - accessibility: https://motion.dev/docs/react-accessibility
  - layout animations: https://motion.dev/docs/react-layout-animations
  - lazy motion: https://motion.dev/docs/react-lazy-motion
  - bundle size: https://motion.dev/docs/react-reduce-bundle-size
  - performance: https://motion.dev/docs/performance
- Motion changelog, 14.6.0 (2026-10-22): https://github.com/motiondivision/motion/blob/main/CHANGELOG.md
- React 19.3 `<ViewTransition>`: the changelog (2026-09-09) at https://github.com/facebook/react/blob/main/CHANGELOG.md and the reference page at https://react.dev/reference/react/ViewTransition
- CSS View Transitions Level 1 (2025-02-16): https://drafts.csswg.org/css-view-transitions-1/
- Chrome, entry/exit animations (2024-09-13): https://developer.chrome.com/blog/entry-exit-animations
- Chrome, the `linear()` easing function (2023-05-25): https://developer.chrome.com/docs/css-ui/css-linear-easing-function
- web.dev, compositor-only properties: https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count
- MDN `will-change` (2026-10-07): https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/will-change
- Chromium ProMotion issue: https://issues.chromium.org/issues/40202100
- WebKit 60 fps issue: https://bugs.webkit.org/show_bug.cgi?id=173434
- WCAG 2.2 SC 2.3.3 (2025-09-16): https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
- WCAG 2.2 SC 2.2.2 (2026-08-10): https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
- Superhuman, "built for speed" (2022-06-28): https://blog.superhuman.com/superhuman-is-built-for-speed/
- Raycast, "A technical deep dive into the new Raycast" (2026-05-14): https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast
