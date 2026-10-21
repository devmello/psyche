---
"@psyche/model-router": patch
"@psyche/gateway": patch
---

Subscription CLIs (#538): a history that ends with tool results keeps the tool exchange in the transcript, so the tool check's `uses_tool_result` case passes on `claude-code`; `models.list` reports a CLI provider as configured once its probe finds it installed and signed in.
