---
"@psyche/protocol": minor
"@psyche/ui": minor
"@psyche/web": minor
"@psyche/gateway": minor
"@psyche/search": minor
---

⌘L (and "Open in a side chat") on a search result now opens a real side chat beside the view you are on, instead of adding a blank copy of the result to the thread list and switching to it. The new chat is named "About …", linked to the chat it came from, and carries the result as context: a chip in its composer, a card on your first message, and `chat.send.context` takes a new `{ kind: "search_hit", id, title?, scope? }`. The Gateway reads the result itself by id from the search index (`SqliteSearchIndex.docOf`) and gives the agent that text as fenced data; the window's label never supplies text or trust. The turn is tainted unless the index says the owner wrote the result, and an id the index does not know is tainted too. The pane has the usual tab and ×, and an Expand button that opens the chat full screen. Enter on a chat result still opens that chat. Protocol: `ViewPane` gains `sidechat`; the `context` block kind gains `search_hit`. The chat toolbar's "running / need you" text now follows the toolbar's own width, so it no longer spills into a pane beside it.
