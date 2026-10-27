---
title: Dictation
---

# Dictation

Psyche can turn your speech into text in two places: the chat composer, and any other app on your Mac. In the composer, what you say becomes a message to the agent. In any other app, what you say is typed where your cursor is, and it never reaches the agent: no thread, no memory, no log of the words.

## Turn it on

Dictation lives in Settings → Voice & dictation.

1. Pick the **Push-to-talk key**: fn, Right Option or Right Command. The default is fn.
2. Pick the **Mode**: "Hold to talk" (the default), or "Press to start, press to stop".
3. For other apps, leave **Dictate into any app** on. It is on by default, and it appears only in the desktop app.
4. Grant Accessibility to Psyche Helper when Settings asks. The "In any app" group shows the state: Granted, Needed, or "Helper not running". "Open System Settings" goes to Privacy & Security › Accessibility, and "Check again" looks again.
5. Optionally set a **System-wide hotkey**: press it once to start and again to stop, from any app. Press Backspace in the field to turn it off. If another app already owns that shortcut, the field says so.

The first time you dictate, macOS asks for microphone access.

::: info Screenshot placeholder
Settings → Voice & dictation with the Dictation group (Push-to-talk key, Mode) and the "In any app" group (Dictate into any app, the Accessibility row, System-wide hotkey).
:::

## What it can do

- **In the composer.** Hold the key, speak, let go. Partial text appears as you speak. The result goes into the composer for you to edit and send.
- **In any app.** Click into a text field in any app, such as TextEdit, Notes or Slack, then hold the key and speak. A small floating panel (the HUD) shows what Psyche hears. When you let go, the text is inserted at your cursor.
- **Names it knows.** The recognizer is given a short vocabulary: the agent's name from `IDENTITY.md`, names from `USER.md`, and your contacts when the helper can read them. This helps it spell names right.
- **On device by default.** On a Mac, the recognizer is the Mac's own, through Psyche Helper. whisper.cpp is used when its model is installed.

## What it never does

- Text dictated into another app goes from the recognizer straight to that app. It is not sent to the agent, saved to a thread, written to memory or put in a log. The receipt records only the app and the number of characters.
- It refuses password and other secure fields. Over one, the HUD shows a short message and nothing is typed.
- It never presses Return. Line breaks and other control characters are collapsed, so dictation cannot submit a form.
- Only the desktop app on the Mac that runs the Gateway can use system-wide dictation. The web client, the CLI, other devices and the agent's tools cannot reach it.

## Limits today

- System-wide dictation is macOS only and needs Psyche Helper running, with Accessibility granted.
- It has not been tested end to end on a real Mac with a real microphone. The tests use a fake helper. Treat it as early.
- A hold shorter than a quarter of a second is ignored. A session stops after 2 minutes.
- Holding fn on its own can open the macOS emoji picker or Apple's dictation when you let go. Set System Settings › Keyboard › "Press 🌐 key to" to "Do Nothing", or pick Right Option instead.
- If Psyche's own window is in front, the hotkey does nothing; dictate in the composer instead.
- On unsigned builds, macOS forgets the Accessibility and Microphone grants each time you install a new build. Grant them again after an upgrade (`psyche doctor` warns about it).
- The **Speech engine** choice in Settings is saved, but it is not clear yet that the Gateway follows it. The Mac's recognizer is used when Psyche Helper is connected.

## Learn more

- [On-device processing](/security/on-device)
- [Settings reference](/reference/settings)
- [System-wide dictation status](https://github.com/devmello/psyche/blob/main/docs/archive/status/m2-system-dictation.md)
- [Psyche Helper](https://github.com/devmello/psyche/blob/main/apps/mac-helper/README.md)
- [macOS specifics in the security design](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#12-macos-specifics)
