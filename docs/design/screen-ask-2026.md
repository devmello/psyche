# Ask about my screen

Status: proposal v1 (2026-10-26), for the owner's sign-off. Applies to psyche-desktop (macOS), the Mac helper and the Gateway. Builds on [../voice/voice-mode-2026.md](../voice/voice-mode-2026.md) (the voice HUD and dictation keys) and the computer-use capture rules (`CaptureHygiene`, J3).

**The owner's brief:** "screenshot something on my page or literally just click that button and say something or type something and it will use the context of whatever I am looking (if needed) to do or answer or complete whatever I asked."

**The short answer:** one shortcut (default ⌥⇧Space) or one menu-bar item opens a small floating **ask panel** over whatever you're looking at. At that moment, and only then, Psyche grabs the frontmost window (or a box you drag) and some cheap text about it: the app, the window title, any selected text and the browser URL. You speak (hold the dictation key) or type, then press Return. The answer streams into the panel, with **Open in Psyche** to carry on in the app. The text context always goes along. The image goes along only when your request is about the screen, or when you pin it. Everything the screen says counts as untrusted, like a web page.

---

## 1. What exists today

| Piece | Where | Reused for |
| --- | --- | --- |
| `computer.screenshot` (ScreenCaptureKit, `windowOnly`, hygiene: Psyche's own windows, password managers, finance apps and Off apps left out; refused while a password field has focus) | `apps/mac-helper/Sources/PsycheHelperSystem/Computer/Screenshots.swift` | The window capture. Region mode adds a crop rect. |
| `computer.screenshot_pick` (system content picker, no Screen Recording grant) | same file | The fallback when Screen Recording is missing (§3.4). |
| AX snapshot (`AXURL`, titles, focus, `focusedIsSecure`) | `LiveAX.swift`, `AXEngine.swift` | App name, window title, selected text (`AXSelectedText`) and browser URL. |
| Voice HUD window (non-activating panel, kept warm) | `apps/desktop/src/main/voice/hud.ts`, `/voice-hud`, `VoiceHudView` | The panel window pattern, placement and material. |
| Composer dictation (`useComposerVoice`) and the two-key `dictation.watch` | `apps/web/src/shell/components/composer-voice.ts`, `apps/desktop/src/main/dictation/` | Speaking into the panel. |
| Quick entry on ⌥Space (⌃⌥Space fallback) | `apps/desktop/src/main.ts` | The shortcut registration pattern, and the key to avoid. |
| `data.replayRetentionDays` | `apps/gateway/src/retention.ts` | How long the capture is kept. |

**The gap:** `chat.send` takes text plus Library item ids, and there's no upload method (`library.upload` is still "unavailable" in the web and desktop clients). So a capture needs a Gateway-side path into the Library. §4 covers that.

## 2. Trigger

- **Shortcut:** ⌥⇧Space by default, falling back to ⌃⌥⇧Space if another app holds it, the same way quick entry does. It doesn't clash with ⌥Space (quick entry), the dictation and voice hold keys (fn, Right ⌥, Right ⌘: these are modifier-only and watched by the helper, not `globalShortcut`) or ⌘Space (Spotlight). Settings can change it (§6).
- **Button:** an **Ask about screen** item in the tray menu, and in the dock menu. Clicking it hides Psyche first, so the window behind it is what gets captured.
- **Whole window or a box:**
  - The shortcut captures the frontmost window (not Psyche's).
  - Pressing the shortcut again while the panel is open, or clicking the panel's **Select area** button, switches to region mode. A dimmed overlay covers the display under the pointer, you drag a box, and that box replaces the capture. Esc in the overlay keeps the window capture.
- **No background capture.** Nothing is captured until the shortcut or button fires, and each trigger captures once. **Recapture** (↻ on the chip) is an explicit second trigger.

## 3. Capture

### 3.1 Helper: `screen.context` (new capability)
One call returns everything, so the panel opens on one round trip:
- `image`: the frontmost window (or `rect` in global points for region mode), JPEG, at most 1600 px on the long side. It goes through the same `CaptureHygiene` and secure-field checks as `computer.screenshot`.
- `app` (name and bundle id), `windowTitle`.
- `selectedText`: the focused element's `AXSelectedText`, at most 4,000 characters. Empty when the focused element is secure.
- `url`: the focused browser window's `AXURL` (Safari, Chrome, Arc, Edge, Brave, Firefox). If that isn't exposed, the address field's value.
- `excluded`: set when the app is one capture never takes (a password manager, say). Then the panel opens with text context only and says "Psyche doesn't capture {app}."

It's a new capability rather than a flag on `computer.screenshot`. That's because it isn't agent-invoked computer use: it doesn't go through tier approvals or need a computer-use session, and it's owner-initiated. The helper only answers it while a trigger is in flight (a token the desktop gets from the Gateway's `screen.capture`), so no agent or skill can call it.

### 3.2 Gateway: `screen.capture` and `screen.discard` (new methods)
- `screen.capture { mode: "window" | "region", rect? }`: invokes the helper's `screen.context` and stores the image as a Library item (`kind: image`, origin `screen`, provenance `untrusted`). Returns `{ captureId, libraryItemId, thumbnail, context }`. The thumbnail is a small data URL.
- `screen.discard { captureId }`: deletes the item. The panel calls it on ✕, Esc, or closing without sending.
- A capture that's never sent is deleted after 10 minutes anyway.

### 3.3 What's sent

| Always (when captured) | Only when relevant or pinned |
| --- | --- |
| App, window title, URL, selected text: one fenced, untrusted "What's on screen" block ahead of the request | The image, as an attachment |

**"Relevant"** is decided on the Gateway, before the model sees anything, by two checks:
1. **Cheap rule:** deictic or visual words ("this", "that", "here", "on screen", "what am I looking at", "the error", "this chart"…) in all ten locales, or a region capture (dragging a box always means "look at this").
2. Otherwise **the model decides:** the image isn't attached, but the agent gets a `screen.look` tool bound to this one capture. That covers "summarise this page" when the text context isn't enough. The tool reads the stored frame and never captures again.

Pinning (📌 on the chip) always sends the image. ✕ drops it, and the text context too.

### 3.4 Permissions
These reuse onboarding's existing flows; the panel doesn't add its own.
- **Without Screen Recording:** the panel opens with text context only, plus a chip: "Allow screen capture". It opens the same Settings deep link onboarding uses. A one-off **Pick window…** uses `computer.screenshot_pick` (no grant needed).
- **Without Accessibility:** there's no text context or dictation key. Typing still works, and the chip links to the Accessibility pane.

## 4. Routing

- **Where it goes:**
  - **New thread by default**, titled from the request. Asking about the screen is usually a side question.
  - A **Send to current chat** toggle in the panel (remembered) sends into the main window's current thread instead.
  - In both cases `chat.send` carries `attachments: [libraryItemId]` when the image goes, and a new optional `screen: { captureId, image: "auto" | "pinned" | "dropped" }`. That field lets the Gateway attach the text context, apply §3.3 and widen taint.
- **The answer** streams inline in the panel. The panel grows to at most 480 × 360 pt and scrolls. **Open in Psyche** opens the thread in the main window, like the voice HUD's click.
- **Doing, not just answering:** "fill this form", "reply to this email" and the like run as normal agent turns. Every action goes through the broker and approvals as usual. Approvals show in the panel, and the panel stays open while one is pending.
- **Dismissing:** Esc cancels at any point. Before sending, it discards the capture. While answering, it hides the panel and the turn carries on in the thread. Clicking outside hides the panel without cancelling.

## 5. Safety

- **Screen content is untrusted input.** The text context block and the image are `untrusted` provenance, and the turn's taint widens exactly as it does after a web fetch. Instructions seen on screen are data. A tainted turn's side effects need approval under the existing taint rules.
- **Actions** go through the broker. `screen.context` itself can't act.
- **Storage:**
  - The image lives only as the thread's Library attachment, and the text context only inside the message. Nothing goes into memory or the graph unless the owner asks.
  - Frames follow `data.replayRetentionDays`, like computer-use frames. Discarded and unsent captures are deleted as in §3.2.
- **Capture hygiene** is the same as computer use: Psyche's own windows, password managers, finance apps and apps set to Off are never captured, and nothing is captured while a password field has focus.
- **Audit:** each capture writes an audit row (app, mode, sent or discarded), with no content.

## 6. Settings and strings

- **Settings → Voice & dictation → Ask about screen:**
  - On/off (default on once Screen Recording is granted).
  - Shortcut picker.
  - "Send to": new thread or current chat.
  - "Always include the screenshot" (default off, so §3.3 applies).
- **Strings** go in all ten locales under `packages/ui/src/i18n/messages/locales/`.

## 7. Build order (each its own PR, with tests)

1. **Protocol:** `screen.capture` and `screen.discard`, `chat.send.screen`, `screen.context` capability params and result, and `ScreenCaptureResult`. Then `pnpm protocol:gen`, with any exhaustive Swift switches updated in the same PR.
2. **Helper:** `screen.context` (window, rect crop, AX text, URL, exclusion), plus Swift tests for the pure parts (crop maths, URL pick, truncation).
3. **Desktop:** the global shortcut, tray and dock items, the panel window (`/screen-ask` route, non-activating, warm like the voice HUD), the region overlay, and the panel view in `packages/ui` with Storybook.
4. **Gateway:** `screen.capture` and `screen.discard`, Library storage and expiry, the §3.3 relevance check, the `screen.look` tool, taint widening, audit and retention.
5. **Settings and strings:** the shortcut picker, on/off, send-to, always-include, and the ten locales.

## 8. Decisions for the owner

1. **Default shortcut:** ⌥⇧Space (fallback ⌃⌥⇧Space)?
2. **Region mode:** shortcut-again or **Select area** inside the panel (window first), rather than a separate shortcut or drag-first?
3. **Default destination:** a new thread, with a remembered "Send to current chat" toggle?
4. **When the image goes:** the cheap deictic rule plus a `screen.look` tool for the model, or always send the image?
5. **Without Screen Recording:** open with text context and a one-off picker, rather than blocking until it's granted?
6. **Unsent captures:** delete on ✕/Esc and after 10 minutes, and keep sent ones under `data.replayRetentionDays`?
