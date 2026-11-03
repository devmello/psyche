---
"@psyche/ui": patch
"@psyche/web": patch
---

"Open the wrap-up" and "Open your day" on a daily brief now take the owner to that post on Home: `/feed/<postId>` becomes `/home?post=<postId>#today`, Home opens Today's "Show more" when the post is hidden, scrolls to it and flashes it, and asking for the same route again scrolls again. A post that is gone leaves the owner at Today. The snapshot's `open` action may now go to its own post's route.
