---
"@psyche/memory": minor
"@psyche/db": minor
---

Everything memory extractor and nightly pass (EM3), owner-authored items only: the `search_docs` reader with per-source cursors and a 3-day catch-up window, deterministic cleaning that also cuts forwarded mail, batching, the versioned extractor prompt and the single `tools: []` call site (pinned by a source-scan test), power, idle, quiet-hours and local-model gates, per-source model routing (None until picked), token budget, `memory_runs`, an extracted-items cache (`memory_extracted_items`), and a nightly step that can fold in the people-graph model pass. Every output goes through the EM2 validator and `ExtractionSink`.
