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

If you skipped onboarding's model step, or run the Gateway with `PSYCHE_MODEL` set, the vault may not exist yet. Settings → Credentials then shows a setup panel that creates it and shows the recovery key once. Setting up the vault asks for neither Touch ID nor a password.

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

Settings → Credentials has a **1Password** panel that walks you through it, from an administrator device. Psyche reads the items you link through the 1Password command-line tool (`op`), signed in by the 1Password app. It stores no 1Password password or token, and 1Password shows its own unlock prompt when it needs one. Linked items are read only.

1. **Install `op`.** The panel shows `brew install --cask 1password-cli` and a link to 1Password's guide. Choose **Check again** afterwards. Psyche runs `op` only if it is a real file owned by you or root that other users can't write, in folders other users can't write, outside Psyche's own data folder, and (on a Mac) signed by 1Password. Opening the panel runs nothing: choose **Check** to ask 1Password where things stand. Once you connect, Psyche pins that exact file and refuses a different one ("the 1Password CLI changed") until you check again.
2. **Turn on the app integration.** In the 1Password app, open Settings, choose Developer, and turn on **Integrate with 1Password CLI**.
3. **Unlock 1Password.** If the panel says it is locked, unlock the app and approve the request if it asks.
4. **Use 1Password in Psyche.** Once the panel shows your account, choose **Use 1Password in Psyche**. It takes effect at once. **Test connection** lists your vaults and shows only how many there are; it never reads an item. **Disconnect** stops Psyche reading 1Password; items you already linked stay, and answer "unavailable" until you connect again.

If the Gateway's `config.json` has a `credentials.onePassword` entry (a service-account token in the vault, or a Connect server), that wins and the panel says so. Alternatively, use real Chrome mode with the 1Password extension, so 1Password fills logins itself (see [Browser](/using/browser)).

### Stripe Link payments

Psyche never stores a card. Payments are designed to go through your Stripe Link wallet: the agent prepares a spend request with the merchant, items and total, you approve it on a purchase card and in Link, and a one-time card or token completes checkout.

Set it up in Settings → Credentials → **Payments**; no environment variable is needed:

1. **Install the Link CLI.** Until Psyche finds it, the panel says "Install the Link command-line tool" and shows the command to run on the Mac that runs the Gateway: `npm install -g @stripe/link-cli`. Then choose **Check again**. Link payments for agents are available in the US and Canada.
2. **Connect it.** Psyche looks in the usual npm and Homebrew places. It runs a program only if the file is a real file (not a link) owned by you or root, that other users can't write to, in folders that other users can't write to either, outside Psyche's own data folder (however its path is spelled). It must be the Link CLI's own script (a `.js`, `.mjs` or `.cjs` file inside the `@stripe/link-cli` package), or an npm or pnpm shim that starts it; any other program, a shell included, is refused. Volta's shim is refused too: point Psyche at the Link CLI's own folder under Volta, or install it with npm. Otherwise the panel says which of these failed. Choose **Connect** next to the copy you installed, and approve the card. Psyche checks the file again before every run, so a program that is swapped out later is not run.
3. **Sign in on Link's page.** Choose **Sign in with Link**. Psyche shows a link to Link's own page and a short phrase: open the page, check that it shows the same phrase, and approve. You type your Link password there, never in Psyche, and Psyche never sees it. Psyche asks Link for payments only, not for your balances or transactions. The page always opens in your system browser, never in Psyche's own browser. The sign-in is saved in `vault/link-auth.json` inside the Gateway's data folder, readable only by you. It is not included in backups, so after restoring one you sign in to Link again.
4. **Connected.** The panel shows your wallet's payment methods and recent payments. Payments switch on right away, with no restart.

**Disconnect** signs out of Link, deletes the saved sign-in and forgets the CLI path. Your Link account and cards are not touched. Signing out at Link is best effort: if the CLI can't run (it was moved or changed), Psyche still deletes its own copy and forgets the path, and the audit log notes that the sign-out was skipped; you can end the session in the Link app. Disconnecting is refused while a payment is still in progress, so it can't be left half done. The panel then names the payment and offers **Disconnect anyway**: Psyche cancels it where Link allows, forgets it, and records that in the audit log. A hold at the merchant lapses on its own, and Psyche can no longer report it. If the sign-in output has no phrase to compare, Psyche does not start the sign-in.

Setting `PSYCHE_LINK_CLI` on the Gateway still works as a developer override and takes priority over the saved path. Changing the path is a security change, so the Gateway asks you to approve it and records it in the audit log.

### Travel holds

The design covers finding a cheaper flight, holding it behind one purchase card, ticketing it behind a second, and cancelling for a refund inside the free window, with an itinerary card in chat. The `travel-hold` skill covers browsing up to the booking step.

## What it asks you

- **Filling a credential:** a device-only "Fill credential" card showing the item, the site it is bound to and the current page, with a note that the agent sees only the placeholder. Choices: Allow once, or Allow for this site.
- **Paying:** a device-only "Pay" card with the merchant, amount and items, offered only as Allow once.
- The Pay card needs proof that you are present: Touch ID on the Mac, or a passkey in the web client. A Fill credential card is one tap on a paired device, and the Mac must be unlocked. Neither card goes anywhere but your own devices.

## Limits today

- **Paying works only in the open checkout tab of Psyche's own browser, and only with Stripe Link set up.** The agent has a `checkout.pay_with_link` tool once Stripe Link is connected in Settings → Credentials → Payments, and loses it when you disconnect; with no Link set up, it is not offered and no Pay card can appear. It reads the merchant, items and total from the page, shows them on a device-only Pay card (Allow once), and only after you approve does it ask Link for a one-time card, capped to that merchant and amount. If the total, items or site change after you approve, it stops. The agent never sees the card number, expiry or security code: they go from a private file straight into the card fields, and only the brand and last four reach the chat, the receipt and the log. One approval pays once. Card fields inside a payment iframe (for example Stripe Elements) are not filled yet, and Link agent payments are limited to the US and Canada. Where Psyche cannot read the items on a checkout page (it reads tables best), the Pay card says "items not checked on this page" and only the merchant and total are bound. Totals written in an ambiguous style (for example `12,50 €`, `1.299,00 €` or `1 234.00`), in a dollar other than US, Canadian or Australian (`HK$`, `NZ$`, `R$`, `HK $`), negative, or with two currencies that disagree anywhere on the total line are refused rather than guessed. A bare `$` is read as US dollars, and the Pay card always names the currency (`US$12.00`). If the tab closes or the page stops answering after you pay, or Psyche restarts mid-payment, the payment is recorded as unconfirmed and the Link card is cancelled. If the page does not confirm the order after you pay, Psyche cancels the Link request, tells the agent not to pay again and leaves you to check the merchant's order page.
- **Touch ID approvals on the Mac use Psyche Helper's own key,** which is registered automatically when the helper pairs. In the web client over https, a passkey added in Settings → Devices & nodes works too (see [Server mode](/guides/server-mode)).
- **Holds, captures and refunds through Link are exercised only by the test scenarios,** in Link's test mode. Settings shows your Link wallet read only.
- **Travel booking is not available.** The hold, ticket and cancel tools exist only in the test scenarios, against made-up airlines.
- "Move to Keychain" is disabled on unsigned builds.
- Bitwarden and the system keychain as credential stores are not available.

## Learn more

- [Key storage](/security/key-storage)
- [Approvals and tiers](/security/approvals-and-tiers)
- [Approvals guide: device-only approvals](/guides/approvals)
- [Release notes 0.3](/release-notes/0.3)
- [Credential Broker in the security design](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#4-credential-broker-specification)
- [Vault package](https://github.com/devmello/psyche/tree/main/packages/vault)
