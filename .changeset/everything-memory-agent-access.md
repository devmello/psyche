---
"@psyche/memory": minor
"@psyche/gateway": minor
---

Everything memory owner-only access (EM7): `agentAccess` (none / accepted / all, default accepted) with a separate switch for sensitive facts, combined with Search's per-source "agent can search" flag (a fact is visible only if every citation's source is), enforced where the agent reads facts (`people_lookup`, `project_brief`, entity recall). Switching the feature off hides everything learned from the agent. Learned facts stay out of person card files unless `writeCardFiles` is on, out of the search index when sensitive, and out of the summary prompt.
