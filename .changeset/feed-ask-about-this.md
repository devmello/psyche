---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

"Ask about this" on each Feed item. It starts a new chat named for the article with the item as a removable chip in the composer (the input asks "Ask about this article…"). `chat.send` takes an optional `context: { kind: "feed_item", id }`; the Gateway reads the item itself and gives the agent its title, source URL, summary, sources and id ahead of the question, as untrusted content (a fenced `<feed_item_context>` preamble, and the turn starts tainted with a `feed` source), never in the system section. The user message records a new `context` block, shown as a compact quoted card in the transcript.
