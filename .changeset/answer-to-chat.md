---
"@psyche/protocol": minor
"@psyche/memory": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

Answers that cite your life: "Open as a chat" now carries the answer and its citations into the new chat. The first message shows the answer with the same citation chips, and a chip opens the source viewer. The Gateway keeps the answer (opaque `answerId`, cited fact and passage ids, the kind of model) and the chat names only that id, so the client never sends answer text. On send, and again on every `chat.history`, `chat.export` and `chat.message` for each connection, the Gateway reads every cited id again: a remote device gets no Messages, Contacts or Memory chip and no claim that rests only on one, and a claim that no longer passes the sensitive switches is dropped. The agent in the new chat reads the answer text and a short list of sources (kind, title, date) as untrusted data, never a passage body; a chat on a cloud model drops what a source kept off the cloud contributed, even if a local model made the answer.
