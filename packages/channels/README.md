# @psyche/channels

**Owner:** S10 (`prompts/s10-channels.md`). Features N1–N4, N10, N11 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md); architecture §4.10; security §9; ADR-011.

Lets the owner (and people the owner designates) reach Psyche from chat apps. It contains the channel framework, authorization copied from OpenClaw (pairing, allowlists, owner identity, identity links, group mention gating), approvals over chat, voice notes, and the WebChat and Telegram adapters.

## Public API (`src/index.ts`)

- `ChannelService`: the framework. `init()`, `attach(adapter)`, `start(id)` (retries with backoff), `stop`, `checkHealth()`, `send(target, text, {format, attachments})` (Markdown flavoring, chunking, per-chat and per-channel token buckets, `rate_limited` retry), `typing`, `sendVoice`, `deliverApproval(issued)`, `ownerSurfaces()`, `handleInbound`, and the channel, pairing and identity management used by the API.
- `createChannelsApi(service, {newId, now})`: handlers for `channels.list|get|configure|allowlist.update|pairing.list|pairing.approve|pairing.deny|identities.list|identities.upsert|identities.delete`. The Gateway (S01) checks the scope (`operator.admin` for changes) and mounts them.
- Ports the Gateway implements: `InboundSink` (receives `ChannelInboundEvent {kind: message | edit | command, route, parts, attachments}`), `LibraryIngest`, `EmitEvent` (`channels.updated`, `pairing.requested`), `ChannelLogger`.
- Stores: `MemoryChannelStore`, `SqliteChannelStore` (`@psyche/db`; migration `202610191200_channels_init.sql` for `channels` and `identities`; pairing rows use the shared `pairing_requests` repo).
- Adapters: `WebChatAdapter` (owner-only, see `webChatChannelDefaults()`), `TelegramAdapter` (grammY 1.46.0: long polling, HTML Markdown, photos, documents, voice via `sendVoice`, inline-button approvals with opaque nonces, typing, `getFile` downloads with a 20 MB cap, token scrubbed from every error).
- Helpers: `authorizeInbound`, `buildRoute` / `sessionKeyFor`, `PairingService`, `IdentityDirectory`, `renderMarkdown`, `chunkMessage`, `sanitizeValue`, `renderApprovalCard`, `chatEligibility`, `VoiceNotes`, `RateLimiter`, `backoffDelay`.

## How inbound works

1. **Authorize** (`policy.ts`). DMs use `dmPolicy`. `pairing` is the default: an unknown sender gets an 8-character code (no 0/O/1/I) that expires in 1 h, and nothing else. Each channel holds at most 3 pending codes; a 4th sender gets no reply, and an existing code is re-sent at most once every 10 min. `allowlist` drops unknown senders silently. `open` requires `"*"` in `allowFrom`. `disabled` drops all DMs. Groups must be listed in `config.groups`. The sender must then be in `groupAllowFrom` (which falls back to `allowFrom`). Under `requireMention` (the default), only a structured mention or a reply to the bot activates the agent. Replying to the bot does not bypass the sender allowlist.
2. **Owner** = strong sender in the channel's `ownerIds` or in `commands.ownerAllowFrom` (`telegram:123`). Weak transports never match an owner (review design-21): Telegram anonymous admins, channel posts, and later SMS behind an iMessage handle. Ownership does not grant chat access.
3. **Commands** (`/approve`, `/deny`, `/whoami`, `/help` here; anything else goes to the Gateway) run only for owners and `config.commandsAllowFrom`.
4. **Route** (`routing.ts`). Groups get their own session. The owner gets `main` / `peer:owner` / per-channel by `dmScope`. Non-owners never land in `main`: under `main` they are coerced to per-channel-peer. `identityLinks` merge one person across channels under `per-peer`. `injectMemory` is true only in the owner's private sessions.
5. **Provenance parts** (review design-22). Forwarded text is `untrusted`, even when the owner forwards it; it never runs as a command, and its mention entities do not activate the bot. Quoted context keeps its author's provenance and is dropped for non-allowlisted authors under `contextVisibility: allowlist` (the default). Edits arrive as `kind: "edit"`, never as a new instruction. Voice notes are transcribed with `SpeechEngine.transcribeFile`. Attachments go to the Library quarantine.

## Designated person mode (N10)

Link a person's senders in an identity with `delegatedPersona` (overlay name) and `toolAllow` (globs; `null` means no tools). Their route carries `role: "designated"`, the overlay, the tool list, `injectMemory: false`, a `peer:<identityId>` session, `grantSubject` for S05's per-sender grant matrix, and `approvalsToOwner: true`. A designated group binds `members` at designation time; later members are ignored.

## Approvals over chat

`deliverApproval(issued)` sends cards to every `<channel>:<peerId>` surface whose peer is an owner. WebChat is excluded, because web clients answer on the device approval card under `operator.approvals`. A failed send on one surface does not stop delivery to the others. Telegram gets inline buttons; channels without buttons get a `/approve <ref> approve|deny` fallback. Card text is `renderForSurface(surface, approval)` from `@psyche/permissions/cards`, the one renderer every surface uses (design-12): a fixed plain-text template (action class and target first), every value sanitized (line breaks become `⏎`, hidden characters become `⟨U+XXXX⟩`, IDN hosts shown in punycode), no parse mode. A card that does not fit is replaced by "Open on your Mac to review." and cannot be answered from chat; it is never truncated. A `deviceOnly`, financial or forbidden-kind approval (and `destructive` without opt-in) gets the header and "Answer this on your Mac." only: no arguments, no buttons, no `/approve` ref. Answers are accepted only from owner identities and always with scope `once`. Broker errors map to short replies (expired, already answered, replaced after restart, too quick).

These never reach chat: `deviceOnly` requests, `financial`, `purchase`, `credential_fill`, `exec_host`, `policy_change` and `pairing`. `destructive` is excluded too unless the channel sets `config.allowDestructiveApprovals` (see the doc conflict in `docs/status/s10.md`). `config.ownerDevice` is recorded but unlocks nothing, because security §3.7 and §9 do not allow it.

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
- iMessage (N5, M2) is not done. It will be an adapter over the Mac node's `messages.*` capability.
