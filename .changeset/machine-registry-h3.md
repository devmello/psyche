---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/db": minor
"@psyche/ui": minor
---

Machines: the Gateway can now pair a helper-only Linux computer as a machine. A `purpose: machine` setup token (scopes exactly `node`) pairs it by link, and the owner's decision is stored in a sealed `machines` table that alone sets the node kind. Machines need a v2-signed connect, are limited to an allowlist of capabilities, and `nodes.invoke` reaches only `health` and `machine.status` on them. New `machines.list`, `machines.rename`, the `machines.changed` event, and `node.unpair` (a machine removes itself). The "added" notice is in all ten languages.
