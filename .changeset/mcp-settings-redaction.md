---
"@psyche/gateway": patch
---

`settings.get`, `settings.set` and `settings.changed` no longer carry a tool server's env values, URL secrets or auth (env values blank, `{{cred:}}` references kept, URLs redacted, auth reduced to its kind); the Gateway reconciles servers from the stored setting. The probe now resolves a vault secret under the server's own `mcp:<id>` binding, so Add, Edit and Test work with vault env secrets. Address redaction also hides valueless query keys and token-like path segments, and redacts addresses in error text.

`settings.set` now refuses the `mcp.servers` key (`invalid_params`, reason `use_mcp_methods`): tool servers change only through the `mcp.*` methods. `psyche config set mcp.servers` says so. A check of a server being added or edited asks for its vault secret as "mcp:<id> check", and `mcp.remove` unbinds (never deletes) the vault items bound to `mcp:<id>`.
