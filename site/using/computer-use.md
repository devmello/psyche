---
title: Computer use
---

# Computer use

With computer use on, the agent can work in the apps on your Mac: read what is in a window, click, type, open and focus apps, run an AppleScript or a Shortcut. You decide app by app how far it may go, some apps are capped no matter what you choose, and pressing Esc stops it at once. Computer use runs through Psyche Helper, the small Mac app that holds the macOS permissions, and it is off until you turn it on.

## Turn it on

1. Make sure Psyche Helper is running. It ships inside Psyche.app and starts with it; Settings → Devices & nodes shows its state.
2. Open Settings → Computer use.
3. Under macOS permissions, grant **Accessibility** (lets the agent click, type and use apps) and **Screen Recording** (lets it see app windows). Each row shows Granted, Denied or Not asked yet, with **Open System Settings**.
4. Turn on **Allow computer use**. Off stops every app at once.
5. Apps appear in the table the first time the agent wants one. Set each to **Ask**, **Off**, **Read only** or **Read and interact**.

Changing these settings needs a device paired as admin.

::: info Screenshot placeholder
Settings → Computer use: the macOS permissions rows with Granted chips, the Allow computer use switch, and the App access table with columns Ask, Off, Read only and Read and interact, including locked rows such as "Safari: Read only (fixed)".
:::

## What it can do

- **Look.** Read the window's accessibility tree: buttons, fields, text and their positions. It takes a screenshot only after it has looked at the same app this way.
- **Act.** Click, double-click, type, press keys, scroll and drag, by pointing at elements it found when it looked.
- **Apps.** List apps, open an app or a `file:` or `mailto:` link, and bring a window to the front.
- **Automate.** Run AppleScript or JavaScript for Automation against one app, and run your Shortcuts by name. Scripts run in a separate process and drive only their target app.

One session drives the computer at a time, and everything the agent reads from an app is untrusted content.

### Tiers

| Tier | The agent may |
| --- | --- |
| Off | Nothing in this app |
| Read only | Look, but not click or type |
| Read and interact | Look, click and type |
| Ask | Ask you the first time, then follow your answer |

### Fixed caps

Some apps have a cap you cannot raise:

- **Browsers are read only**: Safari, Chrome, Firefox, Edge, Arc, Brave, Opera, Vivaldi and Chromium. To act on the web, the agent uses its own browser (see [Browser](/using/browser)).
- **Terminals and code editors are click only**, never typing: Terminal, iTerm2, Warp, Ghostty, kitty, Alacritty, VS Code, Cursor, Zed, Xcode, Sublime Text and JetBrains IDEs. Commands run in the sandbox instead.
- **Always off**: password managers (1Password, Bitwarden, LastPass, Dashlane, Passwords, Keychain Access), System Settings, Psyche itself, Notification Center and system sign-in prompts, and banking, trading and payment apps such as PayPal, Chase, Schwab, Fidelity, Robinhood and Coinbase.

### Stopping it

Press **Esc** on your Mac. The run stops and says "Stopped: you pressed Esc on the Mac". Esc works whatever the agent is doing, and injected content cannot dismiss it.

## What it asks you

- **An app set to Ask.** A "Use app" card: "Let Psyche use {app} for 30 minutes" (with your agent's name). It is offered once; approving lets the agent use that app at the tier you set for 30 minutes.
- **Risky actions always ask**, even in an app set to Read and interact: buttons and menu items such as Delete, Send, Pay or Quit, and the shortcuts ⌘Q, ⌘W and ⌘Delete.
- **Sending in messaging and mail apps.** Pressing Return in Messages, Mail, Outlook, Slack, Discord, WhatsApp, Telegram, Signal, Messenger, Teams, Spark or Superhuman asks.
- **When you are away.** In those messaging and mail apps, if you have not touched the Mac for 5 minutes, or the Psyche window is hidden, every action asks on a "While you're away:" card.
- **Scripts and Shortcuts.** "Run AppleScript" and "Run Shortcut" cards show the target app and the script, or the Shortcut's name and input.
- **Unattended runs** queue these cards instead of waiting; see [Tasks and automations](/using/tasks-and-automations).

## What it can't do

- Type into password or other secure fields, or take a screenshot while one has focus. These are refused before the action reaches the app.
- Raise a fixed cap, from chat or anywhere else.
- See Psyche's own windows, terminals and code editors, password managers, finance apps or any app set to Off in its screenshots. They are left out of the capture.
- Change your macOS permissions or Psyche's settings.
- Use more than one session at a time.

## Limits today

- Computer use is macOS only and needs Psyche Helper.
- It has not been run live on a real Mac with real permissions in Psyche's acceptance runs; it is tested against a fake helper. Treat it as early.
- The typed adapters for Calendar, Reminders, Mail, Notes, Finder and Safari exist in Psyche Helper, but the Gateway does not offer them to the agent yet. The agent uses those apps through the general tools above.
- Reading your Messages history is not an agent tool; the Messages integration is used only by the iMessage channel (see [Channels](/using/channels)).
- The 30-minute allowances live in the helper and are not shown in Settings.
- Screenshots go to the model as data, which uses more context than it should.
- Teach mode (recording a demonstration to replay) is not built.
- On unsigned builds, macOS forgets Accessibility and Screen Recording each time you install a new build. Grant them again after an upgrade; `psyche doctor` warns about it.

## Learn more

- [Approvals and tiers](/security/approvals-and-tiers)
- [On-device processing](/security/on-device)
- [Settings reference](/reference/settings)
- [Computer use status](https://github.com/devmello/psyche/blob/main/docs/status/m2-computer-use.md)
- [macOS specifics in the security design](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#12-macos-specifics)
- [Psyche Helper](https://github.com/devmello/psyche/blob/main/apps/mac-helper/README.md)
