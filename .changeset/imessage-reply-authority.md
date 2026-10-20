---
"@psyche/permissions": patch
"@psyche/gateway": patch
---

Channel reply authority: `authorizeChannelReply` issues an audited, already-decided `once` `message_send` approval for replies into the conversation being answered, pairing codes and the owner's approval cards; the Gateway uses it as iMessage's `authorizeSend`, re-verifies each `messages.send` binding before dispatch, and turns iMessage on with `PSYCHE_IMESSAGE_ACCOUNT`.
