---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

`insights.summary` totals now carry `runsByKind` (done and failed runs per kind: task, chat, automation, subagent). The Overview's first Summary tile is "Tasks done" (finished task and chat runs, linking to Recent runs filtered to done), and the Automations tile's success rate counts automation runs only. The Recent runs link gains a `status=done` modifier.
