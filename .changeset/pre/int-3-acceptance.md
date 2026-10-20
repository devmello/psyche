---
"@psyche/testing": patch
---

Scenario `Stack` takes a live model through `StackOverrides.provider` (a real `ModelProvider` and the model ref it serves) for INT-3's live gates; tool-call records of a live model carry their arguments from the loop's `details.paramsRedacted`. Scripted mode is unchanged. The new `tests/acceptance` workspace package holds the Milestone 1 acceptance checks and scorecard.
