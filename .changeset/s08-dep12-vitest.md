---
"@psyche/browser": patch
---

`vitest` is a devDependency of `@psyche/browser` instead of an optional peer, so it (and vite, lightningcss) no longer lands in the Gateway's production install (#299 DEP-12).
