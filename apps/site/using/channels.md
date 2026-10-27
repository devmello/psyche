---
title: Channels
---

# Channels

Channels let you talk to your agent from a chat app, such as Telegram or iMessage on your phone, as well as from the Psyche app. Only you, the owner, can give the agent work over a channel. Anyone else who writes to it gets a pairing code and nothing more until you approve them, and even then they cannot reach your private data. Approvals that matter most never go to a chat app; they wait for your Mac or the web client.

Today the Telegram and iMessage channels are built, but neither can be created from the app or the CLI yet. This page describes how they behave once a channel exists, so you can prepare.

## Turn it on

### Telegram

1. In Telegram, talk to @BotFather and create a bot. Note its token and username.
2. Save the token in a file only you can read (mode 600).
3. Start the Gateway with `PSYCHE_TELEGRAM_BOT_TOKEN_FILE` set to that file and `PSYCHE_TELEGRAM_BOT_USERNAME` set to the bot's username. A token without a username stops the Gateway with an error that says so. The token is never logged.

The bot starts answering only once a Telegram channel exists in the Gateway, and nothing creates one yet. See [Limits today](#limits-today).

### iMessage

The iMessage channel runs on your Mac through Psyche Helper. It needs:

- `PSYCHE_IMESSAGE_ACCOUNT` set for the Gateway to the Messages account the agent uses on this Mac;
- Psyche Helper running, with **Full Disk Access** (to read the Messages database, read only) and **Automation** permission for Messages (to send).

Use a separate Apple ID for the agent on this Mac. Messages sent from the Mac's own account are ignored as incoming messages, so you cannot talk to the agent from the same account.

Like Telegram, the channel starts only once it exists in the Gateway.

### The web client

The web client is a channel too, and it exists from the start. See [Server mode](/get-started/server-mode) for reaching it from your phone.

## What it can do

### Pairing and the owner

1. Message the bot. You get an 8-character pairing code that expires in 1 hour, and nothing else happens. At most 3 codes can be pending per channel.
2. The Gateway notifies you of the request. In Settings → Channels, under the channel, click **Approve** or **Ignore**. This needs a device paired as admin.
3. Make yourself the owner: set `commands.ownerAllowFrom`, for example `["telegram:123456789"]`, or add your id to the channel's owner ids. Changing it needs fresh proof of presence. Once you are the owner, `/whoami` repeats your id.

Being approved lets someone message the bot; it does not make them the owner. Only the owner's private chats run turns. Everyone else gets "Psyche can't take requests in this chat yet."

In Settings → Channels you also choose who may message the bot (**Direct messages**):

- **Pairing** (the default): new senders get a code; you approve them here.
- **Allowlist**: only senders you listed.
- **Open**: anyone. `psyche security audit` flags this.
- **Disabled**.

For groups, **Only answer in groups when mentioned** is on by default, and groups have their own allowlist.

::: info Screenshot placeholder
Settings → Channels with a Telegram channel: Direct messages set to Pairing, one pending request with Approve and Ignore, and "Only answer in groups when mentioned" switched on.
:::

### Talking to the agent

- Your private chat with the bot is its own thread. With the channel's `dmScope` set to `main`, it continues your main thread instead.
- Commands: `/stop` cancels the running work, `/status` says whether the agent is working, `/new` starts a fresh session (in the main thread it tells you to start one in the app), `/whoami` and `/help`.
- Editing a message never changes a request. The bot asks you to send a new message instead.
- Forwarded and quoted text reaches the agent labelled as someone else's words: data, not instructions.
- Attachments you send go to the Library, quarantined.

## What it asks you

Approval cards can reach you in chat, but only some kinds:

- **Sent to chat:** write actions, such as a calendar change or a draft. Telegram shows inline buttons; iMessage takes a 👍 or 👎 tapback on the card. Either also accepts `/approve <ref> approve` or `/approve <ref> deny`.
- **Never sent to chat:** sending email and other destructive actions, purchases and anything with money, credential fills, commands on your Mac, pairing and permission changes. In chat these show only their header and "Answer this on your Mac."

Answers from chat are always Allow once, only your owner identity can answer, and the first answer on any surface wins. A card that does not fit in one message says "Open on your Mac to review." Every value on a chat card is sanitized so a lookalike name or hidden character cannot hide in it.

When the agent replies in your own chat, that is the channel itself and needs no approval. Sending to anyone else asks you, as "Send message".

## Limits today

- **No channel can be created yet.** The Gateway has the method, but no screen or CLI command creates a Telegram or iMessage channel. Settings → Channels shows "No channels yet" and manages only channels that already exist.
- **Only the owner can use the agent.** Designated people (a family member who may, say, add events to your calendar) are not available, and allowlisted senders and groups get the "can't take requests" reply. The Identity links and Designated people lists in Settings are read only.
- **iMessage:** the agent cannot send attachments or voice bubbles yet, and incoming attachments and voice messages arrive as metadata only. No typing indicator and no formatting. SMS and RCS senders never count as the owner and cannot pair. The Messages integration has not been run live on a signed build with real permissions.
- **Automation results to Telegram** fall back to an in-app notification (see [Tasks and automations](/using/tasks-and-automations)).
- WhatsApp, Signal, Slack, Discord, email and SMS channels are not built.

## Learn more

- [Connectors and channels guide](/guides/connectors)
- [Approvals guide: approving from a chat app](/guides/approvals)
- [Server mode](/get-started/server-mode)
- [Untrusted content](/security/taint)
- [Channels and people in the security design](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#9-channels-and-people)
- [Channels package](https://github.com/devmello/psyche/tree/main/packages/channels)
