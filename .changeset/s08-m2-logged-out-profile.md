---
"@psyche/browser": patch
"@psyche/gateway": patch
---

Browser: logged-out partitions by default (I15). Sessions choose `profile`, `clean` or `auto`; in `auto` a tab uses the owner's profile only for origins they signed into. Tabs report their partition, the pane gets it on `bridge.tab.open`, and the fixtures prove the isolation on both drivers.
