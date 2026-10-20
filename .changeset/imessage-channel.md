---
"@psyche/channels": patch
"@psyche/gateway": patch
---

iMessage channel (N5): `IMessageAdapter` over the mac helper's `messages.*` capabilities (chat.db watch from a persisted cursor, SMS / RCS senders weak, echoes dropped, Full Disk Access health), outbound only through an explicit `authorizeSend` port that returns a `message_send` approval id, and approval cards answerable with `/approve` or a 👍 / 👎 tapback. The Gateway registers it when `ChannelsSetup.imessage` is configured.
