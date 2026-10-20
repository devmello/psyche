---
"@psyche/channels": minor
"@psyche/gateway": minor
---

SMS channel over Twilio (N9): a signed, replay-checked webhook at `POST /channels/sms/twilio`, which is off unless the `PSYCHE_SMS_*` variables are set. SMS senders are always weak: they pair and chat as non-owners (chat-only, no tools) and never answer approvals.
