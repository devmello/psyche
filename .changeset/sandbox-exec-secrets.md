---
"@psyche/sandbox": patch
---

Exec secrets never become arguments: env reaches the command through a pipe and an in-container trampoline, not `env -- NAME=value` (#289). An exec given a vault secret is reaped as it returns, so no background child keeps the value (#290). `reapBackground: "always"` reaps every exec, for one-shot work such as document conversion (#286).
