# Psyche guides

Psyche is a self-hosted personal AI agent. It runs a Gateway (`psyched`) on your Mac or on a Linux server, keeps your data in one directory on that machine, and is controlled from the desktop app, the web UI, or the `psyche` command-line tool.

These guides are for people running Psyche, not for contributors. They describe Psyche as it is on `main` today. Where a design document describes something the code does not do yet, the guides say so.

No release has been published yet. Until the first one, run Psyche from a source checkout with [getting-started.md](getting-started.md) and [server-mode.md](server-mode.md). [install.md](install.md) and [upgrade.md](upgrade.md) describe the release path (Homebrew, the DMG and the published image) for when it exists.

| Guide | Read it when |
| --- | --- |
| [getting-started.md](getting-started.md) | You are running the desktop app from source: choosing a model, onboarding, admin rights, sharing folders, where Settings live. |
| [install.md](install.md) | You are installing a release, on a Mac or a Linux server. |
| [approvals.md](approvals.md) | You want to know what an approval card shows, which scopes and modes exist, what only your devices can approve, receipts, revoking grants and untrusted content. |
| [memory-and-persona.md](memory-and-persona.md) | You want to read or edit the agent's persona and memory files, pause or reset memory, or export. |
| [connectors.md](connectors.md) | You want Google, other mail, 1Password, Telegram or web search, and which of them work yet. |
| [server-mode.md](server-mode.md) | You are running the Gateway on a Linux server or a Mac without a screen from source: Docker Compose, systemd, launchd, Tailscale, pairing, logs. |
| [backup-restore.md](backup-restore.md) | You want encrypted backups, a backup schedule, or to move Psyche to a new machine. |
| [upgrade.md](upgrade.md) | A new version is out, or you need to go back to an older one. |

## Where your data lives

Everything Psyche keeps is in `$PSYCHE_HOME`, which is `~/.psyche` unless you set it otherwise. The directory is readable only by you (mode 0700). With Docker Compose it is the named volume `psyche-home`, mounted at `/data` in the container.

## Getting help from the CLI

Every command has `--help`, and every command accepts `--json` for scripts.

```bash
psyche --help
```

Three commands answer most "is it working?" questions:

```bash
psyche status
```

```bash
psyche doctor
```

```bash
psyche security audit
```

`psyche doctor` and `psyche security audit` exit with code 1 when they find a problem. Checks that depend on parts of the Gateway that are not finished yet are listed as skipped or "Not checked", not as passed.
