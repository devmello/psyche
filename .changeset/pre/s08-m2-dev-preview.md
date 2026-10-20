---
"@psyche/browser": patch
"@psyche/gateway": patch
---

Dev preview (I12): `browser.dev_preview` opens the owner's own local dev server in a logged-out, port-pinned dev-preview session after a `new_origin` approval, gated by `DevServerRegistry` (servers Psyche started, the launch config, the owner's allowlist); `browser.console` and `browser.network` read that tab.
