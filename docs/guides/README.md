# Psyche guides

Psyche is a self-hosted personal AI agent. It runs a Gateway (`psyched`) on your Mac or on a Linux server, keeps your data in one directory on that machine, and is controlled from the desktop app, the web UI, or the `psyche` command-line tool.

These guides are for people running Psyche, not for contributors.

| Guide | Read it when |
| --- | --- |
| [install.md](install.md) | You are setting up Psyche for the first time, on a Mac or a Linux server. |
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
