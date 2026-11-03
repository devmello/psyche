---
"@psyche/protocol": minor
"@psyche/search": patch
"@psyche/gateway": patch
"@psyche/ui": minor
---

Memory follows Search. Search sources is the one list of what Psyche may read; memory learns from each source Search reads unless you opt that source out under Settings → Memory → Sources ("Learning from it"). A source Search does not read shows as off there ("Psyche doesn't read Mail") with a one-click "Let Psyche read Mail" instead of "on, but not indexed". `memory.everything.optOut` stores the opt-outs; a value saved with the old per-source switches is migrated on read (a switch that was off becomes an opt-out), and the Gateway reads effective sources as indexed and not opted out on every pass. Browser pages and chats are still never read.

Rebuild on Search sources now works and says what it did. A rebuild used to run while a pass could still write a stale cursor (so it resumed mid-source), was joined to a pass already in flight (so nothing was read again for minutes), emptied the source even when it could not be read again, and the button swallowed every error. It now waits for the pass in flight, refuses (changing nothing) when the source is off, the Mac helper is not connected or the Mac is on battery, shows Rebuilding…, how far it has read and "Rebuilt N items", and is disabled for a source that is off.
