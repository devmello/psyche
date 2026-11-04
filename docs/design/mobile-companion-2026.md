# Mobile companion: the Gateway as a phone backend

Status: proposal v2 (2026-11-02), revised to the owner's direction. v1 was 2026-10-26. Docs only; nothing here is built. Applies to the Gateway, `packages/protocol`, `packages/notifications`, `apps/web`, and a future native app (iOS first, Android later). The Windows desktop target doesn't change anything here: the phone talks to the Gateway, not to a desktop OS. Linux desktop stays out of scope, although the Gateway still runs on Linux in server mode. The desktop app as a client of a remote Gateway (Mac or Windows over Tailscale) is planned in [remote-gateway-2026.md](remote-gateway-2026.md). It shares this doc's pairing link, Gateway identity key and device surface.

**The owner's question:** can Psyche eventually be the backend for a mobile app that connects to it, with the server sending push notifications and more?

**The owner's direction (2026-11-02):** the phone reaches the Gateway only over the same network or Tailscale. Nobody runs a push relay or any other hosted service for Psyche, and the owner doesn't want to run one. Push comes from the owner's own Gateway. The owner also asked for Live Activities and lock-screen approvals.

**The short answer:** yes. Most of the backend already exists. The phone becomes one more paired device on the same WebSocket protocol, with owner-chosen scopes, and it can use the generated Swift types directly. The plan:

- **Now (M0):** ship the PWA with Web Push. No credentials are needed and nothing new runs anywhere. This stays the zero-setup fallback for everyone.
- **Then (M1):** ship a native iOS app over the existing protocol. It connects over the LAN (Bonjour, with the Gateway's identity key pinned) or over Tailscale (`*.ts.net` through Tailscale Serve). Those are the only two supported paths.
- **Then (M2):** push without a relay. The Gateway calls APNs directly with the owner's own `.p8` key from their Apple Developer account, for the owner's own build of the app. Payloads stay end-to-end encrypted, so Apple sees only ciphertext. This also brings lock-screen Approve / Deny and Live Activities.
- **Then (M3):** the phone becomes a node (location, photos, contacts, calendar).

**What this costs, said plainly:** each owner who wants push on iOS needs a paid Apple Developer account ($99/year) and builds the app under their own team. Psyche doesn't distribute a store build that anyone else can use, and App Store distribution to other people is out of scope for now. Owners without an account still get Web Push through the PWA, with fewer features (§3.2).

---

## 1. What exists and can be reused

All of the following was checked in code on `main` (3fe15f9e).

| Piece | Where | State | What the phone reuses |
| --- | --- | --- | --- |
| WS protocol, pairing, scopes | `packages/protocol/src/methods/connect.ts`, `methods/devices.ts`, `common.ts` (`DeviceScope`) | Built | `connect` → 60 s nonce → Ed25519 signature over `psyche-connect-v1 \n nonce \n platform \n deviceFamily \n protocolVersion \n serverOrigin` → `paired` / `pending` (owner approves a code) / `denied`. Scopes are `operator.read`, `operator.write`, `operator.approvals`, `operator.admin` and `node`. The owner chooses them, never the client. `DevicePlatform` already has `ios` and `android`. `devices.revoke` closes connections and kills node authority. |
| Swift codegen | `packages/protocol/generated/swift/PsycheProtocol.swift` (~27k lines, quicktype, `Codable` + `Sendable` + `public`) | Built; the mac helper consumes a copy | Ship it as a Swift package. Known limits (`generated/README.md`): object unions such as `Frame` and `ConnectResult` become one struct, so switch on `type` / `phase` / `ok` first. Untyped JSON is `JSONAny`. |
| Web client (A8) | `apps/web`, `apps/web/src/platform.ts` | Built; works at phone widths | The whole UI over `location.origin`. Notifications stay in the in-app inbox: the code itself says "Web Push is a follow-up". Passkeys use `navigator.credentials` in a secure context. |
| Server mode (N12) | `docs/guides/server-mode.md`, security §10 | Mostly built | Loopback bind only; Tailscale Serve, Cloudflare Tunnel + Access (JWT verified against JWKS; **not supported for the phone**, §2.1) or an SSH tunnel; passkeys (`passkeys.*`) as presence proof. **TLS pinning for mobile clients is specified but not built**: the audit lists "missing TLS pins" as "not checked yet", and no SPKI code exists. |
| Multi-client consistency (N14) | `apps/gateway/src/state-version.ts`; frames carry `seq` + `stateVersion` | Built | Events are not replayed. A client that missed some refetches when `stateVersion` has moved. This fits a phone that is suspended most of the time. |
| Notifications | `packages/notifications` (`notifier.ts`, `routing.ts`, `surfaces.ts`) | Built | `SurfaceAdapter { name, handles(surface), deliver(n, ctx) → delivered / failed(retryable) / suppressed }`. Durable inbox, per-surface delivery records, retries, quiet hours, interruption levels (`passive` / `active` / `timeSensitive`) and de-duplication. `toNotifyShowParams` already maps actions to `destructive` / `authenticationRequired` / `textInput`, which is exactly what `UNNotificationAction` needs. |
| Approvals | `schemas/permissions.ts` (`ApprovalAnswer`, `PresenceAssertionSchema` kinds `webauthn` / `helper`), `methods/approvals.ts` | Built | A single-use `answerToken` per surface; the first answer wins; there is a 400 ms arming delay; `deviceOnly` kinds (`financial`, `credential_fill`, `exec_host`, `policy`, `pairing`) never reach chat. The channel surface already suppresses them (`surfaces.ts`). |
| Presence keys | `devices.presenceKey.register` (reads `presence.public_key` from a connected node) | Built for the mac helper's Secure Enclave key | The same mechanism works for a phone that pairs with the `node` role (§5). |
| Interim phone surfaces | Telegram (inline buttons), iMessage via the Mac node (polls or 👍/👎) | Built | They work today with no app, but carry the chat limits of security §9: no presence proof and no `deviceOnly` kinds. |
| Upload | `library.upload` (chunked base64, at most 600 KB per chunk, optional `threadId`) | Built | The share sheet (§4). |
| Mac-helper capability names | `contacts.*`, `calendar.*`, `notify.*`, `presence.*` | Built | The phone node reuses the same names where the meaning matches (§4). |

**Gaps this design fills:** Web Push; a device-token registration method; a `push:<deviceId>` surface; Gateway identity pinning (§2.2); direct APNs sending with the owner's own key (§3.3); Live Activities (§3.6); a phone node; and a one-shot signed answer path for lock-screen actions (§3.5).

## 2. Reachability

### 2.1 Transports

The phone talks to the Gateway over exactly two paths. Anything else is not supported.

| Path | How the phone reaches the Gateway | Verdict |
| --- | --- | --- |
| **Tailscale** (tailnet + Serve) | The Tailscale iOS app, plus the Gateway's `https://<host>.<tailnet>.ts.net` through Tailscale Serve | **Supported, and the recommended path.** Private, no public ingress, real TLS. It works from anywhere. Lock-screen approvals depend on Tailscale reconnecting on demand when the app launches in the background (§3.5). That behavior must be verified on a real phone in M1. |
| **LAN** | `https://<mac>.local:7979` via Bonjour | **Supported, at home.** There's no public certificate, so the app relies on the Gateway identity-key pin from §2.2. iOS asks for the Local Network permission. Away from home the phone can't reach the Gateway, so the app shows "Reconnect to answer" on approvals and relies on the push inbox when it comes back. |
| **Cloudflare Tunnel + Access** | Public hostname, Access in front | **Not supported for the phone.** v1 of this doc proposed it, but it needs a browser login in `ASWebAuthenticationSession` and cookie handling that nobody has tested. The server-mode guide for desktop browsers is unchanged. |
| **Publisher-run traffic relay** (a TURN-like tunnel) | Phone → relay → Gateway | **Not supported, not planned.** It would make the publisher a hub for all traffic and run infrastructure the owner doesn't want. If someone can't set up Tailscale, the answer is the LAN. |

### 2.2 Pairing with a QR code

Psyche's own UI already lets the owner approve a code on a paired device; mobile keeps that and adds a QR code for convenience.

1. On an admin device, **Settings → Devices → Add phone** shows a QR code: `psyche-pair:v1` with `{gatewayUrl, gatewayIdentityKey, spkiPins[], setupToken}`. (As built for the desktop in R2, the link is `{gatewayUrl, gatewayFingerprint, setupToken, hostName}` with the key's `sha256:` fingerprint in place of the key, made under Settings → Server & remote access → Pair another computer, and the parser refuses any other field: `spkiPins[]` needs a new link version. The phone reuses `packages/protocol/src/pairing-link.ts`, presents the token in `connect.verify` with a v2, key-bound connect, and gets the Host's auto-approval with the scopes chosen when the token was made.) The same payload, pasted as a link, pairs a remote desktop ([remote-gateway-2026.md §3.4](remote-gateway-2026.md#34-pairing-a-new-computer)). The setup token is the single-use, 10-minute bootstrap token that security §10 already specifies.
2. The app scans the QR code **with its own scanner**. It is not a universal link or deep link: the CVE-2026-25253 rule ("no `gatewayUrl` query or deep-link parameter") still holds. The app shows the host and asks "Connect to `psyche.tailnet.ts.net`?".
3. The app generates its Ed25519 device key, runs `connect` and gets `pending`. The setup token lets the Gateway mark the request as expected. The owner still approves the request and its scopes on the admin device. The default scopes for a phone are `operator.read`, `operator.write` and `operator.approvals`, without `admin`.
4. **Pin the Gateway, not the certificate.** Tailscale rotates leaf certificates, so pinning the SPKI alone breaks on every renewal. Add a long-lived **Gateway identity key** (Ed25519, kept in `$PSYCHE_HOME`). The Gateway signs `{nonce, serverOrigin, devicePublicKey}` in its `connect` challenge, and the app refuses a signature from any key other than the pinned one. SPKI pins become an optional extra layer for LAN setups, where the certificate is self-signed. This closes the N12 "TLS pinning for mobile clients" item in a way that survives certificate rotation. The remote desktop client uses the same key and challenge signature ([remote-gateway-2026.md §3.3](remote-gateway-2026.md#33-the-gateway-identity-key-shared-with-the-phone)), so it is built once for both.

**Passkeys:** a native app can only use passkeys for a relying party it holds an associated-domains entitlement for. The owner's Gateway hostname is different for every install, so **the native app can't use the Gateway's passkeys.** It proves presence with a Secure Enclave key instead (§5). Passkeys stay the PWA's presence proof.

### 2.3 Background reconnection and offline work

- **iOS suspends sockets** soon after the app is backgrounded. The design accepts that: the WS is a foreground connection, and push (§3) covers the background.
- **On the foreground event:** reconnect with jittered backoff (0.5 s → 30 s), then `connect` and `connect.verify`. Compare `stateVersion` with the last one seen. If it moved, refetch the visible lists (`approvals.list`, `notifications.list`, the open thread). This is the same N14 path the web client uses (`onResync`).
- **Push as a hint, not as state:** a push says something changed. The app always fetches the truth from the Gateway, and a decrypted push body is only for display.
- **Offline outbox:** keep a durable queue in the app group for user-originated, idempotent writes: `chat.send` (it already requires an `idempotencyKey`), `library.upload` chunks, mark-read. The app flushes the queue in order on reconnect.
- **Not queued:** approvals. `approvals.answer` isn't idempotency-keyed, the token is single-use and the approval can expire. While offline, or on a LAN-only setup away from home, the card (and the lock-screen notification, §3.5) says "Reconnect to answer".

## 3. Push notifications

### 3.1 The constraint, and how we live with it

APNs authenticates with a `.p8` key that belongs to one Apple developer team and one bundle id (`apns-topic`). A self-hosted, open-source Gateway can't ship with such a key, because the publisher's key would be revoked within a day. Most self-hosted projects solve this with a relay run by the publisher. **Psyche doesn't.** The owner doesn't want to run infrastructure, so the key belongs to the person whose Gateway sends the push: the owner creates a `.p8` key in their own Apple Developer account, builds the app under their own team and bundle id, and gives the key to their own Gateway. No third party sits between the Gateway and Apple.

### 3.2 Options

| Option | How it works | Verdict |
| --- | --- | --- |
| **A. Publisher-run stateless relay** (Home Assistant, Bitwarden, Matrix Sygnal, ntfy upstream) | Gateway → publisher's relay → APNs/FCM → phone. The relay holds the `.p8`. | **Not planned.** It works for store users with no setup, but someone has to run and pay for a service, and metadata reaches it. Kept as an appendix (A) only so the reasoning isn't lost. |
| **B. The owner's own key and build** | The owner builds the app in Xcode (or ships it to TestFlight) under their own team and bundle id. The Gateway signs an APNs provider token with their `.p8` and calls `api.push.apple.com` directly. | **Chosen for iOS push (M2).** No third party. Costs a paid Apple Developer account per owner, and Xcode. |
| **C. Web Push (PWA)** | The Gateway generates VAPID keys and sends RFC 8291-encrypted pushes to the browser's push service (Apple's, for Safari). | **Stays as the zero-setup fallback**, and ships first (M0). iOS 16.4+, and only after the owner adds the site to the Home Screen. Permission must come from a tap. No reliable action buttons on iOS, so pushes are tap-to-open (`docs/06-ui-design.md` already says Web Push carries no auth-required actions). No Live Activities or widgets. Reliability under iOS power management hasn't been tested. |
| **D. ntfy / UnifiedPush** | The Gateway posts to a UnifiedPush endpoint, and a distributor app wakes the Psyche app. | **Android only, later.** iOS has no UnifiedPush, and the ntfy iOS app relies on ntfy.sh's upstream relay, which is option A run by someone else. Android through FCM would need the owner's own Firebase project, the same shape as B. Decide when Android starts (M3). |

### 3.3 Recommendation: direct APNs with the owner's key

1. **M0: C (Web Push).** It costs nothing new and gives every owner a working lock-screen nudge.
2. **M2: B (direct APNs).** For owners with an Apple Developer account. It adds the APNs branch to the push surface, the Notification Service Extension, actionable approvals and Live Activities.
3. **No relay, no hosted service, anywhere.**

**What the owner does once (M2 setup).**

1. In their Apple Developer account, create an APNs authentication key (`.p8`), and note the Key ID and Team ID.
2. Pick a bundle id under their team, build the app from `apps/ios` with Xcode, or archive it and install it through TestFlight.
3. In the app or in Settings → Notifications → Phone push, give the Gateway the `.p8`, Key ID, Team ID and bundle id. The Gateway keeps the `.p8` in its credential vault, never in the state DB or in logs. Setting it needs `operator.admin` and fresh presence, like any other credential.

**What the Gateway does.**

- **Auth.** It signs a short-lived ES256 provider token with the `.p8` and reuses it for up to an hour, as APNs requires. Each request goes over HTTP/2 to `api.push.apple.com` (or the sandbox host for development builds), with `apns-topic` = the bundle id.
- **Device token.** The app sends its APNs token to the Gateway at registration, over the authenticated WebSocket. The Gateway stores it with the device record. That's acceptable now: the token is only useful with the owner's own key, and revoking the device deletes it.
- **Errors.** APNs 410 (`Unregistered`) and 400 `BadDeviceToken` mean the Gateway drops the registration. 429 and 5xx are `failed/retryable`.
- **What Apple sees.** The device token, the topic, the time, the size and the priority. The notification itself is ciphertext (below). Content-free metadata is the same as with any push.
- **If the Gateway is off.** If the Mac is asleep or off, nothing is sent. This is the same as the rest of Psyche: it's local-first, so the phone gets pushes only while the Gateway runs. The in-app inbox catches up when the phone reconnects.

**End-to-end payloads (unchanged from v1).**

- **Content key.** At `push.register`, over the authenticated WS, the app sends a per-device X25519 public key, or a fresh 32-byte key wrapped to the Gateway.
- **Encryption.** The Gateway encrypts `{notificationId, kind, title, body, threadId, actions, answerToken?}` with HPKE (or XChaCha20-Poly1305 under that key) into a ciphertext that fits APNs' 4 KB payload limit.
- **Delivery.** The APNs alert has a generic placeholder ("Psyche needs you") and `mutable-content: 1`. The app's **Notification Service Extension** decrypts the payload, sets the title, body, `categoryIdentifier` and `threadIdentifier`, and hands the notification to the system. If decryption fails, the placeholder is what shows, and that's acceptable.
- **Key storage.** The extension reads the key from the shared app-group Keychain (`AfterFirstUnlockThisDeviceOnly`).

### 3.4 Where it plugs in

**Protocol.** Add `methods/push.ts`:

- `push.register {transport: "apns"|"webpush", environment: "production"|"sandbox", apnsToken | subscription, contentKey, categoriesVersion}` (`operator.read`, the device registers itself only). More transports can be added later for Android.
- `push.unregister`.
- `push.test` (sends one test push).
- `push.apns.configure {keyId, teamId, bundleId, privateKey}` (`operator.admin`, fresh presence; the key goes to the vault and is never returned). `push.apns.status` reports whether a key is configured and the last send result.
- `liveActivity.register` / `liveActivity.end` (§3.6).
- `devices.list` gains `push: {transport, registeredAt, lastDeliveredAt, lastError}`.

Run `pnpm protocol:gen`, and the Swift types follow automatically.

**Surface.** Add `push:<deviceId>` to the `Surface` string family. The remote desktop client adds `device:<deviceId>` to the same family for its OS notifications ([remote-gateway-2026.md §4.2](remote-gateway-2026.md#42-feature-by-feature)).

- **Routing.** `surfaceClass` gains `"push"`, and `isInterruptive` becomes true for it.
- **Fan-out.** `resolveSurfaces` expands `notification` into the OS surface *and* every push-registered phone, so `DEFAULT_SURFACES` doesn't change.
- **Policy.** Quiet hours and interruption levels apply unchanged. `timeSensitive` maps to `interruption-level: time-sensitive`.

**Adapter.** `createPushSurface({ devices, apns, webPush })` is one new `SurfaceAdapter` next to `createOsSurface` and `createChannelSurface`.

- It encrypts the payload, then posts to APNs (with the owner's key) or to the browser's push service (Web Push).
- It maps APNs 410 / `BadDeviceToken` to unregistering the device, 429 to `failed/retryable`, and a revoked device to `suppressed`. With no `.p8` configured, the APNs branch is `suppressed` and Web Push still works.
- It reuses `toNotifyShowParams` for the action list, so Mac banners and phone banners get the same categories.
- A shared `push-crypto.ts` in `packages/notifications` holds the HPKE and RFC 8291 code.

### 3.5 Lock-screen answers

When the owner taps Approve or Deny on the lock screen, iOS launches the app in the background for a few seconds. A full WS handshake is two round trips plus TLS, so it's fragile there. Add `POST /v1/approvals/answer`, signed with the device key over `{approvalId, answerToken, decision, nonce, ts}`. It runs the same `approvals.answer` checks, plus the same presence rules (§5). The WS path stays the normal path.

**Why the tap can reach the Gateway.**

- **On Tailscale.** The Tailscale iOS app can keep its VPN connected on demand. When the app launches in the background and makes one HTTPS request to `https://<host>.<tailnet>.ts.net`, the tunnel comes up and the request reaches the Gateway through Tailscale Serve. This depends on the owner turning on Tailscale's on-demand setting, and the app's onboarding says so. **It hasn't been tested on a real phone**, so M1 includes a check (§6) and M2's acceptance criteria depend on it.
- **On the LAN, away from home.** The request can't reach the Gateway. The app doesn't queue the answer (§2.3). It replaces the notification with a local one that says **"Reconnect to answer"**, and the approval stays pending until the owner is back on the network or on Tailscale, or answers on the Mac.
- **Face ID.** `.authenticationRequired` makes iOS ask for Face ID (or the passcode) before the action runs. Whether the app can also use the Secure Enclave presence key from a background notification action is not known (§7), so the design doesn't rely on it for `write` kinds; see §4.

### 3.6 Live Activities

A running Task or automation shows step progress on the Lock Screen and in the Dynamic Island.

- **Start.** From the app, in the foreground, for a Task the owner is watching (`Activity.request(pushType: .token)`). The app sends the activity's push token to the Gateway with `liveActivity.register {taskId, activityId, pushToken}`. Push-to-start (iOS 17.2+) comes later: the app registers a push-to-start token, and the Gateway may start an activity for an automation run, only if the owner opted in.
- **Updates.** The Gateway sends APNs pushes with `apns-push-type: liveactivity` and the topic `<bundle id>.push-type.liveactivity`, using the **same `.p8`** as ordinary pushes. Routine updates use priority 5, and moments that matter use 10. iOS throttles update frequency, so the Gateway coalesces steps.
- **What the content can say.** iOS decodes Live Activity `content-state` itself, with no service extension, so **these updates can't be end-to-end encrypted** and Apple can read them. The content-state therefore carries only `{step n of m, status, startedAt}`, shown as "Step 3 of 7 · running". The task title is added only if the owner turns on **Show task titles on the Lock Screen** (default off); the title is then sent in plain text to Apple. Never task text, tool arguments or results. If the step count isn't known, the activity shows "Running" with an elapsed timer from `startedAt`.
- **End.** The Gateway ends the activity with an `event: end` push on completion, failure or when the Task needs approval. For needs-approval, the activity moves to a "Needs approval" state and the Gateway also sends the normal encrypted notification with Approve / Deny (§4). iOS limits an activity to about 8 hours, so a longer run ends the activity and relies on the completion notification.
- **Off switch.** Settings → Notifications → Live Activities turns it off for every device; the app also respects the system toggle.

## 4. Mobile-specific features

| Feature | Design | Milestone |
| --- | --- | --- |
| **Approvals from the lock screen** | One `UNNotificationCategory` per approval class. **`write` kinds** (the same set chat may approve) get Approve / Deny. Approve carries `.authenticationRequired` (Face ID or passcode), Deny carries `.destructive`, and the answer goes through `/v1/approvals/answer` (§3.5). Notifications are E2E encrypted and delivered by the owner's own Gateway over direct APNs (§3.3); there's no relay. **`financial` and other destructive or `deviceOnly` kinds** (`credential_fill`, `exec_host`, `policy`, `pairing`) get only **Review…** (`.foreground` + `.authenticationRequired`), which opens the full card. Security §3.7 says cards show full arguments, never truncated, and a lock-screen banner always truncates. The Gateway enforces the 400 ms arming delay as it does today. Answering on any device dismisses the notification everywhere: the Gateway sends a `background` push with `collapseId` = the approval id, and the app removes the delivered notification (N14). | M2 |
| **Live Activities for running Tasks and automations** | Start one from the app (foreground) for a Task the owner is watching; push-to-start (iOS 17.2+) is opt-in and comes later. The Gateway updates it with APNs `liveactivity` pushes, using the same `.p8` as ordinary pushes (§3.6). **Privacy caveat:** iOS decodes Live Activity `content-state` itself, with no service extension, so **those updates can't be E2E encrypted**. The content-state therefore carries only `{step n of m, status enum, startedAt}` ("Step 3 of 7 · running") and never task text. The task title shows only if the owner opts in. The activity ends on completion, failure or needs-approval. The owner can turn it off. | M2 |
| **Share sheet → Psyche** | A share extension: pick "New chat" or a recent thread, add a note, send. It writes to the app-group outbox, and the app (or the extension, if it's connected) runs `library.upload` with `threadId` + `chat.send` with an `idempotencyKey`. Shared content is untrusted input, like any web page: taint applies. | M1 |
| **Voice input** | The composer dictates on the device (`SpeechAnalyzer` on iOS 26+, `SFSpeechRecognizer` fallback), the same engines the mac helper's `speech.transcribe` uses. Voice mode streams to the Gateway's speech pipeline. As on desktop, voice never answers approvals (UI design, voice mode). | M1 (dictation), M3 (voice mode) |
| **Widgets** | WidgetKit: "Pending approvals" (count and a deep link), "Today's brief" (title only) and "Ask Psyche" (opens the composer). The widget reads a snapshot the app writes to the app group on each sync. Refresh comes from the app's own syncs plus occasional `background` pushes, which iOS throttles, so widgets are eventually consistent. They show counts and titles only, because they render on the lock screen. | M2 |
| **Phone as a node** | The app also connects with role `node` (one device, role `both`, which `DeviceRole` already allows) and the owner grants the `node` scope. Capabilities reuse the mac helper's names where the meaning matches: `contacts.search` / `contacts.read`, `calendar.*` (EventKit is the same API), `presence.public_key`, plus new ones: `location.current`, `location.watch_significant`, `photos.search`, `photos.get` (PHPicker-limited or full library, as the owner grants), `notify.show` (local notifications while the app is foregrounded). **Availability:** iOS gives a suspended app no CPU, so the node is reachable only while the app is open, or for a few seconds after a push. The Gateway already treats nodes as intermittent. A `node.invoke` that finds the phone offline returns `failed/retryable` and may raise an `input_needed` notification ("Open Psyche to share your location"). It never sends silent pushes to fetch data, because iOS throttles them and they would be a covert tracking channel. Significant-location monitoring is the one background exception, opt-in, with the system indicator showing. | M3 |

## 5. Security

- **Per-device scopes.** A phone pairs as its own device with owner-chosen scopes (§2.2). `operator.admin` stays off by default. If the owner grants it, every widening call still needs fresh presence, exactly as security §10 lists.
- **Revocation.** `devices.revoke` from any admin device closes the phone's connections, drops its node authority and presence key, and deletes its push registration and content key. Nothing reaches the phone after that: the Gateway no longer has its APNs token or content key, and there's no third party holding a copy. Lost-phone flow: revoke from the desktop, done. A lost remote desktop is revoked the same way ([remote-gateway-2026.md §6.4](remote-gateway-2026.md#64-a-lost-or-stolen-client)). `psyche security audit` gains three checks: "phone with admin scope", "push registration older than 180 days with no delivery" and "Gateway identity key missing". The owner's `.p8` is a new secret on the Gateway: it can only send pushes to that one app, and it can't read anything, but it lives in the vault and its owner can revoke it in the Apple Developer account at any time.
- **Device-only approvals.**
  - **Where they go.** `deviceOnly` kinds may go to a paired phone, because a phone app is a device and not a chat. This follows the same rule as the desktop card and the helper's authenticated notification (architecture §4.6, security §3.7).
  - **What the answer needs.** The answer must include a presence assertion from the phone's **Secure Enclave P-256 key**, created with `.biometryCurrentSet` and registered through `devices.presenceKey.register`, just as for the mac helper.
  - **Proof kind.** `PresenceAssertionSchema.kind` gains `"device"`, or the existing `"helper"` is generalized to cover it.
  - **Fallback.** A phone without a registered presence key gets `deviceOnly` cards in the app as "Answer on your Mac". The PWA uses its passkey (`webauthn`), as today.
  - **What the lock screen shows.** For these kinds the lock screen gets only a nudge (§4).
- **Key storage on the phone.**
  - **Device key.** The Ed25519 key is in the Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and non-synchronizable. Secure Enclave keys are P-256 only, and the connect signature is Ed25519. "After first unlock" lets lock-screen answers work.
  - **Push content key.** In the app-group Keychain, with the same accessibility, readable by the service extension.
  - **Presence key.** In the Secure Enclave, behind biometry. It never leaves the device.
  - **Backups.** Nothing syncs to iCloud, so a new phone pairs again.
  - **Gateway side.** There are no bearer tokens in this design (the device key signs every connect), so a stolen Gateway database can't impersonate the phone.
- **Notification content.**
  - **Lock-screen previews.** Previews follow the owner's iOS "Show Previews" setting. The app recommends "When Unlocked" during onboarding.
  - **Approval summaries.** Approval notifications use the summary line only. Amounts, recipients and URLs appear only in the in-app card.
- **Untrusted input.** Push payloads are display-only (§2.3). Share-sheet content and phone-node results (contacts, photos, location) carry taint like any tool output, under the permission broker's existing rules.


## 6. Phased plan

| Milestone | Scope | Acceptance criteria |
| --- | --- | --- |
| **M0: PWA + Web Push** | `apps/web` gets a manifest (`display: standalone`), icons and a service worker. Web Push uses Gateway-generated VAPID keys stored in the state DB; the private key never leaves the Gateway. Adds `push.register` / `push.unregister` / `push.test` (transport `webpush`), the `push:<deviceId>` surface and `createPushSurface` (Web Push branch only). The notification payload is title + body + route, with no actions. A Settings toggle "Notifications on this device" requests permission from a tap. | On an iPhone (iOS 18+), using the Home Screen PWA over Tailscale: (1) an approval created on the desktop shows a lock-screen notification within 10 s; (2) tapping it opens that approval's card; (3) approving it there dismisses the card on the desktop (N14); (4) `devices.revoke` on the phone means the next approval sends no push (delivery record `suppressed`); (5) quiet hours defer a `passive` notification and let a `timeSensitive` approval through; (6) the push service sees only RFC 8291 ciphertext (unit test on the encoded request). |
| **M1: iOS app over LAN and Tailscale** | SwiftUI app, iOS 18+. `PsycheProtocol.swift` as a Swift package. Transports are the LAN (Bonjour) and Tailscale (`*.ts.net`) only. QR pairing with the Gateway identity key (Gateway side: the identity key and signed challenge). Keychain storage. Screens: chat (streaming), Tasks, approvals (in-app, foreground), inbox and threads. `stateVersion` resync, the offline outbox, the share extension and on-device dictation. No APNs push yet: the PWA's Web Push keeps covering background nudges. A small spike checks the Tailscale on-demand behavior that §3.5 relies on. | (1) Pair by QR in under a minute, with an owner approval on the desktop. (2) A Gateway that presents a different identity key is refused with a clear error, and so is a MITM proxy with a valid certificate. (3) Background the app for 1 hour, reopen it: within 2 s it shows approvals created in the meantime, with no duplicates. (4) A message sent in airplane mode is delivered exactly once after reconnecting. (5) Sharing a PDF from Files creates a Library item in the chosen thread. (6) The `protocol:check` CI step also builds the Swift package, so a schema change that breaks Swift fails CI. (7) The same build works on the LAN (Bonjour) at home and through `*.ts.net` away from home. (8) **Spike result recorded:** with Tailscale's on-demand setting on and the phone locked, a background HTTPS request from the app reaches the Gateway through Serve; and what happens with the setting off. |
| **M2: direct-APNs push, lock-screen approvals and Live Activities** | The owner's `.p8` set up as in §3.3 (`push.apns.configure`, vault storage). The APNs branch of `createPushSurface`, the Notification Service Extension (decryption), the approval categories, `POST /v1/approvals/answer`, the phone presence key for `deviceOnly` answers, Live Activities (§3.6), and widgets. No relay and no hosted service. Docs: an "Apple Developer setup" guide, including the cost and the TestFlight 90-day rebuild. | (1) With the app killed and the phone locked, over Tailscale, a `write` approval shows Approve / Deny. Approve asks for Face ID or the passcode and completes within 5 s, and the desktop card disappears. (2) On a LAN-only setup away from home, tapping Approve shows "Reconnect to answer" and the approval stays pending. (3) A `financial` approval shows only **Review…**, and the in-app answer needs a Secure Enclave presence proof (the Gateway refuses it without one). (4) Apple's servers see only ciphertext for ordinary pushes (automated test on the encoded APNs request: no title, body, thread id or Gateway URL). (5) With no `.p8` configured, the APNs branch is `suppressed` and nothing else breaks. (6) A Gateway database copied to another machine can't send pushes without the vault. (7) Answering on the Mac removes the delivered notification from the phone within 10 s. (8) A running Task shows "Step n of m · running" on the Lock Screen and in the Dynamic Island, and it ends on completion, failure or needs-approval. The content-state contains no task text unless the title option is on (unit test on the payload). |
| **M3: phone as a node** | Role `both`. Capabilities `location.current`, `location.watch_significant`, `photos.search` / `photos.get`, `contacts.*`, `calendar.*`, `notify.show`. Per-capability toggles in the app plus the iOS permission prompts. Intermittent availability with the `input_needed` fallback. Voice mode. Android begins (Kotlin, sharing the JSON Schema); its push story (FCM with the owner's own Firebase project, or UnifiedPush) is decided then. | (1) "Where am I?" in a desktop chat returns the phone's location only while the phone node is connected and the toggle is on. Otherwise the Task asks "Open Psyche on your phone". (2) "Find the photo of the receipt from Tuesday" returns a photo the agent can attach, and the result is tainted. (3) Revoking the `node` scope stops capability calls at once and leaves the client role working. (4) No silent push is ever sent to fetch node data (Gateway test over the delivery log). (5) Turning off location in iOS Settings makes `location.current` return `forbidden`, which isn't retried. |

## 7. Open questions for the owner

**Answered by the 2026-11-02 direction (kept so the history is clear):**

1. ~~Who runs the relay, and under which domain?~~ **Nobody.** There is no relay. The Gateway calls APNs with the owner's own key.
2. ~~Cloudflare Access in the native app?~~ **Not supported.** Only the LAN and Tailscale.
3. ~~Live Activities: acceptable without E2E encryption?~~ **Yes, with generic content** ("Step 3 of 7 · running"). Task titles are opt-in (§3.6).

**Still open:**

4. **iOS Web Push:** test whether action buttons work on iOS and how reliable delivery is (both unverified). If actions work, M0 could answer `write` approvals from the lock screen.
5. **Minimum iOS version:** 18 (Declarative Web Push from 18.4, and wider reach) or 26 (`SpeechAnalyzer`, which matches the mac helper)?
6. **Tailscale on demand:** does the background launch window from a notification action leave enough time for the VPN to come up and one HTTPS request to finish? M1 has a spike for this. If it doesn't work, lock-screen answers would work only when Tailscale is already connected, and the notification would say so.
7. **Presence key from the lock screen:** can the Secure Enclave key (with `.biometryCurrentSet`) prompt for Face ID from a background notification action? If not, `write` approvals on the lock screen rely on iOS's own unlock (`.authenticationRequired`) plus the device-key signature, and the presence key stays for in-app answers. Is that acceptable for `write` kinds?
8. **Distribution inside the family or a team:** App Store distribution to other people is out of scope. If an owner wants to share one build with a partner, they'd use TestFlight under their own team. Is that enough, or should we plan something else later?
9. **Android push:** FCM needs the owner's own Firebase project, and UnifiedPush needs a distributor (ntfy self-hosted is again owner infrastructure). Pick when Android starts.

## Sources

- APNs: developer.apple.com/documentation/usernotifications/generating-a-remote-notification
- APNs token-based auth: developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
- Live Activities push: developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications
- Web Push on iOS: webkit.org/blog/13878, webkit.org/blog/16535 (Declarative Web Push)
- UnifiedPush: unifiedpush.org/users/faq
- Used only for the appendix: Home Assistant push (contributors.home-assistant.io/companion/mobile-app-api/notifications, companion.home-assistant.io/docs/notifications/notification-details), Bitwarden (bitwarden.com/help/configure-push-relay), ntfy iOS upstream (docs.ntfy.sh/config/#ios-instant-notifications), Matrix Sygnal (github.com/matrix-org/sygnal)
- In repo: `docs/05-security-and-permissions.md` §3.7, §9, §10; `docs/02-architecture.md` §4.6, §4.12, §7, §11; `docs/03-feature-spec.md` A8, N12, N14; `docs/guides/server-mode.md`; `docs/design/cross-platform-2026.md`

## Appendix A: publisher-run push relay (not planned)

Kept for the record. The owner decided against running any hosted service, so none of this is on the roadmap. Revisit only if the owner changes that decision.

The idea was a small stateless service, run by the app's publisher, that holds the APNs/FCM credentials so that store-installed apps get push with no setup. The Gateway would send it end-to-end encrypted blobs, and it would forward them to APNs/FCM.

- **Contract:** `POST /v1/push {handle, kind, priority, collapseId?, expiresAt, ciphertext ≤ 3 KB}` → 202, 410 (handle dead), 429 or 401.
- **Handle instead of token:** the app registers its APNs token with the relay and gets back `AEAD_relayKey(token, appId, env)`. The relay stores nothing, and the Gateway never sees the raw token.
- **Abuse control:** App Attest for handle minting, per-installation Ed25519 signing keys (the Bitwarden pattern), and rate limits per handle and per installation.
- **What it would see:** the handle, installation id, time, size and priority, but no titles, bodies or Gateway URLs.
- **Why not:** someone has to run it, pay for it and keep an Apple account for it, and it adds a point of failure and metadata that the local-first design avoids. Existing projects differ a lot in privacy: Home Assistant's relay sees the full title and body, ntfy sends only a generic message plus a hashed topic, and Bitwarden sends only sync triggers.
