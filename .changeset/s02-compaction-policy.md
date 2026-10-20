---
"@psyche/agent-core": patch
---

The loop's `compaction` option (`thresholdRatio`, `keepRecentTurns`) applies again when the owner set no context limits, so the memory flush before compaction runs where it is configured.
