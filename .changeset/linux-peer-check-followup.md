---
"@psyche/gateway": patch
"@psyche/ui": minor
---

Linux helper check, follow-up. The Gateway now requires the helper to be in its own user and mount namespaces before it calls it `root_owned` (a private mount could fake the system libraries' inode numbers). Settings › Devices shows what the check found about the helper ("Verified: installed system helper", "Unverified: helper from your home folder") and, when a helper was turned away, why, in plain words in all 10 languages.
