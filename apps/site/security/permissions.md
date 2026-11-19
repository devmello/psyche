---
title: Permissions
---

# Permissions

Every action the agent takes that changes something goes through the Permission Broker in the Gateway. The broker answers allow, ask or deny. The agent cannot skip it, and nothing the agent reads can change its rules. This page explains how actions are classed, what the four permission modes do, how a decision is made, and how standing grants work and end.

## Side-effect classes

Every tool and node capability declares a side-effect class. The broker also applies a floor per tool, so a tool cannot declare itself weaker than it is (a purchase tool is always financial, a delete is always destructive).

| Class | Meaning | Examples |
| --- | --- | --- |
| none | Computation, or Psyche's own stores | Searching your memory, drafting text in the chat |
| read | Reading a source not yet in the conversation | A web page, a mailbox, a file in a shared folder |
| write | A reversible or private change | A draft, a calendar event, a file in a shared folder, a click or typing in a page, starting a task or an automation |
| destructive | Irreversible or visible to others | Sending an email, submitting a form, deleting, accepting terms, OAuth consent, a command on the Mac itself |
| financial | Moves money or commits to pay | A purchase through Stripe Link |

Each action also names its target: a website origin, a file path, an account, a command or a recipient. Grants and approvals bind to that target.

## Permission modes

Each thread has a permission mode. Balanced is the default.

| Mode | Reads | Writes | Destructive | Financial |
| --- | --- | --- | --- | --- |
| Plan | Only tools with no side effect run | Denied | Denied | Denied |
| Manual | The first read of each new source asks | Ask every time; standing grants are ignored | Ask, once only | Ask, once only, on your device |
| Balanced | The first read of each new source asks, unless you made it a trusted site; sensitive sites always ask | Standing grants apply; otherwise ask | Ask, once or for this task | Ask, once only, on your device |
| Auto | New ordinary sites are read without asking, unless the turn is tainted or the site is sensitive | Inside your grants, a rules classifier decides: routine runs, sensitive asks, prohibited is denied | Ask, once or for this task | Ask, once only, on your device |

A "new source" is a site, connector account, folder, app or MCP server the task has not touched yet. "Sensitive sites" is a built-in, editable list of banking, brokerage, health, password-manager, sign-in and webmail hosts. Government (`.gov`, `.gov.uk`) and iCloud sites are on that list by default, because they hold tax, identity, health and mail accounts. You can turn either category off in Settings → Permissions → Sensitive sites.

Change a thread's mode from the Manual / Balanced / Auto switch above the message box, or from the mode menu in the chat header. Choosing a mode applies at once, with no Touch ID or password, and, from the main chat, is remembered as the default for new chats (a new chat starts in Auto only if its model is on the list). Auto mode is offered only when the thread uses a model on the auto-mode allowlist; the Gateway refuses `auto` otherwise and drops an `auto` thread to Balanced if you switch to a model that is not on the list. Local models are not on the list by default.

Auto's classifier is a set of deterministic rules today, not a model. It sees only your own recent messages, the task's title, the tool name and the action's metadata, never page text, screenshots, tool results or memory. Anything that changes access, shares, deletes or communicates outward, any bulk action, and any action with no request from you to match is "sensitive", so the broker asks. (A model-backed classifier exists in the code but the Gateway does not use it yet.)

::: info Default mode
New threads start in the "Default mode for new threads" you choose in Settings → Permissions. `auto` applies only when the thread's model is on the auto-mode allowlist; otherwise a new thread starts in Balanced.
:::

## How a decision is made

For each tool call, the broker walks these steps in order. The first step that gives a final answer wins.

1. **Hard prohibitions.** Deny, and log it. These cannot be configured (see [Security for owners](/security/)). One of them is trading and moving money: see [Trades and transfers are never allowed](#trades-and-transfers-are-never-allowed).
2. **Your deny rules**, folder grants and blocked paths. Deny.
3. **Hooks.** A hook can deny or ask, never allow. A hook that changes the arguments sends the call back to step 1.
4. **Taint.** If this turn read untrusted content, an allow can become an ask, never the reverse. See [Untrusted content and taint](/security/taint).
5. **Standing grants.** Allow when a live grant matches. A "once" approval matches only the exact arguments it was given for, and is used up.
6. **The mode's default** from the table above.
7. **The rules classifier**, in Auto mode only, for the writes left over.

"Ask" puts an approval card in front of you and parks that action. Work that runs while nobody is watching, such as an automation, sets the action aside and carries on without it. The waiting actions are announced by one digest notice rather than one per action. Approving a set-aside action runs the automation again; the action goes ahead once, and only if that run reaches exactly the same action (the same binding). If it doesn't, nothing is done and you get a notice, as you do when the approval runs out first, the automation is paused or removed, or Psyche restarts before the run. A paused or removed automation can't be approved at all. An action that expires is shown as expired and is never run late.

Only the broker's routine class can be approved in bulk, and the Gateway checks every card in a bulk answer again. Routine means a plain local file or git write that asked only because of your mode: not tainted, not a payment, not device-only and not for someone else, and only for documents and data. That is an allowlist: Markdown, text, CSV, PDF, Office files and pictures, never in a hidden folder (`.claude`, `.config`, `.vscode`, `.github`…), a package, tool, skill or prompt folder (`node_modules`, `venv`, `bin`, `Library`, `skills`, `prompts`) or an app bundle, and never JSON or YAML, a config, script, Dockerfile, Makefile, pip requirements file or agent instruction file (`AGENTS.md`, `CLAUDE.md`, `SKILL.md`…). A commit is routine only for an explicit list of such files (never `.`, a folder or a pattern); switching branches never is. A write to one of these documents never leaves it executable. Paths are compared after Unicode folding, and any non-ASCII name is not routine. Everything else, including anything the action classifier, a taint rule, a prohibition or your own ask rules flagged, keeps its full card and needs its own tap.

Every decision is written to the audit log with the rule that decided it.

**Read-only commands on the Mac** do not ask. `ls`, `cat` and similar commands, and the read-only `git` subcommands (`status`, `diff`, `log`), run without a card outside Manual mode, on a turn that has not read untrusted content, when the sandbox (srt) is set up. They run with no network and no environment, in a sandbox that can write only to a scratch folder, for at most 15 seconds, and each run is audited. Any other command on the Mac asks every time. The owner can make read-only commands ask too with `exec.readOnlyWithoutAsking` (see [Settings reference](/reference/settings)).

## Standing grants and scopes

When you approve a card you choose a scope. Only "Allow once" is single use; the others create a standing grant.

| Scope | Covers | Lasts (default) |
| --- | --- | --- |
| once | This exact call with these exact arguments | Until it runs, at most until the card expires |
| task | The same kind of action on the same target, inside this task | Until the task ends; at most 24 hours, 8 hours for destructive actions |
| site | One website | 30 days |
| session | The same kind of action on the same target | Until the Gateway restarts, after 12 hours idle, or 24 hours at most |
| always | The same kind of action on the same target | 90 days, or until you revoke it |

Some actions limit the scopes on offer. Destructive actions offer only once or task. Financial actions offer only once. Credential fills offer once, or site if you opt in. Pairing, permission changes, skill installs and scripts offer only once. Answers from a chat app are always once.

A grant is bound to a grant key, not to free text. For an email that key is the account plus the exact recipient set; for a command run on the Mac it is the exact argv, working directory, executable and environment. A grant for an MCP tool includes a hash of the server's tool list, so a server that changes its tools loses its grants.

Defaults can be changed in the `grants` section of the `permissions.policy` setting. See [Settings reference](/reference/settings).

## See and revoke grants

1. Open Settings → Permissions → Grants ledger. Each grant shows its scope, expiry, number of uses and last use.
2. Click Revoke next to a grant. Revoking takes effect at once.

Revoking a device (Settings → Devices & nodes, or `psyche devices revoke <id>`) also ends every grant approved from that device. Revoking needs a device paired as admin.

A restored backup never brings revoked grants back; see [Backups](/security/backups).

::: info Screenshot placeholder
Settings → Permissions → Grants ledger, with one "site" grant for a travel site showing its expiry, 37 uses and a Revoke button.
:::

## Trusted sites

On the card for the first read of a site in Balanced mode, **Always for this site** adds that site to Settings → Permissions → Trusted sites. From then on, reads of that site (opening a page, taking a snapshot, reading page text, a GET fetch) don't ask, in any chat. You can also choose **this site and its subdomains**.

A trusted site is exact: the scheme, host and port must all match, so `http://` or another port, a subdomain (unless you chose subdomains), the parent domain and look-alike or punycode names all still ask. Names are compared in lowercase punycode with a trailing dot removed. IP addresses, `localhost`, bare host names, brokerage and bank hosts, hosts shared by many tenants (`s3.amazonaws.com`, `storage.googleapis.com`) and public suffixes from the Public Suffix List, including its private section (`co.uk`, `github.io`, `run.app`), can't be trusted, so a subdomain choice never covers one. A subdomain choice also covers only subdomains that pass the same checks: `google.com` with subdomains covers `news.google.com` but not `docs.google.com`, `drive.google.com`, `script.google.com` or `pay.google.com`, and `amazonaws.com` does not cover a `s3.amazonaws.com` bucket. Names with no public suffix (`.local`, `.lan`, `.internal`) and request catchers or tunnels (`webhook.site`, `ngrok`, `pastebin.com`) can't be trusted either.

A trusted site still asks when:

- it is on the sensitive-site list (banks, health, email, password managers, and any optional category you turned on);
- the turn has read untrusted content (see [taint](/security/taint)), which keeps the usual rules;
- the action is not a read: writes, forms, submits, downloads, filling a login and payments follow the usual rules, and a hard-blocked venue (a brokerage, exchange or bank) stays blocked for anything but a read;
- the thread is in Manual mode. Auto keeps its own rules.

Remove a site in Settings → Permissions → Trusted sites, or revoke it from the grants ledger. Entries expire like other "always" grants (90 days by default, the `alwaysExpiryDays` setting).

## Folders, sites, apps and connectors

The same policy holds your other choices:

- **Folders.** Settings → File access lists the folders the agent may read (`ro`) or read and write (`rw`). Even inside a shared folder, Psyche's own state, credential stores and `~/.ssh` stay out of reach.
- **Sites.** Per-site allow, ask or deny rules, and the sensitive-site list.
- **Apps.** Computer-use tiers per app. See [Approvals and tiers](/security/approvals-and-tiers).
- **Connectors.** Per-connector actions, for example Gmail read allowed, send ask, Drive write denied.

Changing any of these needs an admin device and, once you have added a presence verifier (a passkey, or a Windows Hello key), a tap on the card. The Mac helper's own key does not count as one, so on a Mac with neither, an admin device alone is enough and no card appears.

## Learn more

- [Approvals and tiers](/security/approvals-and-tiers)
- [Untrusted content and taint](/security/taint)
- [Approvals guide](/guides/approvals)
- [Settings reference](/reference/settings)
- [docs/05 §3, permission model](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#3-permission-model-specification)
- [packages/permissions](https://github.com/devmello/psyche/tree/main/packages/permissions)

## Trades and transfers are never allowed

Payments and trades are different things. A purchase (a checkout, a bill on the utility's own site, a Stripe Link spend) asks for your approval with Touch ID or your Mac password. Psyche refuses these in every mode, and no approval changes that, so the card never appears:

- buying or selling stocks, funds or crypto, or swapping tokens;
- moving money between bank accounts, wires, and withdrawals from a brokerage or exchange;
- sending money or crypto to a person (Venmo, Cash App, Zelle, a wallet address).

It tells you to do it yourself. This applies to the browser, to computer use, to MCP tools and to Stripe Link purchases: Link never pays on a brokerage, exchange, bank or payments app. It does not use a model: Psyche looks at the site or app (a brokerage, exchange, bank or payments service, by its real domain) and at what the control says, in any of the ten languages. A look-alike such as `robinhood.com.evil.test` is not treated as Robinhood, and a real bank subdomain is. Reading a balance or your transactions is fine. Banks that also run a brokerage count for trades too: "Buy" on a bank site is refused like "Buy" at a brokerage. Sign-in codes ("Send code") and menus such as "Pay & transfer" are not trades.

## What Psyche never sends out

What Psyche writes to another person goes through a check that runs outside the model. It withholds:

- credentials: private keys, API keys, bearer tokens, JWTs and passwords in URLs;
- card numbers, and a card's CVV or expiry written next to one;
- bank accounts: IBANs, and a US routing number written next to a labeled account number;
- government IDs: US Social Security, Canada SIN, UK National Insurance, India Aadhaar and passport numbers, each with its label ("SIN:", "passport number");
- one-time codes, password-reset codes included ("your verification code is 482913"), because a reset code takes over an account.

Cards in a message are found by their number shape: 13 to 19 digits with a valid checksum and the prefix of a card network (Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay, Maestro, RuPay, Mir, Troy, UATP), grouped the way cards are and joined by one separator: spaces, dashes, dots, bullets or colons. A card number split by newlines, slashes, bullets in a list, or table pipes is caught only when a card word ("card", "Visa", "Amex"…) is within 40 characters of it, so a column of numbers, a table or a grid is not a card. The other values need a checksum or a context word, so order numbers, tracking numbers, phone numbers, prices, dates, ZIP codes, hashes and UUIDs pass through. Digits in other scripts (Arabic-Indic, Persian, Devanagari and the rest), keycap digits and zero-width characters are read the same as ordinary digits.

**Where it runs.**

- Every message the channel service sends (Telegram, iMessage, Discord, Slack, SMS, WhatsApp, Signal, WebChat, email replies and the approval cards in chat) goes through the full check. When one message ends with part of a number and the next one to the same chat, within a minute, carries on with it ("my card is 4111 1111", then "1111 1111"), the two parts are read as one number.
- The `messages_send` tool and other email or message tools use the same check before anything is approved. A credential, a card, an IBAN or a Social Security number, as the strict reading below finds it, is refused outright; a card shape only the message reading finds (rows of numbers aligned with two spaces, say) asks on a paired device instead. The other kinds (a one-time code, a passport, SIN, NI or Aadhaar number, a routing and account number) ask on a paired device, once, so you can still send your own accountant your routing number.
- Other tool calls, such as file writes, MCP servers and browser forms, get a stricter reading for credentials, card numbers, IBANs and Social Security numbers. There a card is 13 to 19 digits split only by a single space, dot or dash, with a valid checksum and no network check, so no card network is missed and a list of ports or a grid of numbers in a file is never taken for a card.

**What happens.**

- In your own one-to-one chat (Telegram, iMessage, Discord, Slack, SMS, WebChat) the value is cut out and the reply says to open Psyche to see it, in your language. A one-time code is allowed there, since it goes to you. A card, a bank number, an ID and any credential are still cut out, because the chat service stores them.
- A message to anyone else, to a group (including one you are in), or any email reply is held: it is not sent, the conversation gets a note telling Psyche why, and you get a notice in Psyche that opens the conversation. Email is always held, even to your own address, because a `From:` address is not verified.
- The audit log records the decision and the kinds of value, never the value. Published test card numbers are not exempt here.

**What it cannot see.** Digits spelled out as words, base64 or other encodings, reversed digits, separators made of letters, and a card in irregular groups (say 3, 5, 4 and 4 digits) get through. This is a guard against a model that mixes up what is private, not against a model that is working to hide it.

