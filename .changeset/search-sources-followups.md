---
"@psyche/search": patch
"@psyche/gateway": patch
---

Search sources, follow-ups: the Memory source checks whether the search index is really encrypted (not whether the switch is on: with the key unavailable the index stays plain), counts the people graph's own model-pass facts as learned from the channel of their interactions (so Messages' rules apply to them), reads past 500 calendar events when only one half of a split is empty, refreshes the chat directory when a day names a chat it does not know and reads again the rows of a chat it could not name once it can, and a memory change now reads only the Memory source instead of every source.
