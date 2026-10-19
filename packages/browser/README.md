# @psyche/browser

**Owner:** S08 (`prompts/s08-browser.md`). **Features:** I2–I4, I7–I9 and I15, plus the M1 parts of I10 and I12 ([docs/03-feature-spec.md](../../docs/03-feature-spec.md)).

This package is the agent-owned browser. It has:

- one `BrowserDriver` API with two drivers: CDP over the desktop bridge (the default, ADR-007) and Playwright;
- an accessibility snapshot builder with stable `ref_N` ids;
- a per-task origin policy that runs on every navigation hop;
- Take control;
- download quarantine;
- vault fills;
- opt-in screencast recording;
- the agent's `browser.*` tools.

The pane UI and the Electron `WebContentsView` host belong to S11.

## Layout

| Path | What |
| --- | --- |
| `src/origin/` | `canonicalizeUrl`, `OriginPolicy` (read-only / read-writable sets, hard rules), `LocalBlocklist` / `ChainedReputation` |
| `src/snapshot/` | `buildSnapshot` (CDP AX tree + DOMSnapshot → pruned text), `RefRegistry`, `extractText` |
| `src/cdp/` | `CdpTarget` and `PageController`, the shared page engine both drivers use |
| `src/bridge/` | `FrameConnection` (NDJSON), `BridgeServer` / `BridgeClient`, the CDP allowlist |
| `src/drivers/` | `DriverBase`, `CdpBridgeDriver`, `PlaywrightDriver` |
| `src/downloads/` | magic-byte `sniff`, `LibraryWriter`, `FsQuarantineWriter` |
| `src/recording/` | `FileRecordingSink` (frames plus a replay index) |
| `src/tools/` | `registerBrowserTools`, `classifyActivation`, `ApprovalGate` |
| `@psyche/browser/testing` | fixture site DSL, `FixtureServer`, `MockBrowser`, `MockDesktop` |
| `@psyche/browser/conformance` | `describeBrowserDriverConformance` (imports vitest) |

## Design in one paragraph

Both drivers run every page operation through `PageController` on top of a `CdpTarget`. For the bridge driver that target is `bridge.cdp.send`; for Playwright it is `context.newCDPSession(page)`. Refs, boxes, pruning, waits and action semantics are therefore identical by construction, which is what I2's "same tool tests pass on both drivers" asks for. Playwright still owns process, profile, popup, download and dialog lifecycle.

The driver enforces the hard rules and the task's origin set on every hop: the initial URL, each redirect (`Network.requestWillBeSent` with `redirectResponse`), page-initiated navigations and each committed URL. It never decides a permission. An origin outside the set raises `approval_required {kind: "new_origin", origin}`. The tool layer then asks the `PermissionBroker`, which applies taint, grants and mode. On approval it widens the policy and retries.

## Snapshot format

```
# http://site-a.localhost:4000/login "Sign in" refs=4 interactive=4
- heading "Sign in" [ref=ref_1] [level=1] @20,20 600x40
- form
  - textbox "Username" [ref=ref_2] value="ada" [focused] @20,70 300x30
  - textbox "Password" [ref=ref_3] [secure] value="•••" @20,110 300x30
  - checkbox "Remember me" [ref=ref_4] @20,150 300x30
  - button "Sign in" [ref=ref_5] @20,190 200x30
- link "Docs" [ref=ref_6] -> /docs @20,230 300x30 offscreen
```

- **What is kept:** interactive roles, landmarks and structure, headings and images. `<div onclick>` elements are named from their text and shown as `clickable`. `generic` and `none` nodes are collapsed, ignored nodes are walked through, and static text is clipped to 120 characters.
- **Boxes** are viewport-relative CSS pixels. DOMSnapshot bounds are device pixels, so they are divided by the DPR (spike 01).
- **Refs** are keyed by `backendDOMNodeId` per document, so the same element keeps its ref across snapshots.
  - The counter is monotonic for the tab, so a ref is never reused for a different element.
  - After a navigation, an old ref fails with `not_found {reason: "stale_ref"}`.
  - After Take control, every ref must be re-read (`conflict {reason: "stale_after_take_control"}`).
- **Limits** (all defaults are overridable):
  - `maxRefs` 400; `refs[]` lists interactive elements first.
  - `maxChars` 24,000 (about 6k tokens). When the tree exceeds it, static text lines are dropped first (`text_omitted=N`, use `read_text`), then the rest is paged (`page=1/3`).
  - `maxDepth` 40, a safety cap only. Spike 04 showed that a depth of 8 loses content.
  - `viewportOnly` drops off-screen subtrees.
- **Frames:**
  - Same-origin frames are fetched with `getFullAXTree({frameId})` and inlined.
  - Cross-origin frames render as `iframe "title" (content hidden: cross-origin <origin>)`, as security §6 requires.
- **Flags:**
  - `SPARSE` (and `sparse: true`) when the tree has little content or a canvas, embed or video covers a quarter of the viewport. This is the screenshot fallback.
  - `CAPTCHA` when a challenge frame or "I'm not a robot" control is present. The task pauses and hands the challenge to the owner; it is never attempted.
- **Secure fields:** password, one-time-code and `cc-*` fields show `•••` and are never descended into. `secureFieldActive` is set when one is focused or holds a value. While it is set, screenshots are refused and recording frames are dropped.

## Tool reference (`registerBrowserTools`)

All page-derived output is `provenance: "untrusted"`. The spec class is the minimum. `describeCall` escalates per element: a form submit is `write` (`browser_submit`, a GET form is `read`); "Accept all", agree and authorize, delete, cancel and sign-up are `destructive`; buy, pay, checkout, place-order and checkout-path form actions are `financial` (`purchase`).

| Tool | Params | Class | Notes |
| --- | --- | --- | --- |
| `browser.tabs` | — | none | the task's tabs |
| `browser.open_tab` | `url?` | read | new origins ask |
| `browser.close_tab` / `focus_tab` | `tabId` | none | |
| `browser.navigate` | `tabId, url` | read | http(s) only; every hop is checked |
| `browser.back` / `forward` / `reload` | `tabId` | read | |
| `browser.snapshot` | `tabId, page?, maxChars?, viewportOnly?` | read | text tree above |
| `browser.find` | `tabId, query` | read | all words must match; up to 20 refs |
| `browser.read_text` | `tabId, maxChars?` | read | from the AX tree, no page JS |
| `browser.screenshot` | `tabId` | read | for sparse trees; refused while a secure field is active |
| `browser.click` | `tabId, target: {ref} \| {x,y}, button?, double?` | read → escalated | |
| `browser.hover` | `tabId, target` | read | |
| `browser.type` | `tabId, ref, text, clear? (true), submit?` | read → write on submit | refuses secure fields, `{{cred:…}}` and Luhn-valid card numbers |
| `browser.press` | `tabId, keys, ref?` | read → write with Enter | `Enter`, `Shift+Tab`, `Meta+a`, … |
| `browser.select` | `tabId, ref, values[]` | read | native `<select>` only |
| `browser.scroll` / `scroll_to` | `tabId, direction, ref?, amount?` / `tabId, ref` | read | |
| `browser.drag` | `tabId, from, to` | write | |
| `browser.upload` | `tabId, ref, libraryItemIds[]` | write | paths come from the Library, never from the model |
| `browser.download` | `tabId, source: {ref} \| {url}` | write | lands in the Library quarantine with a receipt |
| `browser.wait` | `tabId, for, timeoutMs?` | none | load, text, ref, network_idle, timeout |
| `browser.dialog` | `tabId, accept, promptText?` | read → write when accepting a confirm | |
| `browser.fill_credential` | `tabId, ref, placeholder` | write (`credential_fill`) | see below |
| `browser.console` / `network` | `tabId` | read | dev-preview tasks only (I12) |

**Credential fill** (security §4.6) runs in this order:

1. Use the loop's approval for the call, or ask for a `credential_fill` bound to item, origin, ref, element and tab.
2. Call `CredentialBroker.resolve(placeholder, {origin}, approvalId, {executor: "browser"})`.
3. Check that the top-frame origin equals the bound origin, that the element is the approved ref and not in a cross-origin frame, and that the agent is in control.
4. Run `DOM.focus`, then type the value with `Input.insertText` inside `ResolvedSecret.use`.
5. Never read the value back.

## Bridge protocol

This is the wire spec v1 from `packages/protocol/src/bridge.ts`, with the spike 01 amendments.

**Connection and auth**
- The Gateway listens on `$PSYCHE_HOME/run/browser-bridge.sock`: mode 0600, in a 0700 directory, path at most 103 bytes.
- The desktop connects and sends `req bridge.hello {protocolVersion, handshakeSecret, desktopVersion}`.
  - The secret is compared in constant time.
  - Anything else first, a bad secret, or no hello within 5 s closes the socket.
- One desktop is connected at a time.

**Framing**
- NDJSON `req` / `res` / `event` frames, validated against the protocol `Frame` schema.
- The frame cap is **16 MiB** (`BRIDGE_MAX_FRAME_BYTES`, amendment 2), because raw AX trees reach 2 MB.

**Gateway → desktop calls**
- `bridge.tabs.list`, `bridge.tab.open`, `bridge.tab.close`, `bridge.attach`, `bridge.detach`.
- `bridge.cdp.send {tabId, method, params}`. Commands off the allowlist fail on the Gateway side before sending.

**Desktop → Gateway events**
- `bridge.cdp.event`
- `bridge.tab.created`, with `openerTabId` for popups, which then join the opener's session
- `bridge.tab.closed`
- `bridge.control.changed {tabId, state}`: Take control
- `bridge.download {state: "completed", quarantinePath}`, which goes to the Library import and a receipt

**CDP allowlist** (`CDP_ALLOWED_METHODS`, `checkCdpCommand`)
- This is the spike's list plus what the driver needs: back, forward and reload, `Page.stopLoading`, `Page.handleJavaScriptDialog`, `Page.screencastFrameAck` and `DOM.setFileInputFiles`.
- `Runtime.evaluate`, `Runtime.callFunctionOn` and `DOM.resolveNode` are allowed only against a bridge-created isolated world. They run two fixed helpers, a `<select>` setter and a download anchor; there is never any model-supplied script.
- Denied: cookies, `Storage.*`, `Target.*`, `Browser.*`, `Debugger.*`, `Fetch.*` and download-behaviour changes.
- The desktop enforces the same function per tab. `MockDesktop` shows how.

## Origin policy

- **Canonical form:**
  - lowercase, IDNA (punycode), trailing dot removed, default port stripped;
  - userinfo rejected (CVE-2025-47241);
  - whitespace and control characters rejected;
  - numeric IPv4 forms folded;
  - http and https only.
- **Patterns:** `https://example.com`, `https://*.example.com` (strict subdomains, never the bare domain) and `example.com` (https, port 443).
- **Hard rules,** applied in order, before the set:
  1. User deny rules, which ignore scheme and port.
  2. Blocked schemes: `about:`, `chrome:`, `file:`, `javascript:`, `data:`, `blob:`, `view-source:`, ….
  3. Loopback (`localhost`, `*.localhost`, 127/8, ::1, 0.0.0.0) is denied unless the task is a dev preview.
  4. Private networks (RFC 1918, link-local including 169.254.169.254, CGNAT, ULA, `.local`, single-label names) are denied unless `allowPrivateNetwork` is set.
  5. The reputation check: the local blocklist, then an optional remote check that is off by default and fails open unless `failClosed` is set.
- **Hops:**
  - The initial URL is checked before `Page.navigate`.
  - Every main-frame document request, redirects included, is checked in `Network.requestWillBeSent`. A request that is not allowed is stopped with `Page.stopLoading`.
  - Every committed URL is checked again; when it is not allowed, content is withheld from snapshots, text and screenshots.
  - Navigations the owner makes while holding the tab join the read-only set.
- **Access:**
  - `access()` is `read` or `write` from the set. A bare loopback dev server is `write` in dev preview.
  - Write classes still go through the broker. The set says where the agent may go, and the broker says what it may do there.

## Testing

- `pnpm --filter @psyche/browser test` runs the following without network or a browser:
  - unit tests;
  - origin edge cases;
  - page-controller smoke tests;
  - tool tests with the fake broker and vault;
  - the **conformance suite against the CDP driver over `MockDesktop`**.
- `PSYCHE_BROWSER_TESTS=1 pnpm --filter @psyche/browser test` also runs the same suite against **real headless Chromium** through the Playwright driver and `FixtureServer`. Chromium is found from `PSYCHE_CHROMIUM_PATH`, Google Chrome or Chromium; the suite is skipped when none is found.
- The fixture site serves `site-a.localhost`, `site-b.localhost` and `evil.localhost` on one loopback port. Nothing leaves the machine.
- The conformance suite covers:
  - tabs;
  - forms and stale refs;
  - select, submit and checkbox;
  - OAuth popup routing;
  - redirect hops;
  - page-initiated navigation to a blocked origin;
  - loopback denial;
  - downloads with sniffing;
  - iframes;
  - dialogs;
  - Take control refusal and re-snapshot;
  - sparse and CAPTCHA detection;
  - history and SPA navigation;
  - scrolling;
  - uploads;
  - card-number refusal;
  - vault fill and screenshot suppression;
  - the 22-page regression set, with every snapshot under the 300 ms budget.
- The unit tests also check a synthetic 5,000-node page against the same budget.

## Stubbed or pending

See [docs/status/s08.md](../../docs/status/s08.md):

- `BrowserDriverEx` methods are local until the `protocol:` PR lands.
- `LibraryWriter` is local; `FsQuarantineWriter` is the stand-in.
- OOPIF content stays hidden.
- The `browser_submit` binding has no field-value digest yet.
- Clearing typed fields after a failed submit is not implemented.
- I13 real-Chrome launcher, I14 Web Bot Auth and the I12 element picker are M2.
