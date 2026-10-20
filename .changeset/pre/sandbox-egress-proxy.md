---
"@psyche/sandbox": minor
---

Egress proxy (K4): `EgressProxy` with per-scope allowlists, DNS pinning, SSRF ranges refused, TLS-only CONNECT with SNI checks, broker `new_origin` decisions (cards in tainted tasks), receipts and per-connection logs. Proxy-mode sandboxes keep network `none` and reach it through an in-container shim over stdio, on Apple `container`, Docker and Podman. `createSandboxEgress` is the Gateway hook.
