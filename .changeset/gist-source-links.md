---
"@psyche/protocol": patch
"@psyche/memory": patch
"@psyche/search": patch
"@psyche/gateway": minor
"@psyche/ui": minor
---

Conversation gists on a person's page and Home's catch-up lines show a quiet source chip ("From Mail") that opens the passage in the source viewer. The Gateway resolves the source on every read and sends it only to a connection that may open it. Review's citations follow the same rule: no document id, and no Messages or Contacts quote, for a connection that cannot open them.
