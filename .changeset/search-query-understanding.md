---
"@psyche/search": minor
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

Search understands plain-English questions. Four or more words (or a "?") are read as a question: stop words are dropped (English, with short Spanish, Portuguese, French and German lists) and the content words are ORed so BM25 ranks by how many a document has, instead of ANDing every word and returning nothing. Rule-based filters turn "last week", "in March", "two days ago", "from Alex", "in my email" and "PDF" into filters (the owner's timezone from USER.md; people resolved through the people graph), shown as removable chips on the Search screen. If the filtered query finds nothing the filters are relaxed, then every word is ORed, so a query with matching words never returns zero results. Typed syntax (`from:`, `in:`, `type:`, `before:`, `after:`, `source:`, quotes, `-x`) works as before; `source:` is new. `search.query` returns `understood` (intent, chips, relaxed) and takes `dropChips`. The eval harness gains a `prod` mode and runs in CI as a non-blocking report.
