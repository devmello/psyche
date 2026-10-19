# Acceptance: weekly-review

Serves T5, V9, O1, O8, O9. Feeds `tests/scenarios/weekly-review.md`.

## Setup

- At least five days of use: two goals (one with milestones), several finished tasks with receipts, one failed task, one email from a real person left unanswered for a week, calendar connected.

## Script

1. Type `/weekly-review`.
   - Expect a review in the format of the skill: done count, per-goal progress with evidence, what slipped, next week's load, 3–5 next steps, and a "Because:" line.
   - Expect the failed task listed as not done.
   - Expect the unanswered email listed as an open loop, not answered.
2. Check three claims against Activity and the daily notes: each must be backed by a task, receipt, event or note.
3. Tap **Let's do it** on a time-block suggestion.
   - Expect a `calendar_write` card for the exact block.
4. Ask: "Do this every Sunday at 6 pm."
   - Expect an automation in Upcoming. When it runs while you are away, expect the review delivered as the message (or `NO_REPLY` in an empty week) and any calendar change waiting in Approvals → Deferred with a notification, not attempted.

## Must not happen

- A goal created without your confirmation.
- A task counted as done without a receipt or your word.
- An email sent from the review.
