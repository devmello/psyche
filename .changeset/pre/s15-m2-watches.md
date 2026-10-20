---
"@psyche/proactive": minor
"@psyche/gateway": patch
---

Goal watches (O3): `GoalsService.addWatch` / `removeWatch` link scheduler watch automations to a goal; they run only while the goal is active and show their last status on the goal's progress. psyched now gives the scheduler a guarded watch fetcher (watches previously failed with no fetcher). A simulated-day audit test checks every proactive producer against the budget together.
