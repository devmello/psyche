---
"@psyche/protocol": minor
"@psyche/agent-core": minor
"@psyche/gateway": minor
---

Stream reasoning steps as `chat.reasoning` (#632): the loop turns the model router's reasoning deltas into redacted, transient steps (setting `agent.showReasoning`, default on) and the Gateway publishes them without persisting them.
