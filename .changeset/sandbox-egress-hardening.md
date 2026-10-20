---
"@psyche/sandbox": patch
---

Egress proxy hardening: plain HTTP forwards exactly one request with `Host` forced to the URL's host (#282); origin decisions expire so `once` approvals and revoked grants are re-asked, allowlisting a refused host works, and IPv6 is classified from parsed bytes with every IPv4-embedding form covered (#283).
