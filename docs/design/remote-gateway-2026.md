# Remote Gateway: the desktop app as a client of another machine

Status: proposal v1 (2026-11-02). R0's routing half is built (§2.3, §4.1 rule 1; see the PR "Remote Gateway R0"): Host-bound capabilities use `NodeRegistry.hostHelper` (the `mac-helper` on the node socket that presented the handshake secret; guests relay to `run/guest.sock`; the device family is pinned at pairing), any other node claiming `mac-helper` is stored as `remote`, and the desktop gates the handshake secret, helper launch and first-admin bootstrap on a loopback Gateway. The `desktopApp` gate split, per-device appearance settings and `windows` in `DevicePlatform` are not built. R1's first half is built (2026-11-04; see the PR "Remote Gateway R1"): the Gateway identity key and its signature in the challenge, the client pin with the origin check, saved Gateways in the desktop app (switching restarts the app on that Gateway's own data directory), the `remote` supervisor mode, the splash states of §4.6, the Host's "Allow other computers" instructions, and the §4.2 gates marked R1 that the desktop can apply without the Host (browser pane, computer use, Share a folder, Show in Finder, Terminal title, Apple connectors, system-wide dictation). LAN is built (2026-11-04; see the PR "Remote Gateway LAN"): the `gateway.lan` setting (off by default, one chosen interface, admin plus presence), a self-signed certificate under `identity/lan-tls` that clients pin by SPKI, the identity key vouching for that certificate in the challenge (`lanCertSpki`, `lanCertSignature`), Bonjour `_psyche._tcp` with only the host name, port and key fingerprint, "Look on this network" in Add a Gateway, per-address connection limits, and an audit and `doctor` warning while it is on (§3.1, §3.2). R2's pairing links are built (2026-11-04; see the PR "Remote Gateway R2: pairing links"): the setup token and `psyche-pair:v1` link with its QR code on the Host (Settings → Server & remote access → Pair another computer), "Add a Gateway" with a pasted link (and a `psyche-pair:` URL from the OS in packaged builds, which only opens that field), the pre-pinned fingerprint and the Host's auto-approval with the chosen scopes. A link to a Gateway on the local network is refused for now (it needs a certificate pin in the link, a later link version: add it with Look on this network). Not built: the R2 audit checks, the tailnet list, `doctor` checks, upload and download with a cache, per-Gateway presence, notifications, per-computer settings. R4's terminal is built (2026-11-04; the PR "Remote Gateway R4: terminal on the Host"): `terminal.session.*` and the `terminal.output` / `terminal.exit` events in `compose/host-terminal.ts`, and the remote window's `hostTerminalPort`. Client presence for it (passkeys) plugs into `HostTerminalOptions.presence`. Nothing else here is built. Applies to `apps/desktop`, `apps/web`, `apps/gateway`, `packages/protocol` and `packages/notifications`. It shares pairing, the Gateway identity-key pin and the device surface with the [mobile companion](mobile-companion-2026.md), and the Windows work with the [cross-platform audit](cross-platform-2026.md).

**The owner's ask (2026-11-02):** "allow using the psyche app to connect to a remote gateway (over tailscale), for example i can use the psyche app on my windows or mac, and it will connect to a remotely running psyche instance."

**The owner's constraints:** local-first, with no hosted infrastructure and no relay (Tailscale or the LAN only). Taint is absolute. Lower RAM matters more than a smaller app.

**The short answer:** most of the plumbing exists, and the desktop can already do this by hand:

```bash
PSYCHE_GATEWAY_MODE=external PSYCHE_GATEWAY_ORIGIN=https://psyche.<tailnet>.ts.net pnpm --filter @psyche/desktop start
```

This is in [server-mode.md](../guides/server-mode.md#the-desktop-app). The app pairs with a code, and chat, Tasks, Search, Library, memory and connectors work. Three things are missing:

- **A product around it:** choosing a Gateway in the app, saved Gateways, a startup flow for a host it can't reach, and a way to pair that isn't a terminal.
- **Trust that survives the network:** the Gateway identity-key pin, and checking the server origin.
- **An honest answer for every feature tied to one machine.** Today those features fail silently or reach the wrong Mac. The worst case: the Gateway sends computer use, Apple apps and notifications to whichever helper connected most recently (§2.3).

The plan:

- **R0:** fix the routing and the gates.
- **R1:** ship a Mac remote client over Tailscale Serve.
- **R2:** add pairing links, presence and notifications on the client.
- **R3:** ship a client-only Windows build.
- **R4:** run features on the client (Ask about my screen, system-wide dictation, the browser).

---

## 0. Terms

| Term | Meaning |
| --- | --- |
| **Host** | The machine that runs the Gateway and owns `~/.psyche`: data, vault, memory, connectors, models, automations, sandbox. Usually a Mac (with the Mac helper, so Apple connectors work); a Linux server works for everything that isn't Apple-only. |
| **Client** | The Psyche desktop app (Mac or Windows) connected to a Host on another machine. It holds no Psyche data of its own beyond caches and a device key. |
| **This Mac** | Today's mode: the app starts and supervises a Gateway on the same Mac (`launchd`/`dev` in `apps/desktop/src/main/supervisor.ts`). |
| **Host-local** | A capability that acts on the Host's machine (its screen, its apps, its files). |
| **Client-local** | A capability that acts on the machine the owner is sitting at (its screen, microphone, notifications, keyboard). |

## 1. Goal and modes

### 1.1 One brain

There is exactly one brain. A Client never runs a second Gateway against the same data, never syncs `~/.psyche`, and never holds the vault key. Everything durable lives on the Host. The Client is a window onto it, plus, later, a few client-local capabilities the owner switches on (§4).

This is the local-first rule applied across two machines. Data stays on hardware the owner owns. The network path is the owner's own tailnet or LAN, and nobody runs a server in the middle.

### 1.2 Modes

| Mode | Where | Supervisor | What starts |
| --- | --- | --- | --- |
| **This Mac** | macOS | `launchd` (packaged) / `dev` | The local Gateway LaunchAgent and the Mac helper, as today. |
| **Remote** | macOS, Windows | new `remote` (replaces `external` for packaged builds) | Nothing. The app connects to a saved Gateway's origin. No LaunchAgent is installed, and no helper is launched unless the owner turns on client capabilities (R4). |
| **Host** (a This Mac that also serves others) | macOS | `launchd` | Same as This Mac, plus Tailscale Serve in front of the loopback Gateway (§3.1). The Host keeps working as a normal Psyche Mac. |

A Windows install is Remote only. Hosting a Gateway on Windows is out of scope: the cross-platform plan's supervisor and named-pipe work isn't needed for a client.

### 1.3 Saved Gateways and switching

- **The list lives on the Client,** in `userData/gateways.json`, never on any Gateway. Each entry holds:
  - `id` and `name` (the Host's name, editable);
  - `origin` (`https://<host>.<tailnet>.ts.net`, or `http://127.0.0.1:7979` for This Mac);
  - `identityKey` (the pin, §3.3);
  - `deviceKeyRef`;
  - `lastConnectedAt` and `lastStateVersion`.
- **One device key per saved Gateway.** Each Gateway sees a different `deviceId`, so revoking the Client on one Host doesn't touch the others, and two Hosts can't link the same laptop. This Mac keeps today's `device-key.json`.
- **One active Gateway at a time per app.** Switching is a full disconnect and reconnect:
  1. Stop the `GatewayConnection` (`apps/web/src/client/connection.ts`).
  2. Reload the renderer with that Gateway's storage namespace, so drafts, layout and caches never mix.
  3. Connect, and resync through `stateVersion`.
- **Where to switch:**
  - the toolbar avatar menu ("Connected to **studio-mac** · Switch…");
  - the menu-bar tray (`apps/desktop/src/main/tray.ts`);
  - Settings → Devices → **Gateways on this computer**.

  This follows the consolidation rule (no new sidebar rows, see [consolidation-2026.md](consolidation-2026.md)).
- **The window always says where it is.** In Remote mode the toolbar shows the Host's name next to the avatar. Every "runs on the Host" control names the Host ("Terminal on studio-mac"), so the owner never mistakes the Host's files or shell for the machine in front of them.
- **This Mac and Remote on one Mac.** Switching a Mac from This Mac to a remote Gateway leaves the local LaunchAgent running by default, so its automations keep going. The switcher offers "Stop Psyche on this Mac" as a separate, explicit step (open question 2).

## 2. What exists and what's missing

Checked in code on `main` at 4c71db97.

### 2.1 Reused as is

| Piece | Where | What it gives a Remote Client |
| --- | --- | --- |
| Signed connect and pairing | `packages/protocol/src/methods/connect.ts` (`connectSigningPayload`), `apps/gateway/src/auth.ts` (`issueChallenge`, `verify…`, `pairingCode`, `keyFingerprint`) | Ed25519 challenge over `psyche-connect-v1 \n nonce \n platform \n deviceFamily \n protocolVersion \n serverOrigin`. A new device gets `pending` with an 8-character code (no look-alike characters). The owner approves with owner-chosen scopes. No bearer tokens. |
| Scopes and revocation | `packages/protocol/src/methods/devices.ts` (`devices.approve`, `devices.revoke`, `devices.pairing.list`), `DeviceScope` | `operator.read` / `write` / `approvals` / `admin` and `node`. `devices.approve` needs fresh presence once a verifier exists. Revoking closes the device's connections at once. |
| Desktop connection in the main process | `apps/desktop/src/gateway-client.ts` | The device key and the handshake never reach the renderer. The origin comes only from configuration, never from a deep link or the renderer (security §10). Already takes `httpOrigin`. |
| Reconnect and resync | `apps/web/src/client/connection.ts` (jittered backoff, a `/healthz` check every 10 s), `apps/gateway/src/state-version.ts` (N14) | A Client that drops off the tailnet reconnects, and refetches when `stateVersion` moved. Events are not replayed, which is the right shape for a laptop that sleeps. |
| `external` supervisor mode | `apps/desktop/src/main/supervisor.ts` (`chooseMode`, `ensureRunning`), `apps/desktop/src/main/splash.ts` | "Never start anything; report healthy or stopped." The basis of `remote`. |
| Loopback bind with a forwarding proxy | `apps/gateway/src/config.ts` (refuses non-loopback binds), `apps/gateway/src/proxy.ts` (`resolvePeer`) | Tailscale Serve reaches the Gateway from loopback. Forwarding headers make the connection **not loopback**, so it can never be auto-paired or treated as the desktop shell. `Tailscale-User-Login` shows on the pairing card as a claim, never as authority. |
| WS origin check | `apps/gateway/src/server.ts` (upgrade refuses a browser `Origin` outside the allowed set) | The desktop main process sends no `Origin`, like any native client. |
| Uploads and file reads | `library.upload` (chunked base64, at most 600 KB per chunk), `files.read` and `documents.convert` (chunked) in `packages/protocol/src/methods/{library,files}.ts` | Attachments up and file contents down already travel over the WebSocket, not through local paths. |
| Optional platform ports | `apps/web/src/shell/platform.ts` (`browser?`, `terminal?`, `dialogs?`, `dictation?`, `helper?`, `permissions?`, …) | The shell already renders without a port. Remote mode supplies a smaller set, and the UI hides or explains what's missing. |
| A node that dials a remote Gateway | `apps/node/src/transports/ws.ts`, `apps/node/src/capabilities/helper.ts` (a local hub the Mac helper dials, proxying a safe subset of its capabilities and dropping `vault.*`, `permissions.*` and secret-returning `keychain.*`) | The pattern for client capabilities in R4: a Client-side hub that the Client's own helper dials, forwarding to the Host as a node. |
| Device surfaces and approvals | `packages/notifications/src/surfaces.ts`, `methods/approvals.ts`, `PresenceAssertionSchema` (`webauthn` / `helper`) | `deviceOnly` approval kinds (`financial`, `credential_fill`, `exec_host`, `policy`, `pairing`) already go only to devices, never to chat. A Remote Client is a device. |
| Passkeys | `passkeys.*`, `gateway.publicOrigin` | Presence over HTTPS for a device without the Mac helper (Windows, R2). |
| Version negotiation | `negotiateVersion` in `apps/gateway/src/auth.ts` | A clear `protocol_version_mismatch` with the server's version, which the startup flow turns into "Update Psyche on studio-mac" or "Update this app" (§4.7). |

### 2.2 Missing

- **Gateway identity key and pin** (§3.3). The [mobile companion doc §2.2](mobile-companion-2026.md#22-pairing-with-a-qr-code) specifies it, and nothing is built. Today the client signs whatever `serverOrigin` the challenge names (`apps/web/src/client/handshake.ts`) and doesn't check it against the origin it dialed.
- **Saved Gateways, the switcher and a `remote` supervisor mode,** including a packaged build that can start without a local Gateway. Today `external` hides the splash and shows nothing useful when the Host is unreachable.
- **Host-side setup:** "Allow other computers" in Settings → Devices → Server & remote access, and the pairing link.
- **Node routing by owner, not recency** (§2.3).
- **A way to say "this paired device is a Psyche desktop app"** that works off-loopback (§4.1). Today `identity.desktopShell` needs loopback plus the per-launch handshake secret (`auth.ts`). That correctly refuses a remote Client, so dictation, Ask about my screen and attention all answer `forbidden`.
- **Per-computer settings.** The desktop reads zoom, theme, "show in Dock" and "open at login" from Gateway settings (`apps/desktop/src/lib/zoom.ts`, `window-theme.ts`, `main/dock-policy.ts`, `main/login-item.ts`). A Windows Client would apply the Host Mac's Dock setting, and two computers would fight over one zoom level.
- **`windows` in `DevicePlatform`** (`packages/protocol/src/schemas/identity.ts`). `platformFromNode` maps everything that isn't darwin to `linux` (`apps/desktop/src/lib/device-key.ts`).
- **Device key at rest.** It is a plain 0600 JSON file under `userData`. The comment there already says it should move into the Keychain. On Windows it should be wrapped with `safeStorage` (DPAPI).

### 2.3 A latent bug this work must fix first

Host-local capabilities pick **the newest live node of kind `mac-helper`**:

- `computerHelper` in `apps/gateway/src/compose/computer.ts`;
- `macHelper` in `compose/connectors.ts`;
- `dictationNode` in `compose/dictation.ts`;
- the speech selector in `compose/speech.ts`.

`NodeKind` comes from the self-declared `deviceFamily` (`KIND_BY_FAMILY` in `apps/gateway/src/nodes/registry.ts`). Today the only `mac-helper` is the Host's own, which dials the Unix node socket. Once a Client Mac's helper can reach the Host as a node, the most recently connected Mac would receive the agent's computer use, Messages reads, Apple app scripts and OS notifications. A second Mac would get them if it simply woke up last. R0 fixes this before any client node exists (§4.1).

## 3. Connection and trust

### 3.1 Transports

| Path | How | Verdict |
| --- | --- | --- |
| **Tailscale Serve** | On the Host: `tailscale serve --bg --https=443 http://127.0.0.1:7979`. The Client dials `https://<host>.<tailnet>.ts.net` (MagicDNS name, real Let's Encrypt certificate issued by Tailscale). | **Supported, recommended, R1.** The Gateway stays on loopback, so no bind change is needed. The traffic is encrypted twice (WireGuard, then TLS). Only the tailnet can reach it, and it works from anywhere the Client runs Tailscale. |
| **SSH tunnel** | `ssh -L 7979:127.0.0.1:7979 host`, then the Client uses `http://127.0.0.1:7979` | **Works today, for power users.** Allowed as a saved Gateway with a pinned identity key. Not offered in the setup flow. |
| **LAN (Bonjour, self-signed TLS)** | `https://<host>.local:7979` | **Built (2026-11-04), off by default.** A second listener on the owner's chosen interface with TLS and a self-signed certificate (`gateway.lan`, Settings → Server & remote access → Allow computers on this network). Clients pin the certificate's SPKI and the identity key, and the identity key signs the SPKI it served into the challenge. Built once for the phone and the desktop; only the desktop uses it so far. |
| **Direct bind to the Tailscale interface** (`100.x`) | A `PSYCHE_BIND=tailscale` that listens only on the `tailscale0` address | **Not planned.** Serve already gives TLS and a stable name with no Gateway change. A direct bind adds a listening socket, and a lost interface could leave it bound to the wrong address. |
| **Cloudflare Tunnel + Access** | Public hostname | **Not offered by the app.** It is hosted infrastructure, which the owner ruled out. The server-mode guide still documents it for browsers, and the manual `external` path keeps working. |
| **Any relay run by the publisher** | | **Not planned, ever** (same as the [mobile doc §2.1](mobile-companion-2026.md#21-transports)). |

**Host setup (R1).** Settings → Devices → Server & remote access gets **Allow other computers**:

1. It checks for the local `tailscale` CLI and reads `tailscale status --json` (local only).
2. It shows the exact `tailscale serve` command and runs it after the owner clicks **Turn on**. Changing another program's configuration is an outward-facing step, so the owner confirms, and **Copy command** is the fallback.
3. It sets `gateway.publicOrigin` to the MagicDNS name. This also makes the Host's passkeys bind to that name.
4. It turns on `gateway.trustedProxy` for `127.0.0.1` / `::1`, so pairing cards and rate limits see the real tailnet address and `Tailscale-User-Login`.
5. It restarts the Gateway.

`psyche doctor` gets a check that Serve points at the Gateway and that **Funnel is off** (`tailscale serve status --json`).

### 3.2 Finding a Gateway

The Client's **Add a Gateway** sheet (first run on Windows, the switcher on a Mac) offers, in order:

1. **Paste a pairing link** made on the Host (§3.4). It carries the address and the identity key, so there's nothing to type and nothing to trust on first use.
2. **Pick from your tailnet:**
   - If the `tailscale` CLI is present on the Client, list peers from `tailscale status --json` that carry `tag:psyche` or answer `GET /healthz` on 443.
   - This is local only: it reads `tailscaled`, and no service on the internet is asked.
   - Probing peers is opt-in ("Look for Psyche on my tailnet"), because it touches every peer.
3. **Type an address:** a MagicDNS name (`studio-mac`, expanded with the tailnet suffix that `tailscale status` reports) or a full `https://` origin.
4. **LAN:** Bonjour `_psyche._tcp` (built): "Look on this network" on the owner's click. The TXT record holds only the host name, the port (SRV) and the key fingerprint, which the client treats as a claim and checks against the key the Gateway proves. Picking one goes through the normal pairing and pin flow.

The app never takes a Gateway address from a deep link, a URL query or the renderer. This is the CVE-2026-25253 rule, already noted in `gateway-client.ts`. A `psyche-pair:` link is pasted into the app's own field. In a packaged build the OS may also hand the app a `psyche-pair:` URL (the scheme is registered there); that only shows Add a Gateway with the link in the field (`apps/desktop/src/lib/pair-link.ts`). It adds and connects to nothing, and main still parses the link itself and names the normalized address in a native dialog the owner confirms.

### 3.3 The Gateway identity key (shared with the phone)

This is the same design as [mobile companion §2.2 step 4](mobile-companion-2026.md#22-pairing-with-a-qr-code), built once for both clients:

- **The key.** A long-lived Ed25519 key, created at first start. It lives in `$PSYCHE_HOME/identity/gateway.key` (0600), not in the vault, because the Gateway needs it before the vault unlocks.
- **The challenge.** `ConnectChallenge` gains optional `gatewayKey` and `gatewaySignature` fields: a signature over `psyche-gateway-v1 \n nonce \n serverOrigin \n devicePublicKey`. The Gateway already knows the device public key when it issues the challenge.
- **The Client refuses to sign** unless all of these hold:
  1. `gatewayKey` equals the pin for this saved Gateway;
  2. the signature verifies;
  3. `serverOrigin` equals the origin the Client dialed.

  Each check fails closed, with a full-screen error and no "continue anyway" (§4.6).
- **The pin comes from the pairing link.** Without a link (an address typed in), the first connect shows the key fingerprint next to the pairing code. The Host's approval card shows the same fingerprint, and the owner compares the two, as the server-mode guide already asks for codes.
- **Rotation.** `psyched identity rotate` on the Host makes every Client stop with "studio-mac's identity changed". Each Client then re-pins through a new pairing link. Rotation is rare and must be loud.
- **Why not only TLS?** Tailscale certificates already prove the name, so on Serve the pin is defense in depth: against a compromised tailnet node taking over the name, against a mistyped host, and against an SSH tunnel to the wrong machine. On the LAN it is the only proof. It also makes the client-side `serverOrigin` check meaningful.

### 3.4 Pairing a new computer

**With a pairing link (recommended):**

1. On the Host, or any admin device, go to Settings → Server & remote access → **Pair another computer** (as built; the design said Devices → Add a computer). The owner ticks the scopes (Admin off by default, `node` never offered) and confirms with presence. It shows a pairing link, `psyche-pair:v1:<base64url {gatewayUrl, gatewayFingerprint, setupToken, hostName}>`, with **Copy** and a QR code drawn locally (the same payload works for the phone). As built, the link carries the key's `sha256:` fingerprint, not the key: a Client pins the fingerprint until its first paired connect, then the key. The strict parser refuses any other field (the mobile doc's `spkiPins[]` is a later, separate field on a later version).
   - The setup token is single-use, lasts 10 minutes, and is the bootstrap token that security §10 already specifies. It is 256 random bits, stored on the Host only as a SHA-256 hash, spent by one conditional UPDATE, revocable, and at most three are live at once. A Client presents it in `connect.verify`, never in `connect`, and only after it verified the Gateway's key and bound its connect to it (the v2 payload), so an impostor never receives it.
   - The link holds no long-lived secret, but the token in it is a bearer for those 10 minutes: whoever uses it first pairs one computer with the scopes the owner ticked, with no second approval. That is the trade that makes the link worth using, so the owner approves it up front (presence on making it, the scopes chosen then, revocable until used), and the Host's screen says not to share it.
2. On the Client, paste the link into Add a Gateway. The app shows "Connect to **studio-mac** (`studio-mac.tailnet.ts.net`)?".
3. The Client makes a new device key for this Gateway and connects. The Gateway must prove the fingerprint from the link, or the Client stops with the identity-changed screen before it sends anything. With a valid, unexpired token the Host pairs the Client at once with exactly the scopes chosen when the token was made, and no approval card appears (the owner already approved, with presence, when making the token). A used, expired or revoked token is denied with a clear message and never falls back to a pending request. Without a token, the Client gets `pending` as before.
4. **Without a valid token** the Host shows the request in its approval card, on every admin device, with:
   - the Client's name ("Psyche Desktop (ThinkPad)") and platform (`windows`);
   - the tailnet address;
   - the `Tailscale-User-Login` claim, labelled as a claim;
   - the key fingerprint and the code.
5. The owner approves with presence (Touch ID on the Host or a passkey). `devices.approve` already requires it.
6. The Client becomes `paired` and its window opens on Home.

**Without a link:** the Client shows its code and fingerprint, and the owner approves it in Settings → Devices → Waiting to pair, or runs `psyche pairing approve <code>` on the Host. This flow already works today.

**Never automatic without the owner's say-so.** A forwarded connection is never auto-paired by its address or a proxy header (`proxy.ts`). The one exception is a valid setup token, which exists only because the owner made it (with presence) and which grants only the scopes chosen then, never `node` and never admin unless ticked. A token cannot pair a node, a browser page or a Client that did not verify the Gateway's key. The first admin can't be bootstrapped remotely: `devices.bootstrapAdmin` requires the loopback desktop shell (`apps/gateway/src/compose/bootstrap-admin.ts`). A Host is set up on the Host first.

### 3.5 Scopes, revocation and keys at rest

- **Default scopes for a remote computer:** `operator.read`, `operator.write` and `operator.approvals`.
  - `operator.admin` is an unticked checkbox on the approval card.
  - When it is granted, every widening call still needs fresh presence, as today.
  - `node` is a separate checkbox, shown only once the Client offers client capabilities (R4).
- **What the Client can do without admin:** everything in chat, Tasks, Search, Library, People and Home, answering `write` approvals, and reading most of Settings. Changing security settings, devices, connectors' credentials or the vault needs admin and presence. Settings marks those controls "Needs admin on studio-mac" instead of failing on click.
- **Revocation:**
  - From any admin device, in Settings → Devices, `devices.revoke` closes the Client's connections at once.
  - From the Host's terminal: `psyche devices revoke <id>`.
  - The Client then shows "This computer was removed from studio-mac" and offers to pair again or forget the Gateway.
  - Revocation also drops the Client's node authority and presence key.
- **Keys at rest on the Client:**
  - **Mac:** the device key moves into the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, non-synchronizable). The helper is a later, optional component, so this is done from Electron through `safeStorage`, which uses the Keychain on macOS.
  - **Windows:** `safeStorage` (DPAPI, tied to the Windows user).
  - The key never syncs to iCloud or OneDrive, so a new computer pairs again.
- **Forget this Gateway** deletes that Gateway's device key, its storage namespace (drafts, layout, caches) and any files the Client downloaded into its cache. It also asks the Host to revoke the device when the Host is reachable.

## 4. What changes on a remote Client

### 4.1 Two rules first (R0)

1. **Route by owner, not by recency.** Each node gets an explicit place:
   - The **Host helper:** the node on the Unix socket with the per-launch handshake secret, the `transport === "unix"` path in `issueChallenge`.
   - A **device-bound node:** a node whose device is a paired Client with role `both`, or a node the Client's hub registers under the Client's `deviceId`.

   Then:
   - Host-local features (computer use, Apple connectors, `keychain.*`, Host notifications, Host speech) use **only the Host helper**.
   - Client-local features use **only the calling device's own node**.
   - A WebSocket node that claims `deviceFamily: "mac-helper"` gets kind `remote` (or a new `desktop-client`), never `mac-helper`.

   This replaces every `.at(-1)` selector listed in §2.3.
2. **Split the `desktopShell` gate.** Today one flag means both "the window on the Host" and "a Psyche desktop app". Keep `desktopShell` (loopback and handshake secret) for what must stay on the Host:
   - `devices.bootstrapAdmin`;
   - `attention.report` for the Host's browser pane.

   Add `desktopApp` for a paired, owner-approved device with `deviceFamily: "desktop"`. The approval card says "a computer running Psyche", so the owner's approval is the proof, not a self-declared platform (#278). The client-local paths (dictation and Ask about my screen) accept `desktopApp` with the device's own node, and nothing else.

### 4.2 Feature by feature

**Host** means it runs on the Host, as today, labelled with the Host's name. **Client** means it runs on the Client through a client-side capability. **Off** means it's disabled on a remote Client, with the message shown.

| Feature | Today | On a remote Client | Decision and message | Phase |
| --- | --- | --- | --- | --- |
| Chat, Tasks, Search/⌘K, Home, Library, People, memory, automations, Scheduled, generative UI | Gateway | **Host** | Unchanged. Streaming goes over the WS. | R1 |
| Model calls, routing, API keys | Gateway | **Host** | Keys stay in the Host's environment or vault, and the Client never sees them. | R1 |
| CLI providers (Claude Code harness, `packages/harnesses`) | Gateway host | **Host** | They run and log in on the Host. Settings says "Signed in on studio-mac", and signing in opens the Host's terminal (below). | R1 |
| Non-Apple connectors (Google, Microsoft, IMAP/JMAP, MCP, web) | Gateway | **Host** | OAuth consent needs a browser **on the Host**, because the PKCE loopback redirect goes to the Host's `127.0.0.1`. On a Client, **Connect** says "Finish signing in on studio-mac" and puts the card in the Host's inbox. Device-flow connectors can finish on the Client (open question 6). | R1 |
| Apple connectors (Notes, Messages, Mail, Calendar, Reminders, Contacts, Things, Shortcuts) | Host helper | **Host** | They read the Host Mac's apps through the Host helper, which needs the Host's app or helper running. A Linux Host shows them as "Only on a Mac host". The Client's own Apple apps are **never** used: the brain's data is the Host's. | R1 |
| Vault, credential fill | Gateway; key slot from the Host's Keychain/helper or `safeStorage` (`compose/vault.ts`) | **Host** | The Client never holds the vault key and never unlocks it. "Unlock" on a Client asks the Host to prompt (Touch ID on the Host) or says "Unlock on studio-mac". Filling into a browser is **Off** until the browser runs on the Client (R4, open question 4). | R1 |
| Sandbox, exec on host (#967) | Gateway host | **Host** | Labelled "runs on studio-mac". `exec_host` approvals stay `deviceOnly` (§6.2). | R1 |
| Terminal pane | Gateway (`terminal.session.*`: the Gateway runs the PTY) | **Host** | Titled "Terminal on studio-mac". The shell runs on the Host and streams over the Gateway socket (R4, built): admin scope plus fresh presence (the desktop shell on the Host while no verifier exists), one device per session, a cap per device, killed when the device is gone past a short grace or revoked, open and close audited, contents never logged. The client never spawns anything. | R4 |
| Built-in browser (agent browser, signed-in profile, background browser #996/#1036) | The Host's desktop window, over `$PSYCHE_HOME/run/browser-bridge.sock` (`apps/desktop/src/main/bridge/bridge-client.ts`) | **Host** for tasks; **Off** as a pane on the Client in R1 | Browser tasks keep running in the Host's app (background mode), which must be open on the Host. The Client's browser pane says "The browser runs on studio-mac" and shows the tab list read-only. **R4 option:** carry `bridge.*` over the WS so the Client's own window serves the CDP bridge for a task the owner starts there, with cookies kept on the Client (open question 4). CDP is chatty, so this needs a latency spike over a real tailnet. | R1 (Off), R4 |
| Computer use (J1–J6) | Host helper | **Off** on the Client in R1 | Driving a Mac nobody can see is unsafe, and the Host's screen may be locked. The message: "Computer use works at studio-mac. Ask from there, or use the browser." Tasks that started at the Host and need it keep working there. R4 may add computer use on a Client Mac through its own helper, owner-enabled, with the same tiers and caps. | R1 (Off), R4 |
| Ask about my screen | Host helper captures; `screen.capture` needs `desktopShell` (`compose/screen-ask.ts`) | **Client** in R4; **Off** before that | It must capture the **Client's** screen. The Client captures locally (its own helper on a Mac, `desktopCapturer` on Windows), uploads the frame as a held capture, and the Host does the rest, as today. Before R4: "Ask about my screen isn't available when connected to another computer yet." | R4 |
| Dictation in the composer | Renderer mic → speech (`packages/speech`, engine order `mac-node → whisper → web-speech`) | **Client** mic → **Host** STT | The renderer streams audio to the Host's whisper engine. It must not pick the Host helper's `speech.*`, which would listen to the Host's microphone. A Client Mac may transcribe locally with its own helper in R4. | R1 |
| System-wide dictation (hold-to-talk, insert into any app) | Host helper key watch and insert; `desktopShell` gate | **Client** in R4 (Mac: Client helper; Windows: later, with the Windows helper) | The key watch and text insert must run where the owner types. Until then: "System-wide dictation needs Psyche on this computer." | R4 |
| Voice mode | Renderer mic, Gateway pipeline | **Client** mic → **Host** | Same as composer dictation. Latency over the tailnet is measured in R1. | R1 |
| OS notifications | Host helper `notify.*`, Electron fallback (`apps/desktop/src/lib/notify-relay.ts`) | **Client** | Add the device surface `device:<deviceId>`, the same surface family as `push:<deviceId>` in the [mobile doc §3.4](mobile-companion-2026.md#34-where-it-plugs-in). The Client shows OS notifications through Electron `Notification` (a Windows toast, Notification Center on a Mac) for events it receives while connected. They never carry Approve buttons: a click opens the card, as the fallback already does. Quiet hours and interruption levels apply. The Host still notifies its own screen. | R2 |
| Pop-up chat (quick entry), shortcuts, tray, window chrome | Desktop main | **Client** | Pure UI. Settings for them become per-computer (§4.4). | R1 |
| Permissions page (TCC) | Desktop `permissions/permissions.ts`, local | **Client** (for its own app) + **Host** (read-only status) | It shows "On this computer" (the Client's microphone and notifications) and "On studio-mac" (from `permissions.*` through the Host helper, read-only). Granting a Host permission needs the Host. | R1 |
| Logs viewer, "Show logs" | The Gateway reads `$PSYCHE_HOME/logs`; the desktop opens the folder | **Host** viewer; **Off** for "Show in Finder" | The viewer works over the WS. Revealing a Host folder can't work, so that button is hidden. | R1 |
| Backups, updates of the Host | Host | **Host** | The Client shows the Host's version and "Update available on studio-mac", but never updates the Host itself. | R1 |
| Updates of the Client app | Desktop updater (darwin, Squirrel.Mac) | **Client** | As today on a Mac; Squirrel.Windows on Windows (§5). | R1 / R3 |
| Folder access ("Share a folder", `folder_access` approvals) | Native picker on the same Mac (`IPC.dialogPickFolder` → `realpath`) | **Off** in R1, **Host** picker in R4 | A path picked on the Client means nothing on the Host. The Client hides "Share a folder", and a `folder_access` approval says "Choose the folder on studio-mac". R4 adds a Host folder browser: an admin-only method with fresh presence that lists folder names under the Host user's home and grants the path the Gateway resolves, never a typed string. | R1 (Off), R4 |
| VM mode | Host helper | **Host** | Status only on the Client. Start and stop need admin. | R1 |

### 4.3 Files and attachments

- **Up:** dragging or picking a file on the Client reads it in the main process and sends it through `library.upload` in 600 KB chunks with `threadId`, as the phone's share sheet does. That's about 33% base64 overhead, which is fine on a tailnet.
  - Show progress, and allow cancelling.
  - Cap one upload at the Library's existing limit.
  - Uploads count as files the owner added, under the same taint rules as on the Host (§6.1).
- **Down:** **Open** on a Library item or a granted-folder file streams it through `files.read` (chunked, `etag` checked) into a per-Gateway cache under `userData`, then opens it with the Client's default app. **Save as…** writes it where the owner picks. Cached copies expire after 7 days and are wiped by Forget this Gateway.
- **Viewers in the app** (PDF, images, sheets) already read through the Gateway, so they work unchanged.
- **Reveal in Finder** and "Open the folder" are hidden for Host paths. The window shows the Host path as text ("on studio-mac: ~/Documents/Taxes").
- **Downloads from the agent's browser** stay on the Host, quarantined as today (`apps/desktop/src/main/browser/downloads.ts`), and appear in the Library, where the Client can open them.

### 4.4 Settings that belong to the computer

Zoom, window theme, "show in Dock", "open at login", the pop-up and dictation shortcuts and the menu-bar icon describe **the computer the app runs on**, not the brain. Today they are Gateway settings (`appearance.*`, read by `zoom.ts`, `window-theme.ts`, `dock-policy.ts`, `login-item.ts`).

R0 moves them to per-device keys (`device.<deviceId>.appearance.*`), with today's values migrated to the Host's own desktop device. A Client then has its own values, which it keeps on the Gateway with its device so they survive reinstalls. A Client never applies the Host's Dock policy. Settings marks these "On this computer". The [settings redesign](settings-2026.md) owns the layout.

### 4.5 Latency, offline and reconnection

- **Latency:** a tailnet round trip is about 1–5 ms on the LAN and 20–150 ms away from home (Tailscale DERP relays add more when a direct path fails).
  - Chat streaming, lists and Search are request/response or server-pushed, and unaffected.
  - ⌘K search-as-you-type keeps its debounce, and shows the last results while a newer query is in flight.
  - Voice and dictation get a measured budget in R1: speech start to first partial within 800 ms over a DERP path, or the composer warns "Slow connection".
- **Offline:** when the Host is unreachable, the existing banner from [redesign §offline](redesign-2026.md) appears ("Psyche can't reach studio-mac. Tasks keep running there; this window will reconnect.").
  - Lists stay readable from the renderer's last state, marked as stale.
  - The composer is disabled in R1. An outbox for `chat.send` (it already takes an `idempotencyKey`) is shared with the phone's outbox ([mobile §2.3](mobile-companion-2026.md#23-background-reconnection-and-offline-work)) and arrives in R2.
  - Approvals are never queued: the card says "Reconnect to answer".
- **Reconnection:** the existing jittered backoff, plus a reconnect on `powerMonitor` resume and on a network change. After reconnecting, a moved `stateVersion` refetches the visible lists (N14). A Host that answers with a different identity key stops the reconnect loop (§4.6).
- **Sleep:** if the Host sleeps, nothing answers. The Host setup recommends "Prevent automatic sleeping when the display is off" for a desktop Mac, and Psyche doesn't wake it.

### 4.6 Startup and the splash when the Host is unreachable

In Remote mode the splash ([splash-2026.md](splash-2026.md), `StartupSplash.tsx`) shows the same moth and steps, with different lines:

1. "Finding studio-mac…": DNS for the MagicDNS name, then `GET /healthz`.
2. "Checking it's really studio-mac…": the identity pin (§3.3).
3. "Waiting for approval on studio-mac…" (first pairing only), with the code and the fingerprint.
4. The hand-off into the app, as today.

When a step fails, the splash becomes a full-window state with one cause and its own actions. It never shows a spinner forever.

| Cause (how it's told apart) | Message | Actions |
| --- | --- | --- |
| Tailscale not running or logged out on the Client (the name doesn't resolve, and `tailscale status` reports stopped) | "Tailscale is off on this computer." | **Open Tailscale**, **Try again** |
| The name resolves, but there's no answer after 10 s | "studio-mac isn't answering. It may be asleep or off, or Psyche isn't running there." | **Try again** (auto-retry with backoff keeps going), **Switch Gateway**, **Use This Mac** (only on a Mac with a local Gateway) |
| TLS or identity mismatch | "This isn't the studio-mac you paired with." | **Switch Gateway**, **Forget and pair again**. There is no "continue". |
| `protocol_version_mismatch` | "studio-mac runs an older Psyche (1.4). Update it there." or "This app is older than studio-mac. Update this app." | **Update this app** (when it's the Client), **Switch Gateway** |
| Revoked (`denied` for a known device) | "This computer was removed from studio-mac." | **Pair again**, **Forget** |

Once the app has been paired, a slow Host doesn't block the window: after 3 s the shell opens with the offline banner and the last state, and keeps reconnecting.

### 4.7 Version skew

The renderer ships inside the Client, so a Client can be newer or older than the Host.

- The Gateway already negotiates one protocol version.
- The policy: a Client supports the Host's protocol version and the one before it. The method catalogue is checked at connect, so a method the Host doesn't know is hidden in the UI rather than failing on click.
- Codegen keeps this cheap. The rule is documented in `packages/protocol/README`.

## 5. Windows client

A client-only Windows build is much smaller than the full Windows port in [cross-platform-2026.md](cross-platform-2026.md). It needs no Gateway supervisor, no named pipes, no Windows helper and no sandbox detection, because all of that stays on the Host.

### 5.1 What it takes

| Item | Work |
| --- | --- |
| **Build target** | A `client-only` packaging profile in `apps/desktop/forge.config.ts`: no bundled `psyched`, no `mac-helper`, no launchd plist. Add Forge `maker-squirrel` for `win32-x64` (and `win32-arm64` once CI has a runner). Mac builds keep both profiles. A Mac client-only build is optional: the full Mac app can run Remote. |
| **Signing** | Authenticode, with a certificate or Azure Trusted Signing (a SmartScreen reputation risk, see cross-platform §7). Signing keys live in CI secrets, as Apple's do. |
| **Updates** | A per-platform artifact map in the signed update manifest (`apps/desktop/src/main/update-manifest.ts`), plus the Squirrel.Windows apply path. Verification (Ed25519, sha256, downgrade refusal) is unchanged. |
| **Supervisor** | `remote` mode only. `chooseMode` returns `remote` on win32 whatever `PSYCHE_GATEWAY_MODE` says. |
| **Protocol** | Add `windows` to `DevicePlatform`. `platformFromNode` maps `win32 → windows`. Run `pnpm protocol:gen`. |
| **Device key** | Wrapped with `safeStorage` (DPAPI). The file stays under `%APPDATA%\Psyche`. |
| **Notifications** | Electron `Notification` (toast). The installer sets the AppUserModelID. |
| **Quick entry** | Default `Ctrl+Alt+Space`, because `Alt+Space` opens the Windows system menu. It can be rebound. |
| **Presence** | A passkey through Chromium's Windows WebAuthn (Windows Hello). Electron's support for platform authenticators needs a spike. Without it, `deviceOnly` approvals say "Answer on studio-mac". |
| **Dictation** | Composer dictation through the renderer mic and the Host's whisper. Electron has no Web Speech backend, so that fallback is off. System-wide dictation waits for the Windows helper. |
| **CI** | A `windows-latest` job: typecheck and unit tests for `apps/desktop`, `apps/web` and `packages/ui`, and the client-only package build. An Electron smoke test that connects to a mock Gateway (`packages/testing`) and pairs. |

### 5.2 macOS-only paths that need guards

Each needs a guard in the client-only and win32 paths, and preferably goes through the single platform module that cross-platform §4.4 item 2 proposes:

| Path | What it does today | Client-only / Windows behaviour |
| --- | --- | --- |
| `apps/desktop/src/main/supervisor.ts` | `launchctl`, `xattr`, `~/Library/LaunchAgents` | Not constructed. `remote` mode never runs a command. |
| `bundledHelperPath()` and `main/helper-launcher.ts` | Starts the Mac helper through LaunchServices, `codesign` | Skipped. The helper port is absent. |
| `main/bootstrap-admin.ts` | `devices.bootstrapAdmin` on first run | Skipped in Remote mode (the Gateway refuses it off-loopback anyway). |
| `main/updater.ts` | darwin-only Squirrel.Mac, `/usr/bin/codesign -dvv` | Branches by platform. Squirrel.Windows on win32. |
| `main/tray.ts`, `app.dock`, `main/dock-policy.ts`, `window-all-closed` | Menu bar, Dock | A system tray icon on Windows. No Dock code. Closing the last window quits unless "Keep Psyche in the tray" is on. |
| `main/glass.ts` | `electron-liquid-glass`, `/usr/sbin/screencapture` | Off. |
| `main/windows.ts` | Inset title bar and traffic lights on darwin | Already branched (native chrome). Check the toolbar's drag regions. |
| `main/permissions/permissions.ts` | TCC probes | Shows microphone and notifications only. |
| `main/browser/downloads.ts` | Quarantine `xattr` | Not reached: no browser on a Client in R1. |
| `lib/real-chrome.ts` | `open -n -a "Google Chrome"` | Not reached in R1. |
| `main/screen-ask/*`, `main/dictation/*` | Helper-driven | Not constructed until R4. |
| `main/terminal.ts` | Host shell through the Gateway | Refused in remote mode (`terminalOpen`). The pane uses `terminal.session.*` over the Gateway socket instead (R4); the PTY runs on the Host. |
| `packaging/bundle-resources.ts` | Mach-O checks, `codesign` | Skipped in the client-only profile. |
| `lib/device-key.ts` `platformFromNode` | darwin → macos, else linux | win32 → windows. |
| `packages/ui` shortcuts | Cmd vs Ctrl | Already handled. Check the labels ("⌘K" → "Ctrl K"). |
| Copy that says "this Mac" | Onboarding, Settings | Says "this computer" in Remote mode, and names the Host for Host-side things. |

## 6. Security

### 6.1 Taint stays absolute

- **The Gateway decides taint, on the Host,** as today. The Client never marks content trusted and never sends a trust level. This is the same rule the side chat follows ("trust never comes from the window", [redesign §⌘L](redesign-2026.md)).
- **Uploads** from the Client are files the owner added, handled exactly as an upload on the Host.
- **Client-captured screens** (R4) are tainted exactly like Host screen captures today.
- **Client node results** (R4) are tool output like any other node's, under the broker's rules.
- **A Client can't widen what a tainted turn may do,** because approvals, grants and the broker all run on the Host.
- **Client capabilities are never agent-invokable for capture.** The screen and the microphone are captured only when the owner starts it on the Client (a shortcut or a button). The Host can't call `node.invoke` for `screen.capture` or audio on a Client, because the Client hub refuses it. Only `notify.show` is Host-initiated.

### 6.2 Approvals and where they're answered

- **A Remote Client is a device surface,** so it gets approval cards like the Host's window. The first answer wins, the single-use `answerToken` and the 400 ms arming delay apply, and answering anywhere clears the card everywhere (N14).
- **`write` kinds:** answerable on a Client with `operator.approvals`.
- **`deviceOnly` kinds** (`financial`, `credential_fill`, `exec_host`, `policy`, `pairing`) need a presence assertion:
  - **Client Mac:** R2 registers a presence key for the Client device. In R2 that is a passkey in Electron, created with Touch ID. In R4 it can be the Client helper's Secure Enclave key, registered through `devices.presenceKey.register` against the Client's own node.
  - **Windows:** a passkey through Windows Hello (spike, §5.1).
  - **No presence key:** the card shows its full arguments and "Answer on studio-mac or a device with Touch ID". It never shows a weaker Approve.
- **Proposed default:** approvals answered from a remote device always need presence, for `write` kinds too, whenever that device has a presence key (open question 3). A stolen, unlocked laptop then can't approve anything without the owner's finger.
- **`folder_access`** is answered on the Host until the Host folder browser exists (§4.2).
- **Pairing approvals** for further devices are `deviceOnly` and need admin, so a Client without admin can't add more devices.

### 6.3 Exposing the Gateway

- **The Gateway never listens off loopback in this plan.** Tailscale Serve is the only way in, and `config.ts` keeps refusing non-loopback binds outside the container mode.
- **Funnel must stay off.** Funnel would publish the Gateway on the internet. `psyche doctor` and `psyche security audit` read `tailscale serve status --json` and flag it as critical. The setup panel never offers Funnel.
- **Who on the tailnet can reach it.** Every device on the tailnet can reach port 443 on the Host, including shared nodes and other users of a shared tailnet. They still can't do anything without an approved pairing: there are no bearer tokens, every connect is signed, failed challenges are rate-limited (`rate-limit.ts`) and pending requests are capped (`auth.ts`). Defense in depth:
  - **Tailscale ACLs:** the setup guide suggests a `tag:psyche` grant to the owner's own devices only, on port 443.
  - **`gateway.trustedProxy.allowedLogins`** (new, R2): a forwarded connection whose `Tailscale-User-Login` isn't on the list is refused at the transport. This only narrows who may try, and never authorizes anyone. Every device still pairs.
- **What leaks before pairing:** only `/healthz`, `/version` and the static web client. `/version` shows the Gateway and protocol versions to anyone who can reach it. **Decision (R1, 2026-11-04): `/version` stays unauthenticated.** It returns only `{name, version, protocolVersion}`. A test pins that it never carries the host name, a path or the identity key. The same two numbers go to any caller of `connect` (scope `none`) in `protocol_version_mismatch`, so requiring pairing for `/version` would hide nothing, and a client needs them before it is paired to say "Update Psyche on studio-mac" or "Update this app". Tailscale ACLs narrow who can reach it at all.
- **The SSH tunnel path** is as safe as the owner's SSH setup. The identity pin protects against a tunnel to the wrong machine.

### 6.4 A lost or stolen Client

| Before revocation | Mitigation |
| --- | --- |
| The thief has the device key (wrapped by Keychain or DPAPI, readable once the OS user is logged in) and can connect as the Client. | **No admin by default** (§3.5). **Presence for every approval from a remote device** (§6.2). An idle check in `psyche security audit` flags remote devices not seen for 90 days, and an optional auto-revoke follows (open question 7). |
| The thief can read chat, memory and Library through the app, and send messages. | The same as a stolen phone or a stolen Host login. The Client keeps no offline copy of the data beyond the renderer's recent state and the 7-day file cache. |
| The thief can't reach the vault, change security settings, pair devices or approve `deviceOnly` kinds without the owner's presence. | Existing presence gates. |

**Revoking:** from the Host or any admin device (Settings → Devices → the Client → **Remove**), or with `psyche devices revoke` in the Host's terminal. This closes its connections at once and deletes its presence key and node authority. Removing the Client from the tailnet in the Tailscale admin console also cuts the path, and the setup guide says so. The [mobile doc §5](mobile-companion-2026.md#5-security) uses the same flow for a lost phone.

### 6.5 Things that don't change

- Logs stay metadata-only.
- The device key never reaches the renderer.
- The Gateway address never comes from a link or the renderer.
- The browser bridge and the node socket stay Host-local Unix sockets.
- Nothing in this plan needs, contacts or depends on a server run by anyone but the owner, apart from Tailscale's own coordination and DERP service. The owner already chose Tailscale.

## 7. Phased plan

Sizes are for one session: **S** is a few days, **M** one to two weeks, **L** three weeks or more.

| Milestone | Scope | Size | Tests and acceptance |
| --- | --- | --- | --- |
| **R0: routing and gates** (no visible change) | Node placement: Host helper vs device-bound nodes, replacing the `.at(-1)` selectors (§2.3, §4.1). WebSocket nodes never get kind `mac-helper`. The `desktopShell` / `desktopApp` split. Per-device appearance settings with migration (§4.4). `windows` in `DevicePlatform`. The client checks `serverOrigin` against the dialed origin. | M | Gateway unit tests: (1) with two live `mac-helper`-family nodes, one on the Unix socket and one over WS, computer use, Apple connectors, `keychain.*` and notifications go only to the Unix one; (2) a WS node that claims `mac-helper` is stored as `remote`; (3) `screen.capture` and `dictation.*` refuse a paired non-desktop device and a desktop device with no node; (4) two devices keep separate zoom and Dock values; (5) a challenge whose `serverOrigin` differs from the dialed origin makes the client stop before signing. |
| **R1: Mac remote client over Tailscale Serve** | Gateway identity key and challenge signature, plus the pin in the client. **Shared with mobile M1, built once.** The `remote` supervisor mode, `gateways.json`, a device key per Gateway, the switcher (avatar menu, tray, Settings), and per-Gateway renderer storage. The Add a Gateway sheet (address, tailnet list, code pairing). The splash and unreachable states (§4.6). Host labels and Off states for every row in §4.2 marked R1. Upload and download with a cache (§4.3). Host "Allow other computers" (§3.1), plus the `doctor` checks for Serve and Funnel. Guide: `docs/guides/remote-gateway.md`. | L | Two-Mac test on a real tailnet: (1) pair a second Mac by code in under 2 minutes, with the approval and Touch ID on the Host; (2) a Gateway answering with another identity key is refused, and so is an SSH tunnel to a different Gateway; (3) chat streams, a Task runs, and an approval answered on the Client clears on the Host; (4) Host asleep: the splash shows "isn't answering" within 10 s, and the Client recovers by itself on wake; (5) switching between This Mac and the remote Gateway leaves no draft, thread or zoom value from one in the other; (6) Ask about my screen, system-wide dictation, the browser pane, computer use and Share a folder each show their message, and none reaches the Host's screen, microphone or folders; (7) a 50 MB PDF uploads, then opens from the Library on the Client; (8) revoking the Client on the Host shows "removed" on the Client within 2 s. Automated: an Electron e2e test against the mock Gateway in Remote mode with a fake identity key. |
| **R2: pairing links, presence and notifications** | `psyche-pair:v1` links and QR (shared with mobile), the setup token. The `device:<deviceId>` notification surface and Client toasts. Client presence through a passkey (Touch ID in Electron). Presence for all approvals from remote devices (if the owner agrees). `trustedProxy.allowedLogins`. A `chat.send` outbox shared with the phone. Security audit checks: remote device with admin, remote device idle 90 days, Funnel on, Gateway identity key missing. | M | (1) Pairing from a pasted link needs no typing, and a link older than 10 minutes is refused; (2) a `financial` approval on a Client with a passkey needs Touch ID, and without one it shows "Answer on studio-mac"; (3) an approval created while the Client is in the background shows a toast within 5 s, and clicking it opens the card; (4) quiet hours defer a `passive` toast; (5) a tailnet login not on `allowedLogins` gets no WS upgrade; (6) a message sent offline is delivered exactly once after reconnecting. |
| **R3: Windows client-only build** | Everything in §5: the client-only Forge profile, Squirrel.Windows, Authenticode, the update artifact map, the guards, DPAPI key, toasts, Windows Hello passkey (spike first), the `windows-latest` CI job. | L | On Windows 11 over Tailscale: (1) a signed install, no SmartScreen block for the signed build; (2) pair, chat, Tasks, Search, Library and approvals as in R1; (3) composer dictation through the Host's whisper; (4) an update from N to N+1 through the signed manifest, and a downgrade is refused; (5) no macOS path runs (CI asserts no `launchctl`, `codesign`, `xattr` or `open -a` spawn under win32); (6) `devices.list` on the Host shows `platform: windows`. |
| **R4: features on the Client** | A Client node hub (the `apps/node` helper-hub pattern inside the desktop main), registered under the Client's device with the `node` scope. On a Mac: the Client helper for Ask about my screen, system-wide dictation, local STT and a Secure Enclave presence key. On Windows: `desktopCapturer` screen-only Ask about my screen. The Host folder browser for folder grants. Optional: the browser bridge over the WS, and computer use on a Client Mac (each needs its own owner decision). | L | (1) Ask about my screen on a Client captures the Client's screen, never the Host's (a test with two live nodes); (2) the Host can't trigger a Client capture through `node.invoke` (the hub refuses it); (3) dictation inserts into the app focused on the Client; (4) revoking the `node` scope stops client capabilities at once and leaves the client role working; (5) a folder granted through the Host browser is the resolved Host path, and a typed path is refused. |

**Order and dependencies:**

- R0 must land before anything else, because it fixes a real routing bug.
- R1's identity-key work is the same work as mobile M1's. Whichever starts first builds it, and the other reuses it.
- R3 can start once R1 is done, alongside R2.
- R4 depends on the cross-platform neutral capability names (cross-platform Phase 2) for the Windows part.
- The settings redesign owns the Settings → Devices layout. This plan only adds rows to it.

## 8. Owner decisions (2026-11-03)

The ten questions this section asked, with the owner's answers. Two differ from the recommendation (G3, G10).

| # | Question | Decision |
|---|---|---|
| G1 | Admin on a remote computer by default? | **No.** Admin stays an opt-in checkbox when pairing, with presence on every admin change. Some Settings changes then need the Host. |
| G2 | This Mac's own Gateway after switching to a remote one? | **Keep it running** (its automations continue) and offer to stop it. |
| G3 | Presence for every approval from a remote device? | **Only for risky approvals**, the same rules as on the Host. Ordinary `write` approvals from a remote device don't need Touch ID or Windows Hello. (Differs from the recommendation.) |
| G4 | The agent's browser on a Client? | **Always on the Host**, with the Host's signed-in profile; the Client only watches. R4's client-browser option is dropped, so the vault never sends a password to a Client. |
| G5 | Computer use on a Client Mac? | **No.** Computer use stays on the Host. |
| G6 | OAuth sign-in from a Client? | Connectors with a **device code flow may finish on the Client**; every other sign-in finishes on the Host. |
| G7 | Idle remote devices (90 days)? | **Flag in the security audit** with a Remove button; never revoked automatically. |
| G8 | Windows signing? | **Decide later.** Unsigned development builds until R3 ships. |
| G9 | More than one Gateway open at once? | **One active Gateway per app**, switched from the avatar menu. |
| G10 | Tailscale only, or the LAN too? | **Wait for the LAN too.** The desktop remote client ships when LAN reachability (Bonjour, self-signed certificate and the identity pin, shared with the phone's M1) works, not on Tailscale alone. R1 therefore depends on that LAN work. (Differs from the recommendation.) The Tailscale half of R1 is built and is not behind a flag, so whether to release it before the LAN work is the owner's call. |

## Sources

- In repo: `docs/guides/server-mode.md` (the desktop app section, Tailscale Serve, trusted proxy), `docs/design/mobile-companion-2026.md` (§2 reachability and pairing, §3.4 surfaces, §5 security), `docs/design/cross-platform-2026.md` (§2.3 desktop inventory, §4 platform node, §5 phases), `docs/design/splash-2026.md`, `docs/design/redesign-2026.md` (offline banner, side chat trust), `docs/design/settings-2026.md` (Devices section), `docs/05-security-and-permissions.md` §3.7, §9, §10.
- Code: `apps/desktop/src/gateway-client.ts`, `apps/desktop/src/main/supervisor.ts`, `apps/desktop/src/main/splash.ts`, `apps/desktop/src/lib/device-key.ts`, `apps/gateway/src/auth.ts`, `apps/gateway/src/proxy.ts`, `apps/gateway/src/config.ts`, `apps/gateway/src/nodes/registry.ts`, `apps/gateway/src/compose/{computer,connectors,dictation,speech,screen-ask,attention,bootstrap-admin,vault}.ts`, `apps/node/src/capabilities/helper.ts`, `apps/web/src/client/{connection,handshake}.ts`, `apps/web/src/shell/platform.ts`, `packages/protocol/src/schemas/identity.ts`.
- Tailscale Serve and Funnel: tailscale.com/kb/1312/serve, tailscale.com/kb/1223/funnel. MagicDNS: tailscale.com/kb/1081/magicdns. ACL tags: tailscale.com/kb/1068/tags.
