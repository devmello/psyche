# Motion system research for Psyche (Electron 44 / Chromium 152, React 19.3, Tailwind 4.3)

Compiled 2026-10-25. Every fact has a source URL and that page's date. "Fetched 2026-10-25" means the page has no date. "Measured" means I ran it locally on 2026-10-25, with the command described.

Platform baseline: Electron 44.0.0 shipped 2026-08-24 on Chromium 152.0.7977.54. The current 44.9.3 (2026-10-21) is on 152.0.7977.167, and Electron 45.0.0 (2026-10-21) is on Chromium 156. Source: https://releases.electronjs.org/releases.json (fetched 2026-10-25). Every Chromium feature below shipped well before 152.

---

## 1. Apple's motion principles

### HIG "Motion" (change log: last entry 2025-09-09, "Added guidance for Liquid Glass")
Source: https://developer.apple.com/design/human-interface-guidelines/motion (JSON at https://developer.apple.com/tutorials/data/design/human-interface-guidelines/motion.json)
- Use motion on purpose. "Don't add motion for the sake of adding motion." Gratuitous animation can distract people or make them physically uncomfortable.
- Make motion optional. Don't use it as the only way to communicate important information.
- Feedback motion should be realistic and follow the gesture. If a view slides down to reveal, it shouldn't be dismissed by sliding sideways.
- Keep feedback animations brief and precise.
- In apps, avoid adding motion to interactions that happen often. People shouldn't pay attention to unnecessary motion every time.
- **Let people cancel motion.** Don't make people wait for an animation to finish before they can act, especially an animation they'll see repeatedly.
- macOS has no extra platform considerations ("No additional considerations for iOS, iPadOS, macOS, or tvOS").
- For visionOS, avoid sustained oscillation near 0.2 Hz, because people are very sensitive to that frequency.

### HIG "Accessibility": Reduce Motion (change log: last entry 2025-06-09)
Source: https://developer.apple.com/design/human-interface-guidelines/accessibility
- When Reduce Motion is on, apps should reduce "automatic and repetitive animations, including zooming, scaling, and peripheral motion."
- The listed techniques are: tighten springs to reduce bounce; track animations directly with gestures; avoid animating z-depth changes; **replace x/y/z transitions with fades**; avoid animating into and out of blurs.

### WWDC18 "Designing Fluid Interfaces" (session 803, June 2018)
Source: https://developer.apple.com/videos/play/wwdc2018/803/
- Latency: users are very sensitive to lag. Remove delays everywhere, including taps and presses.
- **Interruptibility and redirection:** thought and gesture happen in parallel. For example, the user can interrupt an app launch and go straight to multitasking. The UI must accept a new target mid-flight.
- **Velocity preservation:** the gesture's momentum carries into the animation ("preserving all your energy and momentum"). Use momentum projection: predict the resting point from release velocity and a deceleration rate instead of snapping to the nearest endpoint.
- Springs are described by two designer-friendly parameters: **damping** (100% means no overshoot, 0% oscillates forever) and **response**. Start at 100% damping, and keep bounce for gestures that have momentum. Music uses 100% damping for a tap but 80% for swipe-to-dismiss with momentum.

### WWDC23 "Animate with springs" (session 10158, June 2023)
Source: https://developer.apple.com/videos/play/wwdc2023/10158/
- Springs are "the only type of animation that maintains continuity" in both the static case and the case with an initial velocity. Ease curves can't represent an initial velocity, so they jerk to a halt when a gesture ends.
- Retargeting: "a spring animation uses the velocity it had when it was retargeted" as its new initial velocity.
- Parameters are a perceptual **duration** plus a **bounce** from -1 to 1. Start at bounce 0. Values above about 0.4 can feel too exaggerated for UI.
- Completion handlers use the perceptual duration, not the settling duration.

### SwiftUI spring APIs: defaults verified against Apple's doc JSON (fetched 2026-10-25)
| API | Default values | Source |
|---|---|---|
| `.spring(response:dampingFraction:blendDuration:)` | response **0.5**, dampingFraction **0.825**, blendDuration 0 | https://developer.apple.com/documentation/swiftui/animation/spring(response:dampingfraction:blendduration:) |
| `.spring(duration:bounce:blendDuration:)` | duration **0.5**, bounce **0.0** | https://developer.apple.com/documentation/swiftui/animation/spring(duration:bounce:blendduration:) |
| `.smooth(duration:extraBounce:)` | duration **0.5**, extraBounce 0, base bounce **0** | https://developer.apple.com/documentation/swiftui/animation/smooth(duration:extrabounce:) |
| `.snappy(duration:extraBounce:)` | duration **0.5**, extraBounce 0, base bounce **0.15** | https://developer.apple.com/documentation/swiftui/animation/snappy(duration:extrabounce:) |
| `.bouncy(duration:extraBounce:)` | duration **0.5**, extraBounce 0, base bounce **0.3** | https://developer.apple.com/documentation/swiftui/animation/bouncy(duration:extrabounce:) |
| `.interactiveSpring(...)` | response **0.15**, dampingFraction **0.86**, blendDuration **0.25** | https://developer.apple.com/documentation/swiftui/animation/interactivespring(response:dampingfraction:blendduration:) |
| `Animation.default` (iOS 17 / macOS 14 and later) | a spring with response **0.55**, dampingFraction **1.0**, blendDuration 0 | https://developer.apple.com/documentation/swiftui/animation/default |

- The brief said ".smooth = response 0.5 / damping 1.0". That's correct in substance. Apple's docs express it as duration 0.5 and bounce 0, and bounce 0 means critically damped (damping fraction 1.0).
- Apple's docs explain velocity preservation directly. When springs are mixed on the same property, "each animation will be replaced by their successor, preserving velocity from one animation to the next." Source: the `spring(response:…)` page above.
- `duration` is "approximately equal to the settling duration, but for very bouncy springs, will be the duration of the period of oscillation." Source: the `spring(duration:bounce:)` page above.

### Why interruptible, velocity-preserving motion matters (synthesis of the sources above)
- On a desktop app, people re-click toggles, reverse hovers, close a sheet while it opens, and switch tabs mid-transition. A fixed-duration ease restarts from zero velocity, which causes a visible "hitch" or a 300 ms wait. HIG says "Let people cancel motion."
- A spring retargets from its current position *and velocity*, so reversing mid-flight is continuous (WWDC23).

---

## 2. Material 3 Expressive motion, for contrast

M3 replaced easing and duration tokens with a **motion-physics** system. There are two spring families, each with fast, default and slow speeds:
- **Spatial** springs are for animations that "may change the shape or bounds of the component" (position, size, rotation).
- **Effects** springs are for animations that "do not change the shape or bounds" (color, alpha). They're critically damped so they never overshoot.
- Source: the KDoc in androidx `MotionScheme.kt`, https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/MotionScheme.kt (fetched 2026-10-25). `standard()` is restrained. `expressive()` is "recommended … for prominent UI elements and hero interactions."

The token values below come from the primary source, the androidx token files. The latest commit is dated 2026-08-05:
- https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/StandardMotionTokens.kt
- https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/ExpressiveMotionTokens.kt

| Token | Standard (damping ratio / stiffness) | Expressive (damping ratio / stiffness) |
|---|---|---|
| Spatial fast | 0.9 / 1400 | 0.6 / 800 |
| Spatial default | 0.9 / 700 | 0.8 / 380 |
| Spatial slow | 0.9 / 300 | 0.8 / 200 |
| Effects fast | 1.0 / 3800 | 1.0 / 3800 |
| Effects default | 1.0 / 1600 | 1.0 / 1600 |
| Effects slow | 1.0 / 800 | 1.0 / 800 |

- Compose `spring()` uses mass 1, so the absolute damping coefficient is c = 2ζ√k.
- Two third-party Flutter packages disagree on expressive default spatial damping (0.73 vs 0.8). The androidx source says **0.8**. The packages are https://pub.dev/packages/motor and https://pub.dev/documentation/material_expressive/0.8.0/ (both fetched 2026-10-25).
- m3.material.io pages are client-rendered and could not be fetched. Treat the androidx tokens as canonical.

---

## 3. Spring physics

### Model
- A damped harmonic oscillator: m·x'' + c·x' + k·x = 0.
- Natural frequency ω = √(k/m). Damping ratio ζ = c / (2√(k·m)).
- ζ = 1 is critically damped (fastest settle, no overshoot). ζ < 1 overshoots (bounce). ζ > 1 is overdamped.

### Apple's perceptual-to-physics conversion
- Apple's `Spring` doc example: `Spring(duration: 0.5, bounce: 0.3)` gives mass 1.0, stiffness 157.9, damping 17.6. `Spring(mass: 1, stiffness: 100, damping: 10)` gives duration 0.63 and bounce 0.5. Source: https://developer.apple.com/documentation/swiftui/spring (fetched 2026-10-25; macOS 14+).
- Those numbers fit these formulas. I checked them against both of Apple's examples.
  - **stiffness k = (2π / duration)² · m**
  - **damping c = 4π · (1 − bounce) · m / duration** when bounce ≥ 0 (that is, ζ = 1 − bounce)
  - **c = 4π · m / (duration · (1 + bounce))** when bounce < 0 (that is, ζ = 1/(1+bounce))
  - Inverse: duration = 2π/√(k/m), and bounce = 1 − ζ (or 1 − 1/ζ when ζ > 1).
- WWDC23 presents the same mapping. The transcript rendering I fetched garbled the damping line, so use the formulas above. They reproduce Apple's 157.9 / 17.6 example exactly.

### Motion's conversion (read from the installed `motion-dom@14.6.0` source, `dist/es/animation/generators/spring.mjs`, published 2026-10-22)
- `visualDuration` (seconds) plus `bounce`: ω = 2π / (1.2 · visualDuration), stiffness = ω², damping = 2·ζ·√stiffness, with ζ = 1 − bounce. A comment in the source says this maps bounce to a damping ratio "as SwiftUI does". Negative bounce has been supported since 13.5.0.
- Equivalence: **Motion visualDuration = SwiftUI duration / 1.2**. For example, SwiftUI `.smooth` (0.5 s) ≈ Motion `{ type: "spring", visualDuration: 0.417, bounce: 0 }`.
- The legacy `duration` plus `bounce` path uses a Newton-solver ("findSpring") instead.
- If you set stiffness, damping or mass, they override duration and bounce (https://motion.dev/docs/react-transitions, fetched 2026-10-25).
- Raw defaults are stiffness 100, damping 10 and mass 1. Duration/bounce defaults are bounce 0.3 and visualDuration 0.3. Rest thresholds: restSpeed 2 and restDelta 0.5 (0.01 and 0.005 for small "granular" values). Source: `springDefaults` in the same file.
  - The motion.dev transitions page lists stiffness default "1" and bounce "0.25". The shipped code says 100 and 0.3, so trust the code.
- Motion's **default transitions** with no `transition` prop (`motion-dom/dist/es/animation/utils/default-transitions.mjs`):
  - x, y and rotate use a spring with stiffness 500 and damping 25 (ζ ≈ 0.56, quite bouncy).
  - scale uses stiffness 550 and damping 30, or critically damped when animating to 0.
  - opacity and colors use a 0.3 s tween with ease `[0.25, 0.1, 0.35, 1]`.
  - Keyframe sequences use 0.8 s.
  - Psyche should override these globally through `<MotionConfig transition>`.

### Preset conversion table (computed with the formulas above; mass 1; 1% settle time simulated numerically)
| Preset | k | c | ζ | SwiftUI duration / bounce | Motion visualDuration / bounce |
|---|---|---|---|---|---|
| SwiftUI .smooth | 157.9 | 25.13 | 1.00 | 0.50 / 0 | 0.417 / 0 (settles about 0.53 s) |
| SwiftUI .snappy | 157.9 | 21.36 | 0.85 | 0.50 / 0.15 | 0.417 / 0.15 (settles about 0.36 s) |
| SwiftUI .bouncy | 157.9 | 17.59 | 0.70 | 0.50 / 0.30 | 0.417 / 0.30 |
| SwiftUI `.spring` default (r 0.5, df 0.825) | 157.9 | 20.73 | 0.825 | 0.50 / 0.175 | 0.417 / 0.175 |
| SwiftUI interactiveSpring | 1754.6 | 72.05 | 0.86 | 0.15 / 0.14 | 0.125 / 0.14 |
| M3 std spatial fast | 1400 | 67.35 | 0.9 | 0.168 / 0.10 | 0.140 / 0.10 |
| M3 std spatial default | 700 | 47.62 | 0.9 | 0.237 / 0.10 | 0.198 / 0.10 (settles about 0.20 s) |
| M3 std spatial slow | 300 | 31.18 | 0.9 | 0.363 / 0.10 | 0.302 / 0.10 |
| M3 expr spatial default | 380 | 31.19 | 0.8 | 0.322 / 0.20 | 0.269 / 0.20 |
| M3 effects default | 1600 | 80.0 | 1.0 | 0.157 / 0 | 0.131 / 0 |
| Motion default x/y | 500 | 25 | 0.56 | 0.281 / 0.44 | 0.234 / 0.44 |

### Why springs beat cubic-béziers for interruptible UI
- A bézier is a function of normalized time. It has no concept of the current velocity, so retargeting either restarts the curve (a velocity discontinuity) or needs bespoke blending.
- A spring is a function of state (position and velocity), so retargeting continues smoothly (WWDC23 above; SwiftUI `spring` doc above).
- Springs can also take gesture release velocity as an initial condition, which an ease curve can't represent (WWDC23).
- Caveat: a spring expressed as CSS `linear()` or a WAAPI keyframe list is a *pre-baked* curve. It loses velocity hand-off unless the runtime regenerates it from the current velocity. Motion's changelog 14.1.1 fixed "velocity hand-off for hardware-accelerated springs", which means Motion regenerates it. Source: https://github.com/motiondivision/motion/blob/main/CHANGELOG.md (entry dated 2026-10-13).

---

## 4. The `motion` library (motion.dev), as of late October 2026

### Version
- `npm view motion version dist-tags` returned **latest 14.6.0** (published 2026-10-22). `framer-motion` is also 14.6.0, and `motion` now pins `framer-motion@14.6.0`, `motion-dom@14.6.0` and `motion-utils@14.6.0`.
  - Peer dependencies: react and react-dom `^18.0.0 || ^19.0.0`. (Measured with npm on 2026-10-25.)
- Major releases: v12.0.0 on 2025-01-20, **v13.0.0** on 2026-08-05 (removed the optional `@emotion/is-prop-valid` dependency), and **v14.0.0** on 2026-10-02 (removed internal APIs and pinned internal dependencies). Source: npm `time` data, and https://github.com/motiondivision/motion/blob/main/CHANGELOG.md.
- Recent relevant changelog entries (same URL):
  - 14.2.0 (2026-10-13): "Hardware accelerated independent transforms like `x`, `y`, `scaleX`".
  - 14.1.1 (2026-10-13): velocity hand-off fixed for accelerated springs.
  - 14.1.0 (2026-10-09): delays animation start while the main thread is held, to prevent jumps.
  - 13.4.0 (2026-09-14): `AnimateView`, "View transitions for React 19.3, built on React's `ViewTransition`".
  - 13.5.0 (2026-10-01): `<m>` is 20% smaller; negative bounce added.
  - 12.43.0 (2026-07-27): accelerated `backgroundColor` and SVG.
  - 14.5.0 (2026-10-20): fixed animating from the latest props when a parent `<Activity>` becomes visible (React 19.2+ Activity).

### React 19 compatibility
- React 19 is a supported peer. The changelog records a React 19 CI test suite, StrictMode fixes for `AnimatePresence` and drag, and React 19 `ref` handling. Source: the CHANGELOG URL above.
- React itself is at **19.3.1 (latest, 2026-10-14)**. 19.3.0 shipped on 2026-09-09. Source: `npm view react` (measured), and https://github.com/facebook/react/blob/main/CHANGELOG.md.

### `motion/react` APIs (motion.dev docs; pages undated, fetched 2026-10-25)
- **Layout animations** (https://motion.dev/docs/react-layout-animations):
  - `<motion.div layout>` animates any layout change caused by a React render, using `transform` (FLIP) instead of animating width, height or top.
  - Children are scale-corrected. Border-radius and box-shadow are corrected automatically when they're set through `style`.
  - `layout="position"` handles aspect-ratio changes.
  - `LayoutGroup` covers siblings that don't re-render together. `layoutScroll` and `layoutRoot` handle scrolling and fixed containers.
  - Caveats: inline elements don't animate; animation is blocked during horizontal window resize; SVG isn't supported; use `scrollbar-gutter: stable`.
- **`layoutId` shared layout** (same page): a new element with the same `layoutId` animates from the old one's box, and they crossfade if both are mounted. Wrap it in `AnimatePresence` for exits.
- **`AnimatePresence`**: exit animations for unmounting children. The `mode="popLayout"` fixes are in the CHANGELOG.
- **Reduced motion** (https://motion.dev/docs/react-accessibility):
  - `<MotionConfig reducedMotion="user">` disables transform and layout animations when the OS setting is on, but **keeps opacity and backgroundColor**. `"always"` and `"never"` are overrides.
  - `useReducedMotion()` returns a boolean for bespoke swaps, such as replacing `x` with `opacity` on a sidebar.
- **LazyMotion + `m`** (https://motion.dev/docs/react-lazy-motion):
  - Use `import * as m from "motion/react-m"` inside `<LazyMotion features={domAnimation | domMax}>`.
  - Features can load asynchronously (`features={() => import("./features").then(r => r.default)}`).
  - `strict` throws if a full `motion.*` component is rendered inside, because that defeats the savings.
  - `domAnimation` provides animations, variants, exit, and tap/hover/focus gestures. `domMax` adds drag and layout/layoutId.

### Bundle sizes
**Motion's own published numbers.** Source: https://motion.dev/docs/react-reduce-bundle-size (undated, fetched 2026-10-25). It says sizes are "from Rollup-generated bundles", and the page discusses gzipped sizes.
- Full `motion` component: **~43 kB**. It can't be tree-shaken smaller.
- `m` + `LazyMotion` initial render: **just over 5 kB**.
- `domAnimation`: **+24 kB**. `domMax`: **+38 kB**.
- `useAnimate` mini: **3.3 kB**.
- The `animate()` mini is **3.2 kB** and the hybrid `animate()` is **22 kB**. Source: https://motion.dev/docs/improvements-to-the-web-animations-api-dx (undated, fetched 2026-10-25).

**Measured on motion@14.6.0.** I used Rollup 4.50.1, node-resolve and terser, then `gzip -9`. React was external, and `NODE_ENV` was not replaced.
| Entry | gzip bytes | about KiB |
|---|---|---|
| `motion.div` + `AnimatePresence` | 46,387 | 45.3 |
| `LazyMotion` + `domAnimation` (sync) + `m.div` + `AnimatePresence` | 32,144 | 31.4 |
| `LazyMotion` + `domMax` (sync) + `m.div layout` | 46,293 | 45.2 |
| `m` + `LazyMotion`, features loaded async: initial chunk | 14,358 | 14.0 |
| …plus the lazily loaded `domAnimation` chunk | 18,081 | 17.7 |
| `animate` from `motion/mini` | 3,390 | 3.3 |
| `animate` from `motion` (hybrid) | 23,626 | 23.1 |

- With esbuild 0.25.10 the numbers were similar: full 47.7 KB and domAnimation 33.3 KB.
- Bundlephobia reports the entire `motion@14.6.0` main entry, untree-shaken, as 57,054 B gzip. Source: https://bundlephobia.com/api/size?package=motion@14.6.0 (fetched 2026-10-25).
- Takeaway: the docs' "~5 kB initial" isn't reproduced on 14.6.0 with a default Rollup setup. I measured about 14 kB initial. Budget about 31 kB for the domAnimation path and about 45 kB for domMax or the full `motion`.

### Hardware acceleration (WAAPI)
Source: `motion-dom@14.6.0/dist/es/animation/waapi/utils/accelerated-values.mjs` and `.../supports/waapi.mjs`.
- WAAPI-accelerated values: **opacity, clipPath, filter, transform, backgroundColor**. Independent transforms (`x`, `y`, `scaleX` and so on) are also accelerated as of 14.2.0.
- Color properties are forced onto WAAPI when they use browser-only color spaces such as **oklch** and oklab. This matters because Tailwind 4 uses oklch.
- Motion falls back to the main thread (requestAnimationFrame) when any of these apply: there's an `onUpdate` callback, `repeatDelay` is set, `repeatType: "mirror"` is used, damping is 0, the type is `inertia`, there's a `transformTemplate`, or the element lives in a different window or popup.
- Motion's perf guide (https://motion.dev/docs/performance, undated, fetched 2026-10-25) says:
  - transform and opacity "operate directly on a layer". filter is compositor-handled in Chrome and Firefox. background-color and clip-path are moving to the compositor.
  - **Animating a CSS variable is not accelerated.** Prefer `clip-path: inset(... round r)` to animating border-radius, and `filter: drop-shadow` to animating box-shadow.

---

## 5. View Transitions API

- **Same-document** `document.startViewTransition()` arrived in Chrome 111. **Cross-document** (MPA) arrived in Chrome 126, opted in with `@view-transition { navigation: auto }` for same-origin navigations. Sources: https://developer.chrome.com/docs/web-platform/view-transitions (updated 2024-04-14) and https://developer.chrome.com/blog/view-transitions-update-io24 (2024-05-16).
- **`view-transition-class`** shipped in Chrome 125, Safari 18.2 and Firefox 144. **View transition types** shipped in Chrome 125. Source: io24 post above. MDN marks `view-transition-class` Baseline 2025 (https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/view-transition-class, modified 2026-05-07). A class styles many uniquely named groups with one `::view-transition-group(.card)` rule.
- Later additions, per https://developer.chrome.com/blog/view-transitions-in-2025 (2025-10-08):
  - `view-transition-name: match-element`: Chrome 137.
  - Nested view-transition groups: Chrome 140.
  - `document.activeViewTransition`: Chrome 142.
  - Element-scoped view transitions: behind a flag in 140, badge shows 147.
  - Firefox 144 shipped same-document transitions.
- Electron 44 (Chromium 152) has all of these.
- Mechanics, from the CSS View Transitions Level 1 Editor's Draft (https://drafts.csswg.org/css-view-transitions-1/, 2025-02-16):
  - Calling `startViewTransition` while one is active **skips the running one** with an AbortError. Transitions can't be retargeted with velocity.
  - Rendering is **suppressed** during the update callback, and "all pointer hit testing must target its document element".
- The old view is a **static image** snapshot. The new view is a live snapshot rendered as replaced content. Source: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using (modified 2026-09-15).

### React `<ViewTransition>`
- **Stable in React 19.3.0** (2026-09-09). The release lists "`<ViewTransition />`: Adds `<ViewTransition />` and `addTransitionType`". Source: https://github.com/facebook/react/blob/main/CHANGELOG.md. Some examples on react.dev still pin canary builds (https://react.dev/reference/react/ViewTransition, fetched 2026-10-25).
- Behavior, from the same react.dev page:
  - It activates only for updates inside `startTransition`, `useDeferredValue`, Suspense reveals or `<Activity>`. A plain `setState` doesn't animate.
  - Props are `enter`, `exit`, `update`, `share`, `default` and `name`, each taking "auto", "none", a class name, or a map keyed by transition type.
  - The boundary must come before any DOM node.
  - It animates a snapshot, so children don't animate individually.
  - React interrupts other running view transitions, and you can't call `startViewTransition` yourself.
  - popstate (back) navigation skips the animation.
  - **React doesn't apply reduced motion for you.** Add `@media (prefers-reduced-motion)` rules yourself.
- Motion 13.4.0 added `AnimateView` on top of React's `ViewTransition` (CHANGELOG, 2026-09-14).

### Pros and cons vs Motion for in-app navigation
- **Pros:**
  - Zero JS runtime cost.
  - Animates between two arbitrary DOM states, including cross-component "shared element" morphs, without keeping both trees mounted.
  - Runs on the compositor.
  - Can be styled with CSS and types.
  - Native in Chromium 152.
- **Cons:**
  - Not interruptible or velocity-preserving: a new transition skips the old one.
  - Hit testing is blocked during the update.
  - The old state is a frozen image, so live content (streaming text, the browser-pane screencast, the working avatar) freezes for that duration.
  - Only one transition runs at a time per document.
  - Requires the Transition / Suspense model.
  - No springs, only CSS easing. You can approximate springs with `linear()`.
  - Reduced motion is manual.
- **Motion** is better for gesture-driven, interruptible and component-level motion: drawers, popovers, list reorder, drag, layoutId tabs. View Transitions are better for route-level crossfades and occasional hero morphs.

---

## 6. CSS-only features

- **Scroll-driven animations** (`animation-timeline: scroll()` / `view()`):
  - Chrome 115+. Safari 26 per the page's support list. They can run **off the main thread**.
  - `scroll()` tracks a scroller's range. `view()` tracks an element crossing its scrollport.
  - Use cases: reading progress, parallax, fade-in on reveal, carousel indicators, stacking cards.
  - Source: https://developer.chrome.com/docs/css-ui/scroll-driven-animations (2023-05-05).
  - Motion 13.4.7 moved more `useScroll` offsets onto `ViewTimeline` (CHANGELOG, 2026-09-30).
- **`linear()` easing:**
  - Chrome 113, Firefox 112, Safari 17.2.
  - It interpolates linearly between many stops, so it can approximate springs and bounces. More stops give a smoother curve. Tooling exists in the Archibald/Argyle generator and in DevTools since Chrome 114.
  - Source: https://developer.chrome.com/docs/css-ui/css-linear-easing-function (2023-05-25).
  - Limitation (inference): it's a fixed curve, so it has no velocity hand-off on interruption.
  - Motion's duration-based springs "can be generated as pure CSS" (https://motion.dev/docs/react-transitions).
- **`@starting-style` + `transition-behavior: allow-discrete`:**
  - Chrome 117, together with the `overlay` property. `display` in keyframes arrived in Chrome 116.
  - This enables enter/exit transitions for `display:none` elements, popovers and `<dialog>` without JS.
  - Nested `@starting-style` ordering is fixed from Chrome 130.
  - Source: https://developer.chrome.com/blog/entry-exit-animations (2023-08-16, revised 2024-09-13).
  - This fits Base UI/shadcn popovers and dialogs that already toggle `data-state` or `display`.

---

## 7. Performance

- **Compositor-only properties:**
  - web.dev: "only two properties", **transform and opacity**. Aim for about 4–5 ms of compositing. Promote layers "within reason". Source: https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count (2015-03-20).
  - Motion's newer guidance adds **filter**, which Chrome and Firefox composite, and says clip-path and background-color are coming. It warns that CSS-variable animations aren't accelerated. Source: https://motion.dev/docs/performance (undated, fetched 2026-10-25).
  - box-shadow and border-radius skip layout but repaint (same source).
- **`will-change`:**
  - MDN says to use it "as a last resort" and not to anticipate problems.
  - Overuse slows the page. It applies to the whole subtree, and it creates stacking contexts.
  - Toggle it from script just before a change and reset it to `auto` after. Don't put it inside `@keyframes`.
  - Source: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/will-change (modified 2026-10-07).
- **Frame budget:**
  - 120 Hz gives 1000/120 = **8.33 ms per frame**, and 60 Hz gives 16.7 ms. Motion's guide puts it as "about 8ms" at 120fps and notes React re-renders "can easily take upwards of 100ms". Source: https://motion.dev/docs/performance.
  - Practical target: keep main-thread work per frame well under about 4 ms during animation, and keep motion on WAAPI or the compositor.
- **120 Hz ProMotion in Chromium and Electron:**
  - The Chromium bug "New Mac: Support for ProMotion display" (https://issues.chromium.org/issues/40202100, opened 2021) is **Fixed**. Chrome derives the frame rate from the DisplayLink and was observed hitting 120 Hz, so rAF follows the display's rate.
  - Caveat: adaptive (VRR) ProMotion behaved inconsistently. https://issues.chromium.org/issues/40215853 was filed on Chrome 98, and test pages such as TestUFO can report 60 Hz.
  - Electron exposes `Display.displayFrequency` ("The display refresh rate"). Source: https://www.electronjs.org/docs/latest/api/structures/display (fetched 2026-10-25).
  - I found **no primary source** stating that Electron caps rAF at 60 Hz, or that it needs a flag on ProMotion.
  - Recommendation: measure in Psyche with a rAF-delta probe and compare it with `screen.getPrimaryDisplay().displayFrequency`. Note that hidden or occluded windows are throttled unless `backgroundThrottling: false`.
  - Electron offscreen rendering has its own `frameRate`, but that's irrelevant to normal windows.
  - Safari and WKWebView, by contrast, default to roughly 60 fps page rendering (WebKit bug 173434, https://bugs.webkit.org/show_bug.cgi?id=173434). That matters for the **web client in Safari**: tune springs to look right at 60 Hz too.
- **backdrop-filter cost:**
  - Each output pixel samples its neighbors, so cost scales with blur radius × area.
  - It defeats caching of fixed-position content and forces re-invalidation while scrolling (Firefox analysis: https://bugzilla.mozilla.org/show_bug.cgi?id=1828248, ~2023).
  - A Chromium-internals write-up says an unchanged backdrop layer can reuse its texture, so the cost comes from *invalidating* it. That's a secondary source: https://grida.co/docs/wg/research/chromium/effect-optimizations (fetched 2026-10-25).
  - Guidance: don't animate `backdrop-filter` itself, don't move content underneath a large blur every frame, cap simultaneous blur surfaces, and keep radii small. Apple's HIG also says to avoid animating into and out of blurs under Reduce Motion (Accessibility page above).

---

## 8. Reduced motion

- **Best practice: substitute motion, don't delete it.**
  - Apple HIG: "Replacing transitions in x-, y-, and z-axes with fades", and tighten springs to reduce bounce. Source: https://developer.apple.com/design/human-interface-guidelines/accessibility (2025-06-09).
  - Motion: `reducedMotion="user"` disables transform and layout animations but keeps opacity and color. Its docs recommend replacing large transform animations with opacity and keeping educational transitions. Source: https://motion.dev/docs/react-accessibility.
  - Contrast: older web.dev guidance (https://web.dev/articles/prefers-reduced-motion, 2019-03-11) leans toward removing non-essential animation. WCAG C39 (https://www.w3.org/WAI/WCAG22/Techniques/css/C39, updated 2026-01-12) only requires suppressing *motion*.
  - Opacity crossfades meet both requirements: WCAG's "motion animation" definition excludes color, opacity and blur changes that don't alter perceived size, shape or position.
  - Caveat: an erratum removes blur from that exclusion. So in reduced mode, **don't use blur transitions**; use opacity only.
- **WCAG 2.2 SC 2.3.3 Animation from Interactions (Level AAA):**
  - "Motion animation triggered by interaction can be disabled, unless the animation is essential."
  - Parallax is the classic failure. Respecting `prefers-reduced-motion` is a sufficient technique (C39, SCR40).
  - Source: https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html (updated 2025-09-16).
- **WCAG 2.2 SC 2.2.2 Pause, Stop, Hide (Level A):**
  - Moving, blinking or scrolling content that (1) starts automatically, (2) lasts more than **5 seconds** and (3) is shown in parallel with other content needs a pause, stop or hide mechanism.
  - Auto-updating content needs pause, stop, hide or frequency control, and has no 5-second exemption.
  - A loader that's the only content, or that's essential while interaction is blocked, is exempt.
  - Source: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html (updated 2026-08-10).
  - Psyche implication: auto-updating content shown alongside other UI (the browser-pane screencast, live task status) needs a pause or freeze control. Decorative looping animations over 5 s need one too, or they should stop.
- `prefers-reduced-motion` in Electron reflects the macOS "Reduce motion" setting. That's Chromium's standard media query behavior. It wasn't separately verified for Electron 44, so test it.
- React's `<ViewTransition>` won't honor it automatically (react.dev, above).

---

## Recommendation sketch (for the spec)
1. **CSS first, for the cheap 80%:**
   - Use Tailwind transitions and tw-animate-css for hover, press and fades.
   - Use `@starting-style` + `allow-discrete` for Base UI popovers and dialogs.
   - Use spring tokens exported as `linear()` CSS variables for non-interruptible enter/exit.
2. **Motion (`LazyMotion` + `m`, `domAnimation`, async-loaded) for interruptible and stateful motion:**
   - AnimatePresence exits, drawers and sheets, tab indicators (`layoutId` needs `domMax`, so lazy-load it only where used), drag, and number tweens.
   - Set a global `<MotionConfig reducedMotion="user" transition={tokens.spatialDefault}>` to replace Motion's bouncy defaults (k 500 / c 25).
3. **View Transitions (React 19.3 `<ViewTransition>`) only for route-level crossfades and hero morphs.** Keep them short (≤ 250 ms), because of the snapshot freezing and hit-testing block. Gate them behind reduced motion.
4. **Spring tokens:** define them once in duration/bounce form, then derive Motion `visualDuration = duration/1.2` and CSS `linear()` from the same values. See the §3 table.
