# Psyche redesign research: Apple HIG (macOS 26), Electron on macOS, reference apps

Compiled 2026-10-25. Every fact has a URL and a date. HIG pages show no publish date, so the date given for each is the newest entry in that page's change log. The HIG pages are JavaScript-rendered, so their text was read from Apple's DocC JSON (`developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json`); the human-readable URL is cited. Items marked **[secondary]** are not from the company or Apple. Items marked **[local inspection]** were read from app bundles on this Mac on 2026-10-25.

---

## 1. Apple HIG for macOS

### 1.1 Layout margins and spacing
- **Apple publishes no fixed macOS window margin or spacing numbers.** The macOS section of the Layout page says only to avoid placing controls or critical information at the bottom of a window, and to avoid displaying content behind the camera housing. The only point values on the page are for tvOS (60 pt top/bottom, 80 pt sides) and visionOS (60 pt between button centres). Source: https://developer.apple.com/design/human-interface-guidelines/layout (change log: September 9, 2026).
- The HIG says to "respect system-defined safe areas, margins, and guides", and that layout guides "apply standard margins around content and restrict the width of text for optimal readability" (`NSLayoutGuide`). Source: same URL and date.
- Liquid Glass layout rule: "Instead of applying a solid or semi-opaque background color beneath controls, use a scroll edge effect", and full-window background content should extend beneath sidebars, toolbars and tab bars. Source: same URL and date.
- Hierarchy is created with alignment, indentation, grouping and negative space, and with progressive disclosure through disclosure triangles and menus. Source: same URL and date.
- In macOS 26, the safe area for content near rounded window corners is `layoutGuide(for: .safeArea(cornerAdaptation: .horizontal))`. Source: WWDC25 "Build an AppKit app with the new design", https://developer.apple.com/videos/play/wwdc2025/310/ (June 2025).

### 1.2 Sidebars
- **The HIG gives no sidebar width.** On macOS, "a sidebar's row height, text, and glyph size depend on its overall size, which can be small, medium, or large". Users set this under General settings → Sidebar icon size. Source: https://developer.apple.com/design/human-interface-guidelines/sidebars (change log: June 8, 2026).
- In macOS 26, sidebars "can float above content in the Liquid Glass layer", and content can extend beneath them by scrolling horizontally or with a background extension effect. Source: same URL and date.
- Let people hide the sidebar: provide a show/hide button plus View → Show/Hide Sidebar commands, and don't hide it by default. Source: same URL and date.
- Sidebar icons use the app accent colour by default and should follow the user's system accent colour. Use fixed colours sparingly; Mail's yellow VIP icon is Apple's example. Source: same URL and date.
- AppKit in macOS 26: the sidebar is "a pane of glass that floats above the window's content", while inspectors use "edge-to-edge glass". Apple says to remove any legacy `NSVisualEffectView` sidebar material because it "will prevent the glass material from showing through." Source: https://developer.apple.com/videos/play/wwdc2025/310/ (June 2025).
- Sidebars are now inset, and scroll views extend beneath them by default. Source: WWDC25 "Get to know the new design system", https://developer.apple.com/videos/play/wwdc2025/356/ (June 2025).

### 1.3 Toolbars: unified vs compact
- **Apple publishes no point heights for toolbars.** The values often quoted (about 52 pt for unified, 38 pt for unified compact, 28 pt for a title bar alone) could not be confirmed from any Apple or credible source. Measure them at runtime instead. Search notes: undated, fetched 2026-10-25.
- `unifiedCompact` is "a style indicating that the toolbar appears next to the window title and with reduced margins to allow more focus on the window's contents." Source: https://developer.apple.com/documentation/appkit/nswindow/toolbarstyle-swift.enum/unifiedcompact (undated, fetched 2026-10-25).
- Big Sur introduced the two styles. Unified "emphasizes the controls in the toolbar", with large controls and an inline title, and suits "most windows". Unified compact has "a more compressed layout with regular-sized controls and a smaller toolbar height". Toolbar symbols are "13-point size, medium weight, and using the large symbol scale". Source: https://developer.apple.com/videos/play/wwdc2020/10104/ (June 2020).
- In macOS the toolbar "resides in the frame at the top of a window, either below or integrated with the title bar", and toolbar items have no bezel. Use `.prominent` for a single primary action on the trailing side. The system manages overflow, so don't add an overflow menu yourself. Source: https://developer.apple.com/design/human-interface-guidelines/toolbars (change log: December 16, 2025).
- Concentricity in bars: "standard buttons, text fields, headers, and footers have corner radii that are concentric with bar corners"; custom components should be too. Source: same URL and date.
- In macOS 26, toolbar items sit on glass. Adjacent buttons are grouped onto one glass piece. Use `isBordered = false` for items that aren't interactive. Source: https://developer.apple.com/videos/play/wwdc2025/310/ (June 2025).

### 1.4 Window chrome and traffic lights
- Apple publishes no numeric inset for the traffic lights. In macOS 26, windows have a "softer, more generous corner radius, which varies based on the style of window". Windows with toolbars wrap "concentrically around the glass toolbar elements", and windows with only a title bar wrap "compactly around the window controls". Source: https://developer.apple.com/videos/play/wwdc2025/310/ (June 2025).
- Reports from developers confirm that Tahoe uses several different window corner radii, with toolbar windows the roundest. **[secondary]** https://mjtsai.com/blog/2025/10/16/tahoe-window-corners (Oct 16, 2025, updated through Sept 2026).
- Key, main and inactive windows must look different. Inactive windows "don't use materials" and their traffic lights turn grey, and custom windows have to reproduce this themselves. Source: https://developer.apple.com/design/human-interface-guidelines/windows (change log: June 9, 2025).

### 1.5 Typography (macOS)
- Default text size on macOS is **13 pt**, and the minimum is **10 pt**. On iOS the default is 17 and the minimum 11. Source: https://developer.apple.com/design/human-interface-guidelines/typography (change log: December 16, 2025).
- "SF Pro is the system font in macOS… macOS doesn't support Dynamic Type." Avoid the Ultralight, Thin and Light weights; prefer Regular, Medium, Semibold or Bold. Source: same URL and date.
- **macOS built-in text styles** (size / line height in pt; the weight in parentheses is the emphasized weight). Source: same URL and date.

| Style | Weight | Size | Line height | Emphasized |
|---|---|---|---|---|
| Large Title | Regular | 26 | 32 | Bold |
| Title 1 | Regular | 22 | 26 | Bold |
| Title 2 | Regular | 17 | 22 | Bold |
| Title 3 | Regular | 15 | 20 | Semibold |
| Headline | Bold | 13 | 16 | Heavy |
| Body | Regular | 13 | 16 | Semibold |
| Callout | Regular | 12 | 15 | Semibold |
| Subheadline | Regular | 11 | 14 | Semibold |
| Footnote | Regular | 10 | 13 | Semibold |
| Caption 1 | Regular | 10 | 13 | Medium |
| Caption 2 | Medium | 10 | 13 | Semibold |

- **macOS tracking** (SF Pro, in points): 10 pt +0.12, 11 pt +0.06, 12 pt 0, 13 pt −0.08, 15 pt −0.23, 17 pt −0.43, 20 pt −0.45, 22 pt −0.26, 26 pt +0.22. This matters on the web, where the system font does not get these tracking adjustments automatically. Source: same URL and date.
- In macOS 26, typography is "bolder and left-aligned to improve readability in key moments like alerts and onboarding." Source: https://developer.apple.com/videos/play/wwdc2025/356/ (June 2025).
- Contrast minimums: text up to 17 pt needs 4.5:1, and bold text needs 3:1. Source: https://developer.apple.com/design/human-interface-guidelines/accessibility (change log: June 9, 2025).

### 1.6 Materials and vibrancy
- Apple now has two kinds of material. **Liquid Glass** is for "controls and navigation" and floats above the content layer. **Standard materials** "help with visual differentiation within the content layer." Source: https://developer.apple.com/design/human-interface-guidelines/materials (change log: September 9, 2025).
- macOS provides standard materials "with designated purposes", plus vibrant versions of all system colours. There are two blending modes, *behind window* and *within window*. Use vibrant colours on top of materials, and choose a material by its meaning, not by the colour it happens to give. Source: same URL and date.
- `NSVisualEffectView.Material.sidebar` is "the material for the background of window sidebars." Source: https://developer.apple.com/documentation/appkit/nsvisualeffectview/material-swift.enum/sidebar (undated, fetched 2026-10-25).

### 1.7 Liquid Glass (macOS 26 Tahoe, WWDC 2025)
- **What it is:** a "new translucent material" that "reflects and refracts its surroundings". It ships in iOS, iPadOS, macOS Tahoe, watchOS and tvOS 26. On macOS the menu bar is "completely transparent", sidebars refract the content and wallpaper behind them, and toolbars "fit concentrically with the rounded corners of windows." Source: https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/ (June 9, 2025).
- It is a "digital meta-material that dynamically bends and shapes light". It defines itself through **lensing** and adapts to its size and to whatever is behind it. Source: WWDC25 "Meet Liquid Glass", https://developer.apple.com/videos/play/wwdc2025/219/ (June 2025).
- **Where glass goes:**
  - "Don't use Liquid Glass in the content layer." Apple names tab bars and sidebars as examples of where it belongs. The one exception is transient controls such as sliders and toggles while they are being used. Source: materials HIG (September 9, 2025).
  - "Use Liquid Glass effects sparingly." Source: materials HIG (September 9, 2025).
  - The table view example: glass is "best reserved for the navigation layer". A table made of glass "would… muddy the hierarchy." Source: https://developer.apple.com/videos/play/wwdc2025/219/ (June 2025).
  - "Always avoid glass on glass." Elements on top of glass should use "fills, transparency, and vibrancy" instead. Source: https://developer.apple.com/videos/play/wwdc2025/219/ (June 2025).
- **Variants:**
  - *Regular* is used by most system components. It is the right choice for text-heavy components such as "alerts, sidebars, or popovers".
  - *Clear* is only for components over visually rich media. It needs a dimming layer, about **35% dark** over bright content.
  - The two variants must never be mixed.
  - Sources: materials HIG (September 9, 2025); https://developer.apple.com/videos/play/wwdc2025/219/ (June 2025).
- **Concentricity:** there are three shape types. *Fixed* keeps a constant radius. *Capsule* uses a radius equal to half the height. *Concentric* means "calculate their radius by subtracting padding from the parent's". On Mac, "use a concentric shape that aligns with the window edge". On macOS, mini, small and medium controls stay rounded rectangles, while large and the new X-Large controls are capsules. Source: https://developer.apple.com/videos/play/wwdc2025/356/ (June 2025). SwiftUI's `ConcentricRectangle` computes these radii from the container shape: https://developer.apple.com/documentation/swiftui/concentricrectangle (undated, fetched 2026-10-25).
- **Scroll edge effects** replace "hard dividers with subtle blur". The *hard* style is "mostly used on macOS", for interactive text, controls without a background, and pinned table headers. Apply one per view; split-view panes each get their own, kept at consistent heights. Sources: https://developer.apple.com/videos/play/wwdc2025/356/ (June 2025); https://developer.apple.com/design/human-interface-guidelines/scroll-views (change log: June 8, 2026).
- **Accessibility fallbacks:**
  - *Reduce Transparency* "makes Liquid Glass frostier and obscures more of the content behind it."
  - *Increase Contrast* "makes elements predominantly black or white and highlights them with a contrasting border."
  - *Reduce Motion* "decreases the intensity of some effects and disables any elastic properties."
  - Source: https://developer.apple.com/videos/play/wwdc2025/219/ (June 2025).
- **Colour:** Liquid Glass "has no inherent color". Tint only to emphasise a primary call to action. Source: https://developer.apple.com/design/human-interface-guidelines/color (change log: December 16, 2025).

### 1.8 Sheets, popovers and alerts
- **Sheet:** on macOS, a sheet is always modal. It is "a cardlike view with rounded corners that floats on top of its parent window", and the parent window is dimmed. Use a sensible default size. Use a panel instead if people need to give input repeatedly and watch the results. Source: https://developer.apple.com/design/human-interface-guidelines/sheets (change log: March 24, 2026).
- **Popover:** for "a small amount of information or functionality". The arrow should point "as directly as possible" at the element that opened it, and the popover shouldn't cover that element. It closes when people click outside it. On macOS it can be made detachable into a panel. Source: https://developer.apple.com/design/human-interface-guidelines/popovers (undated, fetched 2026-10-25).
- **Alert:**
  - Use alerts sparingly, and never for undoable actions.
  - The default button goes on the trailing side, and Cancel goes on the leading side.
  - Avoid "OK" as a title. Use the caution symbol sparingly.
  - macOS shows the app icon automatically, and supports a suppression checkbox and a Help button.
  - Source: https://developer.apple.com/design/human-interface-guidelines/alerts (change log: February 2, 2024).

### 1.9 Scroll bars
- On macOS the scroll indicator "is commonly called a scroll bar". The scroll view "can display a translucent scroll indicator that typically appears after people begin scrolling", which is the overlay style. Use small or mini scroll bars in tight panels. Source: https://developer.apple.com/design/human-interface-guidelines/scroll-views (June 8, 2026).
- macOS 26.4 changed scroll bars so they stop above the curve of large window corners. **[secondary]** https://anderegg.ca/2026/03/30/two-more-liquid-glass-fixes-in-macos-264 (Mar 30, 2026).

### 1.10 Focus rings
- Use a focus ring (halo) for text and search fields. In lists, highlight the whole row instead. A focused row gets white text on an accent-colour background; an unfocused selected row is drawn in grey. With full keyboard access, the system handles focus for buttons and other controls. Source: https://developer.apple.com/design/human-interface-guidelines/focus-and-selection (change log: October 24, 2023).

### 1.11 Motion
- From the HIG:
  - "Add motion purposefully… Don't add motion for the sake of adding motion."
  - "Make motion optional", so it never carries information on its own.
  - "Aim for brevity and precision in feedback animations."
  - "Generally avoid adding motion to UI interactions that occur frequently."
  - "Let people cancel motion."
  - Liquid Glass motion is "more subdued" with a trackpad than with touch.
  - There is no macOS-specific guidance, and **the page publishes no durations.**
  - Source: https://developer.apple.com/design/human-interface-guidelines/motion (change log: September 9, 2025).
- Under Reduce Motion, reduce "automatic and repetitive animations, including zooming, scaling, and peripheral motion." Source: accessibility HIG (June 9, 2025).
- Concrete system defaults:
  - Since macOS 14, SwiftUI's `default` animation is a spring with `response 0.55`, `dampingFraction 1.0` (critically damped, no bounce). Before that it was easeInOut. Source: https://developer.apple.com/documentation/swiftui/animation/default (undated, fetched 2026-10-25).
  - `.smooth` is a spring "with a predefined duration and no bounce", and `.snappy` adds "a small amount of bounce". Sources: https://developer.apple.com/documentation/swiftui/animation/smooth and https://developer.apple.com/documentation/swiftui/animation/snappy (undated, fetched 2026-10-25).

### 1.12 SF Symbols
- There are nine weights, ultralight to black, each matched to an SF font weight, and three scales (small, medium, large) relative to cap height. Rendering modes are monochrome, hierarchical, palette and multicolor. SF Symbols 7 adds Draw animations and gradients. Source: https://developer.apple.com/design/human-interface-guidelines/sf-symbols (change log: July 28, 2025).
- On the web, the practical rule is to match the icon stroke weight to the adjacent text weight. In toolbars, symbols are 13 pt medium at large scale (WWDC20 10104 above).

---

## 2. Electron on macOS

### 2.1 Window options (Electron "latest" docs)
- **`vibrancy`** (macOS) accepts `appearance-based`, `titlebar`, `selection`, `menu`, `popover`, `sidebar`, `header`, `sheet`, `window`, `hud`, `fullscreen-ui`, `tooltip`, `content`, `under-window` and `under-page`. Source: https://www.electronjs.org/docs/latest/api/structures/base-window-options (undated, fetched 2026-10-25).
- **`visualEffectState`** takes `followWindow` (the default: active only when the window is active, as Apple's HIG requires), `active` or `inactive`. It must be used together with `vibrancy`. Source: same URL.
- **`backgroundMaterial`** (`auto`, `none`, `mica`, `acrylic`, `tabbed`) is **Windows-only**, on Windows 11 22H2 and later. Sources: same URL; https://www.electronjs.org/docs/latest/api/browser-window (undated, fetched 2026-10-25).
- **`titleBarStyle`:**
  - `hidden` keeps the traffic lights and gives full-size content.
  - `hiddenInset` gives "the traffic light buttons… slightly more inset from the window edge".
  - `customButtonsOnHover` shows the traffic lights only on hover and is marked "currently experimental".
  - Sources: base-window-options (above); https://www.electronjs.org/docs/latest/tutorial/custom-title-bar (undated, fetched 2026-10-25).
- **`trafficLightPosition`** / `win.setWindowButtonPosition({x,y})` set a custom position in frameless windows; `null` resets to the default. Drag areas use `app-region: drag`. Sources: same two URLs.
- `win.setVibrancy(type, {animationDuration})` fades vibrancy in or out, but "animating between different types of vibrancy is not supported." Source: https://www.electronjs.org/docs/latest/api/browser-window (fetched 2026-10-25).
- To avoid a flash on open, either show the window after `ready-to-show`, or show it immediately with a `backgroundColor` close to the app background. The docs say it "is still recommended to set `backgroundColor` to make the app feel more native." Source: same URL.

### 2.2 Caveats
- **Vibrancy needs transparency.** The web content behind the vibrant area must be transparent: `backgroundColor: '#00000000'` plus a transparent CSS background. BrowserWindow supports **only one vibrancy material per window**, so a native addon is needed to get separate sidebar and content materials. Source: https://github.com/davidcann/electron-tinted-with-sidebar (undated, fetched 2026-10-25).
- **Fully `transparent: true` windows:**
  - You cannot click through transparent areas.
  - Transparent windows are "not resizable", and `resizable: true` may break them.
  - Transparency is lost while DevTools is open.
  - On macOS the native shadow is not shown.
  - CSS blur only reaches the window's own web contents.
  - Source: https://www.electronjs.org/docs/latest/tutorial/custom-window-styles (undated, fetched 2026-10-25).
- **Performance on Tahoe:**
  - Electron's override of the private `_cornerMask` method caused high WindowServer GPU load on macOS 26.
  - The fix is Electron PR #48376, merged Sept 26, 2025 and shipped in 36.9.2, 37.6.0, 38.2.0 and 39.0.0-alpha.7. Psyche's Electron 44 already includes it.
  - Sources: https://releases.electronjs.org/pr/48376 (Sept 2025); https://appleinsider.com/articles/25/10/10/update-your-slack-discord-clients-the-electron-tahoe-gpu-slowdown-bug-is-fixed (Oct 10, 2025).
- An Obsidian user reports that on macOS 26 a translucent window rendered flat grey and `setVibrancy('under-window')` had no effect. Test vibrancy on Tahoe specifically. **[secondary]** https://forum.obsidian.md/t/translucent-window-shows-no-vibrancy-blur-on-macos-26-works-in-other-apps-fails-in-themes-default/115493 (2026, fetched 2026-10-25).
- **Web client approximation:**
  - CSS `backdrop-filter` has been Baseline (newly available) since September 2024.
  - It only shows when the element's background is (semi-)transparent.
  - It stops at the nearest **backdrop root**: any ancestor with `filter`, `opacity < 1`, `mask`, `clip-path`, `mix-blend-mode` or its own `backdrop-filter`. This is a common source of "blur does nothing" bugs.
  - Source: https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter (last modified Apr 20, 2026).
  - Recommendation: in Electron, use a native `sidebar` material with a transparent CSS sidebar. On the web, use a `rgb(... / 0.7)` surface with `backdrop-filter: blur() saturate()`, and fall back to opaque under `prefers-reduced-transparency` / `prefers-contrast: more`.

### 2.3 Liquid Glass in Electron and Chromium (as of October 2026)
- **No built-in support.**
  - Felix Rieseberg's Electron PR #50415, "feat: add native Liquid Glass support on macOS 26+", proposed `win.setGlassEffect({style: 'regular'|'clear', cornerRadius, tintColor})`, `setGlassEffectRegions()` and `isGlassEffectSupported()`.
  - It was opened Mar 22, 2026 and **closed unmerged** Jun 30, 2026. Commenters in Jul–Sep 2026 are still asking why.
  - Source: https://github.com/electron/electron/pull/50415 (read via GitHub CLI, fetched 2026-10-25).
- `NSGlassEffectView` is a public AppKit class from macOS 26.0: "A view that embeds its content view in a dynamic glass effect." Source: https://developer.apple.com/documentation/appkit/nsglasseffectview (undated, fetched 2026-10-25).
- The community addon **electron-liquid-glass** (Meridius Labs) inserts `NSGlassEffectView` behind web content.
  - Requirements: macOS 26 or later, Electron 30 or later, `transparent: true`, and vibrancy left off.
  - Its `unstable_*` variant APIs are reverse-engineered, and the README says "DO NOT USE IN PROD".
  - It has about 588 stars.
  - Source: https://github.com/Meridius-Labs/electron-liquid-glass (fetched 2026-10-25).
- No Chromium or CSS Liquid Glass primitive was found. On the web, `backdrop-filter` is the only option, and it cannot do lensing or refraction. Search notes: fetched 2026-10-25.

### 2.4 How other apps handle the sidebar
- **Claude desktop** (v3.6556.2, Electron 44.9.3) **[local inspection]**:
  - Main window: `titleBarStyle: "hidden"` with a custom `trafficLightPosition` (x = 16.5, y = 16.5 plus a title-bar offset, recomputed with zoom via `setWindowButtonPosition`). Minimum size is 600×400.
  - The background is **opaque**: boot colours `#fcfcfb` light and `#151515` dark. There is **no `vibrancy`** and no `backdrop-filter` in the bundle. A secondary window uses `hiddenInset`.
  - It bundles its own variable fonts (Anthropic Sans and Anthropic Serif).
  - Source: /Applications/Claude.app/Contents/Resources/app.asar, inspected 2026-10-25.
- Anthropic's stated reason for using Electron is shared code, so that "features across web and desktop have the same look and feel" (Boris Cherny, as reported). **[secondary]** https://letsdatascience.com/news/claude-mac-app-uses-electron-developer-implicated-396dce96 (Jul 2026).
- **ChatGPT:**
  - In July 2026 OpenAI replaced the native AppKit Mac app (now "ChatGPT Classic", 159 MB) with a 1.5 GB Electron app built from Codex.
  - Reviewers called the old one more "native Mac-like". On the new one they criticised nested panes ("UX hell" per Viticci), speed and RAM use. OpenAI restored the chat experience on Jul 17.
  - Sources: https://daringfireball.net/linked/2026/07/09/todays-the-day-openai-fucked-up-the-chatgpt-mac-app (Jul 9, 2026); https://mjtsai.com/blog/2026/07/10/ (Jul 10, 2026).
- **Linear, Slack, Notion:** I found no primary source describing native sidebar vibrancy in any of them. Linear's own posts describe a flat sidebar, made "a few notches dimmer" in 2026 rather than translucent (see 3.1). Evidence suggests opaque, themed sidebars are the norm in the best Electron apps. That is an inference, fetched 2026-10-25.
- **Raycast 2.0**, built on WKWebView rather than Electron, "adopts macOS Tahoe's Liquid Glass material" from its native shell. Source: https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast (May 14, 2026).

---

## 3. Reference apps

### 3.1 Linear
- **Theming:**
  - The 2024 redesign moved theme generation from HSL to **LCH**, which is "perceptually uniform".
  - Each theme went from **98 variables to 3**: base colour, accent and contrast. Contrast alone can produce high-contrast accessible themes (the post compares values 30 and 100).
  - LCH also produces the elevation surfaces for background, panels, dialogs and modals.
  - Source: https://linear.app/now/how-we-redesigned-the-linear-ui (Mar 28, 2024).
- **Type:** Inter Display for headings and Inter for body text. Text and neutral icons were made darker in light mode and lighter in dark mode, and the UI used less blue "chrome". Source: same.
- **Chrome:**
  - Labels, icons and buttons in the sidebar and tabs were aligned on both axes. The aim was to "reduce visual noise… increase the hierarchy and density of navigation".
  - The project took about 6 weeks with a small team and was rolled out behind a feature flag.
  - Source: same. Part I (why a redesign every 2–3 years): https://linear.app/now/a-design-reset (Mar 27, 2024).
- **2026 refresh:**
  - Colours moved to a warmer, less saturated grey.
  - The sidebar is "a few notches dimmer", with smaller icons and muted inactive text.
  - Tabs are compact rounded pills. Colourful team-icon backgrounds were removed. Dividers are fewer and softer.
  - Principles: "Don't compete for attention you haven't earned" and "Structure should be felt not seen."
  - Source: https://linear.app/now/behind-the-latest-design-refresh (Mar 12, 2026).
- **[secondary]** A reviewer gives 13 px body text in rows, about 1.4 line height, 32–36 px rows and a 4 px grid, without saying how these were measured. https://www.buildmvpfast.com/blog/linear-aesthetic-tokens-density-keyboard-first-ux-2026 (Jul 3, 2026).

### 3.2 Raycast
- Its three principles are "fast, simple, and delightful". Source: https://raycast.com/blog/a-fresh-look-and-feel (Jul 19, 2022).
- An **action bar** at the bottom holds the title and toasts on the left and context actions *with their shortcuts* on the right. It opens with ⌘K and teaches shortcuts as you go. Source: same.
- Icons are outline style with a heavier stroke and share stroke and radius rules (by James McDonald). There is a compact mode. Source: same.
- **Making web UI feel native:**
  - "No `cursor: pointer` on controls, and mostly no hover highlights."
  - Settings open in a separate native window.
  - Popovers and tooltips are native windows that can extend outside the app window.
  - Liquid Glass is adopted. The 60 fps cap is unlocked, and they work to remove flicker on appear and on transitions.
  - Source: https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast (May 14, 2026).
- They rejected Electron as "hard to control native OS integration". Memory use is about 350–450 MB, against 200–300 MB for v1. Source: same.

### 3.3 Arc / Dia
- Arc replaced the tab bar with a wide, hideable sidebar organised by context; ⌘T searches tabs, history and actions. **[secondary]** https://blakecrosley.com/blog/design-study-arc (undated, fetched 2026-10-25).
- Arc is native Swift/SwiftUI on Mac, with "sleek" animations and well-designed context menus. **[secondary]** https://dev.to/theairabbit/arc-browser-a-compelling-but-controversial-newcomer-59oa (undated).
- Dia is Arc's successor; Atlassian completed its purchase of The Browser Company on Oct 21, 2025. Dia has re-added the sidebar, vertical tabs and pinned tabs. https://en.wikipedia.org/wiki/Dia_(web_browser) (fetched 2026-10-25); https://techcrunch.com/2025/11/03/dias-ai-browser-starts-adding-arcs-greatest-hits-to-its-feature-set (Nov 3, 2025).

### 3.4 Things 3
- It won the Apple Design Award in 2017, and the Mac version had won one in 2009. Source: https://culturedcode.com/things/blog/2017/06/back-from-wwdc/ (Jun 2017).
- "The app is dominated by white space": bold type and splashes of colour used sparingly. Source: https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/ (May 2017).
- Opening a to-do makes it "pop out into a card-like form while the rest of the list fades", a spatial transition rather than navigating to a new page. The Magic Plus button can be dragged to choose where a new item is inserted. Source: same.
- **Type Travel**: on Mac you can just start typing to jump anywhere, without opening a search field first. Keyboard support is "excellent", and multiple windows are supported. Source: same.

### 3.5 Craft
- Mac App of the Year 2021, praised for "speed and simplicity". Built natively for Mac and iOS. Source: https://www.businesswire.com/news/home/20211202005370/en/Craft-Docs-Wins-Mac-App-of-the-Year-for-Apples-2021-App-Store-Awards (Dec 2, 2021).

### 3.6 Notion Calendar (Cron)
- Pressing `?` shows a searchable list of shortcuts. Global shortcuts work system-wide and can be remapped. Source: https://www.notion.com/help/notion-calendar-keyboard-shortcuts (undated, fetched 2026-10-25).
- **[secondary]** It is described as having "keyboard-first minimalism" with strong contrast in type scale. https://blakecrosley.com/guides/design/notion-calendar (undated).

### 3.7 Superhuman
- **The 100 ms rule**: every interaction should finish in under 100 ms, with a target of under 50 ms. The techniques are:
  - a local database
  - prefetching and prerendering threads the user is likely to open
  - "minimal animations"
  - keyboard shortcuts with hints shown in the UI
  - a ⌘K command palette
  - Source: https://blog.superhuman.com/superhuman-is-built-for-speed/ (Jun 28, 2022).

### 3.8 ChatGPT macOS app
- The native app (now Classic) was valued for looking "native Mac-like". It had an ⌥Space Chat Bar that can be dragged anywhere. Sources: https://mjtsai.com/blog/2026/07/10/ (Jul 10, 2026); https://help.openai.com/en/articles/9295241 (undated, fetched 2026-10-25).
- The lesson from its 2026 Electron replacement: reviewers judged structure and clarity more than polish. The new app had "the veneer of a polished app" without clear organisation (Gruber, as quoted). Source: https://mjtsai.com/blog/2026/07/10/ (Jul 10, 2026).

### 3.9 Claude macOS app
- It uses Electron with an opaque warm-neutral canvas, its own variable sans and serif fonts, a hidden title bar and custom traffic-light placement. Source: local inspection (see 2.4), 2026-10-25.
- It has been criticised by Mac commentators as non-native. **[secondary]** https://daringfireball.net/2026/07/claudes_criminally_bad_mac_app_is_an_inside_job (Jul 3, 2026).

### 3.10 Warp
- It is rendered on the GPU with Metal from three primitives (rectangles, images and glyphs). They first tried Electron and moved away from it.
- The target was 60 fps even on 4K and 8K displays. They measured "well over 144fps" on 4K and an average redraw of **1.9 ms**.
- **Blocks** give each command and its output its own unit.
- Source: https://www.warp.dev/blog/how-warp-works (Jul 12, 2021).

### 3.11 Reflect
- The app "can be completely operated with keyboard shortcuts". ⌘K accepts natural-language dates. Source: https://reflect.academy/keyboard-shortcuts (undated, fetched 2026-10-25).
- The backlink picker bolds the text you typed and ranks recent and heavily linked notes first. Source: https://reflect.app/blog/april-2024-update (Apr 2024).

### 3.12 Bear
- The original Bear won an Apple Design Award in 2017. https://blog.bear.app/tag/awards (fetched 2026-10-25).
- Bear 2.0 is "a ground-up rewrite" with a "custom text editing engine", plus custom fonts and themes. Source: https://www.macstories.net/news/shiny-frog-releases-bear-2-0/ (Jul 2023).

### 3.13 Patterns across these apps (synthesis, not sourced)
- **Restraint:** one accent colour, neutral surfaces generated from a few variables (Linear's LCH), and chrome that is dimmer than content.
- **Body text at 13 px with 16 px line height** matches macOS Body and the reported Linear density.
- **Keyboard-first:** a ⌘K palette, shortcut hints shown inline (Raycast, Superhuman), `?` for help, and type-to-jump (Things).
- **Speed is part of the feel:** under 100 ms per interaction (Superhuman), no flash on open (Electron `backgroundColor`), and no flicker (Raycast).
- **Motion:** short, critically damped springs (SwiftUI default response 0.55, no bounce), spatial transitions (Things' card), nothing on frequent interactions, and Reduce Motion respected.
- **Glass only for chrome:** a translucent or vibrant sidebar and toolbar, opaque content, and opaque fallbacks for Reduce Transparency and Increase Contrast.
