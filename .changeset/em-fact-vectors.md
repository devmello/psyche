---
"@psyche/db": minor
"@psyche/memory": minor
"@psyche/gateway": minor
---

Life search keeps each fact's vector in `graph_fact_vectors` (per embedding model, keyed by the hash of the embedded text), so only new or changed facts are embedded. Sensitive facts are never stored; vectors go with their fact (cascade) and are pruned after each nightly pass; with encryption on the table lives in the encrypted memory store.
