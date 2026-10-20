---
"@psyche/permissions": patch
---

Fuzz and property tests for canonicalization, decide(), grant TTLs, URL rules and the approval lifecycle; fixes found by them: unused `once` approvals end at a restart, and hosts with empty labels are not canonical.
