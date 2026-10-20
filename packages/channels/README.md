# @psyche/channels

**Owner:** S10 (`prompts/s10-channels.md`). Features N1–N5, N8 (Discord), N10, N11 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md); architecture §4.10; security §9; ADR-011.

Lets the owner (and people the owner designates) reach Psyche from chat apps. It contains the channel framework, authorization copied from OpenClaw (pairing, allowlists, owner identity, identity links, group mention gating), approvals over chat, voice notes, and the WebChat, Telegram, Discord and iMessage adapters.

## Public API (`src/index.ts`)

- `ChannelService`: the framework. `init()`, `attach(adapter)`, `start(id)` (retries with backoff), `stop`, `checkHealth()`, `send(target, text, {format, attachments})` (Markdown flavoring, chunking, per-chat and per-channel token buckets, `rate_limited` retry), `typing`, `sendVoice`, `deliverApproval(issued)`, `ownerSurfaces()`, `handleInbound`, and the channel, pairing and identity management used by the API.
- `createChannelsApi(service, {newId, now})`: handlers for `channels.list|get|configure|allowlist.update|pairing.list|pairing.approve|pairing.deny|identities.list|identities.upsert|identities.delete`. The Gateway (S01) checks the scope (`operator.admin` for changes) and mounts them.
- Ports the Gateway implements: `InboundSink` (receives `ChannelInboundEvent {kind: message | edit | command, route, parts, attachments}`), `LibraryIngest`, `EmitEvent` (`channels.updated`, `pairing.requested`), `ChannelLogger`.
- Stores: `MemoryChannelStore`, `SqliteChannelStore` (`@psyche/db`; migration `202610191200_channels_init.sql` for `channels` and `identities`; pairing rows use the shared `pairing_requests` repo).
- Adapters: `WebChatAdapter` (owner-only, see `webChatChannelDefaults()`), `TelegramAdapter` (grammY 1.46.0: long polling, HTML Markdown, photos, documents, voice via `sendVoice`, inline-button approvals with opaque nonces, typing, `getFile` downloads with a 20 MB cap, token scrubbed from every error), `IMessageAdapter` (the mac helper's `messages.*` node capabilities; see [iMessage](#imessage-n5)).
- Helpers: `authorizeInbound`, `buildRoute` / `sessionKeyFor`, `PairingService`, `IdentityDirectory`, `renderMarkdown`, `chunkMessage`, `sanitizeValue`, `renderApprovalCard`, `chatEligibility`, `VoiceNotes`, `RateLimiter`, `backoffDelay`.

## How inbound works

1. **Authorize** (`policy.ts`). DMs use `dmPolicy`. `pairing` is the default: an unknown sender gets an 8-character code (no 0/O/1/I) that expires in 1 h, and nothing else. Each channel holds at most 3 pending codes; a 4th sender gets no reply, and an existing code is re-sent at most once every 10 min. `allowlist` drops unknown senders silently. `open` requires `"*"` in `allowFrom`. `disabled` drops all DMs. Groups must be listed in `config.groups`. The sender must then be in `groupAllowFrom` (which falls back to `allowFrom`). Under `requireMention` (the default), only a structured mention or a reply to the bot activates the agent. Replying to the bot does not bypass the sender allowlist.
2. **Owner** = strong sender in the channel's `ownerIds` or in `commands.ownerAllowFrom` (`telegram:123`). Weak transports never match an owner (review design-21): Telegram anonymous admins, channel posts, and SMS / RCS behind an iMessage handle. Ownership does not grant chat access.
3. **Commands** (`/approve`, `/deny`, `/whoami`, `/help` here; anything else goes to the Gateway) run only for owners and `config.commandsAllowFrom`.
4. **Route** (`routing.ts`). Groups get their own session. The owner gets `main` / `peer:owner` / per-channel by `dmScope`. Non-owners never land in `main`: under `main` they are coerced to per-channel-peer. `identityLinks` merge one person across channels under `per-peer`. `injectMemory` is true only in the owner's private sessions.
5. **Provenance parts** (review design-22). Forwarded text is `untrusted`, even when the owner forwards it; it never runs as a command, and its mention entities do not activate the bot. Quoted context keeps its author's provenance and is dropped for non-allowlisted authors under `contextVisibility: allowlist` (the default). Edits arrive as `kind: "edit"`, never as a new instruction. Voice notes are transcribed with `SpeechEngine.transcribeFile`. Attachments go to the Library quarantine. Every delivered event carries `taintSources` (`channel_forwarded`, `channel_quoted`, `channel_message`, `channel_attachment`, each with `origin: "<type>:<chatId>"` and the author as `sender`), empty when all content is the owner's or Psyche's; the Gateway starts the turn tainted with them when non-empty, even for the owner's own message (#275, security §3.6).

## Designated person mode (N10)

Link a person's senders in an identity with `delegatedPersona` (overlay name) and `toolAllow` (globs; `null` means no tools). Their route carries `role: "designated"`, the overlay, the tool list, `injectMemory: false`, a `peer:<identityId>` session, `grantSubject` for S05's per-sender grant matrix, and `approvalsToOwner: true`. A designated group binds `members` at designation time; later members are ignored.

## Approvals over chat

`deliverApproval(issued)` sends cards to every `<channel>:<peerId>` surface whose peer is an owner. WebChat is excluded, because web clients answer on the device approval card under `operator.approvals`. A failed send on one surface does not stop delivery to the others. Telegram gets inline buttons; channels without buttons get a `/approve <ref> approve|deny` fallback. Card text is `renderForSurface(surface, approval)` from `@psyche/permissions/cards`, the one renderer every surface uses (design-12): a fixed plain-text template (action class and target first), every value sanitized (line breaks become `⏎`, hidden characters become `⟨U+XXXX⟩`, IDN hosts shown in punycode), no parse mode. A card that does not fit is replaced by "Open on your Mac to review." and cannot be answered from chat; it is never truncated. A `deviceOnly`, financial or forbidden-kind approval (and `destructive` without opt-in) gets the header and "Answer this on your Mac." only: no arguments, no buttons, no `/approve` ref. Answers are accepted only from owner identities and always with scope `once`. Broker errors map to short replies (expired, already answered, replaced after restart, too quick).

These never reach chat: `deviceOnly` requests, `financial`, `purchase`, `credential_fill`, `exec_host`, `policy_change` and `pairing`. `destructive` is excluded too unless the channel sets `config.allowDestructiveApprovals` (see the doc conflict in `docs/status/s10.md`). `config.ownerDevice` is recorded but unlocks nothing, because security §3.7 and §9 do not allow it.

## iMessage (N5)

`IMessageAdapter({account, node, authorizeSend, cursor})` runs on the Gateway and talks to the mac helper through `node.invoke` (`messages.status`, `messages.watch`, `messages.send`). Use a dedicated Apple ID on the Mac: everything the Mac's account sends (`isFromMe`) is dropped as inbound, so the owner writes from their own iPhone handle.

- **Inbound.** One streaming `messages.watch` (`includeFromMe: true`) from the persisted chat.db cursor (`message.ROWID`; the first start begins at the newest row, so history is never replayed). Each batch's cursor is saved on receipt (at most once: a crash drops a batch rather than re-running it), and each ROWID is handled once. Rows are dispatched in per-chat FIFO queues, so a send waiting on its approval in one chat never stalls another.
- **Mapping.** `senderId` is the canonical handle (E.164 or lowercased email; `validateChannel` rejects anything else in the id lists), `chatId` the chat guid. Rows whose handle or chat is `sms`, `rcs` or `unknown` are `identityStrength: "weak"`: they never match an owner (not even with the owner's number in `ownerIds` or `ownerAllowFrom`), cannot pair, and their DMs are dropped. Inline replies become `quoted` (`fromSelf` for Psyche's own rows). Attachments are metadata only (`kind: "voice"` for audio bubbles); the helper returns no bytes, so nothing is ingested yet. Tapbacks are never turns.
- **Groups.** chat.db has no structured mentions, so `mentioned` is always false. Groups stay off unless listed in `config.groups`; under `requireMention` (the default) only an inline reply to one of Psyche's messages activates a listed group, and `requireMention: false` on the group makes every allowed sender's message a turn.
- **Outbound and its authorization.** `messages.send` is destructive (it speaks as the Mac's Apple ID), and the node refuses it without an `approvalId`. Telegram replies are not broker-gated because the bot's reply in the sender's own chat is the channel itself; iMessage keeps that rule for *what* may be sent (only into the conversation being answered: a chat guid seen inbound, or a 1:1 peer's bare handle, which resolves to that peer's known iMessage chat or a new 1:1 iMessage chat), but the node still needs a real approval. So every send (reply chunk, pairing code, approval card, notices) calls `authorizeSend(intent)`, a port the Gateway implements with its Permission Broker: `intent` carries `{channel: "imessage", account, recipient, bodySha256, bindingHash, grantKey, purpose}`, where `bindingHash` is `bindingFor("message_send", …)` (security §3.5), and it must resolve the id of an approved `message_send` approval (scope `once`) bound to exactly that. A refusal sends nothing. The adapter never fabricates an id.
- **Approvals.** Cards are `renderForSurface("imessage:<peerId>", approval)` in plain text with the `/approve <ref> approve|deny` fallback and "Or tap 👍 to approve or 👎 to deny." The card's guid is learned from its own echo; a 👍 (`like`) or 👎 (`dislike`) tapback on it, in the same 1:1 chat, from a strong (iMessage) handle, is relayed as an approval answer, and `ChatApprovals` accepts it only from an owner, with scope `once`. Removed tapbacks and other kinds do nothing. Device-only, financial and non-opted-in destructive approvals get the header and "Answer this on your Mac." only. `ChatApprovals` hands the card to the adapter when it has `buttons` or `reactions`.
- **Health.** `messages.status` is the start preflight. A missing Full Disk Access grant (preflight or a `full_disk_access_missing` watch error) reports "Grant Full Disk Access to Psyche Helper …" as the health and channel status detail; restarts go through `ChannelService`'s exponential backoff and open no new watch while the grant is missing. A retryable watch error keeps the channel up with a detail; an ended watch is restarted. No typing indicators, no Markdown (plain text), 4000 characters per message (the service chunks).

## Discord (N8)

`DiscordAdapter({token, account})` uses no SDK: the gateway websocket (v10, JSON, the `ws` package) and `fetch` for REST. `token` is a source shaped `{use(fn)}`, so the bot token exists only inside `fn`. It is never logged, and every error message is scrubbed of it (and of each of its segments). `gatewayUrl` and `apiBase` can be injected for tests.

- **Gateway.** HELLO, then a heartbeat every `heartbeat_interval` with a jittered first beat. A missed HEARTBEAT_ACK terminates the zombie socket and resumes. IDENTIFY sends `GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT` (37376). READY stores `session_id`, `resume_gateway_url` and the bot user id. After a drop or RECONNECT (op 7) the adapter sends RESUME (op 6) on the resume URL, with backoff from 1 s up to 30 s. INVALID_SESSION (`d: false`) and close codes 4007 / 4009 make the next connection identify afresh. `start()` resolves on READY. `health()` is ok only while the socket is READY.
- **Fatal close codes.** 4004 means "Discord rejected the bot token". The adapter never reconnects with that token: a later `start()` fails fast without opening the gateway, so the service's backoff costs no traffic until the token changes. 4014 says to enable the Message Content intent in the developer portal. 4010–4013 are fatal too.
- **Mapping.** A channel without `guild_id` is a DM (`chatId` = DM channel id, `isGroup: false`). Guild channels are groups, with `mentioned` only when `mentions` holds the bot. `senderId` is the author's snowflake. Messages from the bot itself, other bots, webhooks and system message types are dropped. MESSAGE_UPDATE with a new `edited_timestamp` becomes `editOf`; embed-only updates are ignored. `message_reference` becomes `replyToMessageId` and `quoted` (`fromSelf` for the bot). A forward becomes `forwardedFrom: {}` with the snapshot text, and never counts as a mention. Attachments are metadata with `ref` = the CDN URL. `fetchAttachment` downloads only from `https://cdn.discordapp.com` / `https://media.discordapp.net`, without credentials or redirects, capped at 25 MB.
- **Outbound.** `POST /channels/{id}/messages` with at most 2000 characters (Markdown is native), replies via `message_reference`, `allowed_mentions: {parse: []}` (model text never pings) and embeds suppressed. Attachments go as multipart. A user id (the owner's, for approval cards) maps to the DM channel seen inbound, or opens one with `POST /users/@me/channels`. Pairing codes go to DM channels only. 429 maps to `rate_limited` (retryable, `retryAfterSec`). Typing uses `POST /channels/{id}/typing`.
- **Approvals.** The card is `renderApprovalCard` for `discord:<peerId>`, with an Approve / Deny action row only when the card is answerable. `custom_id` is the Telegram nonce scheme `a:<nonce>:<y|n>`. A click is acknowledged with interaction callback type 7, which removes the buttons. The adapter then emits `onApprovalAnswer` with the clicking user's id, and `ChatApprovals` accepts it only from an owner. Unknown or stale buttons get an ephemeral "no longer valid". Device-only cards have no buttons and say "Answer this on your Mac."
- **Gateway wiring.** Set `PSYCHE_DISCORD_BOT_TOKEN` or `PSYCHE_DISCORD_BOT_TOKEN_FILE` (re-read on each use), plus `PSYCHE_DISCORD_ACCOUNT`. Discord stays off otherwise. Then create a `discord` channel with that account: the defaults are dmPolicy `pairing`, owner via `ownerIds` (snowflakes), and groups only when listed in `config.groups`.

## SMS over Twilio (N9)

`SmsAdapter({accountSid, authToken, from, publicUrl, messagingServiceSid?, apiBase?})` is a Twilio-compatible webhook adapter with no SDK (node:crypto and `fetch`). It is off unless configured. The Gateway turns it on from `PSYCHE_SMS_TWILIO_ACCOUNT_SID`, `PSYCHE_SMS_TWILIO_AUTH_TOKEN` (or `_FILE`), `PSYCHE_SMS_FROM` (E.164) and `PSYCHE_SMS_PUBLIC_URL` (https). It needs all four: none means off, and some but not all stops boot. Only then is `POST /channels/sms/twilio` mounted. The owner still creates the channel with `channels.configure {type: "sms", account: "<PSYCHE_SMS_FROM>"}`. The auth token is an `SmsSecretSource` (`use(fn)`), so it lives only inside `fn`. Neither the token nor the AccountSid appears in an error or a log.

- **Reaching it.** The Gateway binds to loopback (security §10), so Twilio reaches the route through the owner's tunnel or reverse proxy. Set the Twilio number's webhook to exactly `PSYCHE_SMS_PUBLIC_URL`. The signature covers that configured URL and never the request's Host or `X-Forwarded-*` headers. Webhook routes authenticate themselves, so on the container bind they skip the transport gate.
- **Inbound.** Bodies over 64 KB are refused. Then `X-Twilio-Signature` must equal base64(HMAC-SHA1(authToken, publicUrl + each POST parameter's name and value, sorted by name)), compared with `timingSafeEqual`. Then `AccountSid` and `To` must match the configuration, and a `MessageSid` seen in the last 24 h is a replay. Every one of these failures answers 403. A good request gets 200 with empty TwiML (`<Response/>`), and the handlers run after the reply. Before `start()` the route answers 503 so that Twilio retries. Opt-out and help keywords (`STOP`, `HELP`, …, or `OptOutType`) and non-E.164 senders (short codes) never become messages.
- **Identity.** `chatId = senderId = From` (E.164), `isGroup: false`, and `identityStrength: "weak"` on every message: caller ids can be spoofed. SMS is a weak transport (`WEAK_TRANSPORTS` in `settings.ts`). Its senders follow the DM policy (pairing, allowlist) as non-owners and are never dropped as `weak_identity`. The owner's own number never gets owner authority, so every SMS route is chat-only (`toolAllow: []`, no `MEMORY.md`, never `main`). No sender may run commands. Pairing codes are sent with `send`.
- **Approvals.** SMS never answers approvals. An owner number in `ownerIds` gets `renderForSurface("sms:<peer>")` in its device-only form: the header and "Answer this on your Mac.", with no arguments, no `/approve` ref and no delivery to answer against (report `weak_identity`). `/approve` over SMS is refused.
- **Outbound.** A form POST to `{apiBase}/2010-04-01/Accounts/{AccountSid}/Messages.json` with `To`, `From` (or `MessagingServiceSid`) and `Body`, using basic auth. Messages are plain text, up to 1600 characters (the service chunks), with no buttons, typing, Markdown or outbound media. 429 → `rate_limited` (retryable, `retryAfterSec`), 5xx → `unavailable` (retryable), 21610 → `forbidden` "the recipient unsubscribed", other 4xx → a clear error carrying the Twilio code but never Twilio's message text. Default rate: 0.2/s per chat, 1/s per channel, burst 2, because every segment is billed.
- **MMS.** `NumMedia` / `MediaUrlN` / `MediaContentTypeN` become attachment metadata with `ref` set to the media URL. `fetchAttachment` fetches only `https://api.twilio.com` (or the configured `apiBase`), with basic auth. It follows one redirect to the CDN without credentials and caps the download at 5 MB.

## Recommended single-owner policy

```json
{ "type": "telegram", "dmPolicy": "allowlist", "allowFrom": ["<your numeric id>"],
  "ownerIds": ["<your numeric id>"], "dmScope": "main", "requireMention": true,
  "groupAllowFrom": [], "config": { "groups": {} } }
```

Get your id with `/whoami` after pairing once, or from the pairing request. Keep `dmScope: per-channel-peer` (the default) as soon as anyone else can message the bot, and link your other channels with an identity instead of widening `main`.

## Writing a channel adapter

1. Implement `ChannelAdapter` from `@psyche/protocol`. Report honest `capabilities()`. Map transport events to `InboundMessage`:
   - `senderId` must be the transport's stable id, never a display name or a contact-card lookup.
   - Set `identityStrength: "weak"` whenever the id is forgeable or shared.
   - Set `mentioned` only from structured mention entities.
   - Fill `forwardedFrom`, `quoted` (`fromSelf` for the bot's own messages) and `editOf` for edits.
   - Attachments carry a `ref` for `fetchAttachment`, never a credential-bearing URL.
2. `send` renders `format: "markdown"` only if `capabilities().markdown`. Otherwise the service has already flattened it. Reject over-length text with `invalid_params`. Map transport throttling to `PsycheError("rate_limited", …, {details: {retryAfterSec}})`.
3. Approvals:
   - `sendApprovalButtons` must refuse anything `chatEligibility` rejects (`forbidden`).
   - It must render with `renderApprovalCard` in plain text.
   - It must never put the answer token or approval id in transport-visible callback data.
   - It reports presses through `onApprovalAnswer` with the transport's sender id.
4. Scrub secrets (bot tokens) from every error message. Never log message text.
5. Tests:
   - recorded transport fixtures only (no network);
   - optional live tests behind `PSYCHE_LIVE_TESTS=1`;
   - run the service-level matrix in `test/` against your adapter, as `test/telegram/` does.

## What is stubbed

- `VoiceTranscoder` is a port with `FakeVoiceTranscoder` until S17 ships the ffmpeg / afconvert transcoder in `@psyche/speech`.
- `LibraryIngest`, `InboundSink` and `EmitEvent` are ports the Gateway wires. There is no Library contract yet.
- Telegram webhook mode (`handleUpdate` is public for it), polls, reactions, and editing a card after it is answered are not done.
- iMessage: outbound attachments and voice bubbles (CAF), inbound attachment bytes, polls (macOS 26+) and question cards are not done. The Gateway registers the adapter only when `ChannelsSetup.imessage` supplies an `authorizeSend`; no default authorizer ships yet (see `docs/status/s10.md`).
