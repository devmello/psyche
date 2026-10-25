# Liquid Glass: the design, and every way to get it in Electron

Compiled 2026-10-25 for the 2026 redesign ([redesign-2026.md](../redesign-2026.md) §3.4 materials, §4 window chrome; [motion.md](../motion.md)). Every fact cites a numbered source with its URL and date (§7). **[unverified]** marks a claim that rests on a search snippet or a single secondary source. **[measured]** marks numbers from this PR's spike (§5), taken on this Mac: Apple M5, macOS 27.0.1, Electron 44.9.0 (Chromium 152), Chrome 154.

## 0. The short version

1. **The Mac moved on.** This Mac runs **macOS 27 "Golden Gate"**, not Tahoe. At WWDC26 (8 June 2026) Apple reworked Liquid Glass [28][29][30][32]:
   - Sidebars run **edge to edge** again instead of floating.
   - The default glass is **more opaque**, and users get a clear-to-opaque **transparency slider**.
   - Toolbars are uniform across apps.
   - Every window has **one shared, smaller corner radius**.

   Psyche's spec (sidebar edge to edge, opaque content, chrome-only glass) is closer to macOS 27 than to Tahoe's floating-glass look.
2. **Native glass in Electron is one sheet behind the window, sampling the desktop.**
   - `electron-liquid-glass` and Tauri's `window-vibrancy` put one `NSGlassEffectView` *behind all web content*. It refracts the desktop, never the app's own content, and it has no regions [E1][E3][E19].
   - The only per-element native design was Electron PR #50415's `setGlassEffectRegions`. Felix Rieseberg closed it unmerged on 2026-06-30, with no reason posted [E6].
   - Native glass also needs `transparent: true`. That brings Electron's transparent-window limits [E12] and a known Chromium bug that breaks CSS `backdrop-filter` over text [E13].
3. **Glass that refracts the app's own content can only be done in CSS, and Electron is the one place that works fully.**
   - Chromium is the only engine that renders `backdrop-filter: url(#svg-filter)`. That is what the displacement-map refraction technique needs [E21][E23][E24].
   - The spike's refraction runs at 120 Hz without dropped frames. It costs about the same GPU-process time as plain blur **[measured]**.
4. **Recommendation** (details in §6):
   - **Sidebar:** Electron `vibrancy: "sidebar"` (A2's plan; A2 still has to verify it on macOS 27).
   - **Toolbar control groups and the composer:** CSS refraction glass, regular variant.
   - **Popovers, menus, the palette and sheets:** CSS blur glass that turns more opaque as the surface gets bigger.
   - **Everything:** opaque under Reduce Transparency, Increase Contrast, an inactive window, or a non-Chromium web browser.
   - Do **not** ship `electron-liquid-glass`. Keep the native path as a flag-gated spike until an in-repo addon uses Apple's public `contentView` placement.

---

## 1. The design, from Apple's sources

### 1.1 Two layers
- Liquid Glass is "a distinct functional layer for controls and navigation elements" that floats above content [5]. Session 219: it "is best reserved for the navigation layer" [1].
- **"Don't use Liquid Glass in the content layer"** [5]. The exception is transient controls (sliders, toggles), which are glass only while being dragged [5][3][12]. A table view is Apple's example of content that must not be glass [1].
- Content stays opaque and runs edge to edge underneath. AppKit's checklist [4]:
  - extend content under the toolbar and sidebar;
  - remove custom bar backgrounds, borders and `NSVisualEffectView` sidebar materials, which "overlay or interfere with Liquid Glass" [12];
  - keep non-interactive titles and status text off glass.
- Hierarchy comes "through layout and grouping", not decoration [2].

### 1.2 Variants
- **Regular** is the default. It is adaptive, "works in any size, over any content" [1], and blurs and adjusts the luminosity of what is behind it. Use it wherever there is text: alerts, sidebars, popovers [5].
- **Clear** is "permanently more transparent" and not adaptive [1]. Use it only when all three hold [1]:
  1. it sits over media-rich content;
  2. that content tolerates a dimming layer;
  3. what sits on the glass is "bold and bright."

  Over bright content add "a dark dimming layer of 35% opacity" [5]. Never mix regular and clear [1].
- **Identity** (SwiftUI) draws no glass at all, which is useful for switching glass on and off [17]. AppKit exposes only `.regular` and `.clear` [15].
- The look also depends on system settings: the Liquid Glass setting (Clear/Tinted in 26.1, a slider in 27), Reduce Transparency and Increase Contrast [5][27][30].

### 1.3 Optics
- **Lensing is the defining trait.** It bends and concentrates light in real time rather than scattering it like a blur [1]. Apple: it "reflects and refracts its surroundings" [25]. Bigger glass gets stronger lensing and "deeper, richer shadows" [1].
- **Specular highlights** come from environmental light and "respond to geometry" [1][25].
- **Shadows adapt.** They get more opaque over text and lighter over a plain light background [1].
- **Appearing and disappearing:** glass "materializes" by modulating the lensing, not by fading. A menu "simply pops open." In an inactive window the glass "visually recedes" [1].
- **Interaction:** pressed glass "illuminates from within" [1]. macOS 27 adds a click bounce for glass controls: "A little goes a long way!" [28].

### 1.4 Adapting to what's behind
- **Small glass** (toolbar items, tab bars, symbols) flips between light and dark with the content behind it. Its labels are monochrome: dark over light, light over dark [1][10]. AppKit reports the flip through `NSAppearance` [4].
- **Large glass** (sidebars, menus) "don't flip from light to dark". It stays more opaque, and nearby colour "spills onto its surface" [1][10].

### 1.5 Shape
- **Three shape types:** fixed, **capsule** (radius = half the height) and **concentric** (the parent's radius minus the padding). Nested shapes share a centre, so corners are neither "pinched" nor "flared" [2].
- **macOS controls:** Mini to Medium stay rounded rectangles; Large and X-Large are capsules [2][4].
- **Defaults:** the default `glassEffect` shape is a capsule; larger custom panels use about `.rect(cornerRadius: 16)` [18][21].
- **Windows:** Tahoe had a larger radius for windows with toolbars. macOS 27 uses one radius for all windows, less round, with stronger window shadows [4][30][32]. Apple publishes no point value. A hidden default of 20 in 27 is **[unverified]**.

### 1.6 Islands, containers, morphing
- **"Always avoid glass on glass."** [1] Glass can't sample other glass, so nearby glass shares one container (`NSGlassEffectContainerView`, `GlassEffectContainer`). The container merges shapes within its `spacing` and needs fewer render passes [3][4][16].
- **Toolbar grouping** [2][6][12]:
  - group items by function and frequency, with "a maximum of three" groups;
  - don't mix text and symbols in one group;
  - give navigation and Done/Close their own group;
  - put one tinted, prominent primary action at the trailing end.
- **At rest, glass shapes never intersect** [1].
- **Morphing:** `glassEffectID(_:in:)` inside a container animates shapes into and out of each other. `glassEffectUnion` keeps them merged at rest [20][21].
- **Budget:** "Limit the use of Liquid Glass effects onscreen at the same time" [21].
- **Placement:** put content *inside* the glass (`contentView`). "Avoid placing the NSGlassEffectView behind your content as a sibling view" [4]. This is exactly what every Electron addon does (§3.1).

### 1.7 Scroll edges
- Scroll edge effects replace dividers with a blur where pinned chrome overlaps scrolling content. They "don't block or darken like overlays" [2].
- **Soft vs hard:** soft is a "subtle, blurred boundary". Hard is a "linear, nearly opaque boundary" and is "mostly used on macOS" [2][24]. In macOS 27, `automatic` resolves to **hard** when the window title floats over content [28].
- **Rules:** one effect per view; don't mix soft and hard; use none where nothing floats [2].

### 1.8 Colour and legibility
- Glass "has no inherent color" [10].
- **Tint sparingly:** "Avoid tinting all your elements". Colour the *background* of the one primary action, not its glyph. Brand colour belongs in the content layer [1][3][10].
- Use **vibrant** label colours on glass. Non-vibrant greys have poor contrast there, and quaternary labels must not sit on thin materials [5].
- Modal glass needs a dimming layer. A sheet dragged up turns more opaque [2][12].

### 1.9 Accessibility, as Apple describes it
- **Reduce Transparency:** glass becomes "frostier and obscures more of the content behind it" [1].
- **Increase Contrast:** elements become "predominantly black or white" with a contrasting border [1].
- **Reduce Motion:** turns down some effects and disables the elastic behaviour [1].
- **Observed on Tahoe:** Increase Contrast forces Reduce Transparency on [38], and either one disables the Clear/Tinted choice [36].

### 1.10 Don'ts (consolidated)
1. No glass in the content layer.
2. No glass on glass, and no shapes intersecting at rest.
3. No mixing regular and clear; no clear without dimming.
4. No tinting everything.
5. No glass everywhere.
6. No custom bar backgrounds.
7. No text and symbols in one group.
8. No stacked or mixed scroll edges.
9. No glass behind content as a sibling.

[1][2][4][5][12][21]

### 1.11 What changed after Tahoe
- **iOS 26 / macOS 26 betas (June–July 2025):** opacity swung between betas as Apple chased legibility [40][41][42] **[unverified detail]**.
- **26.1 (3 Nov 2025):** a Clear/Tinted Liquid Glass setting. Reviewers called the difference small [27][36][37][38].
- **Through Dec 2025:** critics kept citing washed-out light mode, unreadable menus, a barely visible Finder selection, and a sidebar bleeding through the search field [37][39].
- **macOS 27 (WWDC26, 8 June 2026):**
  - a transparency slider;
  - more opaque default glass, with darker edges and brighter highlights;
  - non-floating, edge-to-edge sidebars, with no sidebar shadow and coloured icons again;
  - uniform toolbars;
  - one less-round corner radius for every window [28][29][30][31][32].

## 2. How shipping apps use it

| App | Stack | What it does | Source |
| --- | --- | --- | --- |
| Safari (Tahoe) | Native | Glass toolbar and sidebar, tabs as sunken pills; the best-received implementation | [33][34] |
| Finder (Tahoe) | Native | Translucent sidebar and toolbar, but the buttons read as "flat, light gray shapes"; weak selection | [33][34][39] |
| Music, Photos (Tahoe) | Native | A floating playback pill and toolbar over artwork; legibility criticised | [33][34] |
| System Settings (Tahoe) | Native | Glass sidebar that bleeds through the search field | [37] |
| Apple apps (macOS 27) | Native | Edge-to-edge sidebars, uniform toolbars, coloured sidebar icons; "more coherent and usable" | [30][32] |
| Things 3 | Native | "a touch of glass in the sidebar", rounder controls (3.22, 2025-09-15); refined for OS 27 (3.24, 2026-09-14) | [44][45] |
| Fantastical / Cardhop | Native | Updated to the Tahoe design (2025-09-22); no specifics | [46] |
| Craft | Native | Liquid Glass on day 1 of OS 26 **[unverified detail]** | [47] |
| Raycast | Native shell | Glass controls in AI Chat (2025-09-16); every UI updated for macOS 27 (v2.4, 2026-09-14) | [48][49] |
| Dia | Native shell on Chromium | "Tahoe Liquid Glass designs… polished corners" (1.15.0, Jan 2026); doesn't say whether it uses `NSGlassEffectView` | [50] |
| Arc | Native shell on Chromium | No glass; in maintenance mode | [51] |
| Linear, Notion, Slack, Cursor, Claude desktop | Electron | No Liquid Glass adoption found | [52][53] |
| Spotify | CEF | No adoption found | [52] |
| Figma | Electron + WASM | The app chrome didn't adopt glass, but Figma shipped a *Glass effect* for users' own designs (July 2025) | [52][63] |
| ChatGPT desktop | Native Swift | Not confirmed either way | [52] |

**Pattern:** every app that shipped real glass is native. No Electron app has shipped Liquid Glass chrome. Their only Tahoe work was picking up Electron's WindowServer-lag fix [58][59]. Psyche would be among the first. The safe interpretation is the one Apple moved to in 27: glass on small floating controls, sidebars as a quiet edge-to-edge material, content opaque.

## 3. Getting it in Electron

### 3.1 Native: `electron-liquid-glass` (Meridius Labs)

**Package and API**
- Version 1.1.1 (2025-09-17), MIT, about 588 stars [E1][E2][E5].
- 193 KB unpacked. N-API prebuilds: arm64 98.6 KB, x64 54.4 KB. No install script since 1.1.1 [E2][E3].
- API [E3]:
  ```ts
  liquidGlass.addView(win.getNativeWindowHandle(), { cornerRadius?, tintColor?: "#RRGGBBAA", opaque? }) // → id, -1 unsupported
  liquidGlass.isGlassSupported()            // execSync("sw_vers") ≥ 26
  liquidGlass.unstable_setVariant(id, n)    // private selectors set_variant:, set_scrimState:, set_subduedState:
  ```

**How it attaches** (read from `src/glass_effect.mm`) [E3]
- It dereferences the handle to the window's root `NSView`, creates `NSGlassEffectView` at the full bounds with autoresizing, and calls `addSubview:positioned:NSWindowBelow relativeTo:nil`. So the glass is **behind every subview, web contents included**.
- There is no region API, and no remove or update call.
- Corner radius goes through `layer.cornerRadius`, not the public property.
- On macOS before 26 it falls back to `NSVisualEffectView` (`UnderWindowBackground`).

**Requirements and limits**
- The window must be `transparent: true`, and `vibrancy` must not be set: it "will override and look blurry" [E1].
- Transparent windows have no click-through, no native shadow on some setups, and lose transparency while DevTools is open [E12].
- In a transparent or vibrant window, CSS `backdrop-filter` blur renders wrongly over text. Electron closed #39529 and #44720 as not planned and handed it to Chromium 380416865 (status **[unverified]**) [E13].

**Public vs private API**
- Apple documents `NSGlassEffectView` as **public, macOS 26.0+**, with `contentView`, `cornerRadius`, `tintColor`, `style`, and `effectIsInteractive` from macOS 27 [14][E18]. The README's "reverse-engineered" wording predates the SDK.
- Only the `unstable_*` setters are private [E3].
- Apple guarantees placement only for the `contentView`; arbitrary sibling subviews have no z-order guarantee [E18].

**Signing**
- No new entitlement is needed if the `.node` is signed with the app, as `pty.node` already is [E33][E34][E35].
- Ad-hoc builds run without the hardened runtime, so library validation doesn't apply to them [E35].
- Packaging would need the addon kept external and copied with its `prebuilds/`, like node-pty. The existing `*.node` asar-unpack glob covers it.

**Maintenance and bundler gotcha**
- One maintainer; no functional commit since 2025-09; open PRs are all Dependabot [E5].
- The maintainer is the person who found Electron's Tahoe `_cornerMask` bug [E7], so the AppKit skill is real, but the package is idle.
- **Gotcha found by the spike:** Vite resolved a constant dynamic-import specifier and bundled the addon into the main chunk, which breaks its `import.meta.url` loader. The addon must be marked external (`vite.main.config.ts`).

### 3.2 Native: Electron itself
- **PR #50415** (Felix Rieseberg, opened 2026-03-22, closed unmerged 2026-06-30, no stated reason) [E6] proposed:
  - `win.setGlassEffect({ style, cornerRadius, tintColor })`: one view behind the content, the same model as the addon.
  - `win.setGlassEffectRegions([...])`: an `NSGlassEffectContainerView` *above* the web view, with `hitTest:` returning nil so clicks pass through, rects pushed from a `ResizeObserver`, and a `contentImage` for crisp content, since DOM under a region gets refracted.
  - `isGlassEffectSupported()`.

  It carried `api-review/requested` and `wip` labels. Electron has no other Liquid Glass work [E6][E15].
- **`vibrancy`** is still `NSVisualEffectView` with 14 materials:
  - `titlebar`, `selection`, `menu`, `popover`, `sidebar`, `header`, `sheet`, `window`, `hud`, `fullscreen-ui`, `tooltip`, `content`, `under-window`, `under-page`;
  - plus `visualEffectState` (`followWindow` by default, `active`, `inactive`), which can't change at runtime;
  - `setVibrancy(type, { animationDuration })`;
  - `backgroundMaterial` is Windows-only [E10][E11].

  A maintainer who compared every material against `NSGlassEffectView .clear`: "none of them get close" [E6]. One Obsidian report has vibrancy showing flat grey on Tahoe. It's unresolved and may be a missing `transparent` **[unverified]** [E14].
- **The Tahoe WindowServer lag:** Electron overrode the private `_cornerMask`, which made WindowServer redraw shadows constantly. The fix shipped in 36.9.2, 37.6.0, 38.2.0 and 39.0.0-alpha.7 (2025-09-27) [E7][E8][E17]. **Psyche's 44.9.0 has the fix.**
- **Reference implementation:** Tauri's `window-vibrancy` 0.8.1 (2026-09-22) uses the public `NSGlassEffectView` with `style`, `cornerRadius` and `clipsToBounds`, and can **reparent the webview into `glass.contentView`**, the placement Apple guarantees. It is also whole-window only [E19]. Model an in-repo addon on it, not on electron-liquid-glass.

### 3.3 Web: CSS glass
- **Plain glass:** `backdrop-filter: blur() saturate()` over a translucent tint. It is supported in Chrome 76+, Safari 18 unprefixed and Firefox 103+ [E27].
- **Specular rim:** an inset top highlight plus a 1 px gradient ring drawn with a `mask` / `mask-composite: exclude` pseudo-element [E26]. `backdrop-filter` samples only the pixels directly behind the element; Josh Comeau's taller masked child fixes colour bleed at edges [E26].
- **Refraction** (Chris Feijoo, kube.io, 2025-09-04) [E21]:
  - Model the rim as a convex squircle, compute the per-pixel shift from its slope (Snell's law), and encode it as an image: R = x and G = y around 128.
  - Feed it to `<feDisplacementMap in="SourceGraphic" in2="map" scale=…>`, applied with `backdrop-filter: url(#lens)`.
  - It is **Chromium only.** WebKit bug 245510 has been open since 2022 [E24], and Firefox is unclear [E23][E24].
  - Limits: 8-bit channels cap the shift at about ±127 px, the map must match the element's size and be rebuilt on resize, and concave profiles need pixels from outside the element.
  - `liquid-glass-react` (6.5k stars) packages the technique but has been idle since 2025-06-13 [E25].
- **Tint animation:** register the tint with `@property --glass-tint { syntax: '<color>' }` so it can transition. Animate opacity or `scale`, never the blur radius [E40][E21].
- **Scroll edge:** a 24 px `mask-image` gradient on the scroller approximates the hard style [E41]. Apple's real effect is a blur, which a mask can't reproduce [E41].

### 3.4 Performance (sources; the spike's numbers are in §5)
- Each `backdrop-filter` creates a render surface. Damage under it re-filters the whole surface, so cost scales with **area** [E37] **[unverified mechanism]**.
- Published measurements, none on Apple silicon [E36]:
  - Galaxy A15: one blurred panel cost about 3.5 ms of GPU-process time per frame.
  - An Electron app with always-on glass chrome over an animated background ran at 21.8 fps, and 46.4 fps without `backdrop-filter`. That was on a **software** renderer.
- At 120 Hz the frame budget is **8.33 ms**.

### 3.5 Accessibility from Electron
| Setting | Main process | Renderer |
| --- | --- | --- |
| Reduce Transparency | `nativeTheme.prefersReducedTransparency` (2024-07; the old `systemPreferences.accessibilityDisplayShouldReduceTransparency` is deprecated) | `@media (prefers-reduced-transparency: reduce)` (Chrome 118+) |
| Increase Contrast | `nativeTheme.shouldUseHighContrastColors` | `@media (prefers-contrast: more)` |
| Reduce Motion | `systemPreferences.getAnimationSettings().prefersReducedMotion` | `@media (prefers-reduced-motion: reduce)` |

[E27][E28][E31][E32]

- Chromium reads `accessibilityDisplayShouldReduceTransparency` / `…IncreaseContrast` from `NSWorkspace` and listens for changes, so the media queries update live in Electron [E30].
- Whether a raw `NSGlassEffectView` in an Electron window frosts itself under Reduce Transparency is **[unverified]**. Gate it explicitly in main.

---

## 4. The spike (this PR)

| Piece | Where | What it does |
| --- | --- | --- |
| `GlassSurface` | `packages/ui/src/components/glass-surface.tsx` | One primitive with four rungs: `native` (transparent, so a native view under the window shows), `refraction`, `css`, `opaque`. `resolveGlassImpl` walks native → refraction → css → opaque and lands on opaque under Reduce Transparency, Increase Contrast or no `backdrop-filter`. It reads `data-glass`, `data-reduce-transparency` and `data-contrast` on `<html>` plus the two media queries, and updates live. Every rung keeps the same tint, 1 px gradient rim and inset highlight, so the shape reads the same. 6.0 KB min / **2.6 KB gz** **[measured]**. |
| Lens map | `packages/ui/src/lib/glass.ts` | A rounded-rect SDF plus a squircle-rim slope (`(1 − (1 − t)⁴)^¼`), encoded for `feDisplacementMap`. It is drawn to a canvas at half resolution and rebuilt on resize (`ResizeObserver`). Unit-tested in `test/glass.test.ts`. |
| Stories | `Primitives/GlassSurface` | The same sidebar, toolbar group and composer drawn as CSS, refraction and native side by side, over a scrolling procedural photo and over text, in light and dark; plus clear-over-photo, Reduce Transparency and Increase Contrast stories. Four `Probe*` stories (tagged `no-visual`) expose `window.__glassProbe(seconds)`. |
| Probe runner | `packages/ui/visual/glass-probe.mjs` | `shots` takes the screenshots; `probe` scrolls each probe story and records rAF frame times, plus Chrome's GPU-process and renderer CPU time through CDP `SystemInfo.getProcessInfo`. |
| Native proof | `apps/desktop/src/main/glass.ts` | Off unless `PSYCHE_GLASS=native` on an unpackaged macOS run. It makes the main window `transparent`, attaches `electron-liquid-glass` (an optional, external, macOS-only dependency) and injects CSS that clears the frame, rail and thread list while `.shell > main` stays opaque. `PSYCHE_GLASS_PROBE=<file>` runs a scripted scroll that records frame times, Electron's GPU and renderer CPU and WindowServer CPU, and screenshots the window with `screencapture`. |

## 5. Measurements

### 5.1 CSS and refraction, in Chrome on this Mac
**Setup**
- Probe stories at 940 × 700. The backdrop scrolls 4 px a frame for 6 s under three glass surfaces (sidebar, toolbar group, composer).
- Two runs each, headed Chrome 154 on the built-in display (ANGLE Metal, Apple M5), so rAF ran at the panel's **120 Hz** (8.33 ms).
- `GPU %` and `renderer %` are those processes' CPU time per wall-clock second, as a share of one core (CDP). They stand in for compositor cost, which rAF pacing hides.

| Story | Frames in 6 s | p50 / p95 / p99 ms | Over 1.5× p50 | GPU process % | Renderer % |
| --- | --- | --- | --- | --- | --- |
| Opaque (baseline) | 715 | 8.3 / 9.3–9.6 / 10.1–10.2 | 0 | 3.1–5.1 | 3.5–5.1 |
| CSS blur (20 px, saturate 1.6) | 715 | 8.3 / 8.8–9.4 / 10.0–10.1 | 0 | 11.0–20.4 | 3.6–6.1 |
| CSS + refraction, over photo | 715 | 8.3 / 9.7–9.8 / 10.2–10.3 | 0 | 11.7–14.1 | 4.6–5.0 |
| CSS + refraction, over text | 715 | 8.3 / 10.0 / 10.3 | 0 | 12.7–13.4 | 4.5–4.9 |

**[measured]**

- **No variant dropped a frame at 120 Hz.** Glass costs GPU-process time, not frames: roughly **+8–15 points of one core** over opaque for three surfaces.
- **Refraction costs the same as plain blur** (overlapping ranges). It swaps a 20 px blur for a 10 px blur plus one displacement pass.
- Headless Chrome (also Metal) paces at a fixed 60 Hz and showed the same ordering at lower levels: opaque 1.5–2.9 %, CSS 5.4–5.7 %, refraction 5.9–10.5 %, refraction over text 10.2–14.6 %.
- **Caveats:**
  - These are three small-to-medium surfaces on an M5. Cost scales with glass *area* (§3.4), and the 248 px full-height sidebar is the largest surface in the spike.
  - The GPU process's own Metal time isn't visible to CDP.
  - Repeat the probe on the slowest supported Mac before raising the glass budget.
- **What it looks like** (screenshots in the PR):
  - **Over a busy photo,** refraction reads as glass: the rim bends and compresses what's behind it while the middle stays clear. Plain blur reads as frosted plastic.
  - **Over text,** refraction lets more of the text behind show through than 20 px CSS blur.
    - The first tuning (6 px blur, 38 % tint) failed outright, with letters behind competing with labels on the glass.
    - The final tuning (10 px blur, 50 % tint) is usable for short, bold labels (capsule pills, the composer placeholder), but plain CSS blur is still more legible over dense text.
    - So refraction goes only on small capsules, never on large text-bearing glass. A should tune `--material-glass-refraction` against the `ComparisonText` story.
  - **Dark mode:** both rungs keep labels legible. The rim highlight carries the edge.

### 5.2 Native path (`PSYCHE_GLASS=native`)
**Only partly measured.** Here is what was verified and what is still open.

| Item | Result |
| --- | --- |
| Install | `pnpm add -O electron-liquid-glass@1.1.1` installs with no build step (`allowBuilds: false`). The arm64 addon is **98.6 KB**, the package 193 KB unpacked **[measured]**. It is optional and `os: darwin`, so Linux CI skips it. |
| Load under Electron 44 | `require("electron-liquid-glass")` under Electron's Node gives `addView: function` and `isGlassSupported() === true` on macOS 27.0.1 **[measured]**. |
| Bundling | First launch failed: Vite resolved the constant dynamic import and bundled the addon, which breaks its `import.meta.url` loader. Fixed by making it external in `vite.main.config.ts`. |
| Attach | Second launch (`PSYCHE_HOME=~/.psyche-try PSYCHE_PORT=7989 PSYCHE_GLASS=native`) attached with no error: `addView` returned an id ≥ 0. |
| Frame times, CPU, screenshots | **Not captured.** The scripted probe waits for animation frames, and the window sat behind other windows, where Chromium sends none. Bringing it forward or taking a screenshot needed computer-use access to the window, which the owner declined. The probe now raises the window itself before measuring. |
| Signing | Not exercised. Dev runs are unsigned. A packaged build would need the addon copied like node-pty and signed with the app (§3.1). |

**How the owner can finish it** (one launch, about 30 s, window in front):

```bash
PSYCHE_HOME=~/.psyche-try PSYCHE_PORT=7989 PSYCHE_GLASS=native PSYCHE_GLASS_PROBE=/tmp/psyche-glass/probe.json pnpm --filter @psyche/desktop dev
```

The probe needs no input. It:
- scrolls the transcript for 6 s three times: glass in light, glass in dark, and the page painted opaque over the glass;
- records rAF frame times, Electron GPU and renderer CPU, and WindowServer CPU for each;
- screenshots each state with `screencapture -l` (this needs Screen Recording for the terminal).

It writes `probe.json` and the `.png`s next to it.

**What the design analysis already settles**, measurements aside:
- The native sheet sits behind the web contents and samples the **desktop**, so it can only ever stand in for the sidebar material. That is the same role `vibrancy: "sidebar"` already fills, at the price of `transparent: true` (§3.1).
- It cannot give the composer or toolbar groups lensing over the app's own content. Only the CSS rungs can.
- That is why §6 keeps vibrancy for the sidebar and doesn't adopt the addon.

## 6. Recommendation

### 6.1 Per surface
| Surface | Desktop (Electron) | Web, Chromium | Web, Safari/Firefox | Notes |
| --- | --- | --- | --- | --- |
| **Sidebar** (rail + thread list) | Native `vibrancy: "sidebar"`, `visualEffectState: "followWindow"` (A2 as planned) | Opaque `--surface-sidebar` | Opaque | macOS 27 sidebars are edge to edge and quiet again, so vibrancy is the right weight. It's the largest surface, so it's too costly for CSS blur. |
| **Toolbar** (52 px strip) | **No material.** A hard scroll edge (24 px `mask-image`) over the opaque canvas | Same | Same | In macOS 27 `automatic` resolves to hard when the title floats [28]. Non-interactive titles and status stay off glass [4]. |
| **Toolbar control groups** (mode + model pills, bell / ⋯) | `GlassSurface impl="refraction"`, capsule, regular | Refraction | CSS blur | At most three groups [2]. One tinted primary at most. Text and symbols in separate groups. |
| **Composer** | `GlassSurface impl="refraction"`, regular, radius = height / 2 | Refraction | CSS blur | The signature surface: small, fixed height, content scrolls under it. Rebuild the lens map on width change only. |
| **Popovers, menus, ⌘K palette** | `GlassSurface impl="css"`, regular, tint 72 % (today's `.material-glass`) | CSS | CSS | Transient and text-heavy. Large glass stays more opaque and doesn't flip [1]. |
| **Agent sheet, Settings sheets, dialogs** | Opaque `--surface-overlay` with `--elevation-3`, plus a dimming scrim | Opaque | Opaque | Apple: modal glass needs dimming, and sheets turn opaque as they grow [2][12]. Big glass costs the most. |
| **Clear variant** | Only for controls over media (image or video viewer, avatar crop) with a 35 % dark dim behind the labels | Same | CSS | Never mixed with regular in one view [1]. |

### 6.2 The fallback ladder
1. **native**: desktop sidebar only, through Electron `vibrancy`. A true `NSGlassEffectView` path waits for an in-repo addon (§6.4).
2. **refraction**: small fixed-size chrome in Chromium (desktop and Chromium browsers).
3. **css**: everything else that is glass, and refraction's fallback in Safari and Firefox.
4. **opaque**: under Reduce Transparency or Increase Contrast (media queries, plus `nativeTheme.prefersReducedTransparency` / `shouldUseHighContrastColors` in main); in an inactive window (`data-window-active="false"`, where glass "recedes" [1]); when the glass budget is exceeded; or whenever a surface would stack on glass (a popover over the composer).

`resolveGlassImpl` already implements rungs 1–4. Wiring the inactive-window and budget rules is A2's job (§6.3).

### 6.3 What workstream A should change in the window-chrome PR (A2)
1. **Keep** `vibrancy: "sidebar"` + `visualEffectState: "followWindow"` behind `appearance.vibrancy`, with `transparent: false`. **Don't** adopt `electron-liquid-glass`: whole-window, desktop-sampling, a sibling placement Apple warns against, `transparent: true` with its shadow, click-through and DevTools limits, the CSS `backdrop-filter` text bug in transparent windows, and an idle maintainer (§3.1).
2. **Electron ≥ 36.9.2 / 37.6.0 / 38.2.0** for the Tahoe WindowServer fix. 44.9.0 already qualifies; add a test that pins the floor.
3. **In main,** read `nativeTheme.prefersReducedTransparency` and `nativeTheme.shouldUseHighContrastColors`. On `nativeTheme` `updated`, call `setVibrancy(null)` / restore, and send both to the renderer as `data-reduce-transparency` / `data-contrast`. The CSS media queries already update live [E30], but the vibrancy layer is native and needs this.
4. **Inactive window:** on `blur`, set `data-window-active="false"` (already planned) **and** raise glass tints to opaque. `design.css` gets `:root[data-window-active="false"] { --material-glass: var(--surface-overlay); --material-blur: none; }`. `GlassSurface` should read the same flag as one more input to `resolveGlassImpl`.
5. **Toolbar:** delete the planned "scroll-edge strip" glass. Use the 24 px hard scroll-edge mask alone, and put glass only on the control groups (`GlassSurface impl="refraction"`, capsule radius).
6. **Composer:** move from `.material-glass` to `GlassSurface impl="refraction"`. Keep `.material-glass` as the CSS rung for popovers, menus and the palette.
7. **Sheets and dialogs:** opaque `--surface-overlay` plus a scrim. Remove glass from the agent sheet in §3.4's table.
8. **Tokens:** add `--material-glass-refraction: color-mix(in oklch, var(--surface-overlay) 50%, transparent)` and `--material-blur-refraction: blur(10px) saturate(1.8)`, and move `GlassSurface`'s inline tints onto these tokens.
9. **Budget:** keep motion.md §5's "two glass surfaces at once, never stacked". The spike shows three small surfaces cost +8–15 % of one core at 120 Hz on an M5, so the budget holds with margin. Treat the toolbar control groups as one container: they never overlap, so they count as one.
10. **Corner radius:** don't hard-code a window radius. macOS 27 uses one smaller radius for every window, and the system draws it. Concentric inner radii come from `--radius-window` minus padding, measured at runtime if needed.

### 6.4 Later: a real native glass layer
If the owner wants real `NSGlassEffectView` on the sidebar, write a ~200-line in-repo addon modelled on Tauri's `window-vibrancy` `liquid_glass.rs` [E19]:
- public API only (`style`, `cornerRadius`, `tintColor`, `clipsToBounds`);
- remove/update calls;
- `nativeTheme.prefersReducedTransparency` gating;
- the web view placed **inside** `glass.contentView`, Apple's guaranteed placement;
- the window and view made transparent only under the sidebar region.

It would still sample the desktop, not the app. Glass that refracts app content needs PR #50415's region overlay. Revisit if Electron reopens it.

---

## 7. Sources

**Apple and app survey** (WWDC pages are undated, so they are dated by session week; accessed 2026-10-25)

1. Apple, WWDC25 session 219 "Meet Liquid Glass." https://developer.apple.com/videos/play/wwdc2025/219/ (June 2025; accessed 2026-10-25)
2. Apple, WWDC25 session 356 "Get to know the new design system." https://developer.apple.com/videos/play/wwdc2025/356/ (June 2025; accessed 2026-10-25)
3. Apple, WWDC25 session 323 "Build a SwiftUI app with the new design." https://developer.apple.com/videos/play/wwdc2025/323/ (June 2025; accessed 2026-10-25)
4. Apple, WWDC25 session 310 "Build an AppKit app with the new design" (Jeff Nadeau). https://developer.apple.com/videos/play/wwdc2025/310/ (June 2025; accessed 2026-10-25)
5. Apple HIG, Materials. https://developer.apple.com/design/human-interface-guidelines/materials (Liquid Glass guidance added 2025-06-09, updated 2025-09-09)
6. Apple HIG, Toolbars. https://developer.apple.com/design/human-interface-guidelines/toolbars (grouping added 2025-06-09; Liquid Glass updated 2025-12-16)
7. Apple HIG, Tab bars. https://developer.apple.com/design/human-interface-guidelines/tab-bars (Liquid Glass added 2025-07-28, updated 2025-12-16; terminology/art 2026-06-08)
8. Apple HIG, Sidebars. https://developer.apple.com/design/human-interface-guidelines/sidebars (extend-under-sidebar 2025-06-09; icon colours and adaptable style 2026-06-08)
9. Apple HIG, Windows. https://developer.apple.com/design/human-interface-guidelines/windows (2025-06-09; no Liquid Glass-specific entry)
10. Apple HIG, Color ("Liquid Glass color"). https://developer.apple.com/design/human-interface-guidelines/color (2025-06-09; updated 2025-12-16)
11. Apple HIG, `/design/human-interface-guidelines/liquid-glass` returned HTTP 404 (accessed 2026-10-25)
12. Apple Developer, "Adopting Liquid Glass." https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass (undated; accessed 2026-10-25)
13. Apple Developer, "Liquid Glass" technology overview. https://developer.apple.com/documentation/technologyoverviews/liquid-glass (undated; accessed 2026-10-25)
14. Apple Developer, NSGlassEffectView. https://developer.apple.com/documentation/appkit/nsglasseffectview (macOS 26.0+; accessed 2026-10-25)
15. Apple Developer, NSGlassEffectView.Style. https://developer.apple.com/documentation/appkit/nsglasseffectview/style-swift.enum (accessed 2026-10-25)
16. Apple Developer, NSGlassEffectContainerView. https://developer.apple.com/documentation/appkit/nsglasseffectcontainerview (accessed 2026-10-25)
17. Apple Developer, SwiftUI Glass. https://developer.apple.com/documentation/swiftui/glass (accessed 2026-10-25)
18. Apple Developer, glassEffect(_:in:). https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:) (accessed 2026-10-25)
19. Apple Developer, GlassEffectContainer. https://developer.apple.com/documentation/swiftui/glasseffectcontainer (accessed 2026-10-25)
20. Apple Developer, glassEffectID(_:in:). https://developer.apple.com/documentation/swiftui/view/glasseffectid(_:in:) (accessed 2026-10-25)
21. Apple Developer, "Applying Liquid Glass to custom views." https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views (accessed 2026-10-25)
22. Apple Developer, backgroundExtensionEffect(). https://developer.apple.com/documentation/swiftui/view/backgroundextensioneffect() (accessed 2026-10-25)
23. Apple Developer, scrollEdgeEffectStyle(_:for:). https://developer.apple.com/documentation/swiftui/view/scrolledgeeffectstyle(_:for:) (accessed 2026-10-25)
24. Apple Developer, ScrollEdgeEffectStyle. https://developer.apple.com/documentation/swiftui/scrolledgeeffectstyle (accessed 2026-10-25)
25. Apple Newsroom, "Apple introduces a delightful and elegant new software design." https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/ (2025-06-09)
26. Apple, "All New Features — macOS Tahoe" PDF. https://www.apple.com/os/pdf/All_New_Features_macOS_Tahoe_Sept_2025.pdf (Sep 2025)
27. Apple Support, "What's new in the updates for macOS Tahoe 26." https://support.apple.com/en-us/122868 (covers 26.0–26.7.1; accessed 2026-10-25)
28. Apple, WWDC26 session 289 "Modernize your AppKit app." https://developer.apple.com/videos/play/wwdc2026/289/ (June 2026; accessed 2026-10-25)
29. MacRumors, "Apple announces Liquid Glass improvements" (Hartley Charlton). https://www.macrumors.com/2026/06/08/apple-announces-liquid-glass-improvements/ (2026-06-08)
30. MacRumors, "All the Liquid Glass Changes in macOS Golden Gate." https://www.macrumors.com/2026/06/09/macos-golden-gate-liquid-glass/ (2026-06-09)
31. Michael Tsai, blog roundup of WWDC26 Liquid Glass reactions (quotes 9to5Mac, MacRumors, Støvring, Suder, Troughton-Smith, Mantia, Khaos Tian). https://mjtsai.com/blog/2026/06/09/ (2026-06-09)
32. MacStories, "macOS 27: The MacStories Review," p. 3 (John Voorhees). https://www.macstories.net/stories/macos-27-the-macstories-review/3/ (Sep 2026, inferred from image dates)
33. MacStories, "macOS 26 Tahoe: The MacStories Review," p. 2 (John Voorhees). https://www.macstories.net/stories/macos-26-tahoe-the-macstories-review/2/ (Sep 2025; page undated)
34. Six Colors, "macOS 26 Tahoe review: Power under glass" (Jason Snell). https://sixcolors.com/post/2025/09/macos-26-tahoe-review-power-under-glass/ (2025-09-15)
35. Benjamin Mayo, "Tahoe Toolbars." https://bzamayo.com/tahoe-toolbars (2025-07-30)
36. Eclectic Light, "Appearance revisited: Get Tahoe 26.1 looking in better shape" (Howard Oakley). https://eclecticlight.co/2025/11/05/appearance-revisited-get-tahoe-26-1-looking-in-better-shape/ (2025-11-05)
37. Eclectic Light, "Last Week on My Mac: Tahoe 26.1 disappointments." https://eclecticlight.co/2025/11/09/last-week-on-my-mac-tahoe-26-1-disappointments/ (2025-11-09)
38. Six Colors, "Soaping up Liquid Glass: less transparency, more contrast" (Glenn Fleishman). https://sixcolors.com/post/2025/11/soaping-up-liquid-glass-less-transparency-more-contrast/ (2025-11-24)
39. Michael Tsai, "Liquid Glass Disbelief" (quotes Oakley, Mueller, Gruber, Heer, Troughton-Smith, Johnson, Guzmán). https://mjtsai.com/blog/2025/12/29/liquid-glass-disbelief (2025-12-29)
40. TechCrunch, "Apple's Liquid Glass interface improves with release of iOS 26 beta 2." https://techcrunch.com/2025/06/23/apples-liquid-glass-interface-improves-with-release-of-ios-26-beta-2 (2025-06-23; search snippet only, not read)
41. BGR, "People are freaking out over the Liquid Glass changes in iOS 26 beta 3." https://bgr.com/tech/ios-26-beta-3-liquid-glass-complaints/ (Jul 2025; search snippet only)
42. Wikipedia, "Liquid Glass" (secondary; cites The Verge 2025-07-07, MacRumors 2025-07-22 and 2025-10-20). https://en.wikipedia.org/wiki/Liquid_Glass (accessed 2026-10-25)
43. MacTrast, "Fourth iOS 26.1, iPadOS 26.1, and macOS Tahoe 26.1 betas allow users to control Liquid Glass shine." https://www.mactrast.com/2025/10/fourth-ios-26-1-ipados-26-1-and-macos-tahoe-26-1-betas-allow-users-to-control-liquid-glass-shine/amp/ (Oct 2025; search snippet only)
44. Cultured Code, "Things for OS 26." https://culturedcode.com/things/blog/2025/09/things-for-os-26/ (2025-09-15)
45. Cultured Code, "Things for OS 27 and Siri AI." https://culturedcode.com/things/blog/2026/09/things-for-os-27-and-siri-ai/ (2026-09-14)
46. TidBITS Watchlist, "Fantastical 4.1, Cardhop 2.4." https://tidbits.com/watchlist/fantastical-4-1-cardhop-2-4/ (2025-09-22)
47. Craft, https://www.craft.do/v3 and 9to5Mac (sponsored), https://9to5mac.com/2025/09/23/craft-ipad-liquid-glass-foundation-models/ (2025-09-23; search summary only)
48. Raycast changelog v2.4 (macOS). https://www.raycast.com/changelog/macos/2-4 (2026-09-14)
49. AlternativeTo, "Raycast v1.103.0 implements Liquid Glass controls..." https://alternativeto.net/news/2025/9/raycast-v1-103-0-implements-liquid-glass-controls-and-comet-browser-support/ (2025-09-16)
50. Dia changelog 1.15.0. https://www.diabrowser.com/changelog/mac/1-15-0 (Jan 2026; the page says 23 Jan, a search snippet said 22 Jan)
51. Wikipedia, "Arc (web browser)." https://en.wikipedia.org/wiki/Arc_(web_browser) (accessed 2026-10-25)
52. codenote.net, "A 2026 Audit of Famous Electron Apps." https://codenote.net/en/posts/famous-electron-apps-2026-research/ (2026-05-04; secondary, used for stack identification only)
53. electron/electron PR #50415, "feat: add native Liquid Glass support on macOS 26+." https://github.com/electron/electron/pull/50415 (opened 2026-03-22, closed 2026-06-30)
54. Meridius-Labs/electron-liquid-glass. https://github.com/Meridius-Labs/electron-liquid-glass (accessed 2026-10-25)
55. sudosylabs/elg. https://github.com/sudosylabs/elg (accessed 2026-10-25)
56. illixion/vscode-vibrancy-continued PR #274. https://github.com/illixion/vscode-vibrancy-continued/pull/274 (2026-09-19 to 2026-09-21)
57. Electron PR #48376 (fixes #48311), stop overriding `_cornerMask`. https://releases.electronjs.org/pr/48376 (Sep–Oct 2025; search snippet only)
58. AppleInsider, "Update your Slack, Discord clients — the Electron Tahoe GPU slowdown bug is fixed." https://appleinsider.com/articles/25/10/10/update-your-slack-discord-clients-the-electron-tahoe-gpu-slowdown-bug-is-fixed (2025-10-10)
59. 9to5Mac, "macOS 26 Tahoe Electron GPU slowdown bug fix rollout." https://9to5mac.com/2025/10/11/macos-26-tahoe-electron-gpu-slowdown-bug-fix-rollout/ (2025-10-11)
60. docs.rs, liquid-glass-rs 0.1.1. https://docs.rs/liquid-glass-rs (accessed 2026-10-25; search summary)
61. docs.rs, rio-window `platform_impl/macos/glass.rs`. https://docs.rs/crate/rio-window/0.5.11/source/src/platform_impl/macos/glass.rs (accessed 2026-10-25; search summary)
62. Electron docs, BrowserWindow (`setVibrancy` types). https://www.electronjs.org/docs/latest/api/browser-window (accessed 2026-10-25)
63. BGR, "Figma debuts Glass effect playground..." https://bgr.com/tech/figma-debuts-glass-effect-playground-to-help-developers-prep-ios-26-apps/ and AlternativeTo https://alternativeto.net/news/2025/7/figma-introduces-glass-effect-and-interactive-playground-for-design (Jul 2025; search summaries)
64. CotEditor 6.0.0 beta release notes. https://coteditor.com/releasenotes/6.0.0-beta.en (2025; search summary)
65. GitHub PRs: ReviewStage/luke #4755 https://github.com/ReviewStage/luke/pull/4755 ; egoist/mygo #719 https://github.com/egoist/mygo/pull/719 ; OpenSource03/electron-glasskit #1 https://github.com/OpenSource03/electron-glasskit/pull/1 (titles from search only)

**Electron, web and performance** (accessed 2026-10-25 unless noted)

- **E1.** Meridius-Labs/electron-liquid-glass, GitHub repo and README. https://github.com/Meridius-Labs/electron-liquid-glass ; raw README https://raw.githubusercontent.com/Meridius-Labs/electron-liquid-glass/main/README.md (repo created 2025-06-16; README as of 2025-09).
- **E2.** npm registry metadata, `electron-liquid-glass`. https://registry.npmjs.org/electron-liquid-glass (versions 0.1.5 to 1.1.1, 2025-06-17 to 2025-09-17).
- **E3.** Published package source, electron-liquid-glass@1.1.1 (2025-09-17): https://unpkg.com/electron-liquid-glass@1.1.1/?meta , `/src/glass_effect.mm`, `/src/liquidglass.cc`, `/js/index.ts`, `/js/variants.ts`, `/js/native-loader.ts`, `/package.json`.
- **E4.** npm downloads API. https://api.npmjs.org/downloads/point/last-week/electron-liquid-glass (2026-10-16 to 10-22) and `/last-month/` (2026-09-23 to 10-22).
- **E5.** GitHub API for Meridius-Labs/electron-liquid-glass: repo stats, commits (latest 2025-09-30), releases (v0.1.1 2025-06-17 to v1.1.1 2025-09-17), issues #15 (2025-07-18), #22 (2025-08-13), #36 (2025-09-17), #64 (2026-06-08). https://github.com/Meridius-Labs/electron-liquid-glass/issues
- **E6.** electron/electron PR #50415 "feat: add native Liquid Glass support on macOS 26+" (opened 2026-03-22, closed 2026-06-30), with body, files diff, timeline and comments (2026-03-27, 2026-05-15, 2026-07-08, 2026-09-21, 2026-09-23). https://github.com/electron/electron/pull/50415 ; cross-ref illixion/vscode-vibrancy-continued#274 https://github.com/illixion/vscode-vibrancy-continued/pull/274
- **E7.** electron/electron issue #48311 "Electron-based apps cause a huge system-wide lag on macOS 26" (2025-09-12 to 2025-09-26); root-cause comment 2025-09-25 https://github.com/electron/electron/issues/48311#issuecomment-3332181420 ; fixed-versions comment 2025-09-29 https://github.com/electron/electron/issues/48311#issuecomment-3344695272
- **E8.** electron/electron PR #48376 (merged 2025-09-26) https://github.com/electron/electron/pull/48376 ; backports #48398 (38-x-y), #48399 (39-x-y), #48400 (37-x-y), #48401 (36-x-y), merged 2025-09-27.
- **E9.** heise, "Under macOS 26 Tahoe: huge lag with Electron apps." https://heise.de/-10692165 (seen through search only; date **[UNVERIFIED]**, about late Sept/Oct 2025).
- **E10.** Electron docs `docs/api/structures/base-window-options.md` and `docs/api/base-window.md` (main; last commit to base-window.md 2026-10-19). https://github.com/electron/electron/blob/main/docs/api/structures/base-window-options.md
- **E11.** Electron docs `docs/api/browser-window.md` `win.setVibrancy(type[, options])` (main, 2026-10). https://github.com/electron/electron/blob/main/docs/api/browser-window.md ; PR #35987 (2022-10-11) https://github.com/electron/electron/pull/35987
- **E12.** Electron docs, "Custom Window Styles › Transparent windows › Limitations." https://github.com/electron/electron/blob/main/docs/tutorial/custom-window-styles.md
- **E13.** electron/electron #39529 (2023-08-16, closed not-planned 2025-05-27) https://github.com/electron/electron/issues/39529 ; #44720 (2024-11-19, closed 2025-06-10) https://github.com/electron/electron/issues/44720 ; SVG workaround comment 2026-05-21 https://github.com/electron/electron/issues/39529#issuecomment-4506093334 ; Chromium https://issues.chromium.org/issues/380416865 (status **[UNVERIFIED]**); #25513 (2020-09-17, open).
- **E14.** Obsidian Forum, "Translucent window shows no vibrancy/blur on macOS 26…" (posted 2026-06-21, auto-closed 2026-09-19). https://forum.obsidian.md/t/translucent-window-shows-no-vibrancy-blur-on-macos-26-works-in-other-apps-fails-in-themes-default/115493
- **E15.** electron/electron #47514 (2025-06-23, open) https://github.com/electron/electron/issues/47514 , maintainer comments 2025-06-23 and 2025-09-17; #48343 (2025-09-17, closed duplicate) https://github.com/electron/electron/issues/48343
- **E16.** Chromium `build/config/mac/mac_sdk.gni` at tag 152.0.7977.167 (`mac_sdk_official_version = "26.5"`) and 140.0.7339.133 (`"15.5"`). https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.167/build/config/mac/mac_sdk.gni
- **E17.** Electron releases index. https://releases.electronjs.org/releases.json (44.9.0 2026-10-17 Chrome 152.0.7977.167; 45.0.0 2026-10-21 Chrome 156; 36.9.2, 37.6.0, 38.2.0 all 2025-09-27).
- **E18.** Apple Developer Documentation: NSGlassEffectView (macOS 26.0), `contentView`, `effectIsInteractive` (macOS 27.0), `NSGlassEffectView.Style` (`regular`, `clear`), NSGlassEffectContainerView (macOS 26.0). https://developer.apple.com/documentation/appkit/nsglasseffectview (read through the JSON endpoint).
- **E19.** tauri-apps/window-vibrancy: `src/macos/liquid_glass.rs` and `src/lib.rs` (main; last commits 2026-10-14/15), CHANGELOG, crates.io versions (0.7.0 2025-11-12, 0.8.0 2026-07-16, 0.8.1 2026-09-22), docs.rs 0.8.1. https://github.com/tauri-apps/window-vibrancy ; https://docs.rs/window-vibrancy/latest/window_vibrancy/
- **E20.** (merged into 6)
- **E21.** Chris Feijoo, "Liquid Glass in the Browser: Refraction with CSS and SVG," kube.io, 2025-09-04. https://kube.io/blog/liquid-glass-css-svg/
- **E22.** Chris Coyier, "Liquid Glass in the Browser," Frontend Masters blog, 2025-12-18. https://blog.master.dev/liquid-glass-in-the-browser/ (redirect from frontendmasters.com)
- **E23.** Rahul Chhodde, "How to create Liquid Glass effects with CSS and SVG," LogRocket Blog, 2025-12-08. https://blog.logrocket.com/how-create-liquid-glass-effects-css-and-svg/
- **E24.** WebKit Bug 245510, "backdrop-filter: url(#some-svg-filter) doesn't work with SVG filters like feDisplacementMap" (reported 2022-09-21; NEW; last modified 2026-09-05). https://bugs.webkit.org/show_bug.cgi?id=245510
- **E25.** rdev/liquid-glass-react: GitHub (created 2025-06-10, last push 2025-06-13), README, npm (1.1.1 published 2025-06-11), npm downloads 2026-10-16 to 22. https://github.com/rdev/liquid-glass-react ; https://www.npmjs.com/package/liquid-glass-react
- **E26.** Josh W. Comeau, "Next-level frosted glass with backdrop-filter" (published 2024-12-02; the fetched page includes notes on Chrome 142 and a Firefox fix in Sept 2026, so it was updated later). https://www.joshwcomeau.com/css/backdrop-filter/
- **E27.** MDN browser-compat-data (main, 2026-10-25): `css/at-rules/media.json` (prefers-reduced-transparency, prefers-contrast, prefers-reduced-motion), `css/properties/backdrop-filter.json`. https://github.com/mdn/browser-compat-data
- **E28.** Adam Argyle, "CSS prefers-reduced-transparency," Chrome for Developers (Chrome 118; last updated 2023-10-25). https://developer.chrome.com/blog/css-prefers-reduced-transparency
- **E29.** MDN, `prefers-reduced-transparency` (last modified 2026-04-20). https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency ; MDN `prefers-contrast` (2026-04-20) https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-contrast
- **E30.** Chromium source `ui/native_theme/os_settings_provider_mac.mm` and `ui/native_theme/native_theme.cc` (main, 2026-10-25). https://chromium.googlesource.com/chromium/src/+/main/ui/native_theme/os_settings_provider_mac.mm
- **E31.** Electron docs `docs/api/native-theme.md` (main); PR #42862 (merged 2024-07-24) https://github.com/electron/electron/pull/42862 with backports #43138 (30-x-y), #43137 (31-x-y), #43024 (32-x-y); `docs/breaking-changes.md` deprecation of `systemPreferences.accessibilityDisplayShouldReduceTransparency`.
- **E32.** Electron docs `docs/api/system-preferences.md` (`getAnimationSettings()`, deprecated `accessibilityDisplayShouldReduceTransparency`). https://github.com/electron/electron/blob/main/docs/api/system-preferences.md
- **E33.** @electron/osx-sign default entitlements (`entitlements/default.darwin*.plist`). https://github.com/electron/osx-sign/tree/main/entitlements
- **E34.** electron-builder docs: `website/docs/features/code-signing/code-signing-mac.md`, `website/docs/mac.md` ("Loading third-party or unsigned binaries"), `website/docs/migration/v27-runtime-changes.md` (electron-builder 27.0.0-alpha.12, 2026-10-24). https://github.com/electron-userland/electron-builder
- **E35.** Psyche repo (read locally, unmodified): `apps/desktop/entitlements.plist`, `apps/desktop/forge.config.ts`, `apps/desktop/src/packaging/signing-config.ts`, `apps/desktop/package.json`.
- **E36.** Performance reports: mrchevyceleb/lumen PR #27 (2026-10-22) https://github.com/mrchevyceleb/lumen/pull/27 ; Station-Sciences/bot-crossing #74 (2026-09-24) https://github.com/Station-Sciences/bot-crossing/issues/74 ; brave/brave-browser #26186 (2022-10-23) https://github.com/brave/brave-browser/issues/26186
- **E37.** Grida working-group notes on Chromium render surfaces and effect optimizations (seen through search; the page redirected; **[UNVERIFIED]**). https://canary.grida.co/docs/wg/research/chromium/render-surfaces ; 21st.dev guide https://21st.dev/blog/liquid-glass-react-components
- **E38.** ProMotion: daimiaopeng/coolapk-desktop #53 (2026, through search) https://github.com/daimiaopeng/coolapk-desktop/issues/53 ; Apple Developer Forums thread 840214 (macOS 27 beta ProMotion judder, through search) https://developer.apple.com/forums/thread/840214 (both **[UNVERIFIED]** details).
- **E39.** Electron docs `win.getNativeWindowHandle()` ("NSView* on macOS"). https://github.com/electron/electron/blob/main/docs/api/base-window.md
- **E40.** MDN, "Registering custom properties" and `@property`. https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Properties_and_values_API/Registering_properties
- **E41.** Scroll edge: Apple `scrollEdgeEffectStyle` docs https://developer.apple.com/documentation/swiftui/scrolledgeeffectstyle ; Apple Dev Forums 840840 https://developer.apple.com/forums/thread/840840 ; tw-fade README https://cdn.jsdelivr.net/npm/tw-fade@0.8.0/README.md (all through search).
