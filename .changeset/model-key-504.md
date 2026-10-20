---
"@psyche/gateway": patch
"@psyche/model-router": patch
"@psyche/ui": patch
"@psyche/web": patch
---

Provider keys (#504): `models.setKey` normalizes a pasted key and refuses ones that cannot work (whitespace, Claude subscription tokens, Admin keys, wrong shape) with a reason; the probe reports the provider's own reason and tells a refused key from a malformed request; onboarding checks a key right after saving it; Settings → Model & providers can add or replace a key and checks it at once.
