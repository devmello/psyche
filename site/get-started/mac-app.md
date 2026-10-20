---
title: The Mac app
---

# The Mac app

The desktop app is the easiest way to run Psyche. It installs the Gateway as a LaunchAgent, starts the Psyche Helper (computer use, dictation, Messages, notifications, the keychain), and walks you through setup without a terminal.

## Install

1. Download `Psyche-<version>-arm64.dmg` (Apple silicon) or `Psyche-<version>-x64.dmg` (Intel) from the [GitHub releases](https://github.com/devmello/psyche/releases).
2. Check it against its checksum file:

   ```bash
   shasum -a 256 -c Psyche-<version>-arm64.dmg.sha256
   ```

3. Open the DMG and drag Psyche to Applications.

A Homebrew cask is planned but not published yet.

## Open it the first time (unsigned builds)

Until the first signed and notarized release, macOS blocks the app the first time you open it. After checking the checksum:

1. Open Psyche from Applications and click **Done** on the warning.
2. Open **System Settings › Privacy & Security** and click **Open Anyway** next to the Psyche message.

Unsigned builds also lose macOS permissions (Accessibility, Screen Recording, Microphone, Automation) each time you install a new build, because macOS ties those grants to the app's signature. `psyche doctor` warns about it. The [install guide](/guides/install#on-your-mac) has the details and the reset command.

## Onboarding

The first run:

1. Starts the Gateway and waits for it to be healthy. If it isn't, the app shows the logs.
2. Makes this Mac your first admin device.
3. Asks for a model provider and stores its key in the vault.
4. Sets up your persona and memory files.

macOS asks for each permission the first time a feature needs it, not up front.

::: info Screenshot placeholder
Onboarding: the model provider step, with the key field and the note that the key goes into the vault.
:::

## Check the install

```bash
psyche status
```

```bash
psyche doctor --first-run
```

```bash
psyche security audit
```

The CLI ships inside the app. The install guide shows how to put it on your `PATH`.

## Limits today

- Builds are unsigned, so the macOS permission resets above apply after every update, and the vault key lives in a key file (see [Key storage](/security/key-storage)).
- Computer use, dictation, Messages and the Apple app adapters have not been verified on a real Mac in every macOS version. Treat them as previews.

## Learn more

- [Install guide: on your Mac](/guides/install#on-your-mac)
- [Upgrade](/guides/upgrade) and [Migrate to a new Mac](/guides/migrate)
- [Release notes 0.3](/release-notes/0.3), the packaged Mac app
