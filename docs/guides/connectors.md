# Connectors and channels

Connectors give the agent your accounts (mail, calendar, files); channels let you reach the agent from a chat app. This guide covers Google, other mail over IMAP or JMAP, 1Password, Telegram and web search. Much of this is in the code but not reachable from the app yet, and each section says so plainly.

## What works today

| Feature | On main |
| --- | --- |
| Google (Gmail, Calendar, Drive) | The Gateway connects it with your own OAuth client ([connectors-google.md](connectors-google.md)); the app's Connect button is not wired yet |
| Other mail (IMAP, Fastmail over JMAP) | Not available yet: the Gateway does not include the mail connector |
| Apple Notes, Reminders, Calendar, Mail | Connect through the Psyche helper on your Mac ([below](#apple-apps-on-your-mac)) |
| 1Password | Not available yet |
| Telegram | The Gateway runs the bot, but the Telegram channel cannot be created from the app or the CLI yet |
| Web search | Not available yet |
| MCP servers | Add them in Settings → MCP servers ([below](#mcp-servers)) |

Settings → Connectors and the onboarding Connectors step offer only what this Gateway can connect; anything without an implementation, such as Microsoft, is left out. In Settings, two rows are not accounts: **MCP server** opens Settings → MCP servers ([below](#mcp-servers)), and **Slack** opens Settings → Channels, because Slack is a place to chat with Psyche, not an account it reads.

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

### Setting it up and connecting

[connectors-google.md](connectors-google.md) walks through creating your Google Cloud client (a Desktop app client, published to In production), giving its id to the Gateway in `config.json` with the secret in the vault, and what connecting, reconnecting, restarts and disconnecting do.

The Gateway runs the whole sign-in: it opens Google's consent page in your browser, receives the answer on a loopback address and keeps the tokens in the vault. The Connect button in onboarding and Settings → Connectors is not wired to it yet.

## Other mail: IMAP and JMAP

Not available yet. The mail connector exists in the code, but the Gateway does not include it, so no mailbox can be added. For the record, it supports:

- Fastmail (JMAP), with a Fastmail API token that has the Mail scope;
- Other mail (IMAP), for any mailbox with an app password, over TLS only (IMAP on port 993, SMTP on port 465 by default; no STARTTLS, no plain text).

There are no presets for other providers' server names. Gmail and Outlook over IMAP with their own sign-in are not supported; for Gmail, the Google connector is the way once it can be connected.

## Apple apps on your Mac

Apple Notes, Apple Reminders, Apple Calendar and Apple Mail connect through the Psyche helper, the small Mac app that comes with the desktop app. The helper talks to the apps on that Mac; Psyche never reads their files directly and nothing goes through Apple's servers on Psyche's behalf.

- The helper must be paired and running. Without it, Connect says the app needs the Psyche helper, and an already connected app's tools say the same until the helper is back.
- The first time the agent uses an app, macOS asks you on the Mac: Calendars or Reminders access for Calendar and Reminders, Automation for Notes and Mail. If you decline, the agent gets the error macOS gave; allow access in System Settings → Privacy & Security and try again.
- The account shown is "This Mac". The scopes listed are the helper capabilities the connection can use.

What each one can do:

| App | Read only | Read and act adds |
| --- | --- | --- |
| Apple Notes | List notes (by folder, or matching a title) and read one | Create a note (plain text) |
| Apple Reminders | List lists and reminders | Add a reminder, change or complete one |
| Apple Calendar | List calendars and events (at most 366 days at a time) | Add an event, change one |
| Apple Mail | Search by subject or sender, read a message | Save a draft; send a message |

Reading is allowed by default. Every change asks first, and sending mail always asks with the exact recipients, subject and text, even if you set it to allow. Notes, reminders, events and mail are untrusted content (see [approvals.md](approvals.md#untrusted-content)). Deleting notes, reminders or events is not offered.

## MCP servers

MCP servers plug in external tool servers that speak the Model Context Protocol. Each one gives Psyche a set of tools, such as searching a wiki or managing tickets. Add them in Settings → MCP servers:

1. Click **Add MCP server** and give it a name.
2. Choose how it runs:
   - **Command**: a program on the Gateway's machine, for example `npx -y @modelcontextprotocol/server-everything`. It always runs in Psyche's sandbox (srt, or its own container on a server), with no access to your files and no network unless you list the websites it may reach. A Gateway without a sandbox cannot run command servers; only URL servers can be added there.
   - **URL**: a server on the internet over HTTPS.
3. Click **Check server**. Psyche starts the server in the sandbox, asks it for its tools and stops it again. Nothing is offered to the agent yet.
4. Review the card: how it runs, what it can reach, and its tools with what each can do (read, change things, destructive). Tool names and descriptions are written by the server; Psyche shows them as data, and a tool whose description reads like instructions to the agent is kept off.
5. Approve the card on your device. Psyche adds the server and its tools become available. If the server lists different tools by the time it is added, Psyche refuses and asks you to check it again.

Every tool call still follows your permissions: anything that changes something asks first. If a server later changes its tools, the permissions you gave its old tools end and you get a notice. Remove a server from its row's ⋯ menu.

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
