---
title: Credentials and payments
---

# Credentials and payments

::: v-pre
Psyche keeps passwords, API keys and other secrets in an encrypted vault on the machine that runs the Gateway. The agent never sees a secret: it works with a placeholder such as `{{cred:github}}`, and the real value is filled in at the last step, only on the site it is bound to, after you approve. Card numbers are never stored; payments are meant to go through Stripe Link instead. This page says plainly which parts work today, because several do not yet.
:::

## Turn it on

The vault is created during onboarding, when you save your model provider's API key. Psyche shows a **recovery key** once. Write it down and keep it somewhere safe: with the vault's key slot lost, the recovery key is the only way back in.

On builds that are not signed with the project's keys, the vault key lives in a key file on disk. Settings → Credentials says what protects the vault ("Vault protected by: …"). See [Key storage](/security/key-storage).

If you skipped onboarding's model step, or run the Gateway with `PSYCHE_MODEL` set, the vault may not exist yet: there is no setup button in Settings and no `psyche vault setup` command.

## What it can do

### Store credentials

Open Settings → Credentials. It lists each item with its Name, Kind, what it is Bound to, when it was Last used and how many Uses it has. "Values are never shown, not even here."

- **Kinds:** login, API key, OAuth token, SSH key, secure note, and payment and signing keys used by Psyche itself.
- **Bindings:** a login is bound to one or more sites, an API key to a host. A value is only ever filled on a site or host it is bound to.
- **Refused:** card numbers, CVVs, bank account numbers and government ID numbers. Psyche will not store them.
- **Import:** "More ways to add" → "Import a CSV export" takes a CSV from 1Password, Bitwarden or Chrome, up to 10 MB. Delete the CSV afterwards; it holds every password in plain text.
- **Recent uses:** open an item to see when, where and by which task it was used, and the outcome.

From the CLI, on the machine that runs the Gateway:

```bash
psyche vault status
psyche vault list
psyche vault add "GitHub token" --kind api_key --bind api.github.com --header Authorization --prefix "Bearer "
psyche vault add "Example login" --kind login --username me@example.com --bind https://example.com
psyche vault import ~/Downloads/passwords.csv --format 1password
psyche vault lock
psyche vault unlock --recovery
```

::: v-pre
`vault add` reads the secret from a hidden prompt (or stdin with `--secret-stdin`) and prints the placeholder to use, `{{cred:<slug>}}`. Pick the slug yourself with `--slug`. `--require-auth` asks for your presence on every use.
:::

### Placeholders and fills

::: v-pre
The agent refers to a credential only as `{{cred:<slug>}}`, or `{{cred:<slug>.<field>}}` for one field. The placeholder is resolved outside the model, by the part of Psyche that does the work:
:::

- **Browser:** typed into the focused field, only if the page's site matches a binding, and only over https (plain http is allowed only for local dev servers). The value is masked afterwards.
- **MCP servers:** an API key can be the server's bearer token, or an environment variable for a local server. Each use asks.
- **Sandbox commands:** passed as an environment variable for one command, never on the command line.

Even so, the first choice for a login is to type it yourself: click **Take control** in the Browser pane, sign in, then **Return control** (see [Browser](/using/browser)).

### 1Password

Settings → Credentials has "Connect 1Password" under "More ways to add". Linked 1Password items are read only in Psyche. Setting up the link needs a `credentials.onePassword` entry in the Gateway's `config.json` and a 1Password token stored in the vault; there is no guided setup yet. Alternatively, use real Chrome mode with the 1Password extension, so 1Password fills logins itself (see [Browser](/using/browser)).

### Stripe Link payments

Psyche never stores a card. Payments are designed to go through your Stripe Link wallet: the agent prepares a spend request with the merchant, items and total, you approve it on a purchase card and in Link, and a one-time card or token completes checkout.

Set it up in Settings → Credentials → **Payments**; no environment variable is needed:

1. **Install the Link CLI.** Until Psyche finds it, the panel says "Install the Link command-line tool" and shows the command to run on the Mac that runs the Gateway: `npm install -g @stripe/link-cli`. Then choose **Check again**. Link payments for agents are available in the US and Canada.
2. **Connect it.** Psyche looks in the usual npm and Homebrew places. It runs a program only if the file is a real file (not a link) owned by you or root, that other users can't write to, in folders that other users can't write to either; otherwise the panel says which of these failed. Choose **Connect** next to the copy you installed, and approve the card. Psyche checks the file again before every run, so a program that is swapped out later is not run.
3. **Sign in on Link's page.** Choose **Sign in with Link**. Psyche shows a link to Link's own page and a short phrase: open the page, check that it shows the same phrase, and approve. You type your Link password there, never in Psyche, and Psyche never sees it. The sign-in is saved in `vault/link-auth.json` inside the Gateway's data folder, readable only by you.
4. **Connected.** The panel shows your wallet's payment methods and recent payments. Payments switch on right away, with no restart.

**Disconnect** signs out of Link, deletes the saved sign-in and forgets the CLI path. Your Link account and cards are not touched.

Setting `PSYCHE_LINK_CLI` on the Gateway still works as a developer override and takes priority over the saved path. Changing the path is a security change, so the Gateway asks you to approve it and records it in the audit log.

### Travel holds

The design covers finding a cheaper flight, holding it behind one purchase card, ticketing it behind a second, and cancelling for a refund inside the free window, with an itinerary card in chat. The `travel-hold` skill covers browsing up to the booking step.

## What it asks you

- **Filling a credential:** a device-only "Fill credential" card showing the item, the site it is bound to and the current page, with a note that the agent sees only the placeholder. Choices: Allow once, or Allow for this site.
- **Paying:** a device-only "Pay" card with the merchant, amount and items, offered only as Allow once.
- Both need proof that you are present: Touch ID on the Mac, or a passkey in the web client. They never go to Telegram or iMessage.

## Limits today

- **Approving fills and payments on the Mac does not work yet.** Touch ID approvals need Psyche Helper's key registered with the Gateway, and no screen or command registers it yet, so these cards can be denied but not approved in the desktop app. In the web client over https, with a passkey added in Settings → Devices & nodes, they can be approved (see [Server mode](/guides/server-mode)).
- **Payments are not usable end to end.** The agent has no purchase tool in the Gateway, and holds, captures and refunds through Link are exercised only by the test scenarios, in Link's test mode. Settings shows your Link wallet read only.
- **Travel booking is not available.** The hold, ticket and cancel tools exist only in the test scenarios, against made-up airlines.
- There is no button to set up the vault outside onboarding, and confirming that you saved the recovery key later is not possible.
- "Where credentials are kept" and "Fill default" in Settings are saved but not used yet. "Move to Keychain" is disabled on unsigned builds.
- Bitwarden and the system keychain as credential stores are not available.

## Learn more

- [Key storage](/security/key-storage)
- [Approvals and tiers](/security/approvals-and-tiers)
- [Approvals guide: device-only approvals](/guides/approvals)
- [Release notes 0.3](/release-notes/0.3)
- [Credential Broker in the security design](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#4-credential-broker-specification)
- [Vault package](https://github.com/devmello/psyche/tree/main/packages/vault)
