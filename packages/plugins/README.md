# @psyche/plugins

Code plugins (docs/03 T4; docs/02 §13 "Plugins"; docs/05 §11). A plugin extends the agent harness through the capabilities its manifest declares and nothing else.

## A plugin

```
my-plugin/
  psyche-plugin.json   {"name", "version", "description", "main": "index.mjs", "capabilities": [...]}
  index.mjs            export default (api) => { api.on("context", (run) => [...]) }
```

| Capability | Called with | May return |
| --- | --- | --- |
| `context` | the run (thread, task, modes, taint) | sections `{title, text}`; shown fenced as untrusted, and they taint the run |
| `before_tool_call` | the run, tool name, side-effect class, arguments | `{block: reason}`; it can never allow or rewrite a call |
| `after_tool_call` | the run, tool name, status, provenance (never the output) | nothing |
| `agent_end` | the run, outcome, steps | nothing |
| `evaluate` | a task's goal and receipts (kind, outcome, summary, refs) | `{verdict: "reopen" \| "escalate", reason, gaps}` to make the evaluator stricter |

`api.on` throws for a capability the manifest does not declare, and the host refuses to start a plugin that registers one.

## Public API

- `PluginManager` (`manager.ts`): `proposeInstall(path)` reads and scans a local folder and opens the device-only `skill_install` card with `details.kind: "plugin"`; `install(proposalId, approvalId)` needs that exact approval, writes the scanned files to `$PSYCHE_HOME/plugins/<name>`, pins the tree hash in `plugins.lock.json` and installs switched off; `setEnabled`, `remove`, `list`; `sync()` starts and stops processes from the admin setting, each switch and the pinned hash, and registers them in agent-core's `AgentPluginRegistry`.
- `PluginProcess` (`host.ts`): one plugin's process. `node --permission --allow-fs-read=<its folder>` with an empty environment, the shim (`shim.ts`, passed with `--eval`) refusing network access, JSON lines over stdio. `agentPlugin(host, capabilities)` adapts it to the loop.
- `createPluginsHandlers` (`handlers.ts`): the `plugins.*` methods (protocol `methods/plugins.ts`).
- `parseManifest`, `pluginBinding`.

The Gateway composes it in `apps/gateway/src/compose/plugins.ts`; the admin setting `plugins.enabled` (default off) gates everything.

## Limits and what is stubbed

- Node 24's permission model does not cover the network; the shim closes `net`, `dgram`, `fetch` and `WebSocket` before the plugin loads, which is not a boundary.
- No registry or git source: only local folders. No update diff yet (a reinstall replaces the files after a new card).
- Bundle plugins (skills + MCP servers + config) and plugins that add channels or tools are not implemented; docs/03 T4's "a community channel adapter installs as a plugin" is not met.
- No Settings → Plugins pane yet (S11); the methods exist.
