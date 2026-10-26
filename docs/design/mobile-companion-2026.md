# Mobile companion: the Gateway as a phone backend

Status: proposal v1 (2026-10-26), for the owner's sign-off. Docs only; nothing here is built. Applies to the Gateway, `packages/protocol`, `packages/notifications`, `apps/web`, and a future native app (iOS first, Android later). The Windows desktop target doesn't change anything here: the phone talks to the Gateway, not to a desktop OS. Linux desktop stays out of scope, although the Gateway still runs on Linux in server mode.

**The owner's question:** can Psyche eventually be the backend for a mobile app that connects to it, with the server sending push notifications and more?

**The short answer:** yes. Most of the backend already exists. The phone becomes one more paired device on the same WebSocket protocol, with owner-chosen scopes, and it can use the generated Swift types directly. The hard part is push. Apple and Google issue push credentials to whoever *publishes* the app, so a self-hosted, open-source Gateway can never hold them. The recommendation:

- **Now:** ship the PWA with Web Push. No credentials are needed and nothing new runs anywhere.
- **Then:** ship a native iOS app over the existing protocol.
- **Then:** add a small, stateless **push relay**, run by the app's publisher. It forwards end-to-end encrypted blobs to APNs/FCM and sees only an opaque device handle, a size and a time.
- **Self-builders:** anyone who builds the app with their own Apple key runs the same relay themselves.
- **Android:** UnifiedPush/ntfy is the de-Googled option, added alongside FCM.

---

## 1. What exists and can be reused

All of the following was checked in code on `main` (3fe15f9e).

| Piece | Where | State | What the phone reuses |
| --- | --- | --- | --- |
| WS protocol, pairing, scopes | `packages/protocol/src/methods/connect.ts`, `methods/devices.ts`, `common.ts` (`DeviceScope`) | Built | `connect` → 60 s nonce → Ed25519 signature over `psyche-connect-v1 \n nonce \n platform \n deviceFamily \n protocolVersion \n serverOrigin` → `paired` / `pending` (owner approves a code) / `denied`. Scopes are `operator.read`, `operator.write`, `operator.approvals`, `operator.admin` and `node`. The owner chooses them, never the client. `DevicePlatform` already has `ios` and `android`. `devices.revoke` closes connections and kills node authority. |
| Swift codegen | `packages/protocol/generated/swift/PsycheProtocol.swift` (~27k lines, quicktype, `Codable` + `Sendable` + `public`) | Built; the mac helper consumes a copy | Ship it as a Swift package. Known limits (`generated/README.md`): object unions such as `Frame` and `ConnectResult` become one struct, so switch on `type` / `phase` / `ok` first. Untyped JSON is `JSONAny`. |
| Web client (A8) | `apps/web`, `apps/web/src/platform.ts` | Built; works at phone widths | The whole UI over `location.origin`. Notifications stay in the in-app inbox: the code itself says "Web Push is a follow-up". Passkeys use `navigator.credentials` in a secure context. |
| Server mode (N12) | `docs/guides/server-mode.md`, security §10 | Mostly built | Loopback bind only; Tailscale Serve, Cloudflare Tunnel + Access (JWT verified against JWKS) or an SSH tunnel; passkeys (`passkeys.*`) as presence proof. **TLS pinning for mobile clients is specified but not built**: the audit lists "missing TLS pins" as "not checked yet", and no SPKI code exists. |
| Multi-client consistency (N14) | `apps/gateway/src/state-version.ts`; frames carry `seq` + `stateVersion` | Built | Events are not replayed. A client that missed some refetches when `stateVersion` has moved. This fits a phone that is suspended most of the time. |
| Notifications | `packages/notifications` (`notifier.ts`, `routing.ts`, `surfaces.ts`) | Built | `SurfaceAdapter { name, handles(surface), deliver(n, ctx) → delivered / failed(retryable) / suppressed }`. Durable inbox, per-surface delivery records, retries, quiet hours, interruption levels (`passive` / `active` / `timeSensitive`) and de-duplication. `toNotifyShowParams` already maps actions to `destructive` / `authenticationRequired` / `textInput`, which is exactly what `UNNotificationAction` needs. |
| Approvals | `schemas/permissions.ts` (`ApprovalAnswer`, `PresenceAssertionSchema` kinds `webauthn` / `helper`), `methods/approvals.ts` | Built | A single-use `answerToken` per surface; the first answer wins; there is a 400 ms arming delay; `deviceOnly` kinds (`financial`, `credential_fill`, `exec_host`, `policy`, `pairing`) never reach chat. The channel surface already suppresses them (`surfaces.ts`). |
| Presence keys | `devices.presenceKey.register` (reads `presence.public_key` from a connected node) | Built for the mac helper's Secure Enclave key | The same mechanism works for a phone that pairs with the `node` role (§5). |
| Interim phone surfaces | Telegram (inline buttons), iMessage via the Mac node (polls or 👍/👎) | Built | They work today with no app, but carry the chat limits of security §9: no presence proof and no `deviceOnly` kinds. |
| Upload | `library.upload` (chunked base64, at most 600 KB per chunk, optional `threadId`) | Built | The share sheet (§4). |
| Mac-helper capability names | `contacts.*`, `calendar.*`, `notify.*`, `presence.*` | Built | The phone node reuses the same names where the meaning matches (§4). |

**Gaps this design fills:** Web Push; a device-token registration method; a `push:<deviceId>` surface; Gateway identity pinning (§2.2); a phone node; and a one-shot signed answer path for lock-screen actions (§3.4).

## 2. Reachability

### 2.1 Transports

| Path | How the phone reaches the Gateway | Verdict |
| --- | --- | --- |
| **Tailscale** (tailnet + Serve) | The Tailscale iOS app, using its VPN-on-demand, plus the Gateway's `https://<host>.<tailnet>.ts.net` | **Default recommendation.** Private, no public ingress, real TLS. Push still needs a relay (§3), because the phone isn't connected while suspended. |
| **Cloudflare Tunnel + Access** | Public hostname, Access in front | Works for the PWA (Access login in Safari). In a native app, Access needs a browser login in `ASWebAuthenticationSession`, then a `CF_Authorization` cookie on the WS, or an Access service token. **Open question:** test whether Access cookies survive app suspension long enough. Use passkeys plus `allowPublicIngress` as today. |
| **LAN** | `https://<mac>.local:7979` via Bonjour | Only at home. There's no public certificate, so it relies on the pin from §2.2. iOS asks for the Local Network permission. Fine for "on the couch", not as the only path. |
| **Publisher-run traffic relay** (a TURN-like tunnel) | Phone → relay → Gateway | **Rejected for v1.** It makes the publisher a hub for all traffic, which conflicts with local-first (vision doc). Revisit only as an opt-in, E2E-encrypted, Tailscale-like option if onboarding data shows that people can't set up Tailscale. |

### 2.2 Pairing with a QR code

Psyche's own UI already lets the owner approve a code on a paired device; mobile keeps that and adds a QR code for convenience.

1. On an admin device, **Settings → Devices → Add phone** shows a QR code: `psyche-pair:v1` with `{gatewayUrl, gatewayIdentityKey, spkiPins[], setupToken}`. The setup token is the single-use, 10-minute bootstrap token that security §10 already specifies.
2. The app scans the QR code **with its own scanner**. It is not a universal link or deep link: the CVE-2026-25253 rule ("no `gatewayUrl` query or deep-link parameter") still holds. The app shows the host and asks "Connect to `psyche.tailnet.ts.net`?".
3. The app generates its Ed25519 device key, runs `connect` and gets `pending`. The setup token lets the Gateway mark the request as expected. The owner still approves the request and its scopes on the admin device. The default scopes for a phone are `operator.read`, `operator.write` and `operator.approvals`, without `admin`.
4. **Pin the Gateway, not the certificate.** Tailscale and Cloudflare rotate leaf certificates, so pinning the SPKI alone breaks on every renewal. Add a long-lived **Gateway identity key** (Ed25519, kept in `$PSYCHE_HOME`). The Gateway signs `{nonce, serverOrigin, devicePublicKey}` in its `connect` challenge, and the app refuses a signature from any key other than the pinned one. SPKI pins become an optional extra layer for LAN and self-signed setups. This closes the N12 "TLS pinning for mobile clients" item in a way that survives certificate rotation.

**Passkeys:** a native app can only use passkeys for a relying party it holds an associated-domains entitlement for. The owner's Gateway hostname is different for every install, so **the native app can't use the Gateway's passkeys.** It proves presence with a Secure Enclave key instead (§5). Passkeys stay the PWA's presence proof.

### 2.3 Background reconnection and offline work

- **iOS suspends sockets** soon after the app is backgrounded. The design accepts that: the WS is a foreground connection, and push (§3) covers the background.
- **On the foreground event:** reconnect with jittered backoff (0.5 s → 30 s), then `connect` and `connect.verify`. Compare `stateVersion` with the last one seen. If it moved, refetch the visible lists (`approvals.list`, `notifications.list`, the open thread). This is the same N14 path the web client uses (`onResync`).
- **Push as a hint, not as state:** a push says something changed. The app always fetches the truth from the Gateway, and a decrypted push body is only for display.
- **Offline outbox:** keep a durable queue in the app group for user-originated, idempotent writes: `chat.send` (it already requires an `idempotencyKey`), `library.upload` chunks, mark-read. The app flushes the queue in order on reconnect.
- **Not queued:** approvals. `approvals.answer` isn't idempotency-keyed, the token is single-use and the approval can expire. While offline, the card says "Reconnect to answer".

## 3. Push notifications

### 3.1 The constraint

APNs authenticates with a `.p8` key that belongs to one Apple developer team and one bundle id (`apns-topic`). FCM HTTP v1 authenticates with a service account in the publisher's Firebase project. A self-hosted Gateway in someone's closet can't have either without the publisher shipping a secret inside open-source software, which would be revoked within a day. Every self-hosted project with an app store app solves this the same way.

### 3.2 Options

| Option | How it works | Pros | Cons |
| --- | --- | --- | --- |
| **A. Publisher-run stateless relay** (Home Assistant, Bitwarden, Matrix Sygnal, ntfy upstream) | Gateway → `relay.psyche.dev` → APNs/FCM → phone. The relay holds the `.p8` and FCM credentials. | Works for app store users with no setup. One small service. | The publisher runs a service. Metadata (which handle, when, size) reaches the relay and Apple/Google. Existing projects differ a lot in privacy: **Home Assistant's relay sees the full title and body**, while ntfy sends only `"New message"` plus a hashed topic, and Bitwarden sends only sync triggers. |
| **B. Self-built app with the owner's key** | The owner builds the app in Xcode with their own team, bundle id and `.p8`, and the Gateway calls APNs directly. | No third party. | Needs a $99/yr Apple Developer account and Xcode. A free account's builds expire after 7 days. Out of reach for most owners. |
| **C. Web Push (PWA)** | The Gateway generates VAPID keys and sends RFC 8291-encrypted pushes to the browser's push service (Apple's, for Safari). | No publisher service, no store, no developer account. Payloads are E2E encrypted by the standard. Available today. | iOS 16.4+, and only after the owner adds the site to the Home Screen. Permission must come from a tap. No reliable action buttons on iOS, so treat pushes as tap-to-open (`docs/06-ui-design.md` already says Web Push carries no auth-required actions). No Live Activities or widgets. Reliability under iOS power management hasn't been tested. |
| **D. ntfy / UnifiedPush** | The Gateway posts to a UnifiedPush endpoint, and a distributor app (ntfy, NextPush, Sunup) wakes the Psyche app. | Fully self-hostable on Android, with no Google. | **iOS has no UnifiedPush**: background services aren't allowed. The ntfy iOS app itself relies on ntfy.sh's upstream relay, so on iOS it's option A run by someone else. |

### 3.3 Recommendation

1. **M0: C (Web Push).** It costs nothing new and gives every owner a working lock-screen nudge.
2. **M2: A, with the relay as open source in this repo** (`apps/push-relay`). The publisher runs the instance for store builds. Self-builders (B) run the same binary with their own key and point the Gateway at it, so B is just configuration of A.
3. **Android, later:** FCM through the same relay, plus D as a per-device choice for de-Googled phones.

**The relay contract.** It is stateless apart from rate-limit counters, so it can run as one small service or an edge worker:

```
POST /v1/push                      (Authorization: installation signature, see below)
{ handle, kind: "alert"|"background"|"liveactivity", priority: 5|10,
  collapseId?, expiresAt, ciphertext (≤ 3 KB, base64url) }
→ 202 | 410 (handle dead: Gateway drops it) | 429 (rate limit) | 401
```

- **Handle, not token.** At registration the app sends its APNs/FCM token to the relay. The relay returns `handle = AEAD_relayKey(token, appId, env)`. The relay stores nothing and decrypts the handle on each send. The Gateway never sees the raw APNs token, and a leaked Gateway database is useless without the relay.
- **Abuse control:**
  - **App Attest.** The relay mints a handle only for a genuine app install, verified with App Attest (Play Integrity on Android).
  - **Installation keys** (Bitwarden pattern). Each Gateway signs its requests with a per-installation Ed25519 key, registered with the relay once and anonymously.
  - **Rate limits** per handle and per installation (Home Assistant uses a per-device daily cap). An over-limit send returns 429, and the inbox still has everything.
- **What the relay sees:** the handle, the installation id, the time, the size and the priority. No titles, bodies, thread ids or Gateway URLs. It keeps no logs past counters. Apple and Google see the same, plus the device token.

**End-to-end payloads.**

- **Content key.** At `push.register`, over the authenticated WS, the app sends a per-device X25519 public key, or a fresh 32-byte key wrapped to the Gateway.
- **Encryption.** The Gateway encrypts `{notificationId, kind, title, body, threadId, actions, answerToken?}` with HPKE (or XChaCha20-Poly1305 under that key) into `ciphertext`.
- **Delivery.** The APNs alert has a generic placeholder ("Psyche needs you") and `mutable-content: 1`. The app's **Notification Service Extension** decrypts the payload, sets the title, body, `categoryIdentifier` and `threadIdentifier`, and hands the notification to the system. If decryption fails, the placeholder is what shows, and that's acceptable.
- **Key storage.** The extension reads the key from the shared app-group Keychain (`AfterFirstUnlockThisDeviceOnly`).

### 3.4 Where it plugs in

**Protocol.** Add `methods/push.ts`:

- `push.register {transport: "apns"|"fcm"|"webpush"|"unifiedpush", environment: "production"|"sandbox", handle | subscription | endpoint, contentKey, categoriesVersion}` (`operator.read`, the device registers itself only).
- `push.unregister`.
- `push.test` (sends one test push).
- `devices.list` gains `push: {transport, registeredAt, lastDeliveredAt, lastError}`.

Run `pnpm protocol:gen`, and the Swift types follow automatically.

**Surface.** Add `push:<deviceId>` to the `Surface` string family.

- **Routing.** `surfaceClass` gains `"push"`, and `isInterruptive` becomes true for it.
- **Fan-out.** `resolveSurfaces` expands `notification` into the OS surface *and* every push-registered phone, so `DEFAULT_SURFACES` doesn't change.
- **Policy.** Quiet hours and interruption levels apply unchanged. `timeSensitive` maps to `interruption-level: time-sensitive`.

**Adapter.** `createPushSurface({ devices, relay, webPush })` is one new `SurfaceAdapter` next to `createOsSurface` and `createChannelSurface`.

- It encrypts the payload, then posts to the relay (APNs/FCM) or to the push service directly (Web Push, UnifiedPush).
- It maps 410 to unregistering the device, 429 to `failed/retryable`, and a revoked device to `suppressed`.
- It reuses `toNotifyShowParams` for the action list, so Mac banners and phone banners get the same categories.
- A shared `push-crypto.ts` in `packages/notifications` holds the HPKE and RFC 8291 code.

**Lock-screen answers.** When the owner taps Approve, iOS launches the app in the background for a few seconds. A full WS handshake is two round trips plus TLS, so it's fragile there. Add `POST /v1/approvals/answer`, signed with the device key over `{approvalId, answerToken, decision, nonce, ts}`. It runs the same `approvals.answer` checks, plus the same presence rules (§5). The WS path stays the normal path.

## 4. Mobile-specific features

| Feature | Design | Milestone |
| --- | --- | --- |
| **Approvals from the lock screen** | One `UNNotificationCategory` per approval class. **`write` kinds** (the same set chat may approve) get Approve / Deny. Approve carries `.authenticationRequired`, Deny carries `.destructive`, and the answer goes through `/v1/approvals/answer`. **`deviceOnly` and `requiresAuthentication` kinds** get only **Review…** (`.foreground` + `.authenticationRequired`), which opens the full card. Security §3.7 says cards show full arguments, never truncated, and a lock-screen banner always truncates. The Gateway enforces the 400 ms arming delay as it does today. Answering on any device dismisses the notification everywhere: the Gateway sends a `background` push with `collapseId` = the approval id, and the app removes the delivered notification (N14). | M2 |
| **Live Activities for running Tasks** | Start one from the app (foreground) for a Task the owner is watching. Updates go through the relay with `apns-push-type: liveactivity` and per-activity tokens. Push-to-start (iOS 17.2+) comes later. **Privacy caveat:** iOS decodes Live Activity `content-state` itself, with no service extension, so **those updates can't be E2E encrypted**. The content-state therefore carries only `{step n of m, status enum, startedAt}` and never task text, and the readable title comes from the app at start time. The owner can turn this off. | M2 (stretch) |
| **Share sheet → Psyche** | A share extension: pick "New chat" or a recent thread, add a note, send. It writes to the app-group outbox, and the app (or the extension, if it's connected) runs `library.upload` with `threadId` + `chat.send` with an `idempotencyKey`. Shared content is untrusted input, like any web page: taint applies. | M1 |
| **Voice input** | The composer dictates on the device (`SpeechAnalyzer` on iOS 26+, `SFSpeechRecognizer` fallback), the same engines the mac helper's `speech.transcribe` uses. Voice mode streams to the Gateway's speech pipeline. As on desktop, voice never answers approvals (UI design, voice mode). | M1 (dictation), M3 (voice mode) |
| **Widgets** | WidgetKit: "Pending approvals" (count and a deep link), "Today's brief" (title only) and "Ask Psyche" (opens the composer). The widget reads a snapshot the app writes to the app group on each sync. Refresh comes from the app's own syncs plus occasional `background` pushes, which iOS throttles, so widgets are eventually consistent. They show counts and titles only, because they render on the lock screen. | M2 |
| **Phone as a node** | The app also connects with role `node` (one device, role `both`, which `DeviceRole` already allows) and the owner grants the `node` scope. Capabilities reuse the mac helper's names where the meaning matches: `contacts.search` / `contacts.read`, `calendar.*` (EventKit is the same API), `presence.public_key`, plus new ones: `location.current`, `location.watch_significant`, `photos.search`, `photos.get` (PHPicker-limited or full library, as the owner grants), `notify.show` (local notifications while the app is foregrounded). **Availability:** iOS gives a suspended app no CPU, so the node is reachable only while the app is open, or for a few seconds after a push. The Gateway already treats nodes as intermittent. A `node.invoke` that finds the phone offline returns `failed/retryable` and may raise an `input_needed` notification ("Open Psyche to share your location"). It never sends silent pushes to fetch data, because iOS throttles them and they would be a covert tracking channel. Significant-location monitoring is the one background exception, opt-in, with the system indicator showing. | M3 |

## 5. Security

- **Per-device scopes.** A phone pairs as its own device with owner-chosen scopes (§2.2). `operator.admin` stays off by default. If the owner grants it, every widening call still needs fresh presence, exactly as security §10 lists.
- **Revocation.** `devices.revoke` from any admin device closes the phone's connections, drops its node authority and presence key, and deletes its push registration and content key. Nothing reaches the phone after that, because the relay holds no state. Lost-phone flow: revoke from the desktop, done. `psyche security audit` gains three checks: "phone with admin scope", "push registration older than 180 days with no delivery" and "Gateway identity key missing".
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
| **M1: iOS app over the existing protocol** | SwiftUI app, iOS 18+. `PsycheProtocol.swift` as a Swift package. QR pairing with the Gateway identity key (Gateway side: the identity key and signed challenge). Keychain storage. Screens: chat (streaming), Tasks, approvals (in-app, foreground), inbox and threads. `stateVersion` resync, the offline outbox, the share extension and on-device dictation. No remote push yet: the PWA's Web Push keeps covering background nudges. | (1) Pair by QR in under a minute, with an owner approval on the desktop. (2) A Gateway that presents a different identity key is refused with a clear error, and so is a MITM proxy with a valid certificate. (3) Background the app for 1 hour, reopen it: within 2 s it shows approvals created in the meantime, with no duplicates. (4) A message sent in airplane mode is delivered exactly once after reconnecting. (5) Sharing a PDF from Files creates a Library item in the chosen thread. (6) The `protocol:check` CI step also builds the Swift package, so a schema change that breaks Swift fails CI. |
| **M2: relay push + actionable approvals** | `apps/push-relay` (open source; the publisher runs the store instance; self-builders run their own). App Attest registration, installation keys, rate limits. Adds the APNs branch of `createPushSurface`, the Notification Service Extension (decryption), the approval categories, `POST /v1/approvals/answer`, the phone presence key for `deviceOnly` answers, widgets, and Live Activities (stretch). Docs: a "Run your own relay" guide. | (1) With the app killed and the phone locked, a `write` approval shows Approve / Deny. Approve asks for Face ID and completes within 5 s, and the desktop card disappears. (2) A `financial` approval shows only **Review…**, and the in-app answer needs a Secure Enclave presence proof (the Gateway refuses it without one). (3) A capture of relay traffic contains no title, body, thread id or Gateway URL (automated test against the relay). (4) A Gateway database copied to another machine can't send pushes without the relay installation key, and the relay refuses handles from a different app id. (5) Answering on the Mac removes the delivered notification from the phone within 10 s. (6) The relay can restart with zero stored state, and no registered phone loses push. |
| **M3: phone as a node** | Role `both`. Capabilities `location.current`, `location.watch_significant`, `photos.search` / `photos.get`, `contacts.*`, `calendar.*`, `notify.show`. Per-capability toggles in the app plus the iOS permission prompts. Intermittent availability with the `input_needed` fallback. Voice mode. Android begins (Kotlin, FCM via the relay, UnifiedPush option), sharing the JSON Schema. | (1) "Where am I?" in a desktop chat returns the phone's location only while the phone node is connected and the toggle is on. Otherwise the Task asks "Open Psyche on your phone". (2) "Find the photo of the receipt from Tuesday" returns a photo the agent can attach, and the result is tainted. (3) Revoking the `node` scope stops capability calls at once and leaves the client role working. (4) No silent push is ever sent to fetch node data (Gateway test over the delivery log). (5) Turning off location in iOS Settings makes `location.current` return `forbidden`, which isn't retried. |

## 7. Open questions for the owner

1. **Who runs the relay, and under which domain?** It needs an Apple Developer account, App Attest and a small budget. It must stay optional: every Gateway feature works without it, with the in-app inbox, Web Push and channels.
2. **Cloudflare Access in the native app:** support it in M1, or document Tailscale as the supported path and Access as PWA-only?
3. **Live Activities:** they can't be E2E encrypted. Is a "step 3 of 7, running" status acceptable, or should they be left out?
4. **iOS Web Push:** test whether action buttons work on iOS and how reliable delivery is (both unverified). If actions work, M0 could answer `write` approvals from the lock screen.
5. **Minimum iOS version:** 18 (Declarative Web Push from 18.4, and wider reach) or 26 (`SpeechAnalyzer`, which matches the mac helper)?

## Sources

- Home Assistant push: contributors.home-assistant.io/companion/mobile-app-api/notifications, companion.home-assistant.io/docs/notifications/notification-details
- Bitwarden: bitwarden.com/help/configure-push-relay
- ntfy iOS upstream: docs.ntfy.sh/config/#ios-instant-notifications
- UnifiedPush: unifiedpush.org/users/faq
- Web Push on iOS: webkit.org/blog/13878, webkit.org/blog/16535 (Declarative Web Push)
- APNs: developer.apple.com/documentation/usernotifications/generating-a-remote-notification
- Matrix Sygnal: github.com/matrix-org/sygnal
- In repo: `docs/05-security-and-permissions.md` §3.7, §9, §10; `docs/02-architecture.md` §4.6, §4.12, §7, §11; `docs/03-feature-spec.md` A8, N12, N14; `docs/guides/server-mode.md`; `docs/design/cross-platform-2026.md`
