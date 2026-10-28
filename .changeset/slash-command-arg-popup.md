---
"@psyche/ui": minor
---

Slash commands with a fixed set of values show a popup of them above the composer: `/model ` lists the models from `models.list` (provider, Vision / Reasoning / Tools / Local badges, the one in use ticked, models that cannot be used greyed with the reason such as "No API key"), `/mode ` lists manual, balanced, auto and plan with a one-line description, and `/export ` offers md and json. ↑ / ↓ move, Return or Tab picks the value and runs the command, Escape closes, typing filters. A command declares `args: { kind: "enum", options }` to get the popup; free-text commands are unchanged. New `/mode [manual | balanced | auto | plan]` sets the thread's permission mode.
