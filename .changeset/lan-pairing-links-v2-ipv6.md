---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/ui": minor
"@psyche/web": minor
"@psyche/desktop": minor
---

Pairing links for a Gateway on the local network, and LAN over IPv6. A `psyche-pair:v2` link carries the Gateway's identity key and the SPKI pin of its self-signed LAN certificate next to the single-use setup token. The desktop checks the certificate against the pin before it sends anything (the token included) and checks the identity key's signature over that certificate in the handshake; a wrong pin, a missing pin, or an address that is not on a local network is refused with a plain message. Settings → Pair another computer offers "From this network" while LAN is on; the Host makes v2 only for that choice and v1 stays as it was for Tailscale. LAN can also listen on IPv6 unique-local addresses (`gateway.lan.ipv6`, off by default, with the address list, bind, certificate names, origin check, network-pause check and rate limits counted per /64 updated). Global unicast and link-local IPv6 are never used. v1 links and the existing LAN flow are unchanged.
