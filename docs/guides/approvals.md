# Approvals

Psyche asks before it does anything that matters, and it keeps a receipt for everything it does. This guide explains the approval card, the scopes you can grant, the permission modes, which approvals only your devices can answer, approving from chat, expiry, receipts and Activity, revoking grants, and what "untrusted content" means for you.

## How a decision is made

Every tool call with a side effect goes through the Gateway's Permission Broker. The agent cannot skip it, and nothing it reads can change it.

Each action has a side-effect class:

| Class | Examples |
| --- | --- |
| read | Reading a page, a file in a shared folder, a mailbox |
| write | Saving a file, a draft, a calendar event, a click or typing in a page |
| destructive | Anything irreversible or visible to others: sending an email, submitting a form, deleting |
| financial | Moving money or committing to pay |

For each call the broker checks, in order: the hard prohibitions, your deny rules and shared folders, untrusted content in the turn, your standing grants, and then the default for the thread's permission mode. The result is allow, ask or deny. "Ask" puts an approval card in front of you and pauses that action until you answer.

Some things never happen, in any mode. Settings → Permissions lists them under Hard prohibitions. The agent never:

- types a password, card number, bank account or government ID it can see;
- solves or bypasses a CAPTCHA;
- makes a financial transfer or trade;
- permanently deletes data without a typed confirmation;
- follows instructions found in web pages, email or files;
- creates third-party accounts without your approval;
- acts on a localhost origin that isn't your own project;
- changes permissions, grants, security settings or pairing from a tool call;
- reads Safari or Passwords.app credentials;
- uses a secret it can see, even one you paste.

## The approval card

Cards appear in a dock above the composer, never inside the conversation. The dock opens one card at a time, the one that expires first, and lists the others as one-line rows you can click. In the conversation, a pending approval shows only as "Waiting for your approval", which opens its card; once answered it becomes one line such as "Approved: …" or "Denied: …".

The agent sheet also lists cards: click the avatar in the chat header, then Approvals, or press ⇧⌘P. The menu-bar item shows "Needs you" with a count.

A card shows, from top to bottom:

- "Approval needed" and a countdown ("expires in …").
- A fixed header line with the kind of action and its class, for example `Send email · destructive`. It ends with `after reading untrusted content` when that applies.
- A one-line summary of the action.
- The full arguments for that kind of action, never truncated. For an email: To, Cc, Subject, Body (behind View) and Account. For a command: Command, In, Env names. For a file write: Path and the change (behind View diff). For a purchase: Merchant, Amount and Items. For a credential fill: Item, Bound to, This page, and a note that the agent sees only the placeholder, never the value.
- Requested by: your agent, and the task when there is one.
- Why asked: the broker's reason, or the mode, the side-effect class and "this turn read untrusted content".
- The choices you have, as radio buttons. Deny is selected when the card appears.
- "Needs Touch ID or a passkey to approve." for actions that require it (see below).
- "Also sent to: …" when the card went to other places too. The first answer wins.
- A short binding hash: "any change above voids this card". The card is bound to these exact arguments. If the agent changes anything, the card is voided and a new one is needed. Details, beside it, shows the card's ids.

To answer, pick a choice and click "Allow with scope", or click Deny. The buttons arm 400 ms after the card appears, so a stray click cannot approve it. Return never approves. ⌘Return submits the selected choice and ⌘D denies.

## Scopes

A scope says how far your "yes" reaches. Only "Allow once" is single use. The others create a standing grant that you can see and revoke in Settings → Permissions.

| Choice on the card | Covers | Lasts |
| --- | --- | --- |
| Allow once | This exact call with these exact arguments | Until it runs |
| Allow for this task | The same kind of action on the same target, inside this task | Until the task ends, at most 24 hours (8 hours for destructive actions) |
| Allow for this site | One website | 30 days |
| Always allow, until this session ends | The same kind of action on the same target | Until the Gateway restarts, after 12 hours idle, or 24 hours at most |
| Always allow, until revoked | The same kind of action on the same target | Until you revoke it; the Gateway ends it after 90 days by default |

Which choices a card offers depends on the action:

- Allow once is always offered.
- Allow for this task needs a task: it appears when the action is part of background work the agent is running.
- Allow for this site appears only when the action targets a website.
- Destructive actions offer only Allow once and Allow for this task.
- Purchases and anything financial offer only Allow once.
- Credential fills offer Allow once and Allow for this site.
- Pairing, permission changes, skill installs and starting a plan offer only Allow once.
- In Manual mode, writes and anything stronger offer only Allow once.
- Answers from a chat app are always Allow once.

## Permission modes

Each thread has a permission mode. The broker supports four:

| Mode | Reads | Writes | Destructive | Financial |
| --- | --- | --- | --- | --- |
| Plan | Only tools with no side effect run | Denied | Denied | Denied |
| Manual | The first read of each new source in a task asks | Ask every time; standing grants are not used | Ask, once only | Ask, once only, on your device |
| Balanced | The first read of each new source in a task asks; sensitive sites always ask | Standing grants run; otherwise ask | Ask, once, for this task or always (you confirm Always allow) | Ask, once or always (you confirm Always allow), on your device |
| Auto | New ordinary sites are read without asking, unless the turn is tainted or the site is sensitive | Inside your grants, a classifier decides: routine runs, sensitive asks, prohibited is denied | As Balanced | As Balanced |

Sends, destructive and financial actions ask by default. You can let one run without asking: choose Allow for that action in Settings → Connectors, or Always allow on its card, and confirm. Psyche still asks after it has read untrusted content in the turn, and every time in Manual mode. Credential entry, purchases, commands on this Mac and other device-only approvals always ask.

A "new source" is a site, connector account, folder, app or MCP server the task has not touched yet. "Sensitive sites" is a built-in list of banking, brokerage, government, health, password-manager, sign-in and webmail hosts (for example `accounts.google.com` and `mail.google.com`). Reads inside a folder you shared run without asking.

On main every thread runs in Balanced, and switching is not available yet. The mode menu in the chat header and ⇧⌘M both answer "Changing the permission mode needs a newer Gateway.", and the "Default mode for new threads" choice in Settings → Permissions is saved but not applied.

## Device-only approvals and Touch ID

Some approvals can only be answered on a paired device (the desktop app or the web client), never from a chat app:

- every destructive action, such as sending an email;
- every financial action and every purchase;
- credential fills;
- running a command directly on the Mac;
- pairing a device and changing permissions.

In a chat app such a card shows only its header and "Answer this on your Mac."

A subset also needs proof that you are present: purchases and other financial actions, credential fills, commands on the Mac, pairing and permission changes. Their card says "Needs Touch ID or a passkey to approve."

In the web client at the server's https address, approve them with a passkey: add one in Settings → Devices & nodes → Passkeys ([server mode](server-mode.md#passkeys)), and approving asks for it. Elsewhere approving those is refused. The Mac helper's Touch ID signature cannot be registered with the Gateway yet, and the Gateway refuses rather than accept an unverified approval. Deny always works. Running commands directly on the Mac is also off by default.

### Approvals as macOS notifications

When Psyche Helper (the Swift helper app) is running and connected to the Gateway on the same Mac, approval cards also arrive as macOS notifications with Approve and Deny. Tapping or dismissing the notification decides nothing. When you answer elsewhere, the notification is withdrawn. When a card is too long for a notification, it offers Deny only and says "Open Psyche on your Mac to review."

Psyche Helper is built from source; there is no release of it yet:

```bash
apps/mac-helper/scripts/build-app.sh --install
```

```bash
open ~/Applications/Psyche\ Helper.app
```

It needs macOS 15 or later and Swift 6. Sign every build with the same identity and keep it at one path, or macOS forgets the permissions you granted it. `apps/mac-helper/README.md` covers signing.

## Approving from a chat app

When the agent can reach you on Telegram, approvals are sent there too (setup is in [connectors.md](connectors.md#telegram)):

- Only cards that are not device-only go to chat. In practice that means write-class actions, such as a calendar change or a draft.
- Telegram shows inline buttons. Where buttons are not available, the card shows a reference you answer with `/approve <ref> approve` or `/approve <ref> deny`.
- Only your own owner identity can answer. Answers are always Allow once.
- The card is plain text from a fixed template. Every value is sanitized: line breaks show as `⏎`, hidden characters as `⟨U+XXXX⟩`, and international domain names in punycode, so a lookalike cannot hide in it.
- A card that does not fit in one message is replaced by "Open on your Mac to review." and cannot be answered from chat.
- The first answer on any surface wins. A later answer is refused.

These never go to chat: credential fills, commands on the Mac, purchases and other money, pairing and permission changes, and destructive actions such as sending email.

## Expiry and restarts

- A card expires 30 minutes after it is issued. An expired card says "Expired. Nothing was done." The task stays resumable.
- If the Gateway restarts, pending cards become out of date ("Psyche restarted, so this card is out of date. It will be re-issued if it is still needed."). The Gateway checks the parked action against your policy again and issues a fresh card with new answer buttons. Old buttons stop working.
- Work that runs while nobody is watching, such as an automation, cannot wait for you. It sets the action aside under Deferred in Approvals, sends you a notification, and carries on without that action.

## Receipts and Activity

Every side effect leaves a receipt, whether it succeeded or not. A receipt records what was done, the approval that allowed it and the outcome:

- ok: it worked;
- failed: it did not happen;
- uncertain: the Gateway stopped mid-action, so it cannot tell. The receipt reads "outcome unknown · not retried". Psyche never repeats an uncertain action by itself.

Receipts show in the conversation next to the action. The agent sheet's Activity tab (⇧⌘A) lists tasks, the work the agent runs in the background, with filters for Running, Needs you and All. Open a task to see its actions with time, tool, summary and outcome. ⌃O cycles how much detail you see: status, actions, raw.

The Approvals tab also has Recent, the decisions of the last 7 days with where they were answered.

Every decision, grant and receipt is also written to a hash-chained audit log in `~/.psyche/audit/`. Receipts and audit entries are never deleted by Psyche's cleanup.

## Revoking grants

- Settings → Permissions → Grants ledger lists every standing grant with its scope, expiry, uses and last use. Click Revoke next to one. "Revoking takes effect at once."
- The Approvals tab shows the count under Standing grants, with a link: Review in Permissions.
- Revoking a device (Settings → Devices & nodes, or `node apps/cli/src/main.ts devices revoke <id>`) also ends the grants approved from that device.

Revoking needs a device paired as admin (see [getting-started.md](getting-started.md#5-make-the-app-an-admin-device)).

## Untrusted content

Untrusted content is anything that did not come from you: web pages, search results, emails and their attachments, files the agent reads, downloads, and messages from anyone else, including messages you forward. Psyche treats it as data. Instructions inside it are never followed.

When the agent reads untrusted content during a turn, the turn is marked tainted. That changes what you see:

- The card's header ends with "after reading untrusted content", and Why asked says "this turn read untrusted content".
- Writing or sending to a target you did not name, or one not already approved in the task, asks even when a standing grant would cover it.
- Opening a site the task has not visited asks.
- The agent cannot change `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md` or `MEMORY.md` in that turn at all. Notes it writes to the daily note are tagged untrusted.
- Memory search marks such entries with an "untrusted" chip.
- In a chat app, forwarded text reaches the agent labelled as someone else's words, and an edited message is never applied as a new instruction.

What this means for you: when a card says the turn read untrusted content, check the arguments against what you asked for. If an email, page or file seems to be steering the agent, deny the card and tell the agent what you want instead.
