---
"@psyche/protocol": minor
"@psyche/memory": minor
"@psyche/search": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

Forget reaches everywhere (memory wave 3A). `memory.forget` now deletes a word or phrase from the Markdown files, claims, chunks (persona and protected files' chunks too, and they stay out when the file is indexed again), the people graph (matching people, facts, relations, loops, interaction subjects and gists, summaries, notes, citations), review and quarantine rows, lessons and their lines in AGENTS.md and skills' LESSONS.md, the owner's feedback events, and Memory's documents in the search indexes. Matching is whole words, in any script; "Jordan" never takes "Jordana". The new read-only `memory.forget.preview` returns the counts per store before anything is deleted, and `/forget` shows them in its confirm. Both are for the Psyche app on the Host only. `memory.reset` also erases the graph, citations and quarantine. A hash of a forgotten phrase (never the phrase) is kept so persona chunks do not return.
