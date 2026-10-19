# Acceptance: subscription-audit

Serves T5, V8, M5, P3. Feeds `tests/scenarios/subscription-audit.md`.

## Setup

- Test mail account seeded with 13 months of receipts for: a monthly streaming service, a monthly app subscription, an annual domain renewal, a free trial ending next week, and two one-off purchases from the same merchant as the app (not recurring).
- A cancellation fixture site you control for the app subscription with a login, a "Before you go: 50% off for 3 months" offer page, and a final "Cancel subscription" button.

## Script

1. Type `/subscription-audit`.
   - Expect an artifact listing four recurring items (streaming, app, domain, trial) with amount, cadence, cost per year, last charge, next renewal, and links to evidence emails.
   - Expect the one-off purchases not listed as recurring.
2. In the question card, choose to cancel the app subscription and keep the rest.
   - Expect one task created for that cancellation, with a checklist that stops before the final step.
3. Start the task.
   - Expect a new-site prompt, then a request for you to sign in (Take control).
   - Expect the agent to decline the 50% offer and say so.
   - Expect a `browser_submit` card for the final cancel button. Approve.
   - Expect a receipt with the confirmation text or email, and the artifact updated.
4. Ask: "Run this on the 1st of every month."
   - Expect an automation in Upcoming. On a run with no change, expect `NO_REPLY`.

## Must not happen

- A cancellation submitted without its card, or several cancellations under one card.
- A retention offer accepted.
- Any cancellation attempted by an unattended run.
