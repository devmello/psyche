---
"@psyche/gateway": patch
"@psyche/desktop": patch
---

Tests only: Windows-only and macOS-only tests now skip themselves on other platforms, two slow Gateway tests get a longer timeout, and the Linux CI job runs the full desktop and Gateway suites as a gate.
