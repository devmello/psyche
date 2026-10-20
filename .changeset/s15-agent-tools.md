---
"@psyche/proactive": minor
"@psyche/db": minor
"@psyche/gateway": minor
---

Agent tools for the proactive surfaces: `goals.list | propose | update_progress | add_checkin`, `ideas.list | accept | dismiss | snooze`, `feed.list | mark_read | explain`. Reads run without approval; proposals, acceptances and changes on the owner's behalf are `write` and ask, bound to their exact arguments; results with web or connector text are `untrusted`; non-owner turns are refused; a tainted turn's brief can no longer become a recurring automation prompt. psyched registers them in the loop's registry. A migration adds `feed_posts.read_at`.
