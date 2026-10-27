---
title: What stays on your machine
---

# What stays on your machine

Psyche runs on hardware you control and needs no hosted service for threads, memory or skills. This page lists what is stored where, what a cloud model provider sees, what else connects to the internet, and what the update check sends. If you use a local model, model calls do not leave your machine either.

## Where your data lives

Everything is under `$PSYCHE_HOME`, which is `~/.psyche` by default on both macOS and Linux. Directories are created with mode 0700 and files with 0600.

| Path | What it holds | Encrypted by Psyche |
| --- | --- | --- |
| `state/psyche.sqlite` | Threads, tasks, approvals, grants, receipts, devices, settings, the memory index | No; relies on FileVault or LUKS |
| `workspace/` | `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`, daily notes | No; plain Markdown by design |
| `vault/` | The credential vault (SQLCipher) and its key slots | Yes |
| `secrets/vault.key` | The vault key, on unsigned Mac builds and servers only | No; see [Key storage](/security/key-storage) |
| `library/` | Files the agent made or received; downloads wait in `library/quarantine/` | No |
| `browser/profiles/` | The agent browser's own profiles and cookies | Cookies use the OS key |
| `audit/` | The hash-chained audit log, one file per month | No; tamper-evident instead |
| `security/` | The revocation ledger and the audit anchor key | No; never put in backups |
| `backups/` | Archives made by `psyche backup create` or the app | Yes, with age |
| `logs/` | Gateway logs | No |

Only the vault and backups are encrypted by Psyche itself. The database is left readable so you can open your own transcripts with ordinary tools; turn on FileVault on a Mac and full-disk encryption on a server.

::: info Screenshot placeholder
A Finder window of `~/.psyche` showing the state, workspace, vault, library, browser, audit, security, backups and logs folders.
:::

## What a model provider sees

With a cloud model (Anthropic, OpenAI, Google, OpenRouter or a compatible endpoint), only the Gateway talks to the provider. Each turn sends:

- the system prompt, assembled from your persona files, including `MEMORY.md` and `USER.md` in your own private sessions;
- the conversation so far, or a summary of it;
- the results of tools the agent ran in that turn, which can include page text, email bodies and file contents it read;
- the list of tools the agent may use.

The provider never receives a secret from the vault. The agent works with placeholders such as `{{cred:github-login}}`, and the real value is filled in by the executor after your approval. A provider API key you enter in onboarding or Settings is a vault item too: the model router reads it per request to authenticate, and the agent can never list or use it.

What the provider keeps, and for how long, is set by the provider's own terms, not by Psyche. Incognito threads skip Psyche's memory flush and index and expire after 24 hours, but the provider still receives their content.

## Use a local model

A local model removes the provider from the picture: nothing about your turns leaves the machine for a model call.

- Psyche supports Ollama, llama.cpp and LM Studio. Pick a model in Settings → Model & providers, which also checks whether a model can use tools.
- To run the Gateway against a non-default server, set `PSYCHE_OLLAMA_URL`, `PSYCHE_LLAMACPP_URL` or `PSYCHE_LMSTUDIO_URL`. See [Settings reference](/reference/settings).
- Local models are not on the auto-mode allowlist, so threads that use them run in Manual or Balanced mode.
- The 0.3 acceptance runs used Anthropic models only; no local model was run against them.

## What else connects to the internet

Besides the model provider, Psyche connects out only for things you set up or ask for:

- connectors you add (Google, Microsoft, IMAP or JMAP, 1Password, Stripe Link) and MCP servers you install;
- web search and fetch, and the agent browser, when a task needs them;
- chat channels you configure, such as Telegram;
- the Feed, which by default reads Hacker News and arXiv for posts. Turn either off, or add RSS feeds, with the `feed.sources` setting.

Sandbox containers have no network unless a task asks for the egress proxy and you approve the domains.

## No telemetry

Psyche sends no analytics, usage data or crash reports. There is no phone-home and no remote kill switch. Logs leave out message bodies and secrets. Dictated text goes from the speech recognizer to the app you are typing in and is never stored, logged or shown to the model; only character counts are recorded.

`psyche security audit` flags a setting that turns logging of bodies or telemetry on, in case one is ever added.

## The update check

The desktop app checks for updates by fetching a signed `update-manifest.json` from the project's GitHub releases. The request carries no account or usage data. Before anything is installed, the app:

1. verifies the manifest's Ed25519 signature against a release key embedded in the app;
2. accepts only a strictly newer version, hosted under `github.com/devmello/psyche/releases/download/`;
3. downloads the update and checks its size and SHA-256;
4. hands only that verified file to macOS's updater, which checks the code signature as well.

Today the check is off: it stays off for unsigned builds, and while no release key is embedded, which is the case at 0.3. A setting to turn the check off (`updates.check`) is in the design but not built yet. Each check writes its result to `$PSYCHE_HOME/run/updater.json` for `psyche security audit`.

## Learn more

- [Key storage](/security/key-storage)
- [Backups](/security/backups)
- [Settings reference](/reference/settings)
- [docs/05 §14, data handling and privacy](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#14-data-handling-and-privacy)
- [docs/05 §11, Psyche's own updates](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#11-supply-chain)
- [docs/02 §12, storage layout](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md#12-storage-layout)
