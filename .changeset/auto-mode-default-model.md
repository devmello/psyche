---
"@psyche/protocol": minor
"@psyche/gateway": patch
"@psyche/ui": patch
"@psyche/web": patch
---

Changing a chat's permission mode (or model) no longer claims "needs a newer version of Psyche" when the Gateway refuses it: the toast now shows the Gateway's own message. Auto is judged against the model the thread would actually use (the router's default chat model) when no model is pinned, the refusal names that model, and `models.list` marks which models allow Auto so the mode pill can skip it with a reason.
