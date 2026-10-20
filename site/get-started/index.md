---
title: Get started
---

# Get started

Psyche has three parts:

- **The Gateway** (`psyched`): the always-on process that runs your agent. It listens only on `127.0.0.1:7979` and keeps everything in `$PSYCHE_HOME` (default `~/.psyche`, readable only by you).
- **The apps**: the Mac desktop app, which installs and supervises the Gateway for you, and the web UI the Gateway serves. Both are clients. They never hold your secrets.
- **The CLI** (`psyche`): setup, status, pairing, backups and upgrades, on macOS and Linux.

## Pick a setup

| You want | Use | Page |
| --- | --- | --- |
| Psyche on your Mac, with computer use, dictation and Messages | The Mac app (DMG) | [The Mac app](/get-started/mac-app) |
| An always-on Gateway on a Linux server | Docker Compose | [Docker and Compose](/get-started/docker) |
| A Gateway on a Mac mini or server without a screen, or under systemd | Server mode | [Server mode](/get-started/server-mode) |

You can combine them: run the Gateway on a server and use the Mac app as a client. Mac-only features (computer use, dictation, Messages, the Apple app adapters, VM mode) need the Psyche Helper on a Mac, which connects to the Gateway as a node.

## Before you start

- **A model.** Psyche needs a model provider: Anthropic, OpenAI, Google, OpenRouter, or a local model through Ollama, llama.cpp or LM Studio. The key you enter goes into the vault, never into a config file.
- **Requirements.** On a Mac, macOS 15 or later. Some features need newer macOS (the command sandbox uses Apple's `container` on macOS 26 and later, and Colima or Docker Desktop on 15). On a server, Docker with Compose.
- **Unsigned builds.** Until the first signed release, the Mac app is signed ad-hoc. macOS warns the first time you open it, and the vault key is kept in a key file rather than the keychain. [Key storage](/security/key-storage) explains what that means.

## After you install

1. Run `psyche doctor` and `psyche security audit`. Fix anything they flag.
2. Read [Approvals and app tiers](/security/approvals-and-tiers), so you know what the cards mean before the agent asks you anything.
3. Set up encrypted backups: [Backups](/security/backups).

## Learn more

- [Install guide](/guides/install), step by step for every setup
- [Getting started from source](/guides/getting-started), for running from a checkout
- [Architecture](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md), the design
