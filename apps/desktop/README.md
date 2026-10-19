# @psyche/desktop

**Owner:** S11 (`prompts/s11-desktop-web-shell.md`). Features A6, A7, E10, I1, I5, I6, I11, K6, D5, O10 (desktop relay), Q1 (composer UI) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md). Design: [architecture §5, §8](../../docs/02-architecture.md), [UI design](../../docs/06-ui-design.md), [security §6, §10, §12](../../docs/05-security-and-permissions.md), [spike 01](../../docs/spikes/spike-01-cdp-bridge.md).

Electron 44 shell (`Psyche.app`). It renders the shared React shell from `@psyche/web/shell`, holds the Gateway connection and the device key in the main process, hosts the agent's embedded browser and its CDP bridge, runs terminal PTYs the Gateway chooses, relays notifications, and keeps a menu-bar item so work continues after the window closes. It decides nothing: approvals are rendered and answered through the Gateway.

## Run

```sh
pnpm --filter @psyche/desktop start      # electron-forge start (Vite dev server + Electron; spawns psyched from apps/gateway)
pnpm --filter @psyche/desktop test       # vitest: pure logic, bridge client against the mock Gateway (no Electron)
pnpm --filter @psyche/desktop typecheck
pnpm --filter @psyche/desktop package    # unsigned build in out/ (also leaves .vite/ for the e2e tests)
pnpm --filter @psyche/desktop e2e        # Playwright-for-Electron smoke tests (run `package` first)
```

Environment (all optional):

| Variable | Effect |
| --- | --- |
| `PSYCHE_HOME` | Gateway home (default `~/.psyche`): handshake secret, bridge socket, quarantine, browser profiles |
| `PSYCHE_GATEWAY_ORIGIN` | Gateway to connect to (default `http://127.0.0.1:7979`). Never taken from a deep link or the renderer |
| `PSYCHE_GATEWAY_MODE` | `dev` (spawn `apps/gateway`), `launchd` (packaged default), `external` (never start anything) |
| `PSYCHE_BROWSER_BRIDGE_SOCKET` | Bridge socket path (default `$PSYCHE_HOME/run/browser-bridge.sock`; macOS limit 104 bytes) |
| `PSYCHE_USER_DATA`, `PSYCHE_DISABLE_GLOBAL_SHORTCUTS=1` | Tests only; ignored by packaged builds |
| `PSYCHE_SIGN_IDENTITY`, `APPLE_*` | Signing and notarization, see [docs/signing.md](docs/signing.md) |

## Window and pane architecture

```
BaseWindow (main)
├─ WebContentsView: app renderer (app://psyche/chat, sandboxed, preload = typed bridge)
└─ WebContentsView × N: agent tabs (persist:agent-<profile>, debugger attached)  ← laid over the browser pane's rect
BaseWindow (pop-out)      app renderer at /chat/:threadId/pane/:paneId, or a browser tab moved out
BaseWindow (quick entry)  frameless, app renderer at /quick, ⌥Space (⌃⌥Space fallback)
Tray                      status, usage placeholder, needs-you, Gateway row, Quit vs Quit entirely
```

- **Shell** (`apps/web/src/shell`, shared with the web client): rail, thread list, chat, composer, panes, palette, shortcut sheet. The pane layout is a pure reducer per thread (`shell/layout`): tab strips, two side by side at ≥ 1440 px, resize clamped to 480/360 px, pop-out, ⌘\ closes the focused pane and focus returns to the opener. Layouts persist per thread in `localStorage` on the `app://psyche` origin.
- **view.\*** (agent pane control): the Gateway forwards `view.command` events; the shell applies them to the layout and reports the result with `view.report` (protocol PR #14).
- **Browser pane**: the renderer reports the pane's rectangle (`setViewport`); main places the active tab's `WebContentsView` there and hides the others (`setVisible(false)`; throttling is off, so hidden agents keep working). Overlays (palette, dialogs) hide the native view while open.
- **Keyboard map** (`shell/keyboard.ts`) is data shared by the key handler, palette and shortcut sheet; the app menu keeps Edit roles and maps ⌘W to "close thread view or pop-out".

## Main process modules

| Path | What |
| --- | --- |
| `src/main.ts` | Wiring, IPC handlers (sender frame and payload checked on every call), app:// protocol, permissions, deep links |
| `src/preload.ts` / `src/renderer/bridge.ts` | `window.psyche` typed bridge → `ShellPlatform`. Invoke results are `{ok, value} \| {ok:false, error}` so error codes survive IPC |
| `src/gateway-client.ts` | `GatewayConnection` from `@psyche/web/client` with the device key, handshake secret and loopback origin |
| `src/main/supervisor.ts` | Gateway lifecycle: dev child, LaunchAgent `com.psyche.gateway`, or external |
| `src/main/browser/*` | `BrowserHost` (tabs, partitions, popups, downloads, PDF interception, highlight, pop-out), `CdpPolicy`, `TakeControl`, partitions, quarantine |
| `src/main/bridge/*` | `BridgeClient`: the CDP bridge to the Gateway |
| `src/main/terminal.ts` | `TerminalHost`: node-pty sessions for the target the Gateway returns |
| `src/main/{windows,tray,menu,updater}.ts` | Windows, menu-bar item, app menu, update placeholder |
| `src/lib/*` | Pure: IPC validators, deep links, app:// paths, notification relay, device key |

## CDP bridge (desktop ↔ Gateway)

The Gateway listens on `$PSYCHE_HOME/run/browser-bridge.sock` (0600). The desktop connects (only to a socket owned by its uid with no group/other bits), sends `bridge.hello {protocolVersion, handshakeSecret, desktopVersion}`, then serves the Gateway's `bridge.*` requests and emits `bridge.*` events with a per-connection `seq`. NDJSON, 16 MiB frame cap (spike 01: raw AX trees exceed 1 MiB). It reconnects with backoff and never logs frame contents.

Defense in depth below the Gateway's `BrowserDriver` (spike 01 amendments):

- **Allowlist** (`cdp-policy.ts`): Accessibility, DOM read/focus, DOMSnapshot, Page navigation/screenshots/screencast, Input, Overlay highlight. `Runtime.evaluate`/`callFunctionOn` only inside isolated worlds created over the bridge (main-world script is refused); cookies, Storage, Target, Browser, Debugger, Fetch, `Page.setDownloadBehavior`, `DOM.setFileInputFiles` and non-http(s) navigation are refused with `method_not_allowed`.
- **Take control** (`take-control.ts`): keyboard via `before-input-event` (CDP never fires it); mouse via `mouseDown`/`mouseWheel` only while no agent `Input.*` is in flight; release after 1.5 s idle or on Return control. Agent `Input.*` gets `user_in_control` (retryable) meanwhile.
- **Tabs** run with `sandbox`, `contextIsolation`, no preload and `backgroundThrottling: false`; popups become agent tabs that keep `window.opener`; permissions are denied; downloads and inline PDFs go to `$PSYCHE_HOME/library/quarantine/` with the quarantine xattr.
- **Profiles**: logged-in = `persist:agent-<name>`, symlinked to `$PSYCHE_HOME/browser/profiles/<name>`; clean = an in-memory partition per task. Cookies are encrypted by the `EnableCookieEncryption` fuse.

## Security settings

- Renderer: `sandbox`, `contextIsolation`, no Node, no `<webview>`, `app://psyche` origin with CSP `default-src 'self'; script-src 'self'; connect-src 'self'` (it talks to the Gateway only through main). Popups denied; navigation away from the app blocked. Only app renderers may use the microphone (audio only).
- Fuses (`forge.config.ts`): RunAsNode, NODE_OPTIONS, `--inspect` and `GrantFileProtocolExtraPrivileges` off; ASAR integrity, OnlyLoadAppFromAsar and cookie encryption on. Unsigned unless `PSYCHE_SIGN_IDENTITY` is set ([docs/signing.md](docs/signing.md)).
- Deep links (`psyche://`) only navigate to known routes; they can never carry a Gateway address, a token or an approval answer.
- Notifications: the mac helper delivers OS notifications with actions when it is online; the Electron fallback never carries Approve buttons.
- Terminals spawn exactly the argv the Gateway returns, with TERM/LANG/PATH plus the Gateway's env; there is no host-shell fallback.
- No telemetry, no crash reporter (ADR-017).

## LaunchAgent handoff (A7)

Packaged builds install `~/Library/LaunchAgents/com.psyche.gateway.plist` (S22 owns the template in `deploy/launchd/`; the app prefers a bundled copy at `Contents/Resources/launchd/` and otherwise writes the same keys: `KeepAlive`, `RunAtLoad`, `PSYCHE_HOME`, logs under `$PSYCHE_HOME/logs`), then `launchctl bootstrap gui/<uid>` and `kickstart`. A Gateway that already answers `/healthz` is attached to, never started twice. Closing the window or "Quit Psyche" leaves the Gateway running; "Quit Psyche entirely" boots the agent out. Bundling `psyched` into `Contents/Resources/psyched/` is the release pipeline's job (S22/C2).

## Stubbed

- Methods the protocol lacks (requested): `terminal.open`, `voice.*` (S17), `commands.list`, `threads.update` (mode/model), `library.upload`. The shell treats `unknown_method` as "unavailable" and says so.
- The shell's components are structural stand-ins with S12's prop shapes; Files, Editor, Diff, Artifact and Subagent panes show placeholders until `@psyche/viewers` (S13).
- Device key is a 0600 JSON file in `userData` (S06 moves it to the keychain).
- Update feed is a placeholder until the signed release manifest check exists (security §11). DMG maker deferred to the release pipeline.
- Real HID input for Take control, cross-origin iframe snapshots (`Target.setAutoAttach` is denied for now), VM display pane (M2).
