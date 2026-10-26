---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

New read-only method `insights.summary` (operator.read) for the Overview screen: run, approval, artifact and specialist totals for 7 days, 30 days or all time with the previous period, one row per day in the caller's time zone, and the people and projects Psyche dealt with most. Incognito threads are left out. The UI gets `useInsights(window)` and mock fixtures for a new user, a typical month and a heavy year.
