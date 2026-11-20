# Linux without the desktop app: a helper-only machine and a headless Linux Host (2026)

Status: design, 2026-11-19, owner decisions included (§1). This doc changes no code. It was checked against `main` at 202961f28 and against the open Linux PRs #1293 (L6, virtual screen), #1294 (L5, direct computer use) and #1295 (separate-desktop hardening). It builds on [linux-desktop-2026.md](linux-desktop-2026.md) (§4 the helper, §5–8 the surfaces, §9 password presence) and [remote-gateway-2026.md](remote-gateway-2026.md) (the identity key, LAN, pairing links, decisions G1–G10).

**The owner's ask (2026-11-19):** "Start looking to allowing linux to run just a psyche helper, so you can connect a desktop app to it."

**The plan in ten lines**
1. **Two first-class tracks.**
   - **Track A, the helper-only machine.** A Linux box or VM runs only `psyche-helper`, with no screen attached. The owner's one Gateway, on the Mac, pairs it as a **machine**, and the agent uses that box's screen, apps, shell and files.
   - **Track B, the headless Linux Host.** A Linux box runs `psyched` and the helper with no Electron. The desktop app on a Mac or PC connects to it as a remote Client (§1).
2. **One shared helper wave (H1).** A **headless session mode** gives the helper its own Xvfb screen, session bus and AT-SPI, with no portal and no dialog. Track A uses it on a machine, and track B uses it on the Host (§3).
3. **Track A process.** One Rust binary and one `systemd --user` unit, with linger, running **under the owner's own account by default** (the owner's choice). A dedicated user is an install option, and Settings explains the trade-off (§3.1, §6.5).
4. **Track A connection.** The helper dials the Gateway's existing endpoints: Tailscale Serve, or the LAN listener with its pinned certificate. Nothing listens on the box. Authentication is mutual at the protocol level: the box pins the Gateway's identity key, and its own device key signs the challenge (§4).
5. **Track A trust model.** A new node kind, `machine`, is granted only by the owner's approval. A machine is routed by its id, never by recency, and is never the Host helper. It is reached only through the agent's tools, never through `nodes.invoke`, and its capabilities are filtered by an allowlist on both ends (§6).
6. **Shell and files on a machine from v1** (the owner's choice). Commands use the `exec_host` card and rules, and files use folder grants, both with plain-tap approvals. The box's root-owned `policy.json` is a ceiling the Gateway can't raise (§5).
7. **The own-account default, made honest.** A compromised Gateway gets what the owner's Linux account can reach, within the ceiling. Four things narrow that:
   - `NoNewPrivileges` on the helper, inherited by what it forks directly (apps are not contained from the user manager yet, see §3.3);
   - a contained shell by default (bubblewrap hides SSH keys, keyrings, browser profiles and the helper's own files);
   - a scrubbed environment (no ssh-agent, no keyring bus);
   - a journal on the box that the account can't erase.

   Settings says all of this plainly (§6.5).
8. **Track B.** It needs:
   - a `psyche-server` package (psyched, the CLI, the helper and units, with no Electron);
   - the helper as a headless Host helper;
   - setup from the terminal (pairing link, LAN);
   - the Host features that today need Electron: the agent browser, computer use watched from a Client, and payment presence by passkey (§7).
9. **Every approval card, receipt, watch pane and run-trace step names the machine or the Host.** The agent picks a machine with an optional `machine` parameter, and it never silently falls back to another computer (§8).
10. **Waves:** H0–H8 for track A and B0–B4 for track B, with H0 and H1 shared. The security PRs get adversarial review. L5 and L6 merging is step zero (§10).

---

## 0. Terms

| Term | Meaning |
| --- | --- |
| **Host** | The machine running the one Gateway (`psyched`) and owning `~/.psyche`. That's the Mac today, or a Linux box in track B. |
| **Host helper** | The helper on the Host's own node socket that presented the per-launch handshake secret (`NodeRegistry.hostHelper`). On Linux, the peer check must also pass (linux-desktop §4.3). |
| **Machine** (new, track A) | A separate computer that runs only the helper and that the owner paired so the agent can use its screen, apps, shell and files. It holds no Psyche data. |
| **Client** | A desktop app connected to a remote Gateway (remote-gateway §0). Under G5, a Client is never driven by computer use. |
| **Surface** | `direct`, `virtual_screen` or `separate_desktop` (`ComputerSurface` in `packages/protocol/src/schemas/tools.ts`). |
| **Ceiling** | The box's `policy.json`: what the Gateway may ever use there. The Gateway's own settings only narrow it. |

## 1. Owner decisions (2026-11-19)

| # | Question | Decision |
| --- | --- | --- |
| Q1 | A helper-only Linux machine used by the Mac's Gateway (A), or a headless Gateway on Linux that a desktop app connects to (B)? | **Both, as first-class tracks.** B is not a "later" item |
| Q2 | Computer use on a paired Linux machine? It's a narrow exception to G5, which covered Clients | **Yes, on explicitly paired machines,** with every Host rule and the machine named on every card |
| Q3 | Which screen on the box? | **A private headless screen in v1.** Driving a logged-in desktop comes later (the orchestrator's default; the owner wasn't asked) |
| Q4 | Shell and files on the box? | **Yes, from v1.** Commands and file reads and writes use the usual tap-to-approve cards, under the box's `policy.json` ceiling |
| Q5 | Which Linux account does the helper run as? | **The owner's own account by default.** A dedicated user stays an option, and Settings states the trade-off |

How the two tracks fit the earlier decisions:
- **One Gateway (G9) holds in both.** In A the Mac stays the brain, and a machine stores nothing of it. In B the Linux box *is* the brain. An owner who runs both a Mac Host and a Linux Host has two separate brains, and the desktop app switches between them (G9: one active at a time). A track B Host can pair track A machines too.
- **Computer use Host-only (G5):** in B it holds as written, because the box is the Host. A gets the Q2 exception.
- **Browser Host-only (G4) holds in both.** In A the agent browser stays on the Mac Host. In B it runs on the Linux Host (§7.4). A machine never gets the vault.
- **Admin opt-in (G1):** a machine gets only the `node` scope. Clients of a B Host follow G1 as for a Mac Host.
- **LAN (G10):** both tracks work over Tailscale Serve and the LAN listener from day one. Both are built on the Gateway side.

---

## 2. Where things stand

| Piece | State on `main` | Matters for |
| --- | --- | --- |
| Rust helper (L3, #1275 merged) | NDJSON over `$PSYCHE_HOME/run/node.sock`, blocking `std` I/O (`daemon.rs`, `channel.rs`, `handshake.rs`), Ed25519 identity, backoff, the capability registry, `--build-info`. **No network transport.** It signs the v1 connect and doesn't check a Gateway identity key | A |
| Rust protocol types | `crates/protocol/src/generated.rs` already has `gatewayKey`, `gatewaySignature`, `lanCertSpki` and `lanCertSignature` | A |
| Direct computer use (L5, #1294 open) | `crates/linux-computer` (AT-SPI, X11, portal, PipeWire, tiers, fixed caps, password refusal), plus the Gateway's `SurfaceRouter` / `registerSurfaceRouter` hook in `compose/computer.ts` | A, B |
| Virtual screen (L6, #1293 open) | `VirtualDisplay` (Xvfb, the helper as window manager, capture, input) needs no systemd and no Gateway. It brings `computerWatch.*`, the ComputerWatch pane and pulled frames. Its open item: `apps.open { surface: "virtual_screen" }` isn't yet linked to L5's `apps` module | A, B |
| Separate desktop (L7, #1287 merged; #1295 open) | `deploy/sandbox-image/desktop/entrypoint.sh` (private bus, Xvfb, AT-SPI launcher, then the helper); `nodes/guest-sockets.ts` (a non-Host helper bound to one target, paired with a single-use token); #1295's release job builds the helper per arch | A, B |
| Peer check (#1292 merged) | `transports/peer-check.ts`: only the root-owned `LINUX_PACKAGED_HELPER_PATH` (`/usr/lib/psyche/resources/linux-helper/psyche-helper`) can be the Host helper in a packaged install | B |
| Remote Gateway R1, LAN and R2 (built) | Identity key and challenge signature, the LAN certificate pin, `psyche-pair:v1` and `:v2` links, setup tokens (`devices.setupToken.*`, "never `node`"), rate limits, pending caps, revoke. A Mac remote Client exists | A, B |
| Server mode (built, not packaged) | `psyched` on Linux under systemd or Docker, the CLI as first admin (`psyched devices approve <code>`), Tailscale Serve. `docs/guides/server-mode.md` "Not supported yet" lists: release binaries, **the agent's browser on a server**, and **a Mac's helper from a server Gateway** | B |
| Remote nodes | `apps/node` dials a Gateway over WebSocket (`transports/ws.ts`) and offers `exec.host` and `fs.*`, but doesn't pin the Gateway key. The Gateway stores any network node claiming a helper family as `remote` and **never routes Host-bound work to it** (`nodeKindOf`, remote-gateway §4.1) | A |
| Host exec | `compose/exec-host.ts`: one argv, in a granted folder, under srt's deny profile, with a card bound to argv, cwd, env and the binary's SHA-256; tainted turns are offered `once` only | A (pattern), B |
| `nodes.invoke` guard | `handlers/nodes.ts`: `UNREACHABLE` already includes `computer`, `apps`, `vault`, `keychain`, `screen` and others, on every node | A |

---

## 3. Process model

### 3.1 Track A: the helper-only package

The `psyche-helper` package comes as deb, rpm, and a tarball for everything else, for x86_64 and aarch64.

| File | Purpose |
| --- | --- |
| `/usr/lib/psyche-helper/psyche-helper` (deb/rpm, root-owned) or `~/.local/lib/psyche-helper/psyche-helper` (tarball) | The same binary as the desktop's bundled helper, from #1295's release build |
| `/usr/bin/psyche-helper` | Symlink |
| `/usr/lib/systemd/user/psyche-helper-remote.service` | The unit (§3.3). The tarball's installer writes it to `~/.config/systemd/user/` |
| `/etc/psyche-helper/policy.json` (deb/rpm: root-owned, 0644) | **The ceiling** (§5.3). With the tarball it's `~/.config/psyche-helper/policy.json`, which the owner's account can edit, so Settings flags it (§6.5) |

- **Runtime dependencies:** `xvfb`, `dbus-user-session` (Debian) or `dbus` (Fedora), `at-spi2-core`, `xauth`, and `bubblewrap` (for the contained shell, §5.1).
- **PipeWire** is loaded with `dlopen` on first Direct use, so a headless box doesn't need it. Today L5 links it, so H1 changes `pw.rs` to load it on demand.
- **Size:** the binary is about 5–10 MB.

### 3.2 Track B: the server package

`psyche-server` (deb, rpm, tarball) installs a headless Host with no Electron.

| File | Purpose |
| --- | --- |
| `/usr/lib/psyche-server/psyched/` | The bundled Gateway (`deploy/scripts/build-psyched.mjs`) with its own Node runtime |
| `/usr/lib/psyche-server/psyche-helper` (root-owned) | The helper. The peer check accepts this path as a second packaged path (§9) |
| `/usr/bin/psyche`, `/usr/bin/psyched` | The CLI (`apps/cli`) and the Gateway |
| `/usr/lib/systemd/user/psyche-gateway.service` | Rendered by the shared unit renderer (`apps/cli/src/systemd-unit.ts`, moved there by #1286) |
| `/usr/lib/systemd/user/psyche-helper-headless.service` | The Host helper for a box with no graphical session (§7.2) |

- **Data** lives in `~/.psyche`, as everywhere.
- **Updates** use the same Ed25519 manifest, with a `linux-server` artifact. `psyche update` verifies it, takes the existing pre-update snapshot (`apps/gateway/src/pre-update.ts`) and prints the `sudo apt install` / `dnf install` command for deb and rpm. The tarball replaces itself atomically, with rollback.

**The desktop deb and `psyche-server` on one box conflict** (two Gateways on one `~/.psyche`). The packages declare `Conflicts`, and the desktop package is the one to use on a box with a screen.

### 3.3 The units

```ini
# psyche-helper-remote.service (track A, systemd --user)
[Unit]
Description=Psyche helper: lets your Psyche use this computer
After=network-online.target dbus.socket
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/psyche-helper remote
Restart=on-failure
RestartSec=5
# 78 = revoked, identity changed, protocol mismatch: never restart into a loop (as apps/node)
RestartPreventExitStatus=78
# Nothing the helper starts (apps, commands) can gain privileges: no sudo, pkexec or setuid.
NoNewPrivileges=yes
Slice=psyche-machine.slice

[Install]
WantedBy=default.target
```

- **Linger.** Both tracks run with nobody logged in, so the installer runs `loginctl enable-linger <user>` once. That's the only admin step, and the installer says why. With linger, the user manager starts at boot and provides the session bus at `/run/user/<uid>/bus`.
- **`NoNewPrivileges=yes` is inherited.** Every process the helper forks keeps the flag, including apps launched through `systemd-run --user --scope`, which runs the command as the caller's child. So no app or command the helper forks directly can use sudo, pkexec or a setuid binary. It does not hold against the user manager. An app or command that can reach `/run/user/<uid>/bus` or `/run/user/<uid>/systemd` can ask `systemd-run --user` to start a process outside the helper's tree, without the flag, and with `NOPASSWD` that process can use sudo (checked on Ubuntu 24.04 in H1 review). Closing that route means hiding those paths from apps and commands in a mount namespace (bwrap, which H5's contained shell needs anyway); until that lands, uncontained apps can reach sudo through the user manager. Chromium-family browsers fall back to their user-namespace sandbox, which is the default on current distros. H1 checks Firefox, Chromium and LibreOffice under the flag.
- **Slice.** `psyche-machine.slice` (track A) or the Host's `psyche-vscreen.slice` (track B) gets `MemoryHigh` from the policy (default 3 GB).
- **Track B's Gateway unit** is today's `deploy/systemd/psyche-gateway.service` shape, with `WantedBy=default.target` and linger. The headless helper unit is the same as the remote one, except for `ExecStart=… --display headless`, no `Restart` (psyched starts it on demand, linux-desktop §4.4) and the idle exit.

### 3.4 Display modes (shared, H1)

| Mode | When | Display | Structure and input | Dialogs at the box |
| --- | --- | --- | --- | --- |
| **Headless** (v1) | No graphical session: a server, VM or spare box | The helper's own Xvfb (L6 `VirtualDisplay`), `:90` and up, private 0600 auth file | AT-SPI on the user's session bus. Apps launch with `GTK_MODULES=gail:atk-bridge`, `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` and `ACCESSIBILITY_ENABLED=1`, as the L7 entrypoint does in the container | **None**: Xvfb plus XTest needs no portal |
| **Desktop session** (later, H9) | Someone is logged in to GNOME or KDE on the box | The real screen (L5 Direct) and, beside it, a virtual screen (L6) | L5: AT-SPI plus portals, or XTest on X11 | The first portal approval must be clicked **at the box**, then the restore token is reused. It's opt-in in the ceiling |
| **Container** (later, H10) | A VPS or shared box | L7's `desktop` image run on the box | As in L7 | None |

- **On a headless box the virtual screen is the only screen**, so its surface is `virtual_screen` and the protocol needs no new value. A machine advertises its surfaces (`machine.status`, §9).
- **Headless bootstrap** follows the L7 entrypoint's order, done by the helper at first need:
  1. Use the user's session bus. If there is none, start a private `dbus-daemon --session` from system config only.
  2. Start Xvfb.
  3. Activate the AT-SPI bus.
  4. Launch each app in an L6 scope with the X11 environment.
- **L6's single-instance guard** still runs. On a headless box nothing is "on your screen", so it always passes.

### 3.5 Lifecycle and cost

- **Track A's helper stays resident while paired.** Without a listener, the Gateway can't wake it from afar. The cost is one TLS WebSocket with a 25 s ping, an estimated 5–10 MB RSS (H2 measures it). L6 measured 13.6 MB for a debug build with the virtual screen running.
- **Track B's helper starts on demand** (psyched starts it) and exits after 5 idle minutes, as in linux-desktop §4.4.
- **In both tracks the screen and apps start on demand** and stop the way L6 does:
  - `WM_DELETE_WINDOW` at Task end;
  - parking on unsaved changes;
  - Xvfb stops after 10 idle minutes.

  Measured in L6: Xvfb about 72 MB, a GTK 4 editor 219–281 MB.

### 3.6 Track A command line

```
psyche-helper pair '<psyche-machine:v1:…>'           # pin the Gateway, pair with the one-time token
psyche-helper pair wss://studio-mac.tailnet.ts.net   # no link: show the Gateway's fingerprint and a code
psyche-helper remote                                 # serve (what the unit runs)
psyche-helper status                                 # Gateway, fingerprint, connection, display, policy, account
psyche-helper unpair                                 # node.unpair if reachable, then wipe the key
psyche-helper update                                 # verified update (H7)
```

- **`remote.json`** (0600, `$XDG_CONFIG_HOME/psyche-helper/`) holds `gatewayUrl`, `gatewayKey`, an optional `certPin` (LAN) and the machine name.
- **The device key for this Gateway** lives at `$XDG_STATE_HOME/psyche-helper/remote-identity.json` (0600), apart from any local Host-helper identity. That's the remote-gateway rule: one device key per Gateway.
- **A helper pairs with exactly one Gateway.** `pair --replace` unpairs the first.

### 3.7 Free signing path

Nothing new needs Apple signing. The Mac's Gateway code changes, but its build and its self-signed signature don't. Linux needs no signing authority. Psyche's own Ed25519 release manifest covers `psyche-helper` and `psyche-server`, and cosign covers the container image. Tailscale's free tier or the LAN cost nothing.

---

## 4. Track A connection

### 4.1 The helper dials the Gateway

| Option | For | Against | Verdict |
| --- | --- | --- | --- |
| **Helper → Gateway over the existing WebSocket endpoint** (Serve URL or LAN listener) | Nothing listens on the box, so NAT doesn't matter. Reuses pairing, rate limits, pending caps, the identity key, LAN certificate pins and setup tokens. The same direction as every node | The Mac must be reachable (Serve or LAN on). While the Mac sleeps, the box waits | **Chosen** |
| Gateway → helper (the helper listens, with mTLS) | The box needn't know the Mac's address | A listener on the box, outbound-connection code and an address book in the Gateway, and a CA to issue client certificates | Rejected |
| `psyche-node` on the box plus its helper hub | Most of the code exists, including `exec.host` and `fs.*` | A Node runtime (about 40–60 MB more RSS, against the owner's RAM rule). No identity pin. The hub proxies `notify.*`, `speech.*` and `keychain.*`, which a machine must not offer | Rejected. `exec.host` and `fs.*` move into the Rust helper instead (H5) |

**Mutual authentication without client certificates.** mTLS can't work behind Tailscale Serve anyway, because `tailscaled` terminates TLS. The protocol is already mutual:
- **The Gateway proves itself** (remote-gateway §3.3, §3.4.1):
  - `gatewayKey` equals the pin;
  - `gatewaySignature` verifies over `psyche-gateway-v1 \n nonce \n serverOrigin \n devicePublicKey`;
  - `serverOrigin` equals the dialed origin;
  - on the LAN, the SPKI pin is checked before the WebSocket upgrade, and `lanCertSignature` is checked too.
- **The machine proves itself:** it signs the v2 connect, which includes `gatewayKey`, with the device key the owner approved.

If the certificate pin fails, the helper writes no byte past the TLS handshake. It never signs a challenge that fails any of these checks.

### 4.2 The transport (H2)

- **Libraries:** `tungstenite` (synchronous, fits L3's loop) and `rustls`. Serve URLs are verified against `webpki-roots` or the system store. LAN URLs use a verifier that accepts only `certPin`.
- **URL rules** (as `apps/node/src/transports/ws.ts`):
  - `wss://` only (`ws://127.0.0.1` in tests);
  - no credentials or query in the URL;
  - path `/ws`;
  - no `Origin` header;
  - no per-message deflate;
  - the Gateway's `maxFrameBytes`.

  The URL comes only from `remote.json` or the `pair` argument, never from the network.
- **Reconnects:**
  - L3's backoff (0.5 s to 30 s, with jitter), reset after 10 s paired;
  - a WebSocket ping every 25 s keeps NAT and DERP paths alive;
  - `denied` with `device_revoked` wipes the key and exits 78;
  - an identity mismatch or `protocol_version_mismatch` exits 78 and keeps the key.
- **While the Mac sleeps or the Gateway restarts:** in-flight calls fail `unavailable` (the existing `#failInvocations`), sessions end, and the Task parks with "lab-box went offline" (§8.2).

### 4.3 Pairing

**With a link (recommended).** In Settings → Devices → **Computers Psyche can use** → **Add a Linux computer**, the owner picks "Over Tailscale" or "On this network". The Host then calls `devices.setupToken.create { purpose: "machine", via }`. The token follows remote-gateway §3.4's rules:
- 256 bits, stored hashed;
- single use, valid for 10 minutes, at most three live;
- audited, and withheld if the audit fails.

The sheet shows the install command and `psyche-helper pair '<link>'`, both copyable.

```
psyche-machine:v1:<base64url JSON {"gatewayUrl","gatewayKey","certPin"?,"setupToken","hostName"}>
```

- **Parsing is strict**, as for `psyche-pair:v2`: exactly these fields, at most 2048 characters.
- **The scheme is separate on purpose:**
  - a desktop app never accepts it, and the helper never accepts a `psyche-pair:` link;
  - a device token never pairs a machine, and a machine token never pairs a client.
- **What a machine token grants:** `["node"]` and `purpose: machine`, nothing else.
- **When it's presented:** in `connect.verify`, only after the Gateway proved the pinned key.
- **On success** every device gets "lab-box was added as a computer Psyche can use", with **Remove**.

**Without a link.** `psyche-helper pair wss://…` prints the Gateway's fingerprint and a code. The Host's **Waiting to pair** shows the request, labelled **"wants to let Psyche use its screen, apps, shell and files"**, with:
- the name, `linux` and the address;
- the `Tailscale-User-Login` claim, marked as a claim;
- the key fingerprint and the code.

The owner compares both and approves with a tap (admin; approvals are button-only). Approving that card is what makes the device a machine.

---

## 5. Shell and files on a machine (track A, v1)

The owner wants shell commands and file reads and writes on a machine from v1, with tap approvals and the box's ceiling.

### 5.1 Shell: `exec.host` in the helper

- **Same shape as the Host's `exec_host`** (`compose/exec-host.ts`, security §5.4):
  - one argv, never a shell string, in a folder granted on that machine;
  - an explicit environment subset;
  - output capped at `EXEC_OUTPUT_CAP_BYTES`;
  - stdout and stderr streamed through `node.event`;
  - a timeout (`EXEC_DEFAULT_TIMEOUT_MS`).

  The capability name is `exec.host`, the same as `apps/node`'s. The helper refuses a call without an `approvalId`.
- **The card:**
  - "Run on **lab-box**: `<argv>` in `<folder>`", answered `once` or `always`;
  - bound to the machine id, argv, cwd, env subset, and the SHA-256 of the resolved executable that the helper reports;
  - "Always allow `<program>` in `<folder>`" works as on the Host (`packages/permissions/src/host-program.ts`), keyed on the machine too;
  - a tainted turn is offered `once` only;
  - a plain tap, following the 2026-11-09 decision for Mac-control approvals, which this mirrors.
- **The contained shell (default).** The command runs under `bwrap`, the machine-side counterpart of srt's deny profile on the Host:
  - the root filesystem is read-only;
  - only the granted folder and a private `/tmp` are writable;
  - tmpfs is mounted over `~/.ssh`, `~/.gnupg`, `~/.local/share/keyrings`, `~/.password-store`, browser profile folders (`~/.mozilla`, `~/.config/{chromium,google-chrome,BraveSoftware}`), `~/.config/psyche-helper`, `~/.local/state/psyche-helper`, `~/.config/systemd`, `~/.config/autostart` and the shell's rc files (bind-mounted read-only);
  - `--unshare-all --share-net`, `--die-with-parent`, `--new-session`;
  - the environment is scrubbed: no `SSH_AUTH_SOCK`, `GPG_AGENT_INFO` or `DBUS_SESSION_BUS_ADDRESS`, so there's no ssh-agent and no Secret Service;
  - network on, so commands can fetch. A policy field turns it off.
- **The full-account shell (opt-in).** `"exec": { "contain": false }` in the ceiling. Commands then see the whole account (still under `NoNewPrivileges` and the scrubbed environment). Settings shows "Full account shell on lab-box" in the machine's row.
- **No PTY in v1.** That keeps to one approved argv per call. An interactive terminal on a machine would be the R4 terminal pattern, later.
- **If `bwrap` is missing or user namespaces are off,** the contained shell can't run. `exec.host` then answers `unavailable` (`details.reason: "contain_unavailable"`) instead of quietly running uncontained.

### 5.2 Files: `fs.*` in the helper

- **Capabilities:** `fs.list`, `fs.stat` and `fs.read` (side effect `read`), `fs.write` and `fs.mkdir` (`write`), `fs.remove` (`destructive`). They keep `apps/node`'s names and semantics:
  - absolute paths only;
  - `realpath` confinement to the ceiling's roots;
  - symlink escapes refused;
  - `ro` roots refuse writes;
  - chunked reads with an etag.
- **Protected paths are always refused**, whatever the roots: the same list the contained shell hides (§5.1), plus `/etc/psyche-helper`, `/proc`, `/sys`, `/dev`, `/boot` and `/root`.
- **Grants and cards:**
  - The first file call in a folder raises a folder grant card for that machine: "Let Psyche read `~/projects` on **lab-box**", for this Task or always. Read-write is a separate tick, asked fresh.
  - Writes and removes outside an `always` read-write grant ask per call.
  - The folder is picked from a list the helper returns (`fs.list` under the ceiling's roots), never typed in. This is the Host-folder-browser rule (remote-gateway §4.2).
- **Moving files between a machine and the Host:**
  - Reads stream back like `files.read`.
  - "Copy to the Host" saves into the Library as a file from the machine.
  - Writes take content the agent produced. Writing Host files onto a machine is an outbound send, so it asks unless the Task already has a read-write grant there.

### 5.3 The ceiling: `policy.json`

```json
{
  "surfaces": { "virtualScreen": true, "direct": false },
  "apps": { "allow": ["*"], "deny": ["org.keepassxc.KeePassXC"] },
  "exec": { "enabled": true, "contain": true, "network": true, "cwdRoots": ["~"] },
  "files": { "roots": [{ "path": "~", "mode": "rw" }] },
  "memoryHigh": "3G",
  "watch": true
}
```

- **The Gateway can only narrow it.** Per-machine settings in Psyche (tiers, enabled tools) clamp to it, and the helper enforces it at dispatch whatever the Gateway sends. It's the same rule as `apps/node`'s `node.json`: file roots and host exec can only be turned on by the box's owner, on the box.
- **The owner sets the defaults** shown above at install. `psyche-helper status` and the machine's Settings row show the effective ceiling.
- **Root-owned in deb/rpm,** under `/etc`, so neither the owner's account nor anything the helper runs can change it. `NoNewPrivileges` closes the sudo route even where the owner has passwordless sudo (§6.5).
- **User-owned with the tarball.** A full-account shell could rewrite it, so Settings flags "This computer's limits can be changed by Psyche's own commands". The contained shell can't reach it, because it sits under the hidden `~/.config/psyche-helper`.
- **The user-owned file is advisory.** An agent with a shell or a GUI terminal on the box runs as the same account and can edit it. Only the root-owned `/etc` ceiling (deb/rpm) is a limit that account cannot change; the Gateway's own machine rules (H3, H4) apply either way. The helper reads the file again on every call and denies everything if it, or a root-owned policy that exists, cannot be read or trusted. `apps.deny` means an app is never launched by a call; it does not stop an allowed app from opening a denied one, so H1 also checks the focused window's app against it.

---

## 6. Track A security

### 6.1 Identity and keys

- **Machine:** an Ed25519 key per Gateway, 0600, never in the environment, never logged. `psyche-helper status` and Settings show the same fingerprint.
- **Gateway:** the identity key (remote-gateway §3.3), pinned from the link or by comparing fingerprints. `psyched identity rotate` stops every machine ("the Gateway's identity changed", exit 78) until it pairs again.
- **The kind comes from the owner, not the node.** A `linux-helper` connecting over the network stays `remote` and unrouted, as `nodeKindOf` does today. Only an owner-approved machine pairing (the card or a machine token) stores the device as a machine. Kind `machine` is then set at accept from that stored decision, and the family is pinned.
- **v2 connect required.** A machine must send `gatewayKey` in `connect.verify`, which proves it pinned this Gateway. A v1-signed machine is refused.

### 6.2 What the Gateway may ask a machine to do

- **An allowlist on both ends:**
  - `health`, `machine.status`;
  - `computer.*`, `apps.list|open|focus`;
  - `vscreen.*` (the watch pane);
  - `a11y.status`, `portal.status`;
  - `exec.host`;
  - `fs.list|stat|read|write|mkdir|remove`.

  In remote mode the helper registers nothing else: no `notify.*`, `speech.*`, `keychain.*`, `presence.*`, `dictation.*`, `screen.*` or `teach.*`. The Gateway also drops anything outside the list from a machine's manifest at accept.
- **Only through the agent's tools.**
  - `nodes.invoke` already refuses `computer.*` and `apps.*` on every node.
  - H3 adds machine rules: only `health` and `*.status` are reachable. `exec.*`, `fs.*`, `vscreen.*` (except status), `portal.*` and `a11y.enable` are not.
  - So every action goes through a tool with its broker path, card and binding.
- **The broker's rules, as on the Host:**
  - per-app tiers (now per machine);
  - fixed caps: browsers read only, terminals and IDEs click only; password managers, banking, polkit and keyring prompts off;
  - `PASSWORD_TEXT` fields refused and redacted;
  - risky labels and chords ask;
  - the Super key is never sent;
  - money intent is classed `financial` and needs presence (the payments-only rule).

  Every approval binds the machine id, so a card approved for lab-box can't be used on the Host or on another machine.
- **Unattended by design.** A card parks the Task (`awaiting_attention`) instead of failing the call, as for the virtual screen.
- **Taint.** Everything a machine returns is `untrusted`, as for any remote node: screen content, command output, file contents. A tainted turn can't widen anything, and `exec.host` is offered `once` only there.
- **Never sent to a machine:**
  - vault credentials (G4's reasoning);
  - the owner's clipboard;
  - presence: a machine can't answer approvals, because it has no operator scope.

### 6.3 Audit

- **On the Gateway:**
  - `machine.paired`, `machine.revoked` and `machine.policy` (the ceiling changed) are audited;
  - every receipt carries `machine: { deviceId, name }`;
  - `exec.host` receipts carry the argv hash, cwd, exit code and duration, never output;
  - `fs.*` receipts carry the path and byte count, never content.
- **On the box** (new): the helper writes one line per command, file write or remove, and app launch to the **user journal** (`sd_journal_send`, identifier `psyche-helper`): machine-local metadata, never content. Journal files belong to `systemd-journald`, so the owner's account can read them but can't delete or edit them. `journalctl --user -t psyche-helper` is the box's own trail even if the Gateway was compromised.

### 6.4 Compromise analysis

| If this is compromised | It can | It can't |
| --- | --- | --- |
| **The Gateway** (or a device with `operator.write` steering a run). The broker runs on the Gateway, so a compromised Gateway approves its own cards; only the box's own checks stand | **Own-account default: everything the owner's Linux account can reach within the ceiling.** It can drive apps on the private screen as the owner (a text editor can open any file the account can read, because apps aren't contained), run commands, and read and write files in the roots. With a full-account shell it can also reach SSH keys, browser cookies and the rest of home, set up persistence (crontab, rc files, user units), and move to other hosts the account can reach | Gain root: `NoNewPrivileges` covers the helper and what it forks directly. **Not covered until bwrap hides the user manager's socket: an uncontained app or command reaching `systemd-run --user`, which with `NOPASSWD` gives root.** Raise a root-owned ceiling. Reach files the contained shell hides, or the ssh-agent and keyring (scrubbed environment), in the default contained mode. Erase the box's journal. Reach other Gateways' machines |
| **The machine** (the helper or the box) | Lie about its screen, command output or files (all tainted). Plant prompt injection (tainted, so it can't widen anything). See whatever the agent types or writes to it: **anything Psyche sends to a machine is disclosed to it**, so pair only boxes you control. Refuse or slow its calls | Call any operator method (the `node` scope allows only `node.*` frames). Become the Host helper (that needs the local socket plus the secret). Receive another machine's calls (routed by id). Reuse an approval (bound to the call and the machine, single use). Receive credentials or presence. Add capabilities (filtered at accept). Exhaust the Gateway (frame caps, per-device rate limits, one session per machine and surface) |
| **A leaked `psyche-machine` link** (within 10 minutes) | Pair the attacker's computer as a machine. The agent might then work there, so the attacker sees commands, typed text and file writes meant for a machine | Get operator scopes or read Psyche data. Stay hidden: every device is notified, and Settings lists the machine with its address, fingerprint and time. The sheet says to paste the link only into your own terminal |
| **The tailnet or LAN** | See that a Gateway exists. Open connections within the per-address limits | Impersonate the Gateway to a paired machine (identity pin, and the LAN SPKI pin before any byte). Read traffic (TLS 1.3) |

### 6.5 The own-account default, and what Settings says

The owner chose the own account for convenience: the agent works with the owner's real files, apps and logins on the box. The cost is the first row above. The design narrows it without adding friction:

1. **No root from the helper itself.** `NoNewPrivileges` on the unit is inherited by what the helper forks directly. It does not stop an uncontained app or command from asking the user manager to start something without the flag (§3.3); H5's bwrap containment closes that. The helper also runs `sudo -n true` at start, under the flag, and reports whether the account *has* passwordless sudo. Settings then says "Psyche can't use sudo here, but other programs you run as this account can".
2. **Contained shell by default** (§5.1): commands can't see SSH keys, GPG, keyrings, password stores, browser profiles or the helper's own files, can't use the ssh-agent or Secret Service, and can write only the granted folder.
3. **Protected paths for `fs.*`** (§5.2), whatever the ceiling's roots.
4. **A root-owned ceiling** with deb/rpm. The tarball's user-owned one is flagged.
5. **The box's own journal** (§6.3).
6. **Apps aren't contained.** An app on the private screen runs as the owner and can open anything the account can. This is the inherent cost of the own account, and only the dedicated user (or, later, the container mode) removes it.

What the machine's row in Settings shows:
- **Own account (default):** "Runs as **dev** on lab-box. Psyche can use your files, apps and logins there, as you can. If your Psyche were ever compromised, so could an attacker, except for root, which Psyche never gets." Then **Use a separate account instead…**, which opens the guide's two commands.
- **Dedicated user:** "Runs as **psyche** on lab-box. Psyche sees only that account's files and apps."
- **Warnings when they apply:**
  - "Full account shell": the contained shell is off;
  - "Limits are user-owned": tarball install;
  - "This account has passwordless sudo".

The installer asks once ("Run as your account (recommended) / as a separate `psyche` account"), and `install.sh --dedicated-user` does the latter. The dedicated user has no sudo, no password, `nologin`, linger, and its own ceiling.

### 6.6 Revocation

- **From any admin device:** Settings → Devices → the machine → **Remove** (`devices.revoke`). The connection closes at once, sessions and running commands end (the helper kills the command's process group), and parked Tasks say "lab-box was removed". On its next connect the helper gets `device_revoked`, wipes its key and exits 78.
- **On the box:** `psyche-helper unpair`, or `systemctl --user disable --now psyche-helper-remote`.
- **On the network:** remove the box from the tailnet, or turn LAN off.
- **Idle machines:** G7's 90-day idle flag applies. They're never revoked automatically.

---

## 7. Track B: a headless Linux Host

### 7.1 What already works

Server mode runs `psyched` on Linux under systemd or Docker behind Tailscale Serve. The CLI is the first admin (`psyched devices approve <code>` while no admin exists), and the Mac desktop app connects as a remote Client: R1, LAN and pairing links are built. Chat, Tasks, Search, Library, memory, connectors, automations and the Host terminal (R4) work. Track B makes this an install, adds computer use on the Host's own private screen, and closes the gaps server mode lists.

### 7.2 The Host helper on a headless box

- `psyched` already starts the Linux helper on demand: `systemctl --user start psyche-helper.service`, L5's `startHelper`. That unit is `PartOf=graphical-session.target`, which never starts without a session.
- B0 adds `psyche-helper-headless.service`. psyched picks it when logind reports no graphical session for the user, and the helper runs with `--display headless` (H1).
- The helper is the **Host helper**: it connects on `node.sock`, presents the handshake secret and passes the peer check. The packaged root-owned path becomes a list (`LINUX_PACKAGED_HELPER_PATHS`: the desktop path and `/usr/lib/psyche-server/psyche-helper`). The other rules don't change.
- **Computer use on a B Host uses `virtual_screen`.** `direct` answers `unavailable` (`details.reason: "no_graphical_session"`), as linux-desktop §4.4 already says.
- **Exec on the Host** (`exec_host`, #967) runs on the Linux box under srt, exactly as on the Mac. srt's Linux backend uses bubblewrap. B3 verifies the deny profile's Linux paths.

### 7.3 Setup from the terminal

On a headless Host there's no desktop shell, and today some steps need one: `devices.bootstrapAdmin`, making a pairing link, and turning LAN on (all "the Host's own desktop shell"). B2 adds a terminal path:
- **`psyche setup`** (`apps/cli/src/commands/onboard.ts`): model keys, `gateway.publicOrigin` and the Tailscale Serve hint, LAN on and its interface, linger, then a summary.
- **The first admin:** the CLI pairs as today. Its code is approved by `psyched devices approve` on the box, which is already allowed while no admin exists.
- **`psyche devices link [--admin] [--lan]`** makes a `psyche-pair:v1`/`v2` link for the desktop app. It's allowed for **an admin CLI device connected over the Host's loopback without a forwarding header** (the CLI already pairs there). It's single use, lasts 10 minutes, at most three are live, and it's audited, as remote-gateway §3.4 requires. That widens "desktop shell only" to "a local admin device on this computer". The security doc records it, and security review checks it.
- **`psyche lan on --interface <if>`** uses the same rule and the existing `gateway.lan` setting.

### 7.4 Host features that need Electron today

| Feature | Mac Host | Headless Linux Host (B3) |
| --- | --- | --- |
| Agent browser | The desktop window serves CDP over `browser-bridge.sock` | Today "not supported" in server mode. B3 runs the existing Playwright driver (`packages/browser/src/drivers/playwright.ts`) against a headful Chromium **on the helper's private screen**, with persistent profiles under `~/.psyche`. The owner watches it in the watch pane and can take over to sign in. G4 holds: the browser is on the Host |
| Computer use | Host helper, Direct | Host helper, `virtual_screen` (§7.2) |
| Watching computer use from a Client | Remote-gateway R1 turns computer use **off** on a Client ("Computer use works at studio-mac") | B3 lets a Client **start and watch** computer use on a remote Host's private screen. It runs on the Host, so G5 holds. `computerWatch.*` become available to a paired desktop device (`desktopApp`, remote-gateway §4.1 rule 2) with `operator.write`. Take over needs `operator.approvals`. The R1 gate stays for `direct` |
| Payment presence | Touch ID or the Mac password (LAContext, through the helper) | polkit refuses with no local session (`presence_unavailable_here`, linux-desktop §9.5). B3 makes **passkeys** the verifier: registered from the web client in a browser at `gateway.publicOrigin` (Serve gives HTTPS). Browsers handle passkeys, so the free signing path doesn't matter. Without a passkey, a payment card says "Set up a passkey to approve payments on this Psyche" and the call fails `presence_required`. Every other approval is a plain tap |
| Notifications | Host helper, Electron fallback | Client devices only, through the `device:<deviceId>` surface (remote-gateway R2, where built) and the phone |
| Apple connectors, iMessage | Host helper | "Only on a Mac host". A Mac pairing back as a node for Apple apps (topology C) is a later wave (B5) |
| Dictation, voice | Renderer mic, Host whisper | Client mic, Host whisper (remote-gateway R1) |
| Host words | "this Mac", "studio-mac" | The Linux host words from #1289 and #1290 ("lab-box", "this computer") |

### 7.5 Track B security

- **A Linux Host has the Mac Host's threat model.** Whoever controls `psyched` controls the brain: data, vault, connectors. Track B adds no new trust path, only a different Host OS:
  - the Host helper rule plus the peer check (defence in depth, linux-desktop §4.3);
  - `exec_host` under srt;
  - Clients under remote-gateway §6 (no admin by default, G1; presence only for payments; revoke).
- **The vault key on a headless box** is the key file plus the full-disk-encryption check (LD10). `psyche setup` warns when the disk isn't encrypted, because a server is more likely to be stolen or imaged.
- **`psyche devices link` from the local admin CLI** (§7.3) is the one widening. A same-user process could already drive the CLI's key, so it matches the same-user boundary security §1.3 accepts. It's still audited, and every device is notified when a link is used.
- **The agent browser on the Host's private screen** shares the box with other apps. L6's per-app scopes keep it separate, and its profiles live under `~/.psyche`, protected by the existing deny profile.

---

## 8. UX

### 8.1 Track A: Settings → Devices → "Computers Psyche can use"

A group inside the existing Devices section (no new sidebar row).
- **Empty state:** "Give Psyche a Linux computer to work on, so it can use apps, commands and files there while you keep using this one." Then **Add a Linux computer**.
- **The add sheet:**
  1. Pick the network. If neither Serve nor LAN is on, the sheet offers "Allow other computers" first.
  2. Choose the account (yours / a separate one, §6.5).
  3. Copy the install command.
  4. Copy `psyche-helper pair '…'`.
  5. Wait; the sheet turns green when the machine pairs.
- **Each machine's row:**
  - name (editable), status, display mode, surfaces;
  - account (own or dedicated) and shell mode (contained or full);
  - the ceiling summary, helper version, and "Update the helper on lab-box" on version skew;
  - fingerprint and pairing date;
  - the warnings from §6.5;
  - **Watch**, **App access**, **Folders** (grants on that machine) and **Remove**.
- **Waiting to pair:** a machine request has its own wording and icon. The status block reuses #1292's `HostHelperCheckGroup` pattern.

### 8.2 How the agent picks a computer

- **Tools.** Every computer tool (`computer.*`, `apps.*`), the `exec_host` tool and the granted-folder file tools take an optional `machine` (an id; omitted means the Host). `machines.list`, a read-only tool, returns `{id, name, status, surfaces[], display, exec, files}`. Tool descriptions name the paired machines.
- **Defaults:**
  - Settings → Computer use → **Default computer for background work**: This Mac / lab-box. A Mac has no virtual screen, so a machine is how a Mac owner says "work over there while I work here".
  - Tasks and automations can be bound to a machine ("Run on lab-box").
- **Binding.** A computer-use session binds one (machine, surface) pair. Changing machine starts a new session, and the run trace says "Switched to lab-box".
- **No silent fallback.** An offline machine answers `unavailable` (`details.reason: "machine_offline"`), and the Task parks with **Retry** / **Use this Mac instead**.
- **Names** match case-insensitively. Two machines with the same name are refused until one is renamed.

### 8.3 Cards, notifications and the watch pane

- **Card header:** "**On lab-box** · Linux · private screen" (or "· command", "· files"), then the action, with the argv and folder for commands and the path for files. It looks the same on desktop, web and iOS: one more string pattern in 10 languages and `Localizable.xcstrings`.
- **Notifications:** "Psyche is working on lab-box", "lab-box went offline" and "lab-box was added".
- **The watch pane** (L6's ComputerWatch) reads "lab-box · private screen". `computerWatch.*` gain `machine`, and frames are pulled from that machine's `vscreen.frame` through the Gateway: at most 4 fps, only while visible. A 1280×800 JPEG is about 60–120 KB; H6 measures that over DERP.
- **Per-machine app tiers:** Settings → Computer use gets a machine picker. Tiers sync to that helper's `computer-use.json` through L5's mechanism (`compose/computer-linux.ts`), clamped by the ceiling.

### 8.4 Track B

- **On the desktop app:** "Add a Gateway" (built) with the link from `psyche devices link`. The window names the Host ("Connected to **lab-box**"), using the Linux host words.
- **Computer use from the Client** opens the watch pane on the Host's private screen (B3).
- **The server's own Settings:** Devices → "This Gateway runs on Linux without a screen", with links to set up a passkey for payments and to see `psyche doctor` output. Apple connectors show "Only on a Mac host".

---

## 9. Protocol changes (additive, no `protocolVersion` bump)

| Change | Where | Notes |
| --- | --- | --- |
| `NodeKind` += `"machine"` | `schemas/identity.ts` | Set from the owner's decision. Never from `deviceFamily` |
| `SetupTokenPurpose = "device" \| "machine"`, plus `purpose` on `devices.setupToken.create` and `SetupTokenInfo` | `methods/devices.ts` | `machine` forces scopes to `["node"]`, and the result's `link` is `psyche-machine:v1`. "Never `node`" stays true for `device` |
| `parseMachineLink` / `formatMachineLink` | the protocol's pair-link module | Strict, at most 2048 characters. Shared vectors for Rust |
| `PairingRequest.purpose?: "device" \| "machine"` | `schemas/identity.ts` | The card's wording |
| `machines.list`, `machines.rename` (admin), the event `machines.changed`, and `MachineInfo {id, deviceId, name, platform, status, display, surfaces, exec: {enabled, contained}, files: {roots}, account: "own"\|"dedicated", policyOwner: "root"\|"user", passwordlessSudo, helperVersion, lastSeenAt}` | `methods/machines.ts` (new), `events.ts` | |
| `ComputerMachineRef { deviceId, name }` on approval targets (`computer_action`, `exec_host`, `folder_access`), on `Receipt.machine?` and on run-trace steps | `schemas/tools.ts`, `schemas/permissions.ts` | The binding hash includes `deviceId` |
| `machine?: Id` on `computerWatch.*` | `methods/screen.ts` (L6's block) | Default: the Host |
| Helper capability `machine.status` | the helper's manifest; shape in `methods/screen.ts` | Read-only. The only machine capability besides `health` that `nodes.invoke` reaches |
| `details.reason` values: `machine_offline`, `machine_surface_unavailable`, `machine_policy`, `contain_unavailable`, `no_graphical_session` | `errors.ts` (documented reasons) | Codes stay `unavailable` / `forbidden` |
| `LINUX_PACKAGED_HELPER_PATHS` (a list), replacing the single `LINUX_PACKAGED_HELPER_PATH` (kept as an alias) | `packages/protocol/src/platform.ts` | Track B's server path |
| Update manifest: `linux-helper` and `linux-server` artifacts | `deploy/scripts/update-manifest.mjs` (not the wire protocol) | `tar.zst`, `deb`, `rpm` per arch |

The tool parameter `machine` lives in the local TypeBox schemas in `apps/gateway/src/compose/` (as `surface` does in `computer.ts`), so it's not a wire change. Swift and Rust codegen pick up the enum additions, and the Mac and Windows helpers ignore them.

---

## 10. Plan

The same rules as the L plan:
- disjoint file ownership between PRs running in parallel;
- append-only locale files;
- light tests (vitest `--maxWorkers=1` on touched files, per-package typecheck, `cargo test`);
- no VMs or containers on the owner's Mac;
- real Linux checks on the Windows/WSL build machine or CI, listed in each PR body.

Two hotspots are shared by H7 and B1: `.github/workflows/release.yml` and `deploy/scripts/update-manifest.mjs`. H7 lands first, and B1 adds to it. **Security PRs (H2, H3, H4, H5, B1's peer-check change, B2) get the security reviewer** until it says fit to merge. Builders default to Haiku 5.5. H2–H5 and B2–B3 are Sonnet-sized.

### 10.1 Shared and track A

| # | Scope | Owns | Depends on | Done means |
| --- | --- | --- | --- | --- |
| **H0** protocol | All of §9, for both tracks. Codegen for TS, Swift and Rust | `packages/protocol/src/**`, `packages/protocol/generated/**`, `packages/protocol-swift/**` (generated only), `apps/linux-helper/crates/protocol/src/generated.rs` | — | `pnpm protocol:check`, `gen:check` and `cargo gen-check` pass. Link parser tests cover every refusal |
| **H1** headless session mode (shared) | `--display headless` and auto-detection. The virtual screen as the primary surface; the bus check or a private bus; AT-SPI activation; the a11y environment for launches. Links `apps.open` / `computer.*` on `virtual_screen` to `VirtualDisplay` (L6's open item). PipeWire loaded with `dlopen`. Checks apps under `NoNewPrivileges` | `apps/linux-helper/crates/helper/src/headless/**`, `main.rs` (register), integration points in `vscreen/` and `linux-computer/src/pw.rs` | L5, L6 merged | On WSL with no `DISPLAY`/`WAYLAND_DISPLAY` under `systemd --user` with linger: open GNOME Text Editor on the helper's Xvfb, snapshot, type, read back, screenshot, with nothing on another display. Firefox and LibreOffice start under `NoNewPrivileges`. RSS measured |
| **H2** remote transport and pairing (helper) | `tungstenite` + `rustls`; CA and SPKI-pin verifiers; Gateway identity checks; v2 signing; the token in `connect.verify`; per-Gateway identity; `remote.json`; keepalive; exit 78 and key wipe; `pair`/`remote`/`status`/`unpair`; the remote-mode allowlist; `policy.json` loading and enforcement at dispatch; the `sudo -n` report | `apps/linux-helper/crates/helper/src/remote/**`, `crates/protocol/src/signing.rs`, `cli.rs`, `Cargo.toml`, `Cargo.lock` | H0 | `cargo test`: the wrong SPKI gets no upgrade and no token; every challenge check fails closed; signing vectors match the TS side. On WSL against a real `psyched` with a temp `PSYCHE_HOME` and LAN on: pair by link and by code, reconnect, and revoke gives exit 78 with the key gone. **Security review** |
| **H3** machine pairing and registry (Gateway) | `purpose: machine` tokens; the machine card; kind from the stored decision; v2 required; family pinned; the accept-time capability allowlist; `nodes.invoke` machine rules; `NodeRegistry.machine(deviceId)`; `machines.list`/`rename`/`changed`; the "added" notification; audit; the revoke cascade | `apps/gateway/src/nodes/registry.ts`, `apps/gateway/src/auth.ts` (token purpose), `apps/gateway/src/handlers/{devices,nodes}.ts`, `apps/gateway/src/handlers/machines.ts` (new) | H0 | A network `linux-helper` without approval is `remote` and unroutable. An approved one is `machine`. A machine token can't carry operator scopes, and a device token can't make a machine. v1 refused. Extra capabilities dropped. `nodes.invoke` refuses `computer.click`, `exec.host`, `fs.write` and `vscreen.input` on a machine. Revoke leads to `device_revoked`. **Security review** |
| **H4** computer-use routing and policy (Gateway) | `machine` on computer tools and the `machines.list` tool; a machine router (`SurfaceRouter` keyed by machine and surface) with remote sessions; the binding includes the machine; receipts; money-intent and risky-label checks; no credential fill; unattended parking; `machine_offline`; per-machine tiers synced and clamped; the default computer for background work | `apps/gateway/src/compose/machines.ts` (new), `compose/computer.ts` (the routing hook only), `compose/computer-settings.ts` (per-machine tiers), `packages/permissions/src/**` (binding) | L5 merged, H3 | With the Host and two fake machines: calls route only to the named one; an approval for A is refused on B and the Host; offline leads to a park; credential fill is refused; the Mac path is unchanged. **Security review** |
| **H5** shell and files on a machine | Helper: `exec.host` (argv, cwd within grants and the ceiling, streamed output, cap, timeout, process-group kill on cancel or revoke, `bwrap` containment, scrubbed env, `contain_unavailable`), `fs.*` (confinement, protected paths, chunked reads), journal lines. Gateway: `machine` on the `exec_host` tool and the granted-folder file tools, cards bound to the machine, machine folder grants picked from `fs.list`, taint, "Copy to the Host" | `apps/linux-helper/crates/helper/src/{exec,fs,journal}/**`, `apps/gateway/src/compose/machine-exec.ts` and `machine-files.ts` (new), `apps/gateway/src/compose/exec-host.ts` (the `machine` hook only), `packages/permissions/src/host-program.ts` (key gains the machine) | H3, H4 | `cargo test`: symlink escape, protected paths, `ro` roots, missing `bwrap`, env scrub, a contained command can't read `~/.ssh` or reach `$SSH_AUTH_SOCK`, and `sudo` fails under `NoNewPrivileges`. Gateway: a card for A is refused on B; a tainted turn gets `once` only; output is tainted. On WSL end to end against a real helper. **Security review** |
| **H6** UI and i18n | The Settings "Computers Psyche can use" group (add sheet with the account choice, rows, warnings), the machine picker in Computer use, the machine line on cards (desktop, web, iOS), notifications, the watch pane with `machine` (`compose/virtual-screen.ts` plumbing), run-trace labels, 10 languages and `Localizable.xcstrings` | `packages/ui/src/screens/settings/{DevicesSection,MachinesGroup}.tsx`, the approvals card component, `packages/ui/src/screens/computer-watch/**`, `apps/web/src/shell/panes/ComputerWatchPane.tsx`, `apps/gateway/src/compose/virtual-screen.ts` (machine param), iOS approval view and strings; locale files (append-only) | H3, H4, H5 | Stories for every row state (online, offline, update, own or dedicated account, full shell, user-owned limits, passwordless sudo). `i18n:check` passes, iOS strings present. Can split into H6a (desktop/web) and H6b (iOS) |
| **H7** helper package, install, update | Helper-only `tar.zst`/deb/rpm; the unit; `install.sh` (own account by default, `--dedicated-user`, linger, ceiling defaults, root-owned policy for deb/rpm); `psyche-helper update`; `linux-helper` manifest artifacts; the release job (extends #1295's helper build); `docs/guides/linux-helper-only.md` | `deploy/linux-helper/**` (new), `apps/linux-helper/crates/helper/src/update.rs`, `deploy/scripts/update-manifest.mjs` (helper artifacts), `.github/workflows/release.yml` (helper job), the guide | H2, H5 | `systemd-analyze verify` passes. The installer runs in a throwaway WSL distro (never on the Mac), both account modes. It survives a reboot through linger. A tampered artifact is refused. The tarball updates and rolls back. `actionlint` is clean |
| **H8** real-machine test A and the security doc | On a Linux VM on the build machine: a Mac Gateway over Tailscale and over LAN; pair; a computer-use Task on lab-box while the owner works on the Mac; a command and a file write with tap approvals from the phone; the watch pane; Mac asleep and waking; revoke during a command; identity rotation; the journal trail. Security doc §10 "Machines" and the threat-model row | `docs/05-security-and-permissions.md`, `docs/guides/linux-test-results.md`, `docs/design/linux-desktop-2026.md` (status line) | H1–H7 | Every step passes or is filed. **The owner's go-ahead before any VM** |

### 10.2 Track B

| # | Scope | Owns | Depends on | Done means |
| --- | --- | --- | --- | --- |
| **B0** headless Host helper | `psyche-helper-headless.service` (no `graphical-session.target`); psyched's `startHelper` picks it when logind reports no graphical session; `direct` answers `no_graphical_session`; the Host helper rule and peer check unchanged | `deploy/systemd/psyche-helper-headless.service` (new), `apps/cli/src/systemd-unit.ts` (render it), `apps/gateway/src/compose/computer-linux.ts` (start choice) | H1, L5 | On WSL with linger and no session: a Task's computer-use call starts the headless helper, which pairs as the Host helper and drives an app on its private screen. With a session, the graphical unit is used as before |
| **B1** server package | `psyche-server` deb/rpm/tarball (bundled psyched with its Node, the CLI, the helper at `/usr/lib/psyche-server/psyche-helper`, the Gateway and headless-helper units, linger); `Conflicts` with the desktop package; `linux-server` manifest artifacts; `psyche update` with the pre-update snapshot; the peer check accepts `LINUX_PACKAGED_HELPER_PATHS` | `deploy/linux-server/**` (new), `apps/gateway/src/transports/peer-check.ts` (path list only), `deploy/scripts/{build-psyched.mjs,update-manifest.mjs}` (server artifacts), `.github/workflows/release.yml` (server job, after H7's lands), `apps/cli/src/commands/service.ts` (`update`) | H0, B0 | Packages build on Linux CI or WSL. The installed helper passes the peer check as `root_owned`, and a copy elsewhere is `user_owned` and refused. A tampered update is refused. Upgrade and rollback keep `~/.psyche`. **Security review** (peer-check change) |
| **B2** terminal setup | `psyche setup` (model keys, `publicOrigin`, Tailscale Serve hint, LAN, linger, disk-encryption warning); `psyche devices link [--admin] [--lan]` and `psyche lan on` for an admin CLI device on the Host's loopback without forwarding headers; audit; the security doc entry | `apps/cli/src/commands/{onboard,devices}.ts`, `apps/gateway/src/handlers/devices.ts` (the loopback-admin rule for link and LAN only), `docs/05-security-and-permissions.md` (§10 entry) | H0 | A local admin CLI makes a v1 link and, with LAN on, a v2 link that the Mac desktop accepts. A forwarded or non-admin connection is refused. Three-live and ten-minute limits hold. Audited. **Security review** |
| **B3** headless Host features | The agent browser through the Playwright driver on the helper's private screen (profiles under `~/.psyche`, watch and take over); computer use started and watched from a Client on a remote Host's `virtual_screen` (`computerWatch.*` for `desktopApp` devices; the R1 gate kept for `direct`); passkey-only payment presence with its card text; Linux host words in the remote window; Apple connectors marked "Only on a Mac host"; srt's Linux deny paths checked | `apps/gateway/src/compose/browser.ts` (server driver choice), `apps/gateway/src/compose/virtual-screen.ts` (Client access; coordinate with H6's machine param), `apps/desktop/src/main/**` (the remote computer-use gate only), payment presence text in `packages/ui/src/**`; locale files (append-only) | B0, L6 | On WSL: a browser Task on the headless Host opens a page in Chromium on the private screen, and the Mac Client watches it and takes over. A Client starts computer use on the Host's private screen. A payment card with no passkey fails `presence_required`, and with a passkey it verifies. `direct` stays off on the Client |
| **B4** real-machine test B and the guide | A Linux VM as the Host and the Mac desktop as the Client over Tailscale and LAN: install `psyche-server`; `psyche setup`; pair the desktop with a link; chat, a Task, a browser Task and computer use watched from the Mac; a passkey payment; an update; a reboot. `docs/guides/server-mode.md` rewritten around the package; "Not supported yet" trimmed | `docs/guides/server-mode.md`, `docs/guides/linux-test-results.md` (track B section) | B0–B3 | Every step passes or is filed. **The owner's go-ahead before any VM** |

### 10.3 Order (≤5 working sessions)

- **Step 0:** finish the L5 (#1294) and L6 (#1293) reviews and merge them. They're on both tracks' critical path.
- **Wave 1:** H0, then H2, H3 and B2 in parallel.
- **Wave 2** (after L5 and L6): H1, then H4, B0 and B1.
- **Wave 3:** H5, B3 and H6.
- **Wave 4:** H7, then H8 and B4.

**Later, each needing its own decision:**
- **H9:** Direct mode on a box's logged-in session (the box clicks the first portal dialog).
- **H10:** a container machine (L7's image on the box, in remote mode), the strongest option for a shared box.
- **H11:** an interactive terminal on a machine (the R4 pattern).
- **B5:** a Mac pairing with a Linux Host as a node for Apple apps (topology C).

---

## 11. Residual questions (recommendation first)

The owner answered Q1–Q5. Three smaller choices follow from them. Each has a default this design already uses, so none blocks a wave.

| # | Question | Recommendation |
| --- | --- | --- |
| R1 | On a machine under your own account, should shell commands run **contained** by default (they can't see SSH keys, keyrings, browser profiles or the ssh-agent), with "Full account shell" as a switch in the box's `policy.json`? | **Yes, contained by default.** Ordinary commands still work in the granted folders, and it removes the worst of the own-account cost (§6.5) |
| R2 | On a headless Linux Host, should **payments** require a passkey registered from a browser, and be refused without one? | **Yes.** polkit can't ask without a local session, and every other approval stays a plain tap |
| R3 | Should a desktop app connected to a headless Linux Host be able to **start and watch** computer use on that Host's private screen? It runs on the Host, so G5 holds | **Yes,** for `virtual_screen` only. `direct` stays off from a Client |

---

## References

- In repo: `docs/design/linux-desktop-2026.md` (§4, §4.3, §4.4, §5, §7, §8, §9.5, §11, §14), `docs/design/remote-gateway-2026.md` (§3.1, §3.3, §3.4, §4.1, §4.2, §6, §8), `docs/02-architecture.md` (§3.1, §3.2, §7), `docs/05-security-and-permissions.md` (§1.3, §5.4, §10), `docs/guides/server-mode.md`, `apps/node/README.md`.
- Code: `apps/linux-helper/crates/helper/src/{daemon,handshake,channel,paths,cli}.rs`, `apps/linux-helper/crates/protocol/src/generated.rs`, `apps/gateway/src/nodes/{registry,guest-sockets}.ts`, `apps/gateway/src/handlers/nodes.ts`, `apps/gateway/src/compose/{computer,exec-host,separate-desktop,browser}.ts`, `apps/gateway/src/transports/peer-check.ts`, `packages/protocol/src/{platform.ts,methods/connect.ts,methods/devices.ts,methods/node.ts,methods/nodes.ts,schemas/identity.ts}`, `packages/browser/src/drivers/playwright.ts`, `apps/cli/src/{systemd-unit.ts,commands/onboard.ts,commands/devices.ts}`, `deploy/sandbox-image/desktop/entrypoint.sh`, `apps/node/src/{transports/ws.ts,capabilities/helper.ts}`.
- PRs: #1275 (L3), #1286 (unit renderer in `apps/cli`), #1287 (L7), #1289 and #1290 (Linux wording), #1292 (peer check follow-up), #1293 (L6, open), #1294 (L5, open: `SurfaceRouter`), #1295 (open: the release job builds the helper).
