---
title: Architecture
---

# Architecture

Psyche is one long-running Gateway that owns all state and makes every decision, a set of clients that only render and relay, and executors that do the risky work in isolation. This page is a short map for contributors: the processes, what each one owns, how a turn flows through the brokers, and where data lives. The full design is [docs/02-architecture.md](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md), and the reasons behind each technology are in [docs/07-tech-decisions.md](https://github.com/devmello/psyche/blob/main/docs/07-tech-decisions.md).

## The processes

| Process | Built with | Runs on | Owns |
| --- | --- | --- | --- |
| Gateway, `psyched` | TypeScript on Node 24 | A Mac (LaunchAgent) or a Linux server (systemd or Docker) | All state, the agent loop, the brokers, tasks, memory, channels, the scheduler. The only process that talks to model providers. Serves the web UI. |
| Desktop app | Electron 44, React 19 | Mac | Rendering, the embedded agent browser, terminal panes, file viewers. Holds no secrets and no model keys. |
| Web UI | The same React app | Any browser, served by the Gateway | Rendering. |
| CLI, `psyche` | TypeScript | Mac or Linux | Install, service control, doctor, security audit, pairing, backups, export. A paired device like any client. |
| Psyche Helper | Swift, a signed `.app` | Mac host and VM guest | Everything that needs a macOS permission or an Apple framework: Accessibility and input, screenshots, Apple Events, Keychain and Touch ID, notifications, speech, Messages, Virtualization. Connects as a node. |
| `psyche-node` | TypeScript, the Gateway's code with another entry point | Inside the VM, on remote machines | Exec, files and the browser, offered as node capabilities. |

::: info Screenshot placeholder
A diagram: clients (desktop, web, CLI, chat channels) on the left connect to the Gateway in the middle; executors (browser, sandbox, helper, VM guest, remote nodes) on the right.
:::

## Inside the Gateway

The Gateway is a composition root in [apps/gateway](https://github.com/devmello/psyche/tree/main/apps/gateway) that wires one package per subsystem:

- **Agent runtime** (`agent-core`): the loop, tool registry, context assembly, compaction, plan mode, questions.
- **Model router** (`model-router`): provider adapters, roles (primary, utility), fallbacks, usage and cost.
- **Task engine and scheduler** (`tasks`, `scheduler`): durable tasks with checkpoints and leases, automations, the heartbeat. Work continues after the window closes or the process restarts.
- **Permission Broker** (`permissions`): allow, ask or deny for every side effect; approval cards, grants, binding hashes.
- **Credential Broker** (`vault`): the encrypted vault, placeholders, fills at the executor.
- **Audit** (`audit`): the hash-chained log and receipts.
- **Memory** (`memory`): workspace files, the search index, the nightly consolidation.
- **MCP host, connectors, channels** (`mcp-host`, `connectors`, `channels`): external tools, Google and other accounts, Telegram and iMessage.
- **Feed, Ideas, Goals, search, notifications, skills, speech.**

Each package implements an interface from [packages/protocol/src/contracts](https://github.com/devmello/psyche/tree/main/packages/protocol/src/contracts) and is tested against the fakes in `packages/testing`.

## One turn, end to end

1. A client sends `chat.send` over the WebSocket.
2. The session controller assembles context: the persona files, memory, the thread and the tools for the thread's permission mode.
3. The model router streams the model's answer back to every client as events.
4. For each tool call, the Permission Broker decides. Ask parks the call and shows a card; deny returns an error to the model.
5. On allow, the executor runs the call. If it needs a secret, the Credential Broker resolves the placeholder at the executor, after re-checking the approval's binding hash against the actual arguments.
6. The result comes back tagged with its provenance. Untrusted results taint the turn.
7. A receipt and audit entries are written for every side effect.

The security rules behind steps 4 to 7 are summarized in [Security for owners](/security/).

## Executors

Executors are assumed to be compromisable by the content they handle, so each gets only what one action needs.

- **Browser.** One tool API, two drivers: CDP over the desktop's embedded views (reached through a Unix-socket bridge), or a Playwright-managed Chromium beside a server Gateway. Its own profiles, origin checks on every navigation and redirect, quarantined downloads.
- **Sandbox.** A per-task Linux container (Apple `container` on macOS 26+, Docker or Colima otherwise): non-root, read-only root filesystem, all capabilities dropped, no network. An egress proxy in the Gateway allows approved domains only. Without a sandbox backend, `exec` fails; there is never a fallback to the host shell.
- **Host helpers.** Converters and stdio MCP servers run under `srt` (Seatbelt on macOS, bubblewrap on Linux), or in their own container.
- **Psyche Helper and nodes.** Capabilities declare side-effect classes like tools, so the broker treats a click on a node like any other write.
- **VM mode.** A macOS guest created by the helper runs task commands through its own `psyche-node`, never on your Mac.

## Deployments

All of these are the same binaries with different configuration:

- **Mac, local (default):** desktop, Gateway and helper on one Mac.
- **Mac with VM mode:** tasks run inside a sandbox Mac the helper manages.
- **Server plus a paired Mac:** the Gateway in Docker Compose on Linux, the Mac pairs as a node for Mac-only capabilities.
- **Server only:** no Mac; the browser runs as a Playwright sidecar.

See [server mode](/get-started/server-mode) and [Docker](/get-started/docker).

## Where data lives

Everything is under `$PSYCHE_HOME` (default `~/.psyche`, the same on macOS and Linux):

| Path | What |
| --- | --- |
| `config.json` | Network and transport configuration; no secrets |
| `state/psyche.sqlite` | Threads, tasks, approvals, grants, receipts, devices, settings, the memory index |
| `workspace/` | `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`, daily notes, workspace skills |
| `vault/` | The SQLCipher vault and its key slots |
| `library/` | Files the agent made or received; `quarantine/` for downloads |
| `browser/profiles/` | Agent browser profiles |
| `skills/`, `plugins/` | Installed skills with their lock file, plugins |
| `audit/` | The hash-chained audit log |
| `security/` | The revocation ledger and the audit anchor key |
| `run/` | Sockets and the per-launch handshake secret |
| `sandbox/`, `vm/` | Sandbox workspaces and VM disks |
| `logs/`, `backups/` | Logs and backup archives |

Migrations are SQL files in `packages/db/migrations/`, one set per owning package.

## Learn more

- [docs/02-architecture.md](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md)
- [docs/07-tech-decisions.md](https://github.com/devmello/psyche/blob/main/docs/07-tech-decisions.md)
- [docs/04-data-model.md](https://github.com/devmello/psyche/blob/main/docs/04-data-model.md)
- [Protocol](/reference/protocol)
- [Contributing](/contributing/)
- [Pull requests](/contributing/pull-requests)
