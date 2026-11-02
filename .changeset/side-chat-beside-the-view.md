---
"@psyche/protocol": minor
"@psyche/ui": minor
"@psyche/web": minor
"@psyche/gateway": minor
---

⌘L (and "Open in a side chat") on a search result now opens a real side chat beside the view you are on, instead of adding a blank copy of the result to the thread list and switching to it. The new chat is named "About …", linked to the chat it came from, and carries the result as context: a chip in its composer, a card on your first message, and `chat.send.context` takes a new `{ kind: "search_hit", id, title, snippet?, scope?, route?, untrusted? }` the Gateway gives the agent as fenced data (an untrusted result taints the turn). The pane has the usual tab and ×, and an Expand button that opens the chat full screen. Enter on a chat result still opens that chat. Protocol: `ViewPane` gains `sidechat`; the `context` block kind gains `search_hit`.
