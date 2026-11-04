# The iOS app: architecture and look

Status: decided (owner, 2026-11-04; §8); M1 build started 2026-11-04. Companion to
[mobile-companion-2026.md](mobile-companion-2026.md), which owns **how the phone reaches the
Gateway** (LAN and Tailscale only, QR pairing, the Gateway identity key), **push** (Web Push first,
then direct APNs with the owner's own `.p8`, no relay), **lock-screen approvals, Live Activities**
and **security**. This doc owns what that one leaves open: **how the app is built inside** and
**what it looks like**. Where the two overlap, the companion doc wins and this one links to it.

Visual mockups: see §9.

---

## 1. Decisions in one table

| # | Decision | Why |
| --- | --- | --- |
| A1 | **Native SwiftUI**, not React Native / Expo / a WebView shell | Already the plan (companion §6 M1). Generated Swift types exist; the mac helper proves the Swift client path; extensions (notification service, share, widgets, Live Activities, App Intents) are native anyway; lowest RAM (owner preference: RAM over disk). |
| A2 | **iOS 26 minimum** (answers companion §7 Q5) | The owner builds the app for their own phone, so reach doesn't matter. iOS 26 gives `SpeechAnalyzer` (matches the mac helper), on-device Foundation Models (matches the Mac's Apple model option), the search tab role and Liquid Glass chrome for free. |
| A3 | **No third-party Swift dependencies** in M1 | Foundation, `URLSessionWebSocketTask`, `Network` (Bonjour), CryptoKit, Security, SwiftUI, Observation, WidgetKit, ActivityKit. Same rule as the mac helper. |
| A4 | **Swift 6 language mode**, strict concurrency, `@Observable` models, actors for I/O | Matches `apps/mac-helper`; the generated types are already `Sendable`. |
| A5 | **One shared Swift package for the wire**, `packages/protocol-swift`, used by both the mac helper and the phone | Today `gen.ts` copies the generated file into the mac helper. Two copies would drift. |
| A6 | **The Gateway is the only source of truth.** The phone keeps a small cache and an outbox, nothing more | Matches N14 (`stateVersion` refetch) and "push is a hint, not state" (companion §2.3). No sync engine, no conflict resolution. |
| A7 | **Native rendering for core chat blocks; one sandboxed WebView for generative UI** (`ui` blocks, artifacts, rich viewers) | Twenty block types exist. Re-implementing every genui widget in SwiftUI would trail the desktop forever. The WebView loads a bundled build of the `packages/ui` block renderer, never remote code. (Owner call, §8 Q3.) |
| A8 | **Four tabs + the search tab**: Home, Chat, Library, Memory, and Search as iOS 26's separate search button | Same five places as the desktop (consolidation-2026 §3). The compact web layout already defines these four tabs. |
| A9 | **Home is the landing tab on the phone** (desktop lands on Chat) | A phone is opened to glance: what needs me, what's today. Chat is one tap away and "Ask Psyche" sits at the top of Home. (Owner call, §8 Q1.) |
| A10 | **XcodeGen `project.yml`**, no committed `.pbxproj` | Many parallel sessions edit this repo; `.pbxproj` merges are the worst conflicts in iOS repos. All logic lives in SwiftPM targets; the Xcode project is a thin generated shell for the app and its extensions. |

## 2. Where it lives

```
packages/protocol-swift/                 NEW SwiftPM package (moved out of apps/mac-helper)
  Package.swift
  Sources/PsycheProtocol/                generated types (gen.ts writes here) + Frames.swift
  Sources/PsycheWire/                    ConnectSigning, Base64URL, request/response correlation,
                                         frame decode, identity-key challenge check
  Tests/PsycheWireTests/

apps/mac-helper/                         depends on ../../packages/protocol-swift (path dep)

apps/ios/
  project.yml                            XcodeGen: app + 4 extensions, bundle id and team from
                                         Config/Owner.xcconfig (gitignored, per owner, §7)
  Config/Owner.example.xcconfig
  Package.swift                          every target below except the thin app/extension mains
  Sources/
    PsycheClient/        connection, pairing, identity, resync, outbox      (no UI, macOS-testable)
    PsycheStore/         cache + snapshot + outbox files in the app group   (no UI, macOS-testable)
    PsycheDesign/        tokens, type, components                           (SwiftUI)
    PsycheFeatures/      Home, Chat, Library, Memory, Search, Approvals,
                         Tasks, Pairing, Settings — one folder each          (SwiftUI)
    PsycheBlocks/        native block views + the genui WebView host         (SwiftUI, WebKit)
    PsycheShared/        Keychain, app group paths, push decryption,
                         snapshot reader — the only module extensions link   (no SwiftUI)
  App/                   @main, scene, deep-link routing                     (thin)
  Extensions/
    NotificationService/ decrypts E2E pushes (companion §3.3)
    Share/               share sheet → outbox → library.upload + chat.send
    Widgets/             WidgetKit widgets + Live Activity views
    Intents/             App Intents: Ask Psyche, Approvals count, Control Center button (M2)
  Tests/
```

**Dependency direction** (nothing points up):

```
App ──► PsycheFeatures ──► PsycheBlocks ──► PsycheDesign
             │                  │
             ▼                  ▼
        PsycheClient ──► PsycheStore ──► PsycheShared ──► PsycheWire ──► PsycheProtocol
Extensions ──► PsycheShared (+ PsycheDesign for Widgets)
```

Keeping `PsycheClient` and `PsycheStore` free of UIKit/SwiftUI means `swift test` runs them on a
macOS CI runner against a real Gateway, with no simulator (§6).

## 3. The client core (`PsycheClient`)

### 3.1 Objects

| Type | Kind | Job |
| --- | --- | --- |
| `GatewayEndpoint` | struct | `{url, identityKey, spkiPins[], transport: .lan / .tailscale}` from the QR payload (companion §2.2). Stored in `PsycheShared`. |
| `DeviceIdentity` | actor | Ed25519 device key in the Keychain (`AfterFirstUnlockThisDeviceOnly`, non-synchronizable); signs `connect` and the lock-screen `POST /v1/approvals/answer`. |
| `GatewayConnection` | actor | One `URLSessionWebSocketTask`. `call<M: Method>(_:params) async throws -> M.Result` with id correlation and per-call timeout; `events: AsyncStream<EventFrame>`; tracks `seq` and `stateVersion`. Verifies the Gateway's identity-key signature in the challenge before anything else. |
| `Session` | `@MainActor @Observable` | What the UI reads: `state` (§3.2), `device` (scopes), `stateVersion`, `lastSyncedAt`. Owns the connection's lifetime: connects on `scenePhase == .active`, closes ~5 s after `.background`. |
| `EventRouter` | actor | Fans typed events to whoever registered (`chat.delta` for thread X, `approvals.*`, `notifications.*`, `tasks.*`). Feature models subscribe with `for await`. |
| `Resync` | struct | On reconnect: if `stateVersion` moved, tell every *visible* model to refetch (N14 `onResync`). Off-screen models refetch on appear. |
| `Outbox` | actor | Durable FIFO in the app group (`PsycheStore`): `chat.send` (idempotency key), `library.upload` chunks, mark-read. Flushes in order on connect. Never approvals (companion §2.3). |

### 3.2 Connection states the UI must draw

| State | When | What the user sees |
| --- | --- | --- |
| `unpaired` | No endpoint stored | Pairing screen |
| `pending` | `connect` returned `pending` | "Approve this phone on your Mac" with the 6-digit code |
| `connecting` | First 1.5 s of a connect | Nothing (no flash). After 1.5 s a quiet "Connecting…" in the nav bar |
| `live` | Connected, verified | Nothing |
| `unreachable(.awayFromHome)` | LAN endpoint, Bonjour finds nothing | Paper banner: "You're away from home. Answers wait until you're back or on Tailscale." Cached content stays readable |
| `unreachable(.gatewayOff)` | Tailscale up, Gateway not answering | "Your Mac isn't answering. It may be asleep." |
| `unreachable(.tailscaleOff)` | `*.ts.net` doesn't resolve | "Turn on Tailscale to reach your Mac." + button that opens the Tailscale app |
| `refused(.identityMismatch)` | Wrong identity-key signature | Full-screen stop, no retry button: "This isn't your Gateway." (companion M1 acceptance 2) |
| `revoked` | `devices.revoke` | Wipes keys, cache and outbox; back to Pairing |

Reconnect uses jittered backoff 0.5 s → 30 s while foregrounded, and stops in the background.

### 3.3 Methods the phone uses (M1)

All exist today except the ones marked **new** (companion §3.4 and remote-gateway §3.3 define them).

- **Session:** `connect`, `connect.verify`, `devices.list` (own record), **identity-key challenge (new)**
- **Home:** `approvals.list`, `questions.list`, `notifications.list` / `markRead` / `resolve`,
  `daily.*` (Today), `nudges.list` / `act`, `memory.catchup.list` / `act` / `seen`,
  `memory.upcoming`, `widgets.list` (pinned), `tasks.list` (running)
- **Chat:** `threads.list` / `get` / `newChat` / `rename` / `pin` / `archive`, `chat.history`,
  `chat.send`, `chat.steer`, `chat.cancel`, `chat.queue.list`; events `chat.delta`,
  `chat.block`, `chat.message`, `chat.reasoning`, `chat.queue.updated`
- **Approvals / questions:** `approvals.get` / `answer`, `questions.get` / `answer`
- **Tasks:** `tasks.get` / `cancel` / `pause` / `resume` / `steer`
- **Library:** `library.list` / `get` / `upload` / `delete`
- **Memory:** `memory.entities.search` / `get` / `timeline`, `memory.life.search` / `answer`,
  `memory.loops.list`, `memory.catchup.*`
- **Search:** `search.query`
- **Dictation:** on-device; the text goes through `chat.send` like typing

`operator.admin` is off by default on a phone, so Settings on the phone is a small subset
(§4.6) and everything else says "Change this on your Mac".

## 4. Feature modules (`PsycheFeatures`)

**Backend contract (2026-11-04).** Screens talk to `any PsycheBackend`, a composition of one protocol
per feature in `apps/ios/Sources/PsycheStore/Backend/` (`HomeBackend`, `ChatBackend`,
`LibraryBackend`, `MemoryBackend`, `SearchBackend`, `AgentBackend`, `SettingsBackend`) plus
`LiveUpdates` (one `LiveEvent` stream: chat events carry content, everything else is a refetch hint).
`FixtureBackend` (an actor, `PsycheStore/Fixtures/`) behaves like a small Gateway so the app runs and
demos with no Mac; `GatewayBackend` (I2, `PsycheClient`) is the real one. Each feature owns its
protocol file and its `FixtureBackend+<Feature>.swift` (with its own state struct), so parallel
sessions never edit the same file.

Every feature follows one shape, so sessions can build them in parallel without inventing a
pattern each:

```swift
@MainActor @Observable final class HomeModel {
    private(set) var phase: LoadPhase<HomeSnapshot> = .idle   // idle / loading / loaded / failed
    func load() async            // fetch from Gateway, write snapshot to PsycheStore
    func resync() async          // called by Resync when stateVersion moved
    func observe() async         // for await over EventRouter, patches `phase`
}
struct HomeView: View { @State var model: HomeModel; … }   // .task { await model.load(); await model.observe() }
```

- **Loading:** cached snapshot first (instant paint), then live data. Skeletons match the loaded
  layout (desktop polish rule). Failures say "Try again".
- **Navigation:** one `NavigationStack` per tab with a typed `Route` enum. `Route(appPath:)` maps
  the desktop's routes (`/chat/<id>`, `/library/<section>`, `/goals/<id>`, `/overview/run/<id>`…)
  so a notification's `route` opens the same thing on the phone. Unknown routes open Home.
- **Deep links:** `psyche://<route>` only. Never a Gateway URL or key in a link (CVE-2026-25253
  rule); pairing is the in-app scanner only.

### 4.1 Home (landing)

Same sections as the desktop Home, in phone order; empty sections aren't drawn:

1. **Ask {persona}** field (opens Chat with the composer focused)
2. **Needs you** (amber): approvals, questions, tasks waiting on input
3. **Running**: tasks in progress with "Step n of m" and a Live Activity toggle (M2)
4. **Today**: the brief as a bounded list with an end marker
5. **Coming up** / **To-do**: due items from memory (`memory.upcoming`), catch-up
6. **Keep in touch**: nudges
7. **Pinned**: up to 6 widgets (WebView host, A7), lazily loaded below the fold
8. **More** (quiet list): Inbox, Scheduled, Overview — pushed pages

### 4.2 Chat

- Thread list → thread. The main thread is pinned at the top; side chats below.
- Messages stream through `chat.delta`; the view coalesces deltas to one layout per frame.
- **Composer:** text, dictation (`SpeechAnalyzer`), attach (Photos picker, Files, camera),
  steer/cancel while running, queue indicator. Sends go through the `Outbox`, so airplane mode
  works (companion M1 acceptance 4).
- **Blocks:** see §5.

### 4.3 Approvals

- A card in the thread, a row on Home, and a **sheet** opened from a notification or Home.
- Full arguments, never truncated (security §3.7). 400 ms arming on Allow (Gateway-enforced; the
  button also shows it).
- `deviceOnly` kinds need the Secure Enclave presence key (companion §5); without one the card
  says "Answer on your Mac".
- Away from home: buttons disabled with "Reconnect to answer".

### 4.4 Library

Sections as on the desktop (documents, images, artifacts, downloads). Grid of first-page
thumbnails for documents; Quick Look for files the phone can open natively; the WebView host for
artifacts. Upload from the share sheet and the + button.

### 4.5 Memory

People and work (memory-everything-2026): search field, **To-do** with due dates and "Handed in",
projects and courses with progress, people. Person and project pages are read-mostly on the phone;
facts can be confirmed or retracted, bigger edits say "Edit on your Mac" in M1.

### 4.6 Search (tab role)

`search.query` with results grouped like ⌘K (chats, files, people, to-dos, actions). Also hosts
**Ask your life** (`memory.life.answer`). Recent searches kept on the device only.

### 4.7 Settings (from the avatar menu)

This phone (name, scopes, revoke-myself), Notifications (M0/M2 push), Live Activities, lock-screen
title option, Face ID presence key, Gateway (endpoint, identity fingerprint, re-pair), Appearance
(follows system), About. Everything else: "Change this on your Mac".

### 4.8 Agent sheet

Tapping the persona avatar in any nav bar opens the agent sheet as on the desktop:
Activity (Needs you / Now / Next up / Recent), Approvals, Upcoming, Soul (read-only on the phone).

## 5. Chat blocks (`PsycheBlocks`)

| Block `type` | M1 rendering |
| --- | --- |
| `text` | Native. Markdown → `AttributedString` for inline; headings, lists, quotes, code fences (mono, horizontal scroll) parsed by a small block parser |
| `approval`, `question` | Native cards (§4.3) |
| `task`, `plan`, `checklist` | Native progress rows |
| `receipt`, `sources`, `context` | Native **evidence line** (the desktop signature: one muted line, mono ids and times, " · ") |
| `file`, `artifact` | Native file row → Quick Look / WebView host |
| `tool_call` | Native collapsed row ("Searched mail · 4 results"); expands to arguments |
| `app_link`, `related_threads`, `learned`, `taught`, `wrap_up`, `compaction`, `specialist_result`, `automation_workflow` | Native simple rows |
| `ui` (generative UI) | **WebView host** |
| Unknown future type | Native "Open on your Mac" row, never a crash |

**WebView host (A7):** one `WKWebView` process pool, created lazily on first `ui` block. It loads
`blocks.html` + a JS bundle built from `packages/ui`'s block renderer and copied into the app at
build time (`pnpm --filter @psyche/ui build:ios-blocks`). No network access from the web view
(content rules block every non-`psyche-blocks://` load); data and actions cross a
`WKScriptMessageHandler` bridge that only accepts `widgets.act` / `widgets.image` with the block's
own ids. Theme tokens are passed in so the web content matches light/dark and the ink accent.

## 6. Testing and CI

| Layer | How |
| --- | --- |
| `PsycheWire`, `PsycheClient`, `PsycheStore` | Swift Testing on a macOS runner. Fake-Gateway unit tests, plus an integration suite against the real Gateway with the scripted model (the walking skeleton already runs in CI): pair, identity mismatch refusal, resync after a missed event, outbox exactly-once. |
| Schema drift | `protocol:check` also runs `swift build` for `packages/protocol-swift` (companion M1 acceptance 6). |
| Views | SwiftUI previews against fixture snapshots in `PsycheFeatures/Fixtures` (general mix, not school-first). Simulator screenshot tests come later; no third-party snapshot library in M1. |
| App | `xcodegen && xcodebuild -scheme Psyche -destination 'platform=iOS Simulator'` build-only in CI (macOS runner, path-filtered to `apps/ios/**` and `packages/protocol-swift/**`). |
| Real phone | Manual checklist from companion §6 M1, plus the Tailscale on-demand spike. |

## 7. Owner setup (the one-time cost)

1. Copy `apps/ios/Config/Owner.example.xcconfig` to `Owner.xcconfig`; set `PSYCHE_TEAM_ID` and
   `PSYCHE_BUNDLE_ID` (gitignored).
2. `brew install xcodegen && pnpm ios:project` (runs XcodeGen), open `apps/ios/Psyche.xcodeproj`,
   run on the phone.
3. On the Mac: Settings → Devices → **Add phone**, scan the QR code in the app, approve.
4. M2 only: APNs `.p8` as in companion §3.3.

M1 works with a free Apple ID (7-day signing) for trying it out; push and TestFlight need the
paid account.

## 8. Owner decisions (2026-11-04)

1. **Landing tab:** Home (A9).
2. **Minimum iOS:** 26 (A2). This also answers companion §7 Q5.
3. **Generative UI:** the sandboxed WebView (A7).
4. **Project:** XcodeGen (A10).
5. **Devices:** iPhone and iPad from one target. On iPad the tab bar adapts to a sidebar (`TabView` with `.sidebarAdaptable`) and Chat is a split view (thread list + thread).
6. **Android:** later, as a native Kotlin app with types generated from the same JSON Schema (companion M3). No cross-platform framework; the PWA covers Android until then.

## 9. Look

The phone keeps the desktop's world (redesign-2026, the ink direction): **paper and ink, amber
for "needs you", a moth for the persona.** iOS 26 supplies Liquid Glass for the chrome; Psyche
supplies the paper underneath. The glass is the system's, so it stays neutral and the ink stays
on content.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| Paper | `#FAF9F8` (gray-2) | `#111110` (gray-1) | Screen background |
| Sheet | `#FFFFFF` | `#191918` (gray-2) | Cards, grouped rows |
| Rule | `#DAD8D6` (gray-6) | `#3B3A38` (gray-6) | Hairlines between rows, ledger lines |
| Text | `#21201F` (gray-12) | `#EFEEEC` (gray-12) | Body |
| Muted | `#6A6966` (gray-11) | `#B6B4B1` (gray-11) | Evidence lines, timestamps |
| Ink | `#2C5AA0` (accent-9) | `#3766AD` fill, `#9AB9E9` text (accent-9/11) | **One** filled control per screen (Send, Allow), links, selection |
| Amber | `#FFC53D` dot / `#AB6400` text | `#FFC53D` / `#FFCA16` | Needs-you dots, the approval hairline |
| Green / Red | grass-11 / tomato-11 | grass-11 / tomato-11 | Done / failed status dots only |

- **Type:** page titles in **New York** (the system serif, `.fontDesign(.serif)`, weight ≤ 600),
  everything else SF Pro; ids, times and amounts in SF Mono. Dynamic Type everywhere.
- **Rules carried over:** one accent fill per screen; status is dot + words, never a colored pill;
  no sparkles or gradients for AI; no sparklines on stats; amber means needs-you and nothing else.
- **Signature details:** the evidence line under agent actions; the approval card's amber
  hairline (not a left stripe); Library files as paper sheets; the moth avatar (flat, no
  breathing) in nav bars, 28 pt.
- **Motion:** system springs only; streaming text fades in by line, not by character; respect
  Reduce Motion.
- **Haptics:** `.success` on an answered approval, `.warning` when one arrives while open, none
  for streaming.

Mockup sources are in [ios-app-2026/](ios-app-2026/) (`*.dc.html`, reference only). Mockups (Home, Chat, the approval sheet, Search, Memory, pairing, lock screen with a Live
Activity, and Home in dark while away from home):
https://claude.ai/artifact/VTyMAJ8bLhmk7W6DXnyp55 (private to the owner until shared).

## 10. Build order (M1)

Work packages sized for one session each, at most five running at once (ops rules). Arrows are
hard dependencies; everything else can run in parallel.

| # | Package | Depends on | Done when |
| --- | --- | --- | --- |
| I0 | Extract `packages/protocol-swift` (PsycheProtocol + PsycheWire); `gen.ts` writes there; mac helper switches to the path dependency; `protocol:check` builds it | — | Mac helper tests green on the new package |
| I1 | `psyche-pair:v1` link + single-use 10-minute setup token + QR in Settings → Devices → Add phone (the pairing-link slice of remote-gateway R2). The identity key and key-bound connect already shipped in R1 (#1188) | — | Desktop shows the link and QR; a token older than 10 minutes or used twice is refused |
| I2 | `PsycheClient` + `PsycheStore`: connection, pairing, identity pin, states (§3.2), resync, outbox | I0, I1 | Integration suite against the real Gateway green on macOS CI |
| I3 | `apps/ios` skeleton: XcodeGen project, five targets, `PsycheDesign` tokens and components, tab shell, Pairing screens | I0 | App builds in CI; pairs with a dev Gateway on the LAN |
| I4 | Chat (thread list, streaming, composer, dictation, native blocks) | I2, I3 | Companion M1 acceptance 3 and 4 |
| I5 | Home + approvals + questions + agent sheet | I2, I3 | Approve on the phone, card disappears on the Mac |
| I6 | Library + share extension | I2, I3 | Companion M1 acceptance 5 |
| I7 | Memory + Search tab | I2, I3 | To-do, Work, People, Ask your life |
| I8 | WebView block host + `build:ios-blocks` | I4 | A `ui` block renders offline with theme tokens |
| S1 | Spike: Tailscale on demand from a notification action (companion §7 Q6) | — | Result recorded in the companion doc |

M0 (PWA + Web Push, companion §6) doesn't touch any of this and can run beside I0–I3.
