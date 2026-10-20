# @psyche/browser

**Owner:** S08 (`prompts/s08-browser.md`). **Features:** I2–I4, I7–I10, I12 (except the element picker) and I15 ([docs/03-feature-spec.md](../../docs/03-feature-spec.md)).

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
| `src/devpreview/` | `DevServerRegistry`, the gate that says which loopback servers a task may preview (security §3.10); `systemLoopbackProbes`, the OS probes behind the broker's localhost rule |
| `src/recording/` | `FileRecordingSink` (frames, snapshots and the event log), `RecordingStore` (reads them back for `browser.recordings.*`) |
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

All page-derived output is `provenance: "untrusted"`, and credential-like URL parameters (`code`, `token`, `sig`, …) are masked in tool output. The spec class is the minimum. `describeCall` escalates per element:

- A form submit is `write` (`browser_submit`); a GET form is `read`. This covers a submit button, Enter in a form field and `type {submit: true}`.
- A button outside a form is `write` unless its name only changes the view (show, more, next, close, …).
- "Accept all", agree and authorize, delete, cancel and sign-up are `destructive`.
- Buy, pay, transfer, checkout, place-order and checkout-path form actions are `financial` (`purchase`).
- A write on an origin that is read-only in the task asks through the broker as a new target.

Every click by ref is hit-tested first (`conflict {reason: "obscured"}` when another element or a frame covers the point).

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
| `browser.dev_preview` | `url` | read (`new_origin`) | opens the owner's own dev server in the task's dev-preview session (I12, below) |
| `browser.console` / `network` | `tabId` | read | dev-preview tabs only (I12) |

**Page echoes** (S23 design-18): when the vault is wired, every tool output and error is checked with `containsSecret` (the Gateway derives it from `CredentialBroker.redact`). A page that reflects a vault value in its text, title, a dialog or its URL gets `policy_denied {reason: "secret_echo"}` with nothing from the page; navigating away ends it. The driver's snapshots and text are masked with the same `redact`, and recording summaries too.

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
- Top-level document requests are paused with a narrow `Fetch.enable` (Document, request stage) and continued unmodified or failed, so a blocked origin never sees the request.
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

## Partitions: logged out by default (I15)

Security §6: each task chooses `logged-in` or `logged-out` explicitly, with a persistent indicator, and the choice is never silently remembered. `src/origin/partition.ts`:

- A session's `partition` is `profile` (the owner's sign-ins), `clean` (an ephemeral partition, "browse without my sign-ins") or `auto`, the default.
- In `auto`, a tab opens in the profile only when its first origin matches one of the task's `signedInOrigins` patterns (`https://github.com`, `https://*.google.com`); every other tab, and every blank tab, is `clean`. Popups inherit the opener's partition, so an OAuth window stays with its flow.
- The bridge driver sends the choice as `bridge.tab.open {profile: "logged-in" | "clean"}`, which the pane shows; the Playwright driver keeps one ephemeral context per session beside the persistent profile, created on first use, so a logged-out task never opens the profile.
- `listTabs` and `browser.tabs` report `partition` per tab; the driver emits `tab_partition {tabId, partition, reason, label}` for Activity.
- The fixture site has a `user` cookie set by `/submit/login` and read by `a/account` (`Signed in as ada` / `Not signed in`), with one cookie jar per partition in the mock, so the conformance suite proves the isolation on both drivers.

The Gateway reads `PSYCHE_BROWSER_PARTITION` and `PSYCHE_BROWSER_SIGNED_IN_ORIGINS` until Settings → Browser exists; the desktop is asked to key `clean` partitions by task.

## Recording and replay (I10)

Opt-in per task (`PSYCHE_BROWSER_RECORD=1`), under `library/recordings/<id>/` where the id is the task id or `thread:<id>`. A recording is:

- JPEG frames from `Page.startScreencast` (`000001.jpg`, …), at most one per tab per 250 ms;
- one text file per snapshot the model read (`s000001.txt`, …);
- `index.json`: `{version: 2, id, taskId, threadId, startedAt, endedAt?, frames[], events[]}`.

The event log is what Activity lists and scrubs: `tab` (opened, with its partition), `navigation` (every commit), `snapshot`, `action` (navigate, back, forward, reload, click, double_click, right_click, hover, type, press, select, scroll, scroll_to, drag, upload, download, read_text, screenshot, dialog), `fill`, `download` (landed in quarantine), `blocked`, `control` (Take control) and `dialog`. Each event has a one-line `summary` (`Clicked button "Sign in"`), the element's role and name, a `frameSeq` pointing at the latest frame, and for snapshots the file holding the text.

Redaction is at write time, in `FileRecordingSink`:

- the page controller never hands over a frame while a secure field is active, after a fill or on a blocked page, as for screenshots;
- URLs keep origin and path (query strings carry tokens);
- a credential fill records the credential id, the element and the origin, never a value;
- typed text and snapshot text go through `CredentialBroker.redact` when the vault is wired, and typed text is capped;
- upload paths are replaced by a file count.

`RecordingStore` serves the Gateway's `browser.recordings.list | get | frame | snapshot | delete`: a live recording from the sink's memory (`get {sinceSeq}` follows it), a finished one from disk. Finished recordings go to the Library through `LibraryWriter.importRecording` (`kind: recording`; `FsQuarantineWriter` keeps them in memory until the Library owner ships), and `prune` applies the 7-day retention at Gateway start. The Gateway publishes `browser.recording.updated` while a recording grows. The Activity UI itself is S12's.

## Dev preview (I12)

Loopback is not the web: `localhost:<port>` may be the owner's Vite app or a local service that trusts the machine. Security §3.10 allows the agent on a local server only when the owner's own setup names it, so:

- `DevServerRegistry` (`src/devpreview/gate.ts`) answers `check(url, {taskId})` from three sources: servers Psyche started this session (`started({port, cwd, name, taskId})`, which the sandbox / exec layer or the terminal pane calls; a server started for one task is that task's only), the project's launch config, and the owner's allowlist (`PSYCHE_DEV_PREVIEW_PORTS` until Settings → Browser exists). The host must be exactly `localhost`, `127.0.0.1`, `[::1]` or a `.localhost` name; a LAN address is never a dev server.
- `browser.dev_preview {url}` runs the gate, asks the broker once per task (`new_origin` with `devPreview: true`, the source and the folder on the card), and opens the URL in the task's **dev-preview session**: a second session, logged out (`clean`), whose policy is `devPreview: true` pinned to the approved ports (`loopbackPorts`), so a redirect or link to another local port is refused. `browser.console` and `browser.network` read that tab's console and requests (capped at 500 entries, kept for dev-preview sessions only); every other tool works on the tab as usual.
- Without a `DevPreviewGate` the tool refuses; the Gateway passes `ComposedBrowser.devServers`.
- The broker has the last word. Its localhost rule (`@psyche/permissions` `createLocalProjectVerifier`, S23 design-03) needs OS probes, which this package supplies as `systemLoopbackProbes({roots})`: the name is resolved by Psyche (`127.0.0.1.nip.io` is not loopback because it says so), the listening PID comes from `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` (two different PIDs on one port count as none), and `ps -o ppid=` walks up to a root PID registered with `devServers.started({port, pid})`. Fixed binaries with argument arrays; every failure reads as "no". The Gateway mounts the verifier as the part's `localProject`, so until a server is registered with its PID, the broker refuses every loopback target, including allowlisted or launch-config ports the owner started by hand.
- Psyche's own listeners are refused first, in the verifier and in the gate (`psyche_port`), even when the owner allowlists them: the ports registered on the Gateway's `ownPorts` (its configured and bound port, a real-Chrome CDP endpoint passed as `realChromeCdpEndpoint`) plus every port the Gateway process is listening on at check time (`listeningPorts(process.pid)`, which catches OAuth receivers on random ports). The Gateway's own PID is never accepted as a dev server's root.
- The element picker (⌘⇧S) is the pane's; its protocol is a follow-up for S11 / S12.

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
  - logged-out partitions kept apart from the profile (I15);
  - recording of navigations, snapshots and actions with fills redacted, and the store (`test/recording.test.ts`);
  - console and network on a dev-preview session pinned to its port (I12), plus the gate and the tool (`test/devpreview.test.ts`);
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
