---
"@psyche/gateway": minor
"@psyche/web": patch
---

Fresh presence for access-widening and destructive admin methods (devices.approve, channels access changes, memory.reset, backup.delete) and a device's first passkey; presence is sticky once enrolled (`presence_required` instead of an admin-only fallback); `psyched presence reset`. The web Passkeys panel retries a first passkey with the owner's approval.
