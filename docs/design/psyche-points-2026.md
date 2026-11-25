# Psyche points, you click (2026)

**Status:** design, 2026-11-24, for the owner's sign-off on §11. Nothing is built. Applies to the Mac helper, the Gateway and the Electron desktop, Host only, Mac only. Builds on [screen-ask-2026.md](screen-ask-2026.md) (owner-initiated capture, desktop-shell-only methods), [teach-by-showing-2026.md §13](teach-by-showing-2026.md#13-phase-2-recording-in-a-mac-app) (an AXObserver on one app, the sensitive-field judge, the session indicator) and [05-security-and-permissions.md](../05-security-and-permissions.md) §3.6 (taint), §7 (injection), §12 (macOS, capture hygiene), §14 (data handling).

**The owner's brief:** "For a scary form (taxes, visa paperwork), Psyche reads your screen and draws an arrow over the next field with a short note on what to type. It never clicks anything." Then: "Do psyche points."

**The short version:**
- The owner picks **one window** ("help me with this window") from Chat, ⌘K or the menu bar, and optionally says what the form is for ("2026 tax return, married filing jointly").
- The Mac helper reads that window's **accessibility tree** and nothing else. It re-reads only when the window tells it something changed (AX notifications), never on a timer. A screenshot goes to the model only when the owner presses **Let Psyche look** on a form the tree can't describe.
- The Gateway makes **one model call per page**. That call plans the order of the fields, what goes in each one and where each value comes from: the owner's words or Memory, with the source shown. Moving from field to field is local: when the owner leaves the field Psyche pointed at, the arrow moves to the next one with no new model call.
- The helper draws a **click-through ring** around the field and a small **note card** beside it. Neither ever takes focus. The card's own buttons (Back, Skip, Stuck?, Stop) are the only things that take a click.
- **It cannot click.** The code that reads the form and draws the overlay is its own Swift target, with no path to event posting or AX actions. A build-time check fails the build if one appears (§4.3). On the Gateway, the guidance model call has no tools, and the session can only reach `points.*` helper capabilities.
- **Sensitive fields** (passwords, cards, bank numbers, SSN, passport, tax id, one-time codes) are found before any value is read. Psyche never reads them, never suggests a value for them, and never quotes them back. The card says "You fill this yourself". On payment pages the card gives directions only and never suggests a value.
- **Nothing is stored:** no screenshots, no field values, no form text. Audit rows hold counts. Idle cost is zero: no observers, windows, timers or monitors exist until the owner starts a session.

---

## 1. What exists today

| Piece | Where | Reused for |
| --- | --- | --- |
| AX tree reading: `AX.copy/attr/string/frame`, `AXEngine.snapshot`, `keyboardFocus()` (Secure Event Input and `AXSecureTextField`) | `apps/mac-helper/Sources/PsycheHelperSystem/Computer/LiveAX.swift`, `AXEngine.swift` | The form reader. The read-only half moves into a target of its own (W2). |
| AXObserver on one pid, bound to pid, launch date and Team ID, re-checked on every event | `PsycheHelperSystem/Teach/LiveAppTeach.swift` | The perception loop's binding rules. Not its `RunLoopThread`, which wakes 4 times a second (builder learnings). |
| Sensitive-field judge: `AppTeachPolicy.sensitiveReason` (secure field, Secure Event Input, `TEACH_SENSITIVE_WORDS` in titles, labels, sheet titles and nearby text) and `valueReason` (Luhn, `ddd-dd-dddd`, tokens, seed phrases, bare 4 to 8 digit codes) | `PsycheHelperCore/Teach/AppRecording.swift`; TS twin `classifyTeachField` / `classifyTeachValue` in `packages/protocol/src/browser-teach.ts` | Field sensitivity, decided before any value is read (§5). |
| Never-list `TEACH_NEVER_APPS` (Psyche, security prompts, Settings, password managers, authenticators, wallets), generated into Swift | `packages/protocol/src/browser-teach.ts`, `TeachNeverApps.generated.swift` | The apps Points refuses, with fixed-cap Off apps and terminals and IDEs added (§2.2). |
| Payment rule: `isPaymentField`, `isMoneyContext`, `isMoneyText`, `isAmbiguousActionLabel`; `venueOfHost` | `packages/protocol/src/money-intent.ts`, `financial-block.ts` | Payment fields and payment pages (§5.1). |
| Window capture with hygiene (`CaptureHygiene`, JPEG ladder under 600 KB, refused under Secure Event Input) | `PsycheHelperSystem/Computer/Screenshots.swift`, `ScreenAskCapabilities.swift`, `PsycheHelperCore/Screenshot/CaptureHygiene.swift` | The vision fallback. Capture moves into a target of its own (W2). |
| Helper TCC rows: Accessibility and Screen Recording for **Psyche Helper**, with Allow → `permissions.request` (Screen Recording with `purpose: "vision_fallback"`), re-read on window focus | #1643: `apps/web/src/compose/permissions.tsx` (`useHelperPermissions`), `packages/ui/src/screens/settings/ComputerUseSection.tsx`, `apps/gateway/src/handlers/nodes.ts` (`isHelperPermissionPrompt`) | First-use permission asks, with no new prompt path (§6.1). |
| Desktop-shell-only methods (`call.identity.desktopShell`, loopback), Host helper lookup, audit rows with no content | `apps/gateway/src/compose/screen-ask.ts`, `compose/teach-app.ts` | The `points.*` Gateway methods (§8). |
| `nodes.invoke` deny prefixes (`UNREACHABLE`) and the Host helper allowlist | `apps/gateway/src/handlers/nodes.ts` | `points` joins the deny prefixes. |
| Memory sources: USER.md "About the owner" fields and Learned lines (owner's words only), trusted recall chunks | `packages/memory/src/profile-fields.ts`, `apps/gateway/src/compose/user-profile.ts`, `compose/memory-recall.ts` | Where suggested values come from (§3.2). |
| Utility-style model call with no tools, redact-then-truncate | `apps/gateway/src/compose/auto-title.ts` | The shape of the guidance call (§3.3). |
| Tray menu, ⌘K actions, the screen-ask panel's "hide Psyche, then target the window behind" | `apps/desktop/src/main/tray.ts`, `packages/ui/src/shell/CommandPalette.tsx`, `apps/desktop/src/main/screen-ask/` | Entry points (§6.2). |

**The gap.** Nothing in the helper can draw over another app's window, and every AX or capture call lives in the same target as `Input` (CGEvent posting) and `AXEngine.perform`/`set`. A "never clicks" promise therefore needs a new target boundary, not just a rule (§4.3).

## 2. Scope

### 2.1 In and out

| In | Out (v1) |
| --- | --- |
| One window of one app on the Host Mac, chosen by the owner | The whole screen; several windows at once; following the owner around |
| Web forms in browsers (Safari, Chrome, Arc, Edge, Brave, Firefox), native forms, PDF forms in Preview | Acting in any way: clicks, keys, `AXPress`, setting values, opening apps or URLs, raising windows |
| Multi-page forms in the same window; sheets and dialogs of that window | iOS. The Chat offer card says to start it on the Mac (§6.2). No "continue on Mac" handoff in v1 (§11 Q5) |
| AX first; owner-asked screenshots when the tree is poor | Linux and Windows helpers (owner, 2026-11-23: Mac and iOS only) |
| Suggestions from the owner's words and Memory, with sources | Judging whether a site is genuine; tax or legal advice beyond what the form says |

### 2.2 Which apps

A session is refused, at the Gateway and again in the helper, when the window belongs to:
- an app on `TEACH_NEVER_APPS` (Psyche, security and sign-in prompts, System Settings, password managers, authenticators, wallets);
- an app whose fixed cap is **Off** (`FixedCaps`: banking, trading and crypto apps);
- a terminal or IDE (`FixedCaps` category `terminalOrIDE`, which capture hygiene already excludes: their windows hold secrets and aren't forms);
- an app the owner set to **Off** in Settings → Computer use.

Everything else is allowed, **browsers included** (fixed cap Read is enough, since Points only reads). Points does **not** need a computer-use tier: the owner's Start click on that window is the consent for that window, for that session only. It grants nothing to computer use.

**Payment and bank pages** in an allowed app (a page where `isMoneyContext` is true, a host where `venueOfHost` answers, or a page served over plain `http:`) run in **directions only** mode. Psyche still shows which field comes next, but every field there counts as sensitive (§5.1).

## 3. Perception and the guidance loop

### 3.1 Perception: the AX tree first, a screenshot only on request

**Decision: accessibility tree first; screenshot plus vision as an owner-requested fallback.**
- **Why:** the tree gives each field's label, role, required flag, options, frame and focus without pixels. It is cheap (a few KB per page) and lets Psyche know which fields are sensitive before anything is read. Computer use is already built this way ("screenshots are for what the snapshot cannot show", `compose/computer.ts`).
- **Vision first** would send pixels of tax and ID forms to the provider on every step, and it can't tell a secure field from a plain one.

**What the helper reads** (`PointsDigest`, built in the helper):
- **Scope:** only the chosen window's subtree, including its sheets, capped at `maxVisit` 4,000 and `maxEmit` 300 fields.
- **Each field:** a stable `fieldId` (`f12`: a helper-held handle keyed by element identity, like computer-use refs, never reassigned) and role, mapped to the fixed role list (text, multiline, number, date, checkbox, radio, popup, combobox, button, link).
- **Labels:** the label from `AXTitle`, `AXDescription`, `AXPlaceholderValue`, `AXHelp`, `AXTitleUIElement` and `AXLinkedUIElements`, each cut to 120 characters, plus the path of headings and group titles above the field.
- **State:** required (`AXRequired`), invalid (`AXInvalid`, which Safari and Chrome expose for `aria-invalid`) and the error text right after the field (at most 200 characters). Options for popups and radio groups (at most 40). The frame in global points. Enabled and focused.
- **Value:** filled or empty for every field. The value itself only for a field that passed the sensitive judge (§5), at most 500 characters.
- **The page:** app name and bundle id, the window title, the web area's host and path (no query or fragment), the page's headings and instruction text near fields (at most 2,000 characters per page), and a **page fingerprint** (a hash of the field roles and label paths).

**Electron and Chromium.** Some apps build their tree only after `AXManualAccessibility` is set on the app element. That one attribute write lives in a tiny target of its own (`PsycheAXEnable`, §4.3), the only AX write the Points code can reach. When the tree is still sparse after 3 s, the card offers **Let Psyche look**.

**When the tree isn't enough.** Points offers **Let Psyche look** (one owner click) when any of these is true:
- the window has visible content but fewer than 3 fillable fields;
- the owner says "Psyche can't see this form" through Stuck?;
- the plan points at a field the helper can't find.

In vision mode:
- the helper captures **that window only**, with the target window's own content filter (§5.3);
- the model answers with a box in image coordinates, which the helper maps to the screen and clamps inside the window;
- the field-change signals are gone, so Psyche moves on only when the owner presses **Next**, and each Next is one new capture. There is no automatic capture.

An eye badge on the card shows while vision mode is on, and it turns off on the next page that has a usable tree.

### 3.2 Which window, and how often Psyche re-reads it

**Choosing the window (explicit, never the whole screen):**
- **From ⌘K or the menu bar:** Psyche hides its own window, as screen ask does. The start sheet then names the window that was frontmost before Psyche: "Help with **Safari: Form I-130**?" It offers **Start**, **Pick another window** (a list from `points.windows`: app and window titles through AX, no Screen Recording needed) and **Cancel**.
- **From Chat:** the same sheet, with the window list open and the most recent non-Psyche window preselected, because Chat is itself in front.
- **Binding:** the session is bound to the pid, launch date and Team ID (the teach rules) plus that window's AX element. A sheet of that window is in scope. A **new window** of the same app (a form that opens page 2 in a new window) shows "Follow to the new window?" on the card. Psyche follows only on the owner's click.
- **Psyche never raises or activates the window.** If it isn't in front, the sheet says "Switch to {app} to begin". The overlay appears when that app becomes active.

**Re-reading: event-driven only, no polling loop.** One AXObserver on the pid listens for:

| Notification | Element | Then |
| --- | --- | --- |
| `kAXFocusedUIElementChangedNotification` | app | The focus moved: re-read that one field (role, label, state). If it is the planned next field, or the previous target lost focus with a new value, the step moves on (§3.4) |
| `kAXValueChangedNotification` | the focused field only (the watch moves with focus, as in teach) | Coalesced for 300 ms: only filled or empty goes to the Gateway, with no value. The value goes once, when focus leaves the field (non-sensitive fields only) |
| `AXLoadComplete`, `kAXTitleChangedNotification`, `kAXUIElementDestroyedNotification` (target field, window), `kAXLayoutChangedNotification` | web area, window | Debounced for 400 ms, then a full re-read. A different page fingerprint means a new page (§3.4) |
| `kAXMovedNotification`, `kAXResizedNotification`, `kAXWindowMiniaturizedNotification` and `kAXWindowDeminiaturizedNotification`, app activated, deactivated, hidden or shown | window, app | Move or hide the overlay (§4.2) |

- **Scrolling:** there is no AX notification for scrolling in web areas, so a **listen-only** `NSEvent` global monitor for `.scrollWheel` re-reads only the target's frame, at most 30 times a second while the owner scrolls. Nothing runs when nothing moves.
- **Thread:** the observer runs on one dedicated thread that blocks in `CFRunLoopRun()`, with no timed wakeups (not `RunLoopThread`), and `AXUIElementSetMessagingTimeout` at 0.5 s so a hung app can't stall it.
- **Rate limit:** at most 2 full re-reads a second.

### 3.3 The guidance loop

**Inputs to the per-page plan call** (Gateway, `points-plan.ts`):
1. **The owner's goal**, if given, at most 500 characters. It is trusted: these are the owner's own words.
2. **The digest** (§3.1) as one fenced, untrusted JSON block, built with `redactor.redact()` first and truncation second (`psyche-permissions` §3f). Sensitive fields go in as `{id, role, label, sensitive: "<reason>", state}`, with no value.
3. **Memory facts**, at most 12 lines and 1,200 characters. They come from USER.md "About the owner" (name, home city, work), its Learned lines (owner's words only) and memory recall chunks marked trusted, retrieved with the form's headings plus the goal as the query.
   - **Never** untrusted or ingested text (mail, web pages, documents others wrote).
   - **Never** a line that `classifyTeachValue` flags or that names a sensitive kind (SSN, passport, card, account, PIN). Psyche never brings an ID number out of Memory, even one the owner told it.
   - Each line keeps its source id (`memory:<id>` or `profile:<field>`).
4. **The session so far:** pages done, with field counts (no values), and the current page's filled or empty states.

**Output** (a JSON schema enforced by the router; anything else is a failed call):

```
{ page: { title, summary ≤ 200 },
  steps: [ { fieldId, kind: fill | choose | check | skip | self | review | next_page,
             note ≤ 140, value?, option?, sources?: [sourceId], derivation?: exact | case | date_format | name_part | address_part,
             expect?: { shape: date | email | phone | postal | digits | oneOf, detail? } } ],
  done_when: "submit" | "next_page" | "none" }
```

**The Gateway checks every step before the helper draws it.** This is code, not the model's word:
- **Real fields only:** `fieldId` must be in the digest, and an `option` must be one of that field's options. Anything else is dropped.
- **Sensitive fields:**
  - A step on a field the helper or the Gateway judged sensitive keeps only `kind: self`. Its `value` and model `note` are removed and the fixed copy is used: "You fill this yourself: {label}".
  - For identity fields (SSN, passport, tax id) one model hint of at most 100 characters may follow, for example "It's on your passport's photo page". The hint is dropped if it contains any digit.
  - Payment fields get the fixed copy alone.
- **Grounding:** every `value` must come from a cited source, the goal or a Memory line:
  - `exact` or `case`: the value is a substring after NFKC and case and space folding;
  - `name_part` or `address_part`: every token of the value is in the source;
  - `date_format`: the parsed date equals a date in the source.
  - A value that fails is removed, and the step becomes "Psyche doesn't know this one. {note}". **Psyche never makes up a value.**
- **No secrets in suggestions:** a `value` that `classifyTeachValue` flags is removed, whatever its source.
- **Clean notes:** URLs and email addresses are stripped, as are control, format and bidi characters (the approval sanitizer, `psyche-permissions` §3b). Notes are plain text, with no Markdown. The page's host is always shown on the card by the helper, never by the model.

**The call:** the router's `primary` role (the chat model) by default (§11 Q2), with no tools and no tool choice. The model is told to reply in the owner's UI language. It is not an agent run: no run-trace payloads and no thread messages. Usage rows record tokens and the model, never content.

### 3.4 Moving on, pages, mistakes and "I'm stuck"

**Moving on (local, no model call)** is a pure step tracker (`points-steps.ts`):
- The target moves to the next planned step when either:
  - the target field **loses focus with a new value** (or a checked box, a chosen option), or
  - focus lands on the planned next field.
- **Skip** and **Back** on the card move it by hand.
- `skip` steps are shown in passing ("Leave this blank: only for joint filers") and are not waited on.
- When every planned step is done, the target is the `next_page` or `review` button.

**Multi-page.** A re-read with a new page fingerprint is a new page: Psyche makes one plan call for it and keeps the earlier pages' summaries (titles and counts). The same fingerprint seen again (the owner pressed the form's own Back) reuses that page's plan, with no call.

**Mistakes** are found three ways, and only the last costs a model call:
1. **Expectation:** on commit, the value is checked against the step's `expect` (a date shape, digit count, postal or email shape) or against the suggested value. A miss shows "This looks different from what I expected: {why}" with **Keep it** and **Show me**.
2. **The form says so:** a field that turns `AXInvalid`, or gets new error text after it, is pointed at with that text quoted (untrusted, at most 200 characters).
3. **The owner asks:** **Looks wrong?** on the card makes one check call, with this field, its value (non-sensitive only), its neighbours and the facts. That call answers in the card.

**"I'm stuck."** The card can't take typing (§4.1), so **Stuck?** offers three quick picks and a way out:
- **I don't have this:** one call. Psyche says what the field needs and where people usually find it, for example "On your W-2, box 1".
- **I don't get this field:** one call that explains the field in plain words.
- **The form won't go on:** a re-read, then one call over the invalid fields and error text.
- **Ask in Psyche…** opens Psyche's own window (the owner's click, on Psyche) on the session's thread, where the owner can type. The answer shows there and in the card. The overlay stays up.

**Ending.** A session ends on:
- **Stop** on the card, the session's menu-bar item, or a bare **Esc** while the target app is in front (§4.2);
- the window closing, the app quitting, or the pid or launch date changing;
- 30 minutes with no field change;
- the owner starting computer use or a teach recording (mutual exclusion, §4.3);
- the helper or the Gateway going away.

## 4. The overlay

### 4.1 Windows

There are two `NSPanel`s per session, created at Start and released at Stop.

**Pointer layer.**
- **Window:** borderless, transparent, `ignoresMouseEvents = true`, one per display that the target field touches.
- **What it draws:** a 3 pt ink ring (#2c5aa0, the UI direction) around the field's frame with 4 pt of padding, plus a short arrow from the card to the ring. It never fills the field, so the owner can read what they type.
- **Out of view:** a scrolled-away field becomes an edge chevron ("Scroll down to {label}").
- **Accessibility settings:** with Reduce Motion the ring appears at once; with Increase Contrast it is 5 pt.

**Note card.**
- **Size and content:** 300 × at most 160 pt, opaque `surface-overlay` with no glass (the screen-ask §10.2 lesson). Rows:
  1. the host or app chip;
  2. the note;
  3. the suggestion as a monospace chip with **Copy**;
  4. the source chips ("From what you told Psyche", "From Memory: Home address");
  5. the step count;
  6. the buttons Back · Skip · Looks wrong? · Stuck? · Stop.
- **Placement:** it never overlaps the target field or the next two planned fields (their frames are known). It prefers the window's side margin, then the display edge outside the window.
- **While the owner types** in the target field, the card dims to 40% and becomes click-through, and it comes back 1 s after the last value change.
- **Hide note** collapses it to a small pill.

**Never focus, never block.** Both panels set:
- `styleMask` `[.borderless, .nonactivatingPanel]`;
- `canBecomeKey` and `canBecomeMain` overridden to `false`, `becomesKeyOnlyIfNeeded`, and `hidesOnDeactivate = false`;
- the card's buttons `acceptsFirstMouse`, so a click works without activating the helper.

The helper never calls `NSApp.activate` or `makeKey`, and the boundary check forbids both (§4.3). Keyboard focus stays in the form the whole time. Only the card's own rectangle takes clicks, and it is placed off the form's fields.

**Copy** puts the suggested value on the pasteboard as `org.nspasteboard.TransientType`, so clipboard managers skip it. It runs only on the owner's click and is never offered for a sensitive field, since those have no value.

### 4.2 Displays, Spaces and full screen

- **Level and behaviour:** `.floating`, with `collectionBehavior` `[.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]`, so the panels can sit over a full-screen app's Space.
- **Shown only while the target is in front:** both panels show only while the target app is active **and** the target window is on screen on the active Space. That is checked on events: app activated or deactivated, `NSWorkspace.activeSpaceDidChangeNotification`, minimise, hide, and a `CGWindowListCopyWindowInfo(.optionOnScreenOnly)` lookup of the window id, which needs no Screen Recording. Switch to Mail and the arrow is gone; come back and it returns.
- **Coordinates:** AX frames are global, top-left origin, in points. The panels convert using the primary display's height and rebuild on `NSApplication.didChangeScreenParametersNotification`. Mixed-DPI displays are fine because everything stays in points.
- **A window across two displays** gets a pointer layer on each display it touches. The card goes on the display that holds the field.
- **A full-screen target:** the panels join its Space through `.fullScreenAuxiliary`. The session's menu-bar item may be hidden there, so the card's Stop and Esc are the stops.

**Esc.** A listen-only `NSEvent.addGlobalMonitorForEvents(matching: .keyDown)` reads only `keyCode` and `modifierFlags`. A bare Esc (keyCode 53, no modifiers) while the target app is in front ends the session.
- **Esc still reaches the app:** a global monitor can't swallow or change events, which is what "never blocks input" requires. In a web form Esc at most closes a date picker.
- **Never characters:** the monitor never reads `characters`, and the boundary check forbids it, so Psyche can't see what is typed. Under Secure Event Input the system delivers nothing to the monitor anyway.

**Session menu-bar item.** "◉ Pointing: {app}", with **Stop pointing**, exists only while a session runs (the teach indicator's pattern). §11 Q1 asks whether the helper should also keep a permanent item for starting.

### 4.3 It never clicks: the structural guarantee

These are code boundaries, not rules for the model.

**1. Its own targets.** Four new SwiftPM targets:

| Target | Holds | Depends on |
| --- | --- | --- |
| `PsycheAXRead` | The read-only AX helpers, moved out of `LiveAX.swift`: `copy`, `attr`, `string`, `frame`, `pid`, `children`, the observer wrapper | Protocol only |
| `PsycheCapture` | Window capture, the JPEG ladder and masking, moved out of `Screenshots.swift` | Protocol only |
| `PsycheAXEnable` | One function, `enableManualAccessibility(pid:)`, the only `AXUIElementSetAttributeValue` call, with a constant attribute name, on the app element | Nothing |
| `PsycheHelperPoints` | Perception, the overlay, the Esc and scroll monitors and the `points.*` capability group | `PsycheHelperCore`, `PsycheAXRead`, `PsycheCapture`, `PsycheAXEnable`, protocol. **Not** `PsycheHelperSystem`, which holds `Input` and `AXEngine.perform`/`set` |

`PsycheHelperSystem` re-uses `PsycheAXRead` and `PsycheCapture`. The executable assembles both groups: `HelperRuntime` takes extra handlers from `main.swift`. A Points handler is built with a `PointsSession` and two closures (`isComputerBusy`, `isRecording`). It never holds a `ComputerUse`.

**2. A build-time check:** `apps/mac-helper/scripts/check-points-boundary.sh`, run by `verify.sh --swift`.
- **Package graph:** `Package.swift` dependencies of `PsycheHelperPoints`, `PsycheAXRead`, `PsycheCapture` and `PsycheHelperCore` must not include `PsycheHelperSystem`.
- **Symbols:** `nm -u` over those targets' object files must not reference `_CGEventPost`, `_CGEventPostToPid`, `_CGEventPostToPSN`, `_CGEventTapCreate`, `_CGEventTapCreateForPid`, `_CGEventTapPostEvent`, `_CGEventCreateKeyboardEvent`, `_CGEventCreateMouseEvent`, `_CGEventCreateScrollWheelEvent*`, `_CGWarpMouseCursorPosition`, `_CGDisplayMoveCursorToPoint`, `_AXUIElementPerformAction`, `_AXUIElementPostKeyboardEvent`, `_AXUIElementSetAttributeValue`, `_IOHIDPostEvent`, `_CGRequestScreenCaptureAccess` or `_posix_spawn*`. Nor may they reference the classes `NSAppleScript`, `OSAScript` or `NSTask`.
- **Core should pass today:** a source grep on 2026-11-24 found that `PsycheHelperCore` uses only the `CGEventFlags` and `CGKeyCode` types (`KeyChord.swift`), which link no symbols. W2 confirms this with `nm`.
- **One exception:** only `PsycheAXEnable` may reference `_AXUIElementSetAttributeValue`, and its source must stay a single call.
- **Selectors:** their method names must not include `postEvent:atStart:`, `sendEvent:`, `activateIgnoringOtherApps:`, `activateWithOptions:`, `activate`, `makeKeyWindow`, `makeKeyAndOrderFront:`, `openURL:`, `openApplicationAtURL:configuration:completionHandler:`, `characters` or `charactersIgnoringModifiers`.
- **Source scan:** the targets' sources must not contain `kAXTrustedCheckOptionPrompt`, `CGEvent(` or `.post(`. This is a quick first line that runs without a build. It is also a Swift test.
- **Positive control:** the same script, run on `PsycheHelperSystem`'s objects, **must** find `_CGEventPost` and `_AXUIElementPerformAction`, or the check itself is broken and fails.

**3. The wire carries no action.** The `points.*` capability schemas have no field that names a key, a click, a point to act on or an AX action. `points.show` draws by `fieldId`, or by a box in vision mode, and nothing else. `points.*` is declared `sideEffect: none` or `read`.

**4. Mutual exclusion.** While a Points session runs, the helper refuses computer-use **actions** (`computer.click`, `type`, `key`, `set_value` and the rest) with `conflict/points_active`. Points refuses to start while a computer-use session or a teach recording runs (`computer_busy`, `recording_active`). So no agent can act on the form while the owner fills it.

**5. The Gateway side.**
- **Allowlisted node:** the Points module gets a `PointsNode` wrapper whose `invoke` accepts only names on a fixed allowlist (`points.windows`, `points.session`, `points.show`, `points.look`, `points.end`). A test hands it every other helper capability name and expects a refusal.
- **No tools:** the guidance call has no tools, and a test checks that the request carries none.
- **Out of reach:** `points` joins `UNREACHABLE` in `handlers/nodes.ts`, so no client or agent node tool reaches the helper's `points.*` on any node. There is no agent tool that starts, steers or reads a session.

## 5. Sensitive fields and screen data

### 5.1 Finding them, before anything is read

The helper decides first, from the element alone (`AppTeachPolicy.sensitiveReason`, extended):
- `AXSecureTextField`, or Secure Event Input being on;
- `TEACH_SENSITIVE_WORDS` (password, one-time code, payment, identity, secret, in the shipped languages) in the field's title, description, identifier, placeholder, help, linked labels, the sheet and group titles above it and the few static texts just before it;
- the card-field tokens of `isPaymentField`, ported to Swift beside the words, with a shared fixture so the two can't drift;
- **directions-only pages** (§2.2): every field.

For a sensitive field:
- `AXValue` is never read;
- filled or empty comes from `AXNumberOfCharacters > 0` where the app offers it, read once when focus leaves the field, and otherwise it is `unknown` and the owner moves on with Skip;
- the helper sends only `{fieldId, role, label, sensitive, state}`.

The Gateway judges again before the model sees anything:
- `classifyTeachField` and `isPaymentField` on the field facts;
- `isMoneyContext` and `venueOfHost` on the page;
- `classifyTeachValue` on every value it did get. A hit drops the value, marks the field sensitive (`value_shape`) and counts it in the audit row.

**Never for sensitive fields:** a suggested value, a model-written note, a quote of the value, or the value in a "looks wrong" check. Payment fields (card, bank account, routing, IBAN) and everything on a directions-only page show the fixed "You fill this yourself", with no hint. The "pay" button on a payment page reads "This button pays. Check the amount, then decide yourself." It never says "press Pay".

**The probe table comes first** (W1, `psyche-permissions` §3). Two lists are written before the rule:
- **Fields that must be sensitive:** "SSN", "Social Security number", "Passport No.", "A-Number", "ITIN", "Routing number", "Account number (for direct deposit)", "Card number", "CVV", "PIN", "One-time code", "Mot de passe", "Reisepassnummer", and fields under a "Two-factor authentication" sheet title.
- **Near-misses that must not be:** "Passport photo upload", "Library card number", "Number of dependents", "Account name", "Card holder's city", "Tax year".
- **Points-only additions** ("A-Number", "ITIN", "Alien registration number") go in a Points list in `points-rules.ts` and the shared fixture, not in `TEACH_SENSITIVE_WORDS`, so teach by showing doesn't change (`psyche-permissions` §2).
- **False matches fail safe:** a field wrongly judged sensitive only gets "You fill this yourself". Today's `\bpass\b` matches "Pass-through entity", for example. That is recorded as accepted, not fixed by loosening the shared words.
- **Recorded choices:** "Password hint" and "Security question answer" count as sensitive (`password` and `secret`), because their answers unlock accounts.
- Every review finding becomes a row.

### 5.2 What goes to the model provider

| Sent (when the session runs) | Never sent |
| --- | --- |
| The app name, window title, page host and path, headings and instruction text (at most 2,000 characters a page) | Any sensitive field's value, or anything `classifyTeachValue` flags |
| Each field's label, role, options, required and invalid flags, filled or empty | Query strings and fragments, cookies, other windows, other apps |
| Values of non-sensitive fields, redacted with `SecretRedactor` and then cut to 500 characters | Memory lines that are untrusted or name a sensitive kind |
| The goal, at most 12 Memory lines | Pixels, unless the owner pressed Let Psyche look on this session |
| On Let Psyche look: one JPEG of the target window only, at most 1372 × 887, with every known sensitive field's frame painted solid before encoding | The overlay itself (the window filter leaves it out; `sharingType = .none` as well) |

**How the owner is told:**
- **The start sheet** always shows one line under Start: "Psyche sends this form's labels and what you type, except passwords, card, bank and ID numbers, to {provider} to guide you." With a local primary model it says "This stays on your Mac."
- **The first Let Psyche look** in a session says "This sends a picture of this window to {provider}". It asks once per session.
- **Settings:** the same text sits under the Points toggle in Settings → Computer use.

**Prompt injection:**
- **Fencing:** the digest is fenced untrusted data.
- **No hands:** the call has no tools and its output is checked (§3.3).
- **Fixed copy:** sensitive and payment fields get fixed text that the page can't change.
- **No links:** notes can't carry links or addresses.
- **The host is always shown:** a phishing page can mislead about an ordinary field at most, and it still shows its host on every card. Deciding whether a site is genuine is a non-goal (§2.1).

### 5.3 Storage

- **Screenshots are never stored.** They live in helper memory until encoded, then in Gateway memory until the model call returns, then they are dropped. They never go to the Library, run-trace frames, the audit log or disk.
- **Vision capture** uses `SCContentFilter(desktopIndependentWindow:)` on the target window, so other windows and Psyche's overlay aren't in it. Capture is refused under Secure Event Input, and when the window belongs to an app §2.2 refuses.
- **Gateway session state** lives in memory and is gone at Stop: the digest, the plans and the step position.
- **Nothing is written to Memory.** §11 Q4 asks about an end-of-session offer.
- **Audit rows:** `points.started` (bundle id, entry point), `points.ended` (reason, pages, steps, model calls, looks, sensitive fields seen, values dropped by shape) and `points.looked` (count). No titles, labels, hosts or values. They follow the audit log's retention.
- **A session started from Chat** ends with one short note in that thread: "Pointed you through {app}: {pages} pages, {steps} fields." A session from ⌘K or the tray gets a new thread only if the owner presses Ask in Psyche…
- **Logs:** `os.Logger` lines carry ids, counts and reasons only (ADR-017).
- **The no-persist test (W7):** run a fake session that plants a value (`1428 Elm Street`), then scan every table, including gzip `step_payloads` in JS, and the Gateway log for it. **Positive control:** the fake provider must have received it.

## 6. Permissions and entry points

### 6.1 TCC

| Permission (for Psyche Helper) | Needed for | Asked when |
| --- | --- | --- |
| **Accessibility** | Reading the tree, the AXObserver, the Esc and scroll monitors | At the first Start, if missing |
| **Screen Recording** | Let Psyche look only | At the first look, if missing |
| Input Monitoring | Not needed: key and scroll global monitors run under Accessibility | Never |

**Reusing #1643:**
- **Accessibility:** the start sheet reads `helperStatus()`. If Accessibility is missing, it shows the same row as Settings → Computer use, extracted from `ComputerUseSection` into `HelperPermissionRow`: name, state and **Allow**. Allow calls `helperRequest("accessibility")`, which is the existing allowlisted `permissions.request {permission: "accessibility"}`. The row is re-read on window focus.
- **Screen Recording:** when the helper answers a look with `permission_missing`, the Gateway emits `points.updated {needs: "screenRecording"}`. The desktop shows the same row in a small Psyche sheet, using `permissions.request` with `purpose: "vision_fallback"`, which #1643 already allows.

There is no new prompt path and no new allowlist entry, and the Points targets can't prompt at all (`CGRequestScreenCaptureAccess` and `kAXTrustedCheckOptionPrompt` are forbidden, §4.3).

**Tests never pop a dialog:**
- every live source (AX, observer, capture, monitors, panels) sits behind a protocol with fakes, as in `AppTeachTests`;
- preflight uses only `AXIsProcessTrusted()` and `CGPreflightScreenCaptureAccess()`;
- UI tests use the mock gateway.

**Free signing** holds: no new entitlements. Panels, AX and ScreenCaptureKit need only the user's TCC grants.

### 6.2 Entry points

| Where | What |
| --- | --- |
| **Chat** | Asking "help me fill this", "walk me through this visa form" and the like lets the agent call **`points.offer {goal}`**, a tool with no side effect that renders a **Point me through it** card holding the goal. The click opens the start sheet with the goal filled in. The tool can't start anything. It is offered only on a Mac Host with Points on. Other clients get the tool's text, "Start Psyche points on your Mac: ⌘K, then Point me through a form." |
| **⌘K** | The action **Point me through a form** opens the start sheet. |
| **Menu bar** | **Point me through this window…** in Psyche's existing menu-bar menu (`tray.ts`), beside Ask about screen. During a session, the helper's own "◉ Pointing: {app}" item has Stop (§11 Q1). |
| **Stop** | Stop on the card, Esc, Stop pointing in the menu-bar item, or the start sheet's session row in Psyche. |

**Settings → Computer use → Psyche points:**
- on or off: off until W9's owner pass, then on;
- the data line (§5.2);
- the reused helper permission rows already on that page.

There is no new sidebar row (IA consolidation).

## 7. Cost and performance

| | Target |
| --- | --- |
| **Idle (off or no session)** | **Zero:** no observer, panels, monitors, threads or timers; no Gateway timers; the code is linked but not touched |
| **Model calls** | 1 plan call per new page. 0 per field step. At most 1 per Looks wrong?, Stuck? pick or form error. Cap: 30 calls or 300k input tokens per session. At the cap the card says so and keeps pointing from the last plan |
| **Plan call size** | Input at most about 6k tokens (digest 4k, facts and goal 1.5k, instructions). Output at most 1.2k tokens. With Let Psyche look, add one image, about 1.5k tokens |
| **A typical 3-page form** | 4 to 6 calls |
| **First arrow** | Within 300 ms of Start, on the first empty field in reading order ("Reading the form…"), then replaced by the plan's first step when it arrives |
| **Helper CPU while active** | At most 1% on average while the owner types (one field read per coalesced change). A full re-read of a 300-field page takes at most 150 ms, off the main thread |
| **Helper RAM while active** | At most 20 MB more resident memory. Within 2 MB of the baseline 10 s after Stop (measured with `footprint` in W9) |
| **Gateway** | At most 1 MB per session, one session at a time |

## 8. Protocol and data

**Gateway methods** (`packages/protocol/src/methods/points.ts`):
- **Who may call:** every method is `operator.admin` and refused (`forbidden`) unless `call.identity.desktopShell === true` on a loopback connection. That is the Host's own desktop, never a paired phone, another Mac or a window onto a remote Gateway, where the feature is hidden as #1643 hides helper rows.
- **Which helper:** always the Host helper (`ctx.nodes.hostHelper("points.session")`).

| Method | Params → result |
| --- | --- |
| `points.windows` | `{}` → `{windows: [{ref, app: {bundleId, name}, title, frontmost, refusal?}]}`. The titles come through AX |
| `points.start` | `{window: ref, goal?: string ≤ 500, threadId?, entry: "chat" \| "palette" \| "tray", locale, strings: PointsCardStrings}` → `{sessionId, app: {bundleId, name}}`. Side-effecting. The result carries no title or values |
| `points.stop` | `{sessionId}` → `{ended: true}` |
| `points.status` | `{}` → `{session?: {sessionId, app, state, page, step, of, vision}}` |
| `points.ask` | `{sessionId, text ≤ 1000}` → `{answer}`. Ask in Psyche…; one model call |

`PointsCardStrings` is the helper's fixed text (buttons, the fixed sensitive and payment copy, the menu-bar title, the step format `{n}/{total}`). The desktop renderer resolves it from `packages/ui` messages in the owner's language and sends it at Start. The Gateway accepts only the known keys, each at most 80 characters with control and bidi characters stripped, and refuses a start without the full set.

**Gateway events**, sent only to the device that started the session (the `dictation.key` pattern):
- `points.updated {sessionId, state: reading | pointing | paused | ended, page, step, of, vision, needs?: "accessibility" | "screenRecording", reason?}`;
- `points.ask_requested {sessionId}`, sent when the owner pressed Ask in Psyche… on the card.

**Helper capabilities** (`points.*`; never through `nodes.invoke`; no agent node tool):

| Capability | Side effect | Params → result |
| --- | --- | --- |
| `points.windows` | read | → candidate windows (pid, AX window index, app, title, refusal) |
| `points.session` | read, streaming | `{window, strings}` → events `{type: "digest", digest}`, `{type: "field", fieldId, state, value?}` (value on commit, non-sensitive only), `{type: "focus", fieldId}`, `{type: "page"}`, `{type: "action", action: back \| skip \| wrong \| stuck_missing \| stuck_unclear \| stuck_blocked \| ask \| look \| next \| follow_window \| stop}`, `{type: "visible", visible}`, `{type: "ended", reason}`. `node.cancel` ends it |
| `points.show` | none | `{sessionId, target: {fieldId} \| {box, imageSize}, kind, note, value?, sources?: [label], step: {n, of}, warning?}` → `{shown}`. Text only; the helper clamps lengths again |
| `points.look` | read | `{sessionId, actionId}` → `{image, width, height, pointsPerPixel, masked}`. Answered only for the `actionId` of the owner's latest `look` or `next` action in vision mode, so the Gateway can't capture on its own |
| `points.end` | none | `{sessionId}` → `{}` |

**Scopes and hosts:** Host only, Mac only (`hostOs() === "mac"`, Host helper kind). `points.*` is added to `UNREACHABLE`. The agent gets `points.offer` only, which has no side effect.

**Retention:** see §5.3. Session state lives in memory, plus audit rows with counts.

## 9. Copy

- **Desktop, web and shared UI:**
  - **Source:** `packages/ui/src/i18n/messages/points.ts` (`points.*`), with all 10 languages in `locales/points/<lang>.ts`.
  - **Coverage:** the start sheet, the data line, the window list and refusals, the ⌘K action, the menu-bar item, the Chat offer card, the Settings subsection, the permission sheet and the `points.updated` states.
  - **Check:** `pnpm i18n:check` passes.
  - **Mac wording:** strings that say "Mac" get Linux and Windows variants only if they reach shared screens. The feature is Mac-only, so prefer wording without "Mac" ("on this computer") where it reads fine.
- **The helper's own strings:** the card buttons, "You fill this yourself: {label}", the payment button copy, "Scroll down to {label}", "◉ Pointing: {app}", Stop pointing, Hide note and the eye badge's label.
  - **Source:** `points.card.*` keys in the same message files, in all 10 languages, sent to the helper in `PointsCardStrings` at Start (§8).
  - **No catalog:** the helper ships no string catalog of its own and has today only `Support/en.lproj`.
  - **Fallback:** it keeps English fallbacks, used only if a key is missing. A test checks they match the English messages.
- **Model-written notes:** these are in the owner's UI language, which is named in the prompt.
- **Menu bar:** the new tray row's label comes from the renderer with the tray model. The existing tray rows are English today, and localizing them is out of scope.
- **Tone:** short and calm, with no alarm words. Example: "This is your employer's name, as on your W-2."

## 10. Builder wave plan

Every wave follows the hard rules in `.claude/CLAUDE.md`:
- branch from `origin/main`, merge `origin/main` in, never `reset --soft`;
- `vitest --maxWorkers=1` on the touched files only;
- `FakeModelProvider` and fake helper nodes only;
- no live TCC, no built Psyche.app.

**One Swift build at a time:** the Swift waves (S) run **one after another**. TypeScript waves (T) run beside them when their files don't overlap. **Sec** means an independent security review before merging. The model is Haiku 5.5 unless the table says otherwise.

| Wave | What | Files (ownership) | Done when | Depends on | Lane | Review |
| --- | --- | --- | --- | --- | --- | --- |
| **W0** | **Protocol, additive.** `methods/points.ts`, `schemas/points.ts` (digest, field, step, `PointsCardStrings`, capability params and results), the `points.updated` and `points.ask_requested` events, the `points_offer` part. `pnpm protocol:gen` | `packages/protocol/src/methods/points.ts`, `schemas/points.ts`, `events.ts`, generated TS and Swift in `packages/protocol-swift` | Registry and codegen freshness tests pass; `swift build` of protocol-swift passes; no exhaustive Swift switch breaks | – | S (codegen build) | normal |
| **W1** | **Shared rules.** `packages/protocol/src/points-rules.ts`: field sensitivity (wraps `classifyTeachField`, `isPaymentField`, page money context, `venueOfHost`, plain `http:`), value shapes, the grounding checker, the note and hint sanitizer, the Memory line filter. The table-driven probe test of §5.1 with both lists, plus a JSON fixture shared with Swift | `packages/protocol/src/points-rules.ts`, `packages/protocol/test/points-rules.test.ts`, `packages/protocol/test/fixtures/points-sensitive.json` | Both probe lists pass; grounding rows for each `derivation`, including refusals; a sanitizer row for every bidi or control class (#1537) | W0 | T (parallel with W2) | **Sec**, Sonnet builder |
| **W2** | **Helper target split, no behaviour change.** New targets `PsycheAXRead`, `PsycheCapture`, `PsycheAXEnable` and an empty `PsycheHelperPoints`; `PsycheHelperSystem` re-uses the first two; `HelperRuntime` takes extra handlers; `scripts/check-points-boundary.sh` (package graph, `nm`, selectors, source scan, the positive control on `PsycheHelperSystem`) wired into `verify.sh --swift`; a source-scan Swift test | `apps/mac-helper/Package.swift`, `Sources/PsycheAXRead/*`, `Sources/PsycheCapture/*`, `Sources/PsycheAXEnable/*`, `Sources/PsycheHelperPoints/` (stub), `PsycheHelperSystem/Computer/LiveAX.swift` and `Screenshots.swift` (moved parts), `HelperRuntime.swift`, `Sources/PsycheHelper/main.swift`, `scripts/check-points-boundary.sh`, `.claude/scripts/verify.sh` (one hook line) | `verify.sh --swift` passes; every existing helper suite still passes; the check fails when a `CGEvent(` call is planted in `PsycheHelperPoints` (shown in the PR) and passes without it; the positive control finds `_CGEventPost` in System | W0 (build order only) | S | **Sec** (capability split), Sonnet builder |
| **W3** | **Helper perception.** `PsycheHelperCore/Points/`: the pure digest builder over an abstract AX source, field ids, the sensitive judge (reusing `AppTeachPolicy`, plus the ported card tokens from the W1 fixture), page fingerprint, change coalescing, the §2.2 refusals. `PsycheHelperPoints/Perception/`: the observer thread (`CFRunLoopRun`, messaging timeout), the notification table of §3.2, the scroll monitor, `points.windows`, `points.session`, `points.end`; mutual exclusion with computer use and teach (`isPointing` closure into `ComputerUse`) | `apps/mac-helper/Sources/PsycheHelperCore/Points/*`, `Sources/PsycheHelperPoints/Perception/*`, `Sources/PsycheHelperPoints/PointsCapabilities.swift`, one closure in `PsycheHelperSystem/Computer/ComputerCapabilities.swift`, `Tests/PsycheHelperCoreTests/Points*` | Fixture tests: no `AXValue` read for any sensitive row (a fake source counts reads); a value is sent only on commit; the page fingerprint changes on a new page and not on a value change; a refused app per §2.2 row; computer actions refused while a session runs; the boundary check passes | W2, W1 (fixture) | S | **Sec** (sensitive fields, screen data), Sonnet builder |
| **W4** | **Helper overlay.** `PsycheHelperPoints/Overlay/`: pointer layer and note card panels (§4.1), placement that avoids the next fields, the dimming while typing, Copy (transient pasteboard), `points.show`, the Esc monitor, the session menu-bar item, Spaces, full-screen and multi-display handling (§4.2). The manual test plan section | `Sources/PsycheHelperPoints/Overlay/*`, `PsycheHelperCore/Points/Placement.swift` (pure placement maths), `Tests/PsycheHelperCoreTests/PointsPlacementTests.swift`, `apps/mac-helper/docs/manual-test-plan.md` (§ Points) | Placement tests (never overlaps the target or the next two fields; multi-display and edge cases); panel flag tests (`canBecomeKey == false`, `ignoresMouseEvents` on the pointer layer) on panels made in tests without showing them; the boundary check passes; manual plan written | W3 | S | normal |
| **W5** | **Helper vision fallback.** `points.look`: target-window filter, masks over sensitive frames, refusal under Secure Event Input and for §2.2 apps, single-use `actionId`; vision-mode box mapping and clamping | `Sources/PsycheHelperPoints/Look/*`, `PsycheCapture` (mask helper), `PsycheHelperCore/Points/BoxMapping.swift`, tests | Mask tests (a fixture frame comes back painted where the sensitive frames were); refused without a fresh `actionId`; box mapping tests over Retina and non-Retina, clamped to the window | W4 | S | **Sec** (screen data) |
| **W6** | **Guidance engine (pure).** `points-plan.ts` (prompt builder: redact then truncate, fenced digest, Memory lines with source ids; response validation per §3.3; fixed copy for sensitive and payment fields), `points-steps.ts` (step tracker, pages and fingerprints, expectations, budget caps) | `apps/gateway/src/compose/points-plan.ts`, `points-steps.ts`, `apps/gateway/test/points-plan.test.ts`, `points-steps.test.ts` | With `FakeModelProvider`: an ungrounded value is dropped; a value on a sensitive field is dropped; a model note on a payment field is replaced; the request has no tools; a redaction test with a secret that straddles the cut (real `SecretRedactor`); budget cap rows; a multi-page replay with no second call for a page seen again | W1 | T (parallel with W3–W5) | **Sec** (data to the model), Sonnet builder |
| **W7** | **Gateway wiring.** `compose/points.ts`: the methods with the desktop-shell and loopback gate, the Host helper lookup, the `PointsNode` allowlist wrapper, the session manager (one at a time, idle end, helper loss), `points.*` events to the starting device, audit rows, the closing thread note, the `points.offer` agent tool and part; `points` added to `UNREACHABLE`; the start refusals of §2.2 | `apps/gateway/src/compose/points.ts`, `compose/index.ts` (registration), `handlers/nodes.ts` (one regex), `compose/parts.ts` (part), `apps/gateway/test/points.test.ts`, `nodes.test.ts` rows | Refused for a phone, a remote Mac and a non-loopback connection (and a control that the desktop shell passes); `nodes.invoke points.*` refused on every node kind; the wrapper refuses every non-`points` capability; the **no-persist test** of §5.3 with its positive control; audit rows carry no labels or titles | W6, W0 | T | **Sec** (screen data flow, reachability), Sonnet builder |
| **W8** | **Desktop UI and copy.** `packages/ui/src/points/*`: the start sheet (window list, goal, data line, `HelperPermissionRow` extracted from `ComputerUseSection`), the Chat offer card, the ⌘K action, the Settings subsection; desktop main: the tray row and the "hide Psyche, then target the window behind" step; `apps/web/src/compose/points.tsx`; `messages/points.ts` plus 10 locales, including `points.card.*` | `packages/ui/src/points/*`, `packages/ui/src/screens/settings/ComputerUseSection.tsx` (row extraction only), `packages/ui/src/i18n/messages/points.ts`, `locales/points/*`, `apps/web/src/compose/points.tsx`, `apps/desktop/src/main/tray.ts`, `apps/desktop/src/main/points/*`, stories | `pnpm i18n:check` passes; stories in light and dark; tests: the sheet shows the permission row when Accessibility is missing and hides it when granted (positive control); the sheet is hidden in a remote window; the offer card opens the sheet with the goal; the `--related` run for the shared Settings screen | W0 (shapes; mock gateway until W7) | T (parallel with W2–W7) | normal |
| **W9** | **End to end and turn-on.** `psyched` with a temporary `PSYCHE_HOME` and a fake helper node driving a recorded digest through W7 into W6; the README capability table; the site page; the owner's manual pass (`manual-test-plan.md` § Points: Safari, Chrome, Preview PDF, a full-screen app, two displays, Spaces, Esc, a payment page, a sensitive field, a `footprint` before and after); `points.enabled` defaults to on after the owner's pass | `apps/gateway/test/points-e2e.test.ts`, `apps/mac-helper/README.md`, `apps/site/using/points.md`, the default in the settings schema | The e2e passes; the owner ticks the manual plan; the §7 numbers measured and written into this doc | W5, W7, W8 | T (docs) plus the owner | final **Sec** pass over W3–W7 together, Opus |

**Lanes:**
- **Swift lane (sequential):** W0 → W2 → W3 → W4 → W5.
- **TypeScript lane:** W1 (beside W2) → W6 (beside W3 to W5) → W7.
- **UI lane:** W8 from W0 onward, against the mock gateway.
- **W9** comes last.
- **Shared files:** the only files two waves share are the W1 Swift fixture, read by W3, and `ComputerUseSection.tsx` in W8, which no other wave touches.

## 11. Open questions for the owner

1. **A helper menu-bar item for starting?** **Recommended:** no permanent helper icon. Start from Psyche's existing menu-bar menu, ⌘K and Chat; the helper shows its own "◉ Pointing" item only during a session (one icon at rest, zero idle cost).
2. **Which model guides?** **Recommended:** the chat model (`primary` role), since tax and visa forms reward the stronger model and a form costs 4 to 6 calls. Offer a Points model picker later if cost shows up.
3. **Bank and payment pages: directions only, or refuse?** **Recommended:** directions only (§2.2). Psyche shows which field comes next and fills nothing, so a tax payment page still gets help.
4. **Offer to save new facts at the end?** For example "Save your employer's address to Memory?" **Recommended:** not in v1. Nothing from a session is written anywhere, and the owner can tell Psyche facts in Chat as today.
5. **iOS "continue on Mac"?** **Recommended:** not in v1. The Chat offer card on iOS just says to start it from the Mac with ⌘K; a handoff that wakes the desktop can come later.
