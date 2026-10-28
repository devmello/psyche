# Psyche

**An open-source, self-hosted personal AI agent.** Psyche is an open-source take on Meta's Muse: one persistent conversation with a named agent that remembers you in files you can read. It runs on your Mac or on your own Linux server, keeps your data there, and asks before it does anything that changes something.

> **Status: alpha (v0.3).** The macOS desktop app is built from source; there is no signed release yet. Windows is planned. Linux is supported for the Gateway (server mode) only, not the desktop app.

## What it does

- **Chat with artifacts.** One main thread plus side chats. Replies can include previews of files, email, the browser, and interactive artifacts that update in place.
- **Ask about my screen.** A hotkey opens a small panel over whatever you're looking at. Psyche sends the window's context, and the image only when your request is about the screen. See [docs/design/screen-ask-2026.md](docs/design/screen-ask-2026.md).
- **Feed and Search.** Search covers your threads, files and memory, and runs on-device. The Feed is a set of agent-written posts from your interests. Both are still being finished; see [docs/design/search-2026.md](docs/design/search-2026.md) and [docs/03-feature-spec.md](docs/03-feature-spec.md) §O.
- **Connectors and MCP.** Apple Notes, Reminders, Calendar and Mail through the Mac helper; Gmail and Google Calendar with your own OAuth client; MCP servers from Settings. What works today is in [docs/guides/connectors.md](docs/guides/connectors.md).
- **Background specialists.** Delegated agents with their own tools and approvals, for work that outlives the chat. Planned: [docs/agent/specialists-2026.md](docs/agent/specialists-2026.md).
- **Mail and meetings.** Mail and calendar tools are available through connectors; meeting capture and the mail and meeting workflows are planned in [docs/workflows/mail-and-meetings-2026.md](docs/workflows/mail-and-meetings-2026.md).
- **Voice dictation.** Hold a key and speak; the words appear as text for you to review. Psyche does not speak back.
- **Permissions and approvals.** Every change goes through a Permission Broker. Approval cards show the exact action, and content from the web or from files can never approve anything. Each external write leaves a receipt.
- **Browser and sandbox.** A browser you can watch and take over, and a command sandbox with no network by default.
- **Secrets stay out of the model.** Passwords and keys live in an encrypted vault and are filled in at the last step.
- **Your model, your choice.** Anthropic, OpenAI, Ollama and other OpenAI-compatible providers, including local models.

## Install

**On a Mac (from source, until a signed release exists):**

```bash
pnpm install
pnpm app:ship
```

`pnpm app:ship` builds `dist/Psyche-*.dmg` and installs it into `/Applications`; `pnpm app:build` and `pnpm app:install` do each step on its own. Installing resets Psyche's local data, so pass `--keep-data` to keep it. Details are in [docs/guides/getting-started.md](docs/guides/getting-started.md).

**On a Linux server:** Docker Compose, with the Gateway on loopback. See [docs/guides/server-mode.md](docs/guides/server-mode.md). When releases are published, the DMG and image paths are in [docs/guides/install.md](docs/guides/install.md).

## Quick start for developers

Requires Node 24+ and pnpm 12+ (the repo pins pnpm 12.4.1).

```bash
pnpm install
pnpm dev                                    # all apps through Turborepo
pnpm --filter @psyche/gateway start         # the Gateway (psyched) on 127.0.0.1:7979
pnpm --filter @psyche/desktop dev           # the desktop app
```

To run the Gateway with a model, set `PSYCHE_MODEL`, for example `PSYCHE_MODEL=anthropic/claude-sonnet-5-5` with `ANTHROPIC_API_KEY`, or `PSYCHE_MODEL=ollama/qwen3.8:27b` for a local model. Without a model, the Gateway starts and answers "No model is configured yet".

Checks:

```bash
pnpm test                                   # unit tests (Vitest)
pnpm typecheck
pnpm lint
pnpm --filter @psyche/integration-tests test   # the walking-skeleton scenario, with a scripted model
```

Contributors: read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Repository layout

| Path | What is in it |
| --- | --- |
| `apps/` | Things you run: `gateway` (`psyched`), `desktop` (Electron), `web`, `cli`, `mac-helper` (Swift), `node` and `site` (this documentation site) |
| `packages/` | One library per subsystem, shared by the apps: `protocol`, `agent-core`, `permissions`, `vault`, `memory`, `ui` and the rest |
| `docs/` | The design documents (`00`–`09`), guides, release notes and per-topic design; `docs/archive/` holds the build history |
| `deploy/` | Dockerfiles, Compose, launchd and systemd files, macOS packaging and release scripts |
| `scripts/` | Repository checks used by CI (`scripts/ci/`) and the i18n baseline |
| `tests/` | Integration and acceptance tests, the injection corpus and scenario fixtures |
| `skills/` | The `SKILL.md` skills that ship with Psyche |
| `templates/` | The default persona files (`SOUL.md`, `AGENTS.md`, `USER.md`, …) written at onboarding |

## Documentation

- **Using Psyche:** [docs/guides/](docs/guides/README.md), starting with [getting-started](docs/guides/getting-started.md), [approvals](docs/guides/approvals.md) and [memory and persona](docs/guides/memory-and-persona.md).
- **How it is built:** [docs/00-vision-and-principles.md](docs/00-vision-and-principles.md), [02-architecture](docs/02-architecture.md), [03-feature-spec](docs/03-feature-spec.md), [05-security-and-permissions](docs/05-security-and-permissions.md), [07-tech-decisions](docs/07-tech-decisions.md) and [08-roadmap](docs/08-roadmap.md).
- **Design notes:** [docs/design/](docs/design/) and [docs/agent/](docs/agent/). Updates and install: [docs/design/updates-and-install-2026.md](docs/design/updates-and-install-2026.md).
- **History:** [docs/archive/](docs/archive/README.md) holds past build prompts, spikes, reviews and status logs. It is kept for reference and is not current.

## Contributing, security and license

- [CONTRIBUTING.md](CONTRIBUTING.md): how to work in the repo and what is expected of a change.
- [SECURITY.md](SECURITY.md): how to report a vulnerability. Please don't open a public issue for one.
- [LICENSE](LICENSE): Apache-2.0.
