---
"@psyche/agent-core": patch
"@psyche/permissions": patch
---

The loop forwards `describeCall().connectorRule` and the turn's taint sources to the broker; the broker applies the connector matrix from `ToolCallIntent.connectorRule` and fills `ApprovalRequest.taintSources` (#71).
