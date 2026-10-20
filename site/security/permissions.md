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
| Balanced | The first read of each new source asks; sensitive sites always ask | Standing grants apply; otherwise ask | Ask, once or for this task | Ask, once only, on your device |
| Auto | New ordinary sites are read without asking, unless the turn is tainted or the site is sensitive | Inside your grants, a classifier decides: routine runs, sensitive asks, prohibited is denied | Ask, once or for this task | Ask, once only, on your device |

A "new source" is a site, connector account, folder, app or MCP server the task has not touched yet. "Sensitive sites" is a built-in, editable list of banking, brokerage, government, health, password-manager, sign-in and webmail hosts.

Change a thread's mode from the mode menu in the chat header. Auto mode is offered only when the thread uses a model on the auto-mode allowlist; the Gateway refuses `auto` otherwise and drops an `auto` thread to Balanced if you switch to a model that is not on the list. Local models are not on the list by default.

The Auto classifier sees only your own recent messages, the task's title, the tool name and the action's metadata. It never sees page text, screenshots, tool results or memory. If it is slow, unavailable or unsure, it answers "sensitive", so the broker asks.

::: warning Not applied yet
`defaultMode` in the permission policy, and the "Default mode for new threads" choice in Settings → Permissions, are saved but not applied. New threads start in Balanced.
:::

## How a decision is made

For each tool call, the broker walks these steps in order. The first step that gives a final answer wins.

1. **Hard prohibitions.** Deny, and log it. These cannot be configured (see [Security for owners](/security/)).
2. **Your deny rules**, folder grants and blocked paths. Deny.
3. **Hooks.** A hook can deny or ask, never allow. A hook that changes the arguments sends the call back to step 1.
4. **Taint.** If this turn read untrusted content, an allow can become an ask, never the reverse. See [Untrusted content and taint](/security/taint).
5. **Standing grants.** Allow when a live grant matches. A "once" approval matches only the exact arguments it was given for, and is used up.
6. **The mode's default** from the table above.
7. **The classifier**, in Auto mode only, for the writes left over.

"Ask" puts an approval card in front of you and parks that action. Work that runs while nobody is watching, such as an automation, sets the action aside under Deferred, notifies you, and carries on without it.

Every decision is written to the audit log with the rule that decided it.

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

## Folders, sites, apps and connectors

The same policy holds your other choices:

- **Folders.** Settings → File access lists the folders the agent may read (`ro`) or read and write (`rw`). Even inside a shared folder, Psyche's own state, credential stores and `~/.ssh` stay out of reach.
- **Sites.** Per-site allow, ask or deny rules, and the sensitive-site list.
- **Apps.** Computer-use tiers per app. See [Approvals and tiers](/security/approvals-and-tiers).
- **Connectors.** Per-connector actions, for example Gmail read allowed, send ask, Drive write denied.

Changing any of these needs an admin device and, once a passkey or the helper's Touch ID key is registered, fresh proof that you are present.

## Learn more

- [Approvals and tiers](/security/approvals-and-tiers)
- [Untrusted content and taint](/security/taint)
- [Approvals guide](/guides/approvals)
- [Settings reference](/reference/settings)
- [docs/05 §3, permission model](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#3-permission-model-specification)
- [packages/permissions](https://github.com/devmello/psyche/tree/main/packages/permissions)
