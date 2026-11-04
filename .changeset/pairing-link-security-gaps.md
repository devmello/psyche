---
"@psyche/db": patch
"@psyche/gateway": patch
"@psyche/desktop": patch
---

Pairing links: revoking a device now revokes the unused links it made. A computer forgets its setup token as soon as the Host answers the connect that carried it (paired, waiting or denied), not only when the token was refused. A failed audit write is logged (never with the token) instead of dropped, and a new link whose creation cannot be audited is withheld and its token revoked.
