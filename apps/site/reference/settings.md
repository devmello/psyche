---
title: Settings reference
---

# Settings reference

Psyche reads its configuration from three places: Gateway settings stored in the database, the `gateway.*` and `credentials.*` keys in `$PSYCHE_HOME/config.json`, and environment variables. This page lists the keys the Gateway and the CLI actually read, compiled from the code, with the source file for each. Keys that the app's Settings screen writes but the Gateway does not read yet are listed separately at the end.

## How settings work

**Gateway settings** live in `state/psyche.sqlite`. Read and change them with `settings.get` and `settings.set` over the [protocol](/reference/protocol), with the Settings screen, or with the CLI:

```bash
psyche config get models.primary
psyche config set threads.crossThreadAwareness true
```

`psyche config set` parses the value as JSON when it can (`true`, `30`, `["a"]`), else uses it as a string. A change emits `settings.changed`, and most keys apply without a restart.

Who may change a setting:

- Keys under `appearance`, `ui`, `editor`, `shortcuts`, `locale`, `notifications.sound` and `notifications.badges` need only `operator.write`.
- Every other key needs `operator.admin`.
- Security keys also need fresh proof of presence (Touch ID or a passkey) once a verifier is registered: anything under `permissions`, `exec`, `vault`, `devices`, `gateway`, `identityLinks` and `computerUse`, plus `commands.ownerAllowFrom` and `channels.<id>.dmPolicy`, `allowFrom` and `groupAllowFrom`. The first call fails with `approval_required` and a device-only card; approve it and retry with its `approvalId`.
- Keys starting with `_` are internal to the Gateway. They are hidden from `settings.get` and cannot be set.

**`config.json`** holds the network and transport configuration. The Gateway reads it once at start and refuses to start on an unknown key or a bad value. `psyche config set gateway.<key> <value>` edits it and tells you to restart (`psyche restart`). It holds no secrets.

## Gateway settings

| Key | What it does | Default | Where to change | Source |
| --- | --- | --- | --- | --- |
| `permissions.policy` | The owner's permission policy: rules, folders, sites, apps, connectors, grant lifetimes and approval options. Fields are listed below. Applied without a restart. An invalid value is ignored with a warning. | `{ "defaultMode": "balanced" }` | Settings → Permissions; Settings → File access for folders | [compose/index.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/index.ts) |
| `models.primary` | The model for chat and tasks (`provider/model`). Overrides `PSYCHE_MODEL`; re-applied at every start. | `PSYCHE_MODEL`, else none | Settings → Model & providers | [compose/model-settings.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/model-settings.ts) |
| `models.utility` | The model for background jobs such as the Auto-mode classifier and the Feed. | `PSYCHE_UTILITY_MODEL`, else the primary model | Settings → Model & providers | [compose/model-settings.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/model-settings.ts) |
| `computerUse.enabled` | Turns computer use on. While off, the computer-use tools are not offered and every app is off. | `false` | Settings → Computer use | [compose/computer-settings.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/computer-settings.ts) |
| `computerUse.apps` | Per-app tiers, as `[{ "id": "<bundle id>", "name": "…", "tier": "off" \| "read" \| "click" \| "interact" }]`. Fixed caps still apply. Apps not listed ask on first use. | none | Settings → Computer use | [compose/computer-settings.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/computer-settings.ts) |
| `browser.realChrome` | Real-Chrome mode, as `{ "enabled": true, "profile": "…" }`. Read on every use. Each task still asks for consent. | off | Settings → Browser | [compose/browser.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/browser.ts) |
| `mcp.servers` | The MCP servers you installed, as an array of server configs. Each change starts, stops or reconfigures servers and revokes grants that no longer match. | none | CLI | [compose/mcp.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/mcp.ts) |
| `commands.ownerAllowFrom` | Your own sender ids on chat channels. Only these identities are treated as you: they run agent turns and may answer approvals. | none | CLI | [compose/channels.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/channels.ts) |
| `feed.sources` | Feed inputs, as `{ "rss": ["https://…"], "hackerNews": true, "arxiv": true }`. Read when the Gateway starts. | Hacker News and arXiv on, no RSS | CLI | [compose/proactive.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/proactive.ts) |
| `cleanupPeriodDays` | Stored tool payloads older than this many days are deleted by the hourly retention sweep. Receipts and audit entries are never deleted. Minimum 1. | `30` | CLI | [retention.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/retention.ts) |
| `threads.crossThreadAwareness` | Lets the agent list, read and message your other threads (never incognito ones). What it reads there is untrusted. | off | CLI | [compose/thread-tools.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/thread-tools.ts) |
| `speech.tts.personalVoice` | Use Apple Personal Voice on the Mac for read-aloud, when it is available. | `false` | CLI | [compose/speech.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/speech.ts) |
| `vm.enabled` | Run tasks in the sandbox Mac (VM mode). | `false` | Settings → VM mode | [schemas/vm.ts](https://github.com/devmello/psyche/blob/main/packages/protocol/src/schemas/vm.ts), [compose/vm.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/vm.ts) |
| `vm.guestNodeId` | The paired `psyche-node` inside the guest that runs task commands. | none | Settings → VM mode | [compose/vm.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/vm.ts) |
| `vm.defaultWorkspace` | Where a task runs when it names no workspace: `sandbox` (a container) or `vm`. | `sandbox` | Settings → VM mode | [compose/vm.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/vm.ts) |

### `permissions.policy` fields

The schema rejects unknown keys, so a typo cannot silently disable a rule. Defaults are applied by the broker when a field is absent.

| Field | What it does | Default | Source |
| --- | --- | --- | --- |
| `defaultMode` | Accepted, but not applied yet: new threads start in Balanced. | `balanced` | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `grants.taskHours`, `grants.destructiveTaskHours` | Lifetime of task grants, and of task grants for destructive actions | 24, 8 | [broker.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/broker.ts) |
| `grants.siteExpiryDays` | Lifetime of site grants | 30 | [broker.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/broker.ts) |
| `grants.sessionIdleHours`, `grants.sessionMaxHours` | Session grants end after this idle time, or this total time | 12, 24 | [broker.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/broker.ts) |
| `grants.alwaysExpiryDays`, `grants.execHostAlwaysExpiryDays` | Lifetime of always grants, and of always grants for commands on the Mac | 90, 30 | [broker.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/broker.ts) |
| `approvals.ttlMinutes` | How long an approval card stays answerable | 30 | [broker.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/broker.ts) |
| `approvals.deviceOnly` | Extra approval kinds never sent to chat (the built-in set always applies) | none | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `approvals.chatScopes` | Scopes a chat answer may grant | `once` | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `approvals.answersPerMinute` | Rate limit on approval answers per identity | 10 | [broker.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/broker.ts) |
| `deny`, `ask`, `allow` | Rules: `"<tool glob>"`, `"<tool glob>(<target glob>)"`, or `"<origin\|path\|recipient\|app\|account\|command>:<glob>"` | none | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `connectors` | Per connector, per action: `allow`, `ask` or `deny` | none | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `apps` | Per-app tier by bundle id; `computerUse.apps` is layered on top | none | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `sites` | Per-site `allow`, `ask` or `deny` | none | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `folders` | Shared folders, as `[{ "path": "/Users/you/Notes", "mode": "ro" \| "rw" }]` | none | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `sensitiveOrigins` | Host globs that always ask for reads | a built-in list of banking, government, health, password-manager, sign-in and webmail hosts | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `designated` | Per-person rules for designated people, keyed by identity id | none | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `exec.execHostEnabled` | Allows commands directly on the Mac (`exec_host`), which still ask every time | `false` | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `exec.allowEnv` | Environment names you allow despite the dangerous-name list | none | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |
| `classifier.model`, `classifier.timeoutMs` | The Auto-mode classifier's model and timeout; it always fails closed | utility model, 8000 | [policy.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/policy.ts) |

Example, sharing one folder read-write and denying `.env` files:

```bash
psyche config set permissions.policy '{"folders":[{"path":"/Users/you/Notes","mode":"rw"}],"deny":["read_file(**/.env)"]}'
```

`psyche config set` replaces the whole value, so include every field you want to keep.

## `config.json` keys

| Key | What it does | Default | Source |
| --- | --- | --- | --- |
| `gateway.host` | Address to listen on. Anything but loopback is refused unless `PSYCHE_BIND=container`. | `127.0.0.1` | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `gateway.port` | Port for WebSocket and HTTP | `7979` | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `gateway.allowedOrigins` | Extra WebSocket `Origin` values to accept | none (plus `publicOrigin`) | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `gateway.publicOrigin` | The HTTPS origin the web client is served from behind a proxy. Passkeys use its host. Must be `https://` without a path. | none | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `gateway.trustedProxy.enabled` | Trusted-proxy mode for Tailscale Serve or Cloudflare Access. Needs `trustedProxies`. | `false` | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `gateway.trustedProxy.trustedProxies` | CIDRs of proxies allowed to forward connections | none | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `gateway.trustedProxy.tailscaleProxies` | CIDRs of Tailscale Serve peers whose `Tailscale-User-Login` header is trusted | none | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `gateway.cloudflareAccess.teamDomain`, `.audience` | Cloudflare Access team and application tag. Forwarded connections must carry a valid Access token for them. | none | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `gateway.rateLimits.inboundChatPerMinute` | Inbound chat messages per sender per minute | 30 | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `gateway.rateLimits.fetchPerMinute` | Web fetches per task per minute | 60 | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `credentials.onePassword` | Where linked 1Password items are read: `{ "kind": "cli", "op": "/abs/path/op" }` or `{ "kind": "connect", "url": "https://…" }`. The token itself is a vault item. Edit the file by hand. | none | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |

The permission policy is not read from `config.json`, although older design notes show it there. Use the `permissions.policy` setting.

## Environment variables

Read by the Gateway (`psyched`):

| Variable | What it does | Source |
| --- | --- | --- |
| `PSYCHE_HOME` | Data directory (default `~/.psyche`) | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `PSYCHE_HOST`, `PSYCHE_PORT` | Override `gateway.host` and `gateway.port` | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `PSYCHE_BIND` | `loopback` (default) or `container`, which listens on the container interface | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `PSYCHE_GATEWAY_TOKEN_FILE` | Transport token file, required with `PSYCHE_BIND=container` | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `PSYCHE_PUBLIC_ORIGIN`, `PSYCHE_ALLOWED_ORIGINS` | Override `gateway.publicOrigin` and `gateway.allowedOrigins` (comma-separated) | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `PSYCHE_DB`, `PSYCHE_NODE_SOCKET`, `PSYCHE_WEB_ROOT` | Database file, local node socket, built web UI directory | [config.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/config.ts) |
| `PSYCHE_LOG_LEVEL` | Minimum log level (default `info`) | [log.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/log.ts) |
| `PSYCHE_MODEL`, `PSYCHE_UTILITY_MODEL` | Primary and utility model, until set in Settings | [compose/models.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/models.ts) |
| `PSYCHE_OLLAMA_URL`, `PSYCHE_LLAMACPP_URL`, `PSYCHE_LMSTUDIO_URL` | Address of a local model server | [compose/models.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/models.ts) |
| `PSYCHE_VAULT_KEY_FILE` | Vault key file (the key-file slot) | [compose/vault.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/vault.ts) |
| `PSYCHE_BROWSER`, `PSYCHE_SANDBOX`, `PSYCHE_VM`, `PSYCHE_CODING`, `PSYCHE_MCP` | Set to `off` to leave that part out of the Gateway | [compose/parts.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/parts.ts) |
| `PSYCHE_BROWSER_PARTITION`, `PSYCHE_BROWSER_SIGNED_IN_ORIGINS` | Browser profile choice (`profile`, `clean`, `auto`) and the origins `auto` treats as signed in | [compose/parts.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/parts.ts) |
| `PSYCHE_BROWSER_RECORD`, `PSYCHE_DEV_PREVIEW_PORTS` | `1` records browser sessions; loopback ports allowed for dev preview | [compose/parts.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/parts.ts) |
| `PSYCHE_REAL_CHROME`, `PSYCHE_REAL_CHROME_PROFILE`, `PSYCHE_REAL_CHROME_PATH` | Real-Chrome mode on (`1`), its profile, and the Chrome binary | [compose/parts.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/parts.ts), [launcher.ts](https://github.com/devmello/psyche/blob/main/packages/browser/src/realchrome/launcher.ts) |
| `PSYCHE_CHROMIUM_PATH` | Chromium binary for the Playwright driver | [profiles.ts](https://github.com/devmello/psyche/blob/main/packages/browser/src/profiles.ts) |
| `PSYCHE_SANDBOX_BACKEND`, `PSYCHE_SANDBOX_IMAGE` | Restrict the sandbox to one backend; override the sandbox image | [detect.ts](https://github.com/devmello/psyche/blob/main/packages/sandbox/src/detect.ts), [image.ts](https://github.com/devmello/psyche/blob/main/packages/sandbox/src/image.ts) |
| `PSYCHE_MCP_LAUNCHER` | `container` runs stdio MCP servers in their own sandbox container | [compose/parts.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/parts.ts) |
| `PSYCHE_SRT_PATH`, `PSYCHE_SPEECH_RUNNER_PREFIX` | Path of `srt` for stdio MCP servers and speech helpers; a custom wrapper for speech helpers | [compose/speech.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/speech.ts) |
| `PSYCHE_BACKUP_IDENTITY_FILE` | age private key, so the app can verify age-encrypted backups | [compose/parts.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/parts.ts) |
| `PSYCHE_TELEGRAM_BOT_TOKEN`, `PSYCHE_TELEGRAM_BOT_TOKEN_FILE`, `PSYCHE_TELEGRAM_BOT_USERNAME` | Telegram bot (prefer the file) | [compose/channels.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/channels.ts) |
| `PSYCHE_IMESSAGE_ACCOUNT` | The Messages account to answer as (opt-in) | [compose/channels.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/channels.ts) |
| `PSYCHE_LINK_CLI` | Path of the Stripe Link CLI | [compose/payments.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/payments.ts) |
| `PSYCHE_BUNDLED_SKILLS` | Directory of bundled skills | [compose/skills.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/compose/skills.ts) |

Read by the CLI (`psyche`):

| Variable | What it does | Source |
| --- | --- | --- |
| `PSYCHE_HOME` | Data directory | [paths.ts](https://github.com/devmello/psyche/blob/main/apps/cli/src/paths.ts) |
| `PSYCHE_URL`, `PSYCHE_PORT` | Gateway address (default `http://127.0.0.1:7979`) | [paths.ts](https://github.com/devmello/psyche/blob/main/apps/cli/src/paths.ts) |
| `PSYCHE_GATEWAY_BIN` | Path of `psyched` for `psyche start` | [supervisor.ts](https://github.com/devmello/psyche/blob/main/apps/cli/src/supervisor.ts) |
| `PSYCHE_BACKUP_PASSPHRASE` | Backup passphrase for scripts | [commands/backup.ts](https://github.com/devmello/psyche/blob/main/apps/cli/src/commands/backup.ts) |
| `PSYCHE_DB` | Database file for `psyche migrate` | [commands/migrate.ts](https://github.com/devmello/psyche/blob/main/apps/cli/src/commands/migrate.ts) |

## Keys only the security audit looks at

`psyche security audit` also checks a few keys that the Gateway does not read, so that a value set by hand is still flagged: `gateway.auth.mode`, `gateway.allowPublicIngress`, `auth.passkeys.enabled`, `sandbox.enabled`, `exec.host.enabled`, `telemetry.enabled` and `logging.bodies`. Source: [apps/cli/src/audit.ts](https://github.com/devmello/psyche/blob/main/apps/cli/src/audit.ts).

## Written by the app, not read by the Gateway yet

The Settings screen stores these keys, but the Gateway does not act on them yet: `permissions.mode` (default mode for new threads), `backup.schedule`, `vm.clipboard`, `vm.credentials`, `vm.shares`, `vault.backend`, `vault.fillDefault`, `data.replayRetentionDays`, `data.transcriptRecall` and `models.image`. The desktop app may read some of them itself. The full list of keys the app writes is in [setting-labels.ts](https://github.com/devmello/psyche/blob/main/packages/ui/src/screens/settings/setting-labels.ts).

## Learn more

- [CLI reference](/reference/cli)
- [Protocol](/reference/protocol)
- [Permissions](/security/permissions)
- [Server mode guide](/guides/server-mode)
- [apps/gateway/src/handlers/settings.ts](https://github.com/devmello/psyche/blob/main/apps/gateway/src/handlers/settings.ts)
- [packages/protocol/src/methods/settings.ts](https://github.com/devmello/psyche/blob/main/packages/protocol/src/methods/settings.ts)
- [apps/cli/src/commands/config.ts](https://github.com/devmello/psyche/blob/main/apps/cli/src/commands/config.ts)
