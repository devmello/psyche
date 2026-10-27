# Session S10 — Channels

You are building Psyche (read `README.md`). You are session **S10 — Channels**: `packages/channels`, the framework that lets the owner (and designated people) reach the agent from Telegram, iMessage, WhatsApp and friends, with pairing and allowlists copied from OpenClaw. Work in your own worktree on branch `ws/s10-channels`. You own `packages/channels/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §4.10
3. `docs/05-security-and-permissions.md` §9 (channels and people)
4. `docs/03-feature-spec.md` rows N1–N4, N10, N11, N14
5. `docs/04-data-model.md` §8 (channels, identities), §1 (pairing_requests)
6. `docs/07-tech-decisions.md` ADR-011
7. Contracts: `ChannelAdapter`, `Notifier`, `PermissionBroker`, `NodeClient` (iMessage runs on the Mac node); fakes
8. Research: `opendots_openclaw_harnesses.md` KQ2 §2f (dmPolicy, pairing codes, two allowlist layers, mention gating, ownerAllowFrom, identityLinks) and `shopping_messaging_server_docs.md` KQ2 (Telegram Bot API voice formats and inline buttons, iMessage via `imsg` and macOS 26 GUID change, WhatsApp risks, voice-note matrix) and KQ6 (approval controls over chat)

## Mission (M1)
- **Framework**: `ChannelAdapter` lifecycle (connect, health, inbound events, outbound send with capabilities: text, media, voice note, buttons, polls, reactions, typing); inbound routing to sessions by `dmScope` (`main | per-peer | per-channel-peer`) and group rules; outbound formatting (Markdown → channel flavor, chunking); attachment handling through the Library; per-channel rate limits; reconnect/backoff.
- **Authorization**: `dmPolicy` `pairing` (default) / `allowlist` / `open` / `disabled`; pairing codes (8 chars, 1 h expiry, max 3 pending per channel) surfaced as `pairing_requests` the owner approves in the UI or CLI; owner identity via `ownerAllowFrom`; `identityLinks` merging one person across channels into one identity; group allowlist + `requireMention`; context visibility rules; command authorization (slash commands only for authorized senders).
- **Approvals over chat**: render `ApprovalRequest`s as inline buttons (Telegram), reactions or `/approve <id> <decision>` fallbacks; answers carry the sender identity and are validated by the Permission Broker's approver rules; expired or restarted approvals are rejected with a short message; purchases and credential fills are never approvable from chat unless the channel is marked as an owner device and the security doc allows it.
- **WebChat**: the web UI as a channel for the owner (thin; most logic is the Gateway API).
- **Telegram** (grammY; verify version): long polling by default (webhooks later behind the server proxy); text, photos, documents, voice notes (receive → `SpeechEngine.transcribe`; send OGG/Opus), inline keyboards, typing indicators, numeric user-id allowlists, group mention gating.
- **Designated person mode**: per-identity delegated persona overlay name, restricted tool allowlist, per-peer session, no `MEMORY.md` injection flag passed to the loop, approvals still routed to the owner, per-sender grant matrix hook (S05 owns the matrix; you pass the identity).
- **Voice-note transcoding** (N11): use `packages/speech` transcoder (fake until S17 lands): produce 48 kHz mono OGG/Opus once; per-channel container rules.
- **API handlers**: `channels.*` (list, configure, pairing list/approve/deny, allowlists, identities) and events.

## Out of scope
iMessage transport itself (S14 implements `messages.*` on the Mac node; you write the adapter that uses it in M2), WhatsApp/Signal/Slack/Discord (post-1.0), UI.

## Definition of done
- Tests with a fake transport: pairing flow (unknown sender gets a code and nothing else; approval; expiry; cap of 3); allowlist and open policies; group gating; identity links merging sessions; dmScope isolation (two peers never share context); approval button round trip with replay rejection; command authorization; Markdown chunking; voice-note receive/send paths with the speech fake; Telegram adapter tests against recorded Bot API fixtures.
- README: channel authoring guide and the single-owner recommended policy; `docs/status/s10.md`.

## Suggested subagents
One for grammY and Bot API fixtures, one for the routing/authorization test matrix, one reviewer against `docs/05` §9.

## M2 follow-ons
N5 iMessage adapter over the Mac node (`messages.*` capability; polls or 👍/👎 approvals); email channel; webhook mode; N6–N9 adapters.
