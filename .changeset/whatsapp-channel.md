---
"@psyche/channels": patch
"@psyche/gateway": patch
---

WhatsApp as a channel over Meta's Cloud API (N6), with no SDK and no Baileys. The webhook (GET verify-token handshake, POST signed with the app secret over the raw body) is mounted only when configured. The adapter keeps the 24-hour service window, sends approval reply buttons that carry only a nonce, downloads media only from the media host, and reads its three secrets from env or the vault. WhatsApp senders are strong, set by the single constant `WHATSAPP_IDENTITY_STRENGTH`. Gateway webhook routes can now declare GET as well as POST.
