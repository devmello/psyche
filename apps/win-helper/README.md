# Psyche Helper for Windows (`apps/win-helper`)

`psyche-helper.exe` is the Windows node: the counterpart of the Swift mac helper
(`apps/mac-helper`). It connects to the Gateway as `role: "node"`, `platform: "windows"`,
`deviceFamily: "win-helper"` over a named pipe, speaks the same NDJSON node protocol, and serves
Windows-backed capabilities under the mac helper's names and shapes, so Gateway code paths stay
the same. Apple-only groups (Notes, Messages, Things, Music, Shortcuts, Safari, AppleScript/JXA,
the Apple on-device model) are not offered. VM guests are the sandbox PC (`vm.*`, below).

Rust 2024, the official `windows` crate (0.62.2, pinned), Tokio.

## Build and run

```powershell
cd apps/win-helper
cargo build --release          # target\release\psyche-helper.exe
cargo test                     # unit + integration tests (fake Gateway on a real pipe)
cargo test -- --ignored        # live checks: real toast, COM activation, Recycle Bin
cargo clippy --all-targets
pnpm --filter @psyche/win-helper build   # same through turbo; copies the exe to dist\ (no-op off Windows)
```

```
psyche-helper                  stay connected and serve (reconnects; one per PSYCHE_HOME)
psyche-helper --handshake-only [--challenge-only] [--timeout <s>]   exit 0 done, 2 no pipe, 3 denied, 4 timeout, 1 other
psyche-helper --manifest       print the capability manifest
psyche-helper --print-identity {deviceId, presenceKeyId?, presenceKeyKind?, presenceKeyAlgorithm?, presenceError?}; never prompts
psyche-helper --build-info     {"presenceFileFallback": false}
```

Environment: `PSYCHE_HOME` (default `%USERPROFILE%\.psyche`), `PSYCHE_NODE_SOCKET` (a
`\\.\pipe\…` override), `PSYCHE_HELPER_NO_REGISTER=1` (do not write the toast registration).
COM starts the helper with `-ToastActivated` / `-Embedding`; both just mean "serve".

## Wire contract (what the Gateway side must match)

- **Pipe.** Read `$PSYCHE_HOME\run\node-socket` (one line, the pipe path) before every connect
  attempt; fall back to `\\.\pipe\psyche-node-<h>`, `<h>` = first 16 hex chars of SHA-256 over the
  UTF-8 absolute `$PSYCHE_HOME` (`path.resolve(home)`, no trailing separator). Before sending
  anything the helper checks that the pipe's server process runs as the same Windows user (token
  user SID) and refuses otherwise; it connects with `SECURITY_IDENTIFICATION` QoS.
- **Handshake.** `req connect {protocolVersion: {min: 1, max: 1}, deviceId, publicKey, role: "node",
  platform: "windows", deviceFamily: "win-helper", name: "Psyche (Helper)", capabilities,
  handshakeSecret?}` → challenge → `req connect.verify {nonce, signature}` with the v1 payload
  `psyche-connect-v1\n<nonce>\nwindows\nwin-helper\n<version>\n<serverOrigin>`. The secret is
  `$PSYCHE_HOME\run\handshake.secret` (trimmed), re-read on every reconnect.
- **Identity.** Ed25519, byte-identical to `PsycheWire.DeviceIdentity`: `publicKey` = base64url
  raw 32 bytes, `deviceId` = `dev_` + first 22 base64url chars of SHA-256(public key). The seed is
  stored DPAPI-sealed (CurrentUser, fixed entropy) in `$PSYCHE_HOME\helper\device.key.dpapi`.
- **Invoke.** `node.invoke` → `res {accepted: true}` → `node.event`* → one `node.result` (with a
  receipt for side effects, a `failed` receipt for refused side effects); `node.cancel
  {invocationId}`; frames ≤ 1 MiB (an oversized result becomes `internal/result_too_large`).
  Reconnect backoff 0.5 s doubling to 30 s; 5 s while pairing is pending; 5 min after a denial.
- **Presence key.** `presence.public_key` → `{publicKey, keyId, kind: "windows_hello", algorithm:
  "rsa-2048-pkcs1-sha256"}`: base64url DER `SubjectPublicKeyInfo` of a TPM-backed Hello key
  (`KeyCredentialManager`, name `com.psyche.helper.presence`), `keyId` = hex SHA-256 of the DER.
  Signatures (`presence.confirm`, `notify.response.presence.signature`) are RSASSA-PKCS1-v1_5
  SHA-256 over `psyche.presence.helper.v1|<challenge>`, base64url.
- **Toasts (installer contract).** AppUserModelID `com.psyche.helper`; COM activator CLSID
  `{B1DFC43D-98FC-44C2-9C1B-F3C21D0871C6}` with `HKCU\Software\Classes\CLSID\{…}\LocalServer32` =
  `"<path>\psyche-helper.exe" -ToastActivated`; `HKCU\Software\Classes\AppUserModelId\com.psyche.helper`
  (`DisplayName`, `CustomActivator`); Start-menu shortcut
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Psyche Helper.lnk` with `System.AppUserModel.ID`
  and `System.AppUserModel.ToastActivatorCLSID`. The helper writes the registry entries on every
  serve start (HKCU only) and creates the shortcut only when missing.

## Capabilities

**App identity** (the Mac's bundle id). Every capability names an app by one id, so the Gateway's
approvals and per-app tiers match across them: the **lowercase executable file name** of the
app's process (`notepad.exe`, `calculatorapp.exe`, `chrome.exe`). Windows that
`ApplicationFrameHost.exe` draws for packaged (UWP) apps belong to the hosted app, never the frame
host. One function computes it (`crates/win-computer/src/app_id.rs`, used by `apps.*`,
`computer.*`, `screen.context`, `teach.*`, `chrome.*` and `dictation.*`); AppUserModelIDs, package
family names and full paths are extra fields (`aumid`, `packageFamilyName`, `exe`), never the id.

| Group | Capabilities | Windows backing / differences from the mac helper |
|---|---|---|
| `permissions` | `status`, `request`, `open_settings` | Mac permission names mapped to Windows (privacy consent store, toast setting, UIPI), plus `camera`; rows add `applicable` and (UI Automation) `details`. No consent prompts exist for desktop apps: `request` opens the `ms-settings:` page when something is off. Statuses add `notApplicable`. `bundle.signing` is `authenticode`/`unsigned`/`untrusted`. |
| `apps` | `list`, `open`, `focus` | Alt-Tab windows; `bundleId` is the app id (above), plus `exe`, `aumid`, `packageFamilyName`, `windows`. `open` takes the app id (a running app's own AUMID / executable, a Start-menu app whose shortcut or package manifest runs that executable, App Paths, `PATH`) and still AUMIDs, Start-menu names and full paths, launching only executables under Program Files / Windows / per-user Programs; `focus` takes the app id, a full path, an AUMID, a package family name or the app name, uses the AttachThreadInput foreground workaround and reports whether it worked. `pid` may be `null` when the shell hands off to a running instance. |
| `notify` | `show`, `withdraw`, `authorization_status`, `request_authorization`, `subscribe` | Toasts with buttons, inline reply, `reminder` scenario for time-sensitive cards, silent/no-popup passive toasts; Approve with `requireBiometry` runs Windows Hello and signs `presenceChallenge`. Status is `authorized`/`denied` (no "not determined" on Windows), `badge` `notSupported`, `timeSensitive` `unknown`. |
| `keychain` | `status`, `set`, `delete`, `store`, `retrieve`, `delete_item`; `vault.unlock` | Credential Manager (`Psyche/vault/<account>`, `Psyche/item/<name>`, local machine only). Values that need Touch ID on the Mac are sealed to Windows Hello (deterministic Hello signature → HKDF → X25519 wrap key; items sealed with X25519 + AES-256-GCM bound to their target): storing needs no prompt after a one-time setup prompt, reading shows Hello. The Hello dialog cannot show `reason`. A Hello reset makes sealed values unrecoverable (`hello_key_invalidated`). `status` adds `store` and `sealingKey`. |
| `presence` | `public_key`, `confirm` | Windows Hello (see above). Creating the key shows one Hello prompt (the Mac's does not); the Hello dialog cannot name the approval. |
| `files` | `files.trash`, `files.move`, `files.rename`, `files.recent`, `finder.list`, `finder.reveal` | Recycle Bin through `IFileOperation` (refuses anything that would be destroyed instead); `added` is the creation time; `folder: "shell:recent"` lists Recent items inside granted folders; Explorer reveal. |
| `ocr` | `recognize` | `Windows.Media.Ocr` + `Windows.Data.Pdf`. No PDF text layer on Windows, so every page in range is recognised; confidence is `1`/`0` (Windows reports none). |
| `computer` | `ax_tree`, `ax_value`, `click`, `double_click`, `right_click`, `press`, `set_value`, `select`, `type`, `key`, `scroll`, `drag`, `menu`, `end_session`, `screenshot`, `screenshot_pick` | `crates/win-computer` (UI Automation, `SendInput`, Windows Graphics Capture), adapted in `src/computer/`. `app` / `bundleId` are the app id (above); `app` params also take the app name or full executable path. Results add `method: "sendinput"`, `scaleFactor`, `truncated: "timeout"`. Esc fails the in-flight call with `cancelled/user_stopped` and ends the session (no other wire event, as on the Mac). |
| `screen` | `screen.context` | Same crate: the foreground window or a region, app (`context.bundleId` is the app id), title, selected text, browser URL; Windows extras under `win`. |
| `speech` | `transcribe_stream`, `transcribe_file`, `audio_push`, `stop`, `status` | `crates/win-dictation`. On-device SAPI by default for every source (`defaultEngine: "sapi"`); Windows online dictation only with `engine: "windowsSpeech"` (microphone only). Engines report `sapi` / `windowsSpeech`. No text-to-speech. |
| `dictation` | `target`, `insert`, `watch` | Same crate: `WH_KEYBOARD_LL` hold-to-talk, UIA / typed / paste insertion; `target.bundleId` is the app id (above) of the focused element's process, plus `exe` and `packageFamilyName`; refuses password fields and elevated targets (`forbidden/elevated_target`). |
| `teach` | `start`, `stop`, `cancel`, `status` | Low-level mouse / keyboard hooks (injected input ignored), targets through UI Automation (`ElementFromPoint`, focus), apps named by the app id (above). Chords use `ctrl` / `opt` / `shift` / `win`. Dropping the `teach.start` invocation cancels the recording. |
| `chrome` | `tabs`, `current_tab` | Chrome, Edge and Brave through UI Automation (tab strip + address bar); tabs add `browser`, `active`. Only active tabs carry a `url` (`""` for background tabs). |
| `outlook` | `mail.mailboxes`, `search`, `read`, `selected`, `draft`, `reply_draft`, `forward_draft`, `send_draft`, `send`, `move`, `set_flags`, `save_attachments`; `calendar.list_calendars`, `list_events`, `create_event`, `update_event`, `delete_event`, `free_busy`, `watch`; `contacts.list`, `read`, `search`, `create`, `update`; `reminders.list_lists`, `list`, `create`, `update`, `complete`, `delete`, `set_flagged` | Classic Outlook over late-bound COM on a dedicated STA thread (per-call deadlines, `CoCancelCall` for calls blocked by an Outlook dialog). **Registered only when classic Outlook is installed**; the new Outlook for Windows has no COM object model (`health.providers.outlook` / `permissions.status.outlook` give the reason). Ids are `ol1.<StoreID>.<EntryID>[.<occurrence>]` (opaque, not Mail's numbers), folder ids `olf1.…`. Guarded operations are refused with `outlook_object_model_guard` instead of triggering Outlook's security prompt. Reminders are Outlook tasks (date-only due; flagged = "Flagged" category, plus follow-up-flagged mail with `flagged: true`); contacts hold 3 emails; one reminder per appointment; no `message://` links; `mail.search.source` is `outlook`. Mapping details in `src/outlook/mod.rs`. Live checks: `cargo test -- --ignored live_outlook`. |
| `vm` | `status`, `restore_image`, `create`, `start`, `stop`, `delete`, `export_image`, `snapshot`, `restore`, `reset`, `snapshot_delete`, `share_add`, `share_remove`, `pause`, `resume`, `suspend`, `configure`, `display`, `agent_status`, `copy_in`, `copy_out`, `install_psyche`, `grant_permissions`, `watch`, plus `service_info` | The sandbox PC: the mac helper's `vm.*` names, schemas, side effects and receipt kinds, served by a **client of `psyche-vm-svc.exe`** (a LocalSystem service driving Hyper-V's Host Compute Service) over its control pipe `\.\pipe\psyche-vm-<owner SID>` (NDJSON `{id, method, params}`; params and results cross unchanged; the service's events become `node.event`s `{type: <event>, …}`). The guest is Linux, not macOS (`ipsw` is refused). The service relays guests straight to the Gateway's guest pipe (`$PSYCHE_HOMEun\guest-socket`), so the helper has no relay role. **Advertised in full only when the service `PsycheVM-<owner SID>` is installed**; before that only `vm.status` exists and answers `service: {installed: false, state: "notInstalled", action: "turn_on_sandbox_pc"}` (the desktop installs the service and restarts the helper). `vm.status` never wakes a sleeping service more than once per helper run (the first call learns what exists; after that it answers from memory with every guest `stopped`), and sends `passive: true` so the service need not count it as activity. Every other call starts the service first (`StartService`; no admin needed once the service's security descriptor grants the owner `SERVICE_QUERY_STATUS | SERVICE_START`: SDDL `(A;;LCRPRC;;;<owner SID>)`). The helper talks only to a pipe whose server is the process the SCM reports for that service. Owner-side checks before anything reaches the SYSTEM service: `share_add` (valid name, absolute existing folder, canonical path, never a drive root, the user folder, AppData, Windows, Program Files, ProgramData, credential folders or `$PSYCHE_HOME`; read-write needs `approvalId`), `copy_in` (same folder rules), `copy_out` / `export_image` (inside the granted folders). `PSYCHE_VM_PIPE` points at a fake service for tests. |
| `health` | `health` | Version, OS build, uptime, notify / Hello / Outlook state. |

## Layout

```
src/main.rs        CLI, single instance, runtime start
src/groups.rs      the one list of capability groups
src/node/          runtime: frames, NDJSON, pipe transport, handshake, identity, registry,
                   session (invoke/cancel/timeouts), daemon (reconnect), tiers, granted folders
src/win/           Win32/WinRT wrappers (DPAPI, Credential Manager, registry, shell, processes,
                   foreground, token security, Authenticode)
src/<group>/       one folder per capability group
src/bridge.rs      blocking capability crates on the node's invocation path (cancellation)
crates/            workspace members: win-computer (computer, screen, chrome tabs, element
                   lookups), win-dictation (dictation, speech)
tests/             fake Gateway end to end, the real binary
```

Logs are content-free (phases, names, sizes, outcomes) on stderr and in
`$PSYCHE_HOME\logs\helper.log` (rotated at 5 MB).

## CONTRIBUTING: adding a capability

1. Pick the group folder (`src/computer/`, …) or create `src/<group>/mod.rs` with
   `pub fn register(reg: &mut CapabilityRegistry)`, declare it in `src/lib.rs` and append it to
   `GROUPS` in `src/groups.rs`. Core files need no other change.
2. Keep the mac helper's name, input schema, side effect, target kind, receipt kind and result
   shape (read the Swift `CapabilitySpec` and handler). Where a field is Mac-specific, keep it and
   fill it with the Windows analogue; document differences in the module doc and the table above.
3. Register with `reg.add_blocking(spec, |ctx| …)` for Win32/COM work (runs on the blocking pool,
   COM MTA) or `reg.add(spec, |ctx| async move …)` for async/streaming work. Decode params with
   `ctx.decode::<T>()?` (errors become `invalid_params` naming the field), stream with
   `ctx.emit(json)`, poll `ctx.is_cancelled()` in long loops, return
   `CapabilityOutput::with_receipt(..)` for side effects. Set `.timeout(..)` when the helper should
   give up on its own.
4. Errors: `CapabilityError::new(ErrorCode::…, "machine_reason", "message")`; reuse the mac
   helper's reasons so the Gateway reacts the same way.
5. Shared state: `reg.runtime().service(|| …)` gives one instance per process (see
   `node::tiers::shared_policy` for the computer-use tiers `apps.*` already uses).
6. Never log params, results or user content. Add unit tests for pure logic and a `#[ignore]`
   live test for anything that needs the desktop.
