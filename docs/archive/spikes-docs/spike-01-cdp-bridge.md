# Spike 01: Electron WebContentsView + CDP bridge to an external process

- **Status:** done, 2026-10-19 (one-day time box)
- **Code:** [`spikes/cdp-bridge/`](../spikes/cdp-bridge/README.md). Run it with `npm install && npm start`.
- **Raw numbers:** `spikes/cdp-bridge/results/`
- **Decision informed:** ADR-007 (`docs/07-tech-decisions.md`), architecture §5 and §8

## Question

Can an Electron 44 app do all of the following, fast enough for an agent loop?

- Host agent-controlled tabs as `WebContentsView`s in a `persist:` partition.
- Attach `webContents.debugger` to each tab.
- Forward raw CDP commands and events over a Unix socket to a separate Node process.
- Still let a human use the same tab.

## Answer: **GO for ADR-007, with five amendments**

The bridge itself costs almost nothing:

- A command round trip over the socket is 0.1 ms at p50 and 0.2 ms at p99.
- Pipelined throughput is about 34,000 commands/s.
- A full pruned snapshot of a real page takes 3–170 ms (median about 56 ms). Nearly all of that time is Chromium building the AX tree, not the bridge.

Everything else worked on the first or second try:

- Click and type by ref
- Isolated worlds
- 10-frame screencast
- OAuth-style popup with `window.opener` kept
- Download quarantine
- Persistence across restarts
- Take control with zero false positives

The amendments cover four things the design did not anticipate: background throttling, the 1 MiB frame cap, how to tell agent input from user input, and outdated docs on DevTools detaching. They are listed in [Amendments to ADR-007 and the bridge contract](#amendments-to-adr-007-and-the-bridge-contract).

## Setup

| | |
| --- | --- |
| Machine | MacBook Pro Mac17,2, Apple M5, 16 GB, Retina (DPR 2), macOS 27.0.1 |
| Electron | 44.9.0 (Chromium 152, Node 24.22), from npm |
| Client | Plain Node 24.18 as a separate process, connected to the bridge socket in `$TMPDIR` |
| Layout | One `BaseWindow` (1280×860), a 220 px sidebar `WebContentsView`, and agent tabs as `WebContentsView`s with `{partition: 'persist:agent-spike', sandbox: true, contextIsolation: true, backgroundThrottling: false}` |
| CDP | `webContents.debugger.attach('1.3')` on every tab, including popups adopted as tabs |

All numbers below come from `results/results.json` unless stated otherwise. That run used `backgroundThrottling: false`. A second run used Chromium's default throttling (`results-throttled.json`). A first exploratory run had the window occluded behind other apps; it is described in gotcha 1.

## Measurements

### Round trip per command (500 samples each, Runtime.evaluate `1+1` on about:blank)

| Path | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- |
| In process (`sendCommand` in main, no socket) | <0.1 ms | <0.1 ms | 0.1 ms | 0.1 ms |
| External process via bridge | 0.1 ms | 0.1 ms | 0.2 ms | 0.3 ms |
| Bridge-only method (`Bridge.listTabs`, no CDP) | <0.1 ms | <0.1 ms | 0.1 ms | 0.1 ms |
| `Input.dispatchMouseEvent` mouseMoved via bridge | 8.3 ms | 9.2 ms | 9.8 ms | 10.7 ms |
| 1,000 pipelined `Runtime.evaluate` | 29 ms total (≈34k cmds/s) | | | |

`mouseMoved` takes about 8.3 ms because it resolves only on the next rendered frame. Blink aligns mouse moves to rAF, and 8.3 ms is one frame at 120 Hz. Bridge overhead is not the cause. `mousePressed` and `mouseReleased` return in 0.2–2 ms.

A full click by ref takes 6–9 ms in total: `DOM.scrollIntoViewIfNeeded`, then `DOM.getContentQuads`, then three mouse events. Typing by ref with `DOM.focus` and `Input.insertText` takes about 1.6 ms.

**Large payloads.** The Wikipedia AX tree is about 1.9 MB of JSON. Fetching it takes 61 ms in process and 123 ms through the bridge. That is roughly 30 ms per MB of extra cost for `JSON.stringify` in main, the socket, and `JSON.parse` in the client. One run moved 38.6 MB through the bridge in total.

### Snapshot latency (5 real pages + login fixture)

Each snapshot sends four commands, pipelined: `Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`, `Page.getLayoutMetrics`, and an `evaluate` for URL and DPR. The client then builds a pruned YAML-like tree:

- Interactive and landmark roles are kept.
- `generic`, `none` and ignored nodes are collapsed.
- Interactive nodes, headings and images get `ref_N` ids keyed by `backendDOMNodeId`.
- Boxes are in CSS pixels.

"Cold" means the first snapshot after load. "Warm" means a repeat on the same document.

| Page | Raw AX nodes | Kept | Interactive | AX JSON | DOMSnapshot JSON | Cold total | Warm | Snapshot | ≈ tokens | Refs stable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| news.ycombinator.com | 1,634 | 480 | 231 | 619 KB | 114 KB | **56 ms** | 39 ms | 21 KB | 5.3k | yes |
| en.wikipedia.org (Electron article) | 5,343 | 1,042 | 368 | 1,937 KB | 792 KB | **170 ms** | 140–157 ms | 61 KB | 15.3k | yes |
| bbc.com/news | 1,695 | 317 | 123 | 629 KB | 369 KB | **53 ms** | 41 ms | 25 KB | 6.3k | yes |
| github.com/electron/electron | 2,894 | 681 | 331 | 1,527 KB | 503 KB | **134 ms** | 89–96 ms | 42 KB | 10.4k | yes |
| developer.mozilla.org (Window.open) | 3,740 | 457 | 211 | 1,330 KB | 550 KB | **125 ms** | 90–108 ms | 48 KB | 12.1k | yes |
| login fixture | 28 | 9 | 5 | 13 KB | 3 KB | **3 ms** | 1 ms | 0.4 KB | 0.1k | yes |

- Client-side pruning takes 0.1–3.4 ms. The time is dominated by `getFullAXTree`, which Chromium builds on demand.
- Refs are byte-identical across repeated snapshots of the same document.
- Refs also stay the same after typing into fields and toggling a checkbox. In the login test, all four refs (`ref_2`–`ref_5`) survived.
- The throttled run had the window visible, and its numbers are within noise: 56–202 ms cold.

### Memory per tab (`app.getAppMetrics()` working set, summed over the tab's frame processes)

| Tab content | Working set |
| --- | --- |
| about:blank (baseline, each of 2 tabs) | 85–87 MB |
| login fixture | 99 MB |
| news.ycombinator.com | 91–110 MB |
| developer.mozilla.org | 170 MB |
| en.wikipedia.org | 148–162 MB |
| github.com | 265 MB |
| bbc.com/news | 378 MB |

The working set is RSS and includes pages shared with other processes, so the "private" cost per tab is lower. With two real tabs open, the total working set by process type was:

| Process type | Working set |
| --- | --- |
| Browser (main) | 138 MB |
| GPU | 97 MB |
| Utility (network, storage, …) | 53 MB |
| Tab renderers | 324 MB |

Each tab mapped to one renderer process in these runs. The code also sums cross-site OOPIF processes through `mainFrame.framesInSubtree[].osProcessId`.

### Screencast (`Page.startScreencast`, jpeg q70, max 1280×800, animated fixture)

| | Throttling off (recommended) | Default throttling, window visible | Default throttling, window occluded |
| --- | --- | --- | --- |
| 10 frames recorded | yes, first frame after 13 ms | yes | **no, 0 frames in 10 s** |
| Frame interval | p50 8.3 ms, p90 17 ms | | |
| Frame size (1060×828 device) | 8.8 KB | | |
| Frames while the view is hidden (`setVisible(false)`), 2 s | 186 | **1** | 0 |

The 10 frames are in `results/frame-01.jpg` and `results/frame-10.jpg` (first and last). The client acks every frame with `Page.screencastFrameAck`. That is standard CDP flow control; running without acks was not tested.

### Behaviour checks

| Check | Result |
| --- | --- |
| `persist:` partition on disk | `ses.storagePath` = `<userData>/Partitions/agent-spike`. It holds Cookies, Local Storage, Cache, and so on. |
| Persistence across restart | A cookie set in run N (`spike_login`) was returned by `Network.getCookies` at the start of run N+1. |
| Login by ref | Click `textbox "Username"`, type, type the password, check "Remember me", click "Sign in". The status text reads `Welcome ada (password 16 chars, remember=true)`. |
| Isolated world | Created with `Page.createIsolatedWorld` and evaluated with `Runtime.evaluate {contextId}`. The isolated world sees the DOM (`input.value = "ada"`) but not page globals (`typeof window.pageSecret` is `undefined` in the isolated world and `string` in the main world). |
| OAuth-style popup | `window.open` from a CDP click goes through `setWindowOpenHandler` and becomes a new agent tab, adopted by `createWindow: (o) => new WebContentsView({webContents: o.webContents})`. In the popup, `window.opener` is present. It shares the partition: the request carried the opener tab's cookies. Clicking "Approve" by ref ran `opener.postMessage` and `window.close()`, the tab closed (`target closed`), and the opener got `token tok_123`. Total time: 306 ms. |
| `will-download` with a PDF attachment | The download landed in quarantine (`state: completed`, 590 B, `%PDF-` header). The spike calls `DownloadItem.setSavePath` synchronously inside the event, as the Electron docs require. |
| Inline PDF (`Content-Type: application/pdf`, no attachment) | No download event fires. Chromium's built-in PDF viewer renders it in the tab (`results/inline-pdf.png`). The viewer has its own download button. |
| DevTools opened on an agent tab | **No detach in Electron 44.9.** `isAttached()` stayed true while DevTools was open, commands kept working, and Page events still arrived after DevTools closed. |
| Forced `debugger.detach()` | The `detach` event fired with reason `target closed`. Commands then failed with `DETACHED`. After re-attaching, previously enabled domains were gone: no `Page.loadEventFired` until `Page.enable` was sent again. |

### Take control

The "human" in these tests was `webContents.sendInputEvent` from main, which is the same native path that OS events use (see gotcha 3). The agent sent `Input.insertText` every 25 ms throughout.

| Phase | Result |
| --- | --- |
| Agent alone: 30 `insertText`, 5 clicks by ref, 3 `dispatchKeyEvent` | **0 false grabs**. 230 agent echoes were filtered. |
| Human types "HUMAN" (5 keys over 406 ms) mid-stream | The first agent command was refused 20 ms after the first key, then **69 refused, 0 leaked**. The field reads `…xxxHUMANxxx…` with no interleaving. The agent resumed 1.43 s after the last key (idle timeout 1.5 s). |
| Human clicks the field mid-stream | The first refusal came 11 ms after the click, then 57 refused. The agent resumed 1.51 s after the click. |
| Sidebar "Take control" button (sticky) | Refused immediately, and still refused after 2 s. Accepted again right after Release. |

The agent sees `Bridge.userControl {active, via: keyboard / mouse / button}` events and `USER_IN_CONTROL` errors.

### Focus and visibility (CDP `Input.*` vs `sendInputEvent`)

| Window state | `document.hasFocus()` / visibility | CDP click | CDP insertText | `sendInputEvent` keys |
| --- | --- | --- | --- | --- |
| Focused (`app.focus({steal:true})`) | true / visible | ✓ | ✓ | ✓ |
| Blurred (another app frontmost) | false / visible | ✓ | ✓ | ✓ |
| Minimized | visible with throttling off; **hidden** with throttling on | ✓ | ✓ | ✓ |
| View hidden (`view.setVisible(false)`) | visible with throttling off; **hidden** with throttling on | ✓ | ✓ | ✓ |

Neither path needs OS focus in Electron 44 for these events. The `sendInputEvent` doc note ("the containing BrowserWindow must be focused") did not reproduce for keyboard or mouse into a `WebContentsView`.

CDP `Input.*` does not move OS focus or activate the window. The page's `document.hasFocus()` stays false while the app is in the background. Pages that check focus can tell the difference; use `Emulation.setFocusEmulationEnabled` if that matters.

## Gotchas

1. **Background throttling breaks the agent when the pane is not on screen.** With Chromium's default `backgroundThrottling: true`, a tab whose window is occluded by other apps reports `document.visibilityState === "hidden"`, and rAF stops entirely (0 callbacks in 500 ms). The same happens for a `WebContentsView` with `setVisible(false)`.
   - `Input.dispatchMouseEvent {type: "mouseMoved"}` then blocks for **5.1 s**, which is the input-ack timeout, because mouse moves wait for a frame.
   - The click that followed it was dropped. The login submit did nothing.
   - `Page.startScreencast` produces **0 frames**.

   The Psyche pane is often closed or behind the chat, so this is the default case. **Fix:** set `webPreferences.backgroundThrottling: false` on every agent tab, and pass the same prefs to popups through `overrideBrowserWindowOptions`. With that set, everything above works in every window state: mouseMoved 8 ms, 186 frames in 2 s while hidden. The cost is that hidden agent tabs keep painting at the display rate. Pause the screencast and close idle tabs instead of relying on throttling.

2. **AX payloads exceed the 1 MiB frame cap in wire spec v1.** Four of five real pages returned 1.3–1.9 MB from `Accessibility.getFullAXTree`, and DOMSnapshot reached 0.8 MB. Raw CDP forwarding over `browser-bridge.sock` with `MAX_FRAME_BYTES = 1 MiB` would fail on Wikipedia, GitHub and MDN. See amendment 2.

3. **Telling agent input from user input.** CDP `Input.*` events reach `webContents.on('input-event')`, so a naive "any input means the user" rule grabs control on every agent action. Measured on Electron 44.9:

   | Source | `before-input-event` | `input-event` types |
   | --- | --- | --- |
   | CDP `Input.dispatchKeyEvent` | **never** | `keyDown`, `keyUp` |
   | CDP `Input.insertText` | never | none |
   | CDP mouse | never | `mouseMove` / `mouseDown` / `mouseUp`, all arriving *inside* the `sendCommand` await |
   | CDP `mouseWheel` | never | `mouseWheel` plus `gestureScroll*`, some arriving after the command resolves |
   | Native (`sendInputEvent`, OS events) | `keyDown` / `keyUp` | `rawKeyDown`, `char`, `keyUp`, mouse |

   **Keyboard:** grab on `before-input-event`. CDP never fires it, so no heuristics are needed.

   **Mouse:** grab on `input-event` `mouseDown` or `mouseWheel` only while no agent `Input.*` command is in flight, using a depth counter. Ignore wheel and gesture events for 50 ms after an agent wheel. Hover (`mouseMove`) never grabs.

   A time-based "grace window after agent input" (the first attempt) fails completely. With the agent typing every 25 ms, the window never closes, and the human's keystrokes were all classified as echoes: 0 refusals, and the text interleaved. The residual risk is a user `mouseDown` landing in the 1–9 ms window while an agent mouse command is in flight. That event is missed, but the user's next event catches it.

   `sendInputEvent` stood in for real HID input. Real keyboard and mouse events take the same `RenderWidgetHostViewMac` → `before-input-event` / `input-event` path, but that was not driven in this spike; S07 should confirm it with a real keyboard.

4. **Isolated worlds.** `Page.createIsolatedWorld` returns a fresh `executionContextId` per call, and the context dies on navigation. Create the world once per document, cache it, and drop it on `Runtime.executionContextDestroyed` or `Page.frameNavigated`. `Runtime.evaluate` without `contextId` runs in the **main world**, where page code can see it, observe it and lie to it. The bridge should refuse that form (amendment 4).

5. **DOMSnapshot bounds are in device pixels.** On Retina they are 2× CSS pixels, while `DOM.getContentQuads` and `Input.*` use CSS pixels. Divide by `devicePixelRatio`; the spike reads it in the same pipelined round trip. Boxes are page coordinates, so scroll into view and re-read quads before clicking, as `centerOf` does.

6. **Partition paths.** `ses.storagePath` is `<app userData>/Partitions/<name minus "persist:">`, here `.userdata/Partitions/agent-spike`. To put profiles under the Gateway's `browser/profiles/` (architecture §12), either set `app.setPath('userData')` before `ready` or symlink. Electron has no per-partition path option. One profile held 27 MB after a run of 6 pages.

7. **DevTools does not detach the debugger in Electron 44.** This contradicts the Debugger doc note ("detached when DevTools is opened"). Chromium now supports multiple clients. Keep the `detach` handler anyway: a renderer crash or `debugger.detach()` still detaches with reason `target closed`, and re-attaching loses all `*.enable` state. The bridge must replay enabled domains on re-attach, or tell the Gateway so it can.

8. **Popups.** `createWindow` must return the adopted `WebContents`. Wrapping it in `new WebContentsView({webContents: options.webContents})` keeps `window.opener`, the partition and the debugger. The spike attaches the debugger inside `createWindow`, and no early popup events were missed. When the popup calls `window.close()`, the tab's `WebContents` is destroyed: the debugger reports `target closed` and the bridge emits `tabClosed`. Without `createWindow`, Electron opens a separate `BrowserWindow` with no CDP attached.

9. **Inline PDFs do not fire `will-download`.** They open in Chromium's built-in viewer inside the tab. The quarantine rule only covers attachment downloads unless the bridge also cancels `application/pdf` navigations (`will-navigate` / `webRequest.onHeadersReceived`) and routes them through `DownloadItem` or the Library's PDF.js viewer. Whether the viewer's own download button goes through `will-download` was not tested.

10. **Minor:**
    - Socket paths in `$TMPDIR` are about 75 bytes, within macOS's 104-byte limit (see the S00 note on `PSYCHE_NODE_SOCKET`).
    - `getFullAXTree` without `Accessibility.enable` worked fine and avoids keeping the AX tree alive between snapshots. Cold builds are 1.2–1.5× warm.
    - `Page.navigate` returns before load. Register the `Page.loadEventFired` wait before sending the command.

## Recommended bridge frame format

Keep wire spec v1 (`packages/protocol/src/bridge.ts` on the S00 branch): NDJSON, `req` / `res` / `event`, `bridge.*` methods, and `bridge.cdp.send {tabId, sessionId?, method, params}`. The spike's shorter frames carry the same fields and the measured overhead is negligible. Add the following:

1. **Frame cap.** Raise `MAX_FRAME_BYTES` on the browser bridge socket to 16 MiB (the node socket can stay at 1 MiB). Or add a desktop-side `bridge.snapshot {tabId}` that runs the pruning in the desktop main process or a utility process and returns the 20–60 KB pruned tree. That cuts bridge traffic about 30×.
   - Recommendation: do both. The Gateway keeps raw CDP for everything else, and `bridge.snapshot` becomes the hot path.
   - Serialising 2 MB in main costs part of the measured 62 ms gap and blocks the main event loop while it runs; this was not isolated. A utility process avoids jank in the window.
2. **Error codes** in the shared `ErrorCode` enum:
   - `user_in_control` (`retryable: true`)
   - `debugger_detached` (`retryable: true`, with `details.reason`)
   - `tab_not_found`
   - `method_not_allowed`
3. **Events:**
   - `bridge.tab.created` gains `openerTabId` and `disposition` for popups.
   - Add `bridge.debugger.detached {tabId, reason}`.
   - `bridge.control.changed` gains `via: "keyboard" | "mouse" | "button"`.
4. **CDP events** are forwarded unfiltered in the spike. Screencast frames are 9 KB+ each. Production should forward only the domains the Gateway enabled, which the bridge already knows from `*.enable` calls, and use per-connection `seq` as in v1.

## Amendments to ADR-007 and the bridge contract

1. **Agent tabs run with `backgroundThrottling: false`**, and popups get the same prefs through `overrideBrowserWindowOptions`. Without this, an agent in a closed or occluded pane stalls for 5 s per mouse move, drops clicks and records nothing. Add this to architecture §5, next to `persist:agent-<profile>`.
2. **The bridge frame cap is at least 16 MiB, and `bridge.snapshot` is a desktop-side composite method** (above). Raw `Accessibility.getFullAXTree` alone exceeds 1 MiB on most real pages.
3. **The take-control arbitration rule is part of the contract.** Keyboard is detected by `before-input-event`. Mouse is detected by an `input-event` `mouseDown`/`mouseWheel` while no agent `Input.*` command is in flight. Release comes after 1.5 s idle or on the explicit Release button. The desktop refuses `Input.*` with `user_in_control` while the user holds the tab. Time-window heuristics must not be used.
4. **The desktop enforces a CDP method allowlist**, as defense in depth below the Gateway's `BrowserDriver`, because the socket otherwise grants full CDP over the user's logged-in profile.
   - Allow: `Accessibility.*`, `DOM.*` (read and focus), `DOMSnapshot.captureSnapshot`, `Page.navigate`, `getFrameTree`, `createIsolatedWorld`, `*Screencast*`, `captureScreenshot`, `getLayoutMetrics`, `enable`/`disable`, `Input.*`, `Runtime.evaluate` **only with a `contextId` from a bridge-created isolated world**, and `Network.enable` for events.
   - Deny: main-world `Runtime.evaluate`/`callFunctionOn`, `Network.getCookies`/`getAllCookies`, `Storage.*`, `Target.*`, `Browser.*`, `Debugger.*`, `Fetch.*` (request rewriting), and `Page.setDownloadBehavior`.
   - Also check peer credentials (`LOCAL_PEERCRED`) on accept, alongside the handshake secret. File the Gateway-side half as a request to S18 (security).
5. **Inline PDF navigations are intercepted** and routed to the quarantine or the Library viewer. `will-download` alone does not catch them.

The DevTools note in ADR-007's evidence ("debugger detached when DevTools is opened") no longer holds for Electron 44. Keep the re-attach path for crashes, and drop the claim that DevTools must be disabled to keep CDP alive. Disabling DevTools in production is still a good idea for other reasons.

Nothing found argues for the Playwright sidecar or real-Chrome modes as the default. The in-process route is fast, keeps the user and the agent on the same renderer, and needs no network listener.

## Follow-ups (not done in this spike)

- Drive real HID input (keyboard and trackpad) to confirm gotcha 3 outside `sendInputEvent`.
- Measure cross-origin iframes. `getFullAXTree` covers only the main frame's process; OOPIFs need `Target.setAutoAttach {flatten: true}` and a per-session `getFullAXTree`, which `bridge.cdp.send`'s `sessionId` already allows.
- Measure snapshot size and latency under a viewport-only pruning mode. Wikipedia at 15k tokens is too large to send every turn.
