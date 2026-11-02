---
"@psyche/gateway": minor
"@psyche/memory": minor
"@psyche/protocol": minor
"@psyche/ui": patch
---

Memory store location (EM9b, part 1): with `memory.encrypt` on (not in Settings yet), the people graph, the memory index and everything memory use the encrypted `state/memory.sqlite`, opened once its key arrives from the vault slot or the Mac helper. Until then reads are empty and writes fail with `unavailable`; the nightly pass reports `store_unavailable`. Off (the default) passes `psyche.sqlite` itself, unchanged.
