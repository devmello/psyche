---
"@psyche/permissions": minor
"@psyche/connectors": minor
"@psyche/gateway": minor
---

The broker now applies the owner's Settings → Connectors rules (Allow / Ask / Deny per action group) to connector tool calls (#747).
- **Registry:** stamps each call with its group; connector-write receipts record the deciding rule.
- **Broker:** allow → no card; ask → card; deny → refused, with a receipt.
- **Hard floors:** sends, destructive, financial and device-only calls always ask.
- **Shortcuts:** a shortcut set to off is denied.
- **Gateway:** syncs `permissions.connectors.*` and `shortcutRules` into the broker policy and the executor's matrix. Direct Apple helper calls follow the same groups.
