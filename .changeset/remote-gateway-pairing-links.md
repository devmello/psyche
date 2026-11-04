---
"@psyche/protocol": minor
"@psyche/db": minor
"@psyche/gateway": minor
"@psyche/ui": minor
"@psyche/web": minor
"@psyche/desktop": minor
---

Remote Gateway pairing links. Settings → Server & remote access → "Pair another computer" makes a one-time setup token (single use, 10 minutes, 256 random bits, stored only as a hash, revocable, at most three live) and a `psyche-pair:v1` link with a QR code drawn on the Host. "Add a Gateway" on the other computer accepts the pasted link, pre-pins the Host's key fingerprint so the first connect is verified rather than trust-on-first-use, and presents the token only after the Host proved that identity. The Host pairs the computer at once with exactly the scopes the owner ticked (admin off unless ticked); without a token the manual approval still applies. A used or expired token is refused with a clear message. In packaged builds a `psyche-pair:` URL opened from the system only fills the Add a Gateway field.
