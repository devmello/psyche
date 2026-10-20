# Connectors and channels

Connectors give the agent your accounts (mail, calendar, files); channels let you reach the agent from a chat app. This guide covers Google, other mail over IMAP or JMAP, 1Password, Telegram and web search. Much of this is in the code but not reachable from the app yet, and each section says so plainly.

## What works today

| Feature | On main |
| --- | --- |
| Google (Gmail, Calendar, Drive) | Not available yet: the Gateway has the connector, but nothing can connect it |
| Other mail (IMAP, Fastmail over JMAP) | Not available yet: the Gateway does not include the mail connector |
| 1Password | Not available yet |
| Telegram | The Gateway runs the bot, but the Telegram channel cannot be created from the app or the CLI yet |
| Web search | Not available yet |

The onboarding Connectors step and Settings → Connectors also list Microsoft (Outlook, Calendar), Other email (IMAP), Apple Notes, Apple Reminders and MCP server. None of them connect on main. In onboarding, Connect lists the account as connected without connecting anything; use Skip for now.

## Google

### What it does once connected

The Google connector covers Gmail, Google Calendar and Google Drive. It runs on your own Google Cloud OAuth client, so your mail never passes through anyone else's server. When you connect, you choose what the agent may do:

| Choice | Google scopes requested |
| --- | --- |
| Read only | `gmail.readonly`, `calendar.readonly`, `drive.file` |
| Read and act | `gmail.modify`, `calendar`, `drive.file` |

- Read only: the agent can read and search. Nothing is sent, changed or deleted, and the write tools are not even offered to it.
- Read and act: the agent can also draft, label and send mail, and create, change and delete events. Each action still follows your permissions, and sending an email is a destructive action, so it always asks on your device.
- `drive.file` limits Drive to files the agent creates or you open with it.
- Every reconnect revokes the previous grant first, so a Read only connection never keeps send or modify rights from an earlier one.
- Mail and calendar contents are untrusted content (see [approvals.md](approvals.md#untrusted-content)).

### Prepare your own Google Cloud client

You can set this up now. It takes a few minutes, once.

1. In the Google Cloud console, create a project. Any name works.
2. Enable the Gmail API, the Google Calendar API and the Google Drive API for the project.
3. Under Google Auth Platform → Branding, set the audience to External.
4. Under Audience, choose Publish app so the status is In production. If you leave it in Testing, Google expires the sign-in 7 days after you consent. In production, an app used only by its owner does not need Google's review.
5. Under Clients, create a client of type Desktop app. Keep its client ID and client secret.

### Connecting

Connecting Google from the app or the CLI is not available yet. The Gateway has the connector, but it does not offer the connect step to clients: Settings → Connectors has no Connect button and onboarding's Connect does nothing. Connector sign-ins are also kept in the vault, which cannot be set up yet. There is no workaround in Psyche today.

## Other mail: IMAP and JMAP

Not available yet. The mail connector exists in the code, but the Gateway does not include it, so no mailbox can be added. For the record, it supports:

- Fastmail (JMAP), with a Fastmail API token that has the Mail scope;
- Other mail (IMAP), for any mailbox with an app password, over TLS only (IMAP on port 993, SMTP on port 465 by default; no STARTTLS, no plain text).

There are no presets for other providers' server names. Gmail and Outlook over IMAP with their own sign-in are not supported; for Gmail, the Google connector is the way once it can be connected.

## 1Password

Not available yet. The vault code can read items from 1Password, but the app has no way to link it, and the Gateway's vault cannot be set up yet either. Settings → Credentials shows "External manager" as a choice, without a working connect step.

What to use instead: keep your logins in 1Password and sign in yourself. In the desktop app's browser pane, click Take control, type the login, then click Return control. While you have control, the agent's input to the page is refused. Psyche itself never types a password it can see.

## Telegram

The Gateway can run a Telegram bot. It starts the bot only after a Telegram channel exists in the Gateway, and creating that channel from the app or the CLI is not available yet: the Gateway method for it (`channels.configure`) exists, but no screen or CLI command calls it to create a channel. Until then, the bot does not answer.

What follows is how Telegram behaves once a channel exists, so you can prepare.

### Create the bot and give the Gateway its token

1. In Telegram, talk to @BotFather and create a bot. Note its token and its username.
2. Save the token in a file only you can read, for example with mode 600.
3. Start the Gateway with these variables:
   - `PSYCHE_TELEGRAM_BOT_TOKEN_FILE`: the path to the token file. (`PSYCHE_TELEGRAM_BOT_TOKEN` takes the token itself, but the file keeps it out of your shell history.)
   - `PSYCHE_TELEGRAM_BOT_USERNAME`: the bot's username.

The Gateway reads the token file when it starts. A token without a username stops it with "PSYCHE_TELEGRAM_BOT_USERNAME is required with a Telegram bot token". The token is never logged and is removed from every error message.

### Pair yourself as the owner

1. Message the bot. You get an 8-character pairing code that expires in 1 hour, and nothing else happens. Owning the bot does not, by itself, let you chat with it.
2. The Gateway notifies you of a "New chat pairing request", which names the sender's Telegram id. Approve the code in Settings → Channels, under the Telegram channel. Approving needs a device paired as admin.
3. Make that id the owner: list it in the channel's owner ids, or set the `commands.ownerAllowFrom` setting to `["telegram:<your id>"]`. Once you are the owner, `/whoami` in the chat repeats your id.

Only the owner's private chats run turns. Anyone else gets "Psyche can't take requests in this chat yet." In Settings → Channels you can also change who may message the bot (Direct messages: Pairing, Allowlist, Open or Disabled) and whether it answers in groups only when mentioned.

### Using it

- By default your private chat with the bot is its own thread. With the channel's `dmScope` set to `main`, it continues your main thread instead.
- Commands: `/stop` cancels the running task, `/status` says whether it is working, `/new` starts a fresh session (in the main thread it tells you to start a new one in the app), `/whoami`, and `/help`.
- An edited message is never applied. The bot answers "Edits are not applied to a request. Send a new message instead."
- Forwarded and quoted text reaches the agent labelled as someone else's words: data, not instructions.
- Attachments go to the Library's quarantine folder, `~/.psyche/library/quarantine/`.

### Approvals over Telegram

- Write-class approvals, such as a calendar change or a draft, arrive as a card with inline buttons. You can also answer with `/approve <ref> approve` or `/approve <ref> deny`.
- Only your owner identity can answer, and an answer from chat is always Allow once.
- The first answer on any surface wins.
- A card that does not fit in a message says "Open on your Mac to review." and cannot be answered from chat.

These never go to chat: sending email and every other destructive action, purchases and anything that moves money, credential fills, commands on the Mac, pairing, and permission changes. In chat they show only their header and "Answer this on your Mac." See [approvals.md](approvals.md#device-only-approvals-and-touch-id).

## Web search

Not available yet. Search providers (Brave, Exa, Tavily and SearXNG) are in the connector code, but the Gateway does not configure any of them, so the agent has no web search tool.

What to use instead: in the desktop app, ask the agent to look something up in its browser. It opens pages in the browser pane, where you can watch and take control. The first visit to each new site asks first, and everything it reads there is untrusted content.
