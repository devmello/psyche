---
"@psyche/model-router": patch
---

Anthropic thinking replay (#306): thinking envelopes carry a fingerprint of the system prompt and tools they are bound to; a completed turn's stale block is dropped on replay, no earlier thinking is sent when thinking is off, and requests that still replay thinking ask the API to `drop_block` on a prefix mismatch.
