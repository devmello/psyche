---
"@psyche/sandbox": patch
---

Fixes the #314 regression: execs with env lost their output on real containers (`setsid: wait: …`) because the wrapper's fd-3 process substitution left a child that `setsid --wait` reaped instead of its own. The trampoline now reads the pairs from stdin, which the wrapper never reads, and the wrapper leaves no child.
