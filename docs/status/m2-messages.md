# M2 messages (J7 / N5) — status (2026-10-19)

Sessions: M2 messages. PRs: devmello/psyche#208 (`protocol:` messages.*, merged), the J7 mac-helper PR (`ws/m2-messages-helper`), the N5 iMessage channel PR.

## J7 — Messages in the mac helper

- Works: `messages.status | chats | read | watch | send` in `apps/mac-helper/Sources/*/Messages/`, registered with one line in `HelperRuntime`. Read-only chat.db (`mode=ro`), schema probing across macOS versions, typedstream body text without `NSUnarchiver`, tapbacks, inline replies, attachments as metadata, ROWID cursor, polling watcher with back-off, Full Disk Access error naming the Settings pane, Automation preflight, send refused without `approvalId`, macOS 26+ chat-GUID fallbacks. Details: `apps/mac-helper/README.md` "Messages (J7)".
- Tests: 22 Swift Testing cases on fixture chat.db files built per test (modern and macOS 12-era schemas) and a fake script sender; no TCC grants needed.
- Not run live: the manual plan §12 needs Full Disk Access and Automation on a signed build.
- Stubbed: sending attachments / CAF voice bubbles, attachment bytes, polls.

## Requests

- **S05:** classify `messages.send` (node capability, `destructive`, `recipient`) as `message_send`; binding `{channel: "imessage", account: <node id>, recipient, bodyHash}` (security §3.5).
- **S14:** `Support/Info.plist`'s `NSAppleEventsUsageDescription` could name Messages ("sending a message you approved"); left untouched to avoid colliding with the J6 adapters.
