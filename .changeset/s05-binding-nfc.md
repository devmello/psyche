---
"@psyche/agent-core": patch
"@psyche/connectors": patch
---

Binding recipes hash the exact strings that run or are sent: no NFC folding in the loop's or the connectors' canonical JSON, or in the Gmail send binding (S23 design-13).
