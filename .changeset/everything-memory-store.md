---
"@psyche/db": minor
"@psyche/memory": minor
---

Everything memory store (EM1): migration `202610281200_memory_everything` (event/topic kinds, life attributes and relations, fact review/sensitivity/subject columns, `graph_citations`, `memory_runs`, `memory_quarantine`, `graph_exclusions`, `memory_never_rules`, `memory_claim_subjects`) and `EverythingStore` (cited proposals, supersession and conflict rules, review decisions, quarantine, per-contact exclusion, retention, per-person export, "forget what they said"). Proposed, discarded and quarantined facts are invisible to the existing graph readers.
