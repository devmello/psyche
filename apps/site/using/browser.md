---
title: Browser
---

# Browser

The agent has its own browser. In the desktop app it opens in the Browser pane beside the chat, where you watch every click and keystroke and can take over at any time. It is not your Safari or Chrome: it has its own profiles, it starts logged out, and it asks before it opens a site it has not been to in the task. For sites that need your sign-ins or extensions, there is real Chrome mode.

## Turn it on

There is nothing to turn on. Ask the agent to look something up, fill a form or compare prices, and it uses its browser. To watch, open the Browser pane with ⌘⇧B, or press ⌘K and choose "Open browser pane".

The Browser pane is in the desktop app only. The web client says the browser lives in the desktop app.

::: info Screenshot placeholder
The Browser pane beside the chat: a tab strip, the status pill reading "Typing in 'Preferred date'", the live page with the field outlined, and the Take control and Stop the task buttons.
:::

## What it can do

- **Read pages** through the page's accessibility tree, and take screenshots when the tree is too sparse.
- **Act on pages**: navigate, click, type, choose from menus, scroll, use the keyboard, manage tabs.
- **Show you what it does.** The status pill says what the agent is doing right now. The element it acts on is outlined for a moment.
- **Keep going when you close the pane.** Closing the pane hides it; the task keeps running. A toast says so ("Browser closed. Tasks keep running"). To end the work, click **Stop the task**.
- **Download files** into the Library, quarantined. A toast says "Downloaded … to Library → Downloads (quarantined)". Nothing opens by itself.
- **Preview your own dev server.** The agent can open a local dev server and read its console and network requests. Only servers Psyche started, ports in the project's launch configuration, and ports listed in `PSYCHE_DEV_PREVIEW_PORTS` are allowed. The first visit asks.

Other controls in the pane: **Open in window**, **Full**, **Find**, zoom, and **Clear browsing data**.

### Take control

Click **Take control** to use the page yourself, for example to sign in, solve a CAPTCHA or type something private. While you have control, the agent's input to the page is refused and the pill reads "Paused: you have control". Click **Return control**, or press Esc, to hand it back.

This is the recommended way to sign in. Psyche never types a password it can see, and it never attempts a CAPTCHA.

### Logged out and logged in

By default the agent browses **logged out**: each tab uses a clean profile with none of your cookies. A chip in the pane says which profile a tab uses: "logged-out profile" or "agent profile".

The agent profile keeps sign-ins you make in it (with Take control) across restarts. Which sites use it is set on the Gateway, not in Settings yet:

- `PSYCHE_BROWSER_PARTITION=auto` (the default) uses the agent profile only for sites listed in `PSYCHE_BROWSER_SIGNED_IN_ORIGINS`. That list starts empty, so everything is logged out.
- `PSYCHE_BROWSER_PARTITION=profile` always uses the agent profile.
- `PSYCHE_BROWSER_PARTITION=clean` never does.

### Real Chrome mode

Some sites need extensions, such as 1Password, or a real Chrome. Real Chrome mode runs Google Chrome with a separate profile that only the agent uses, never your own.

1. Open Settings → Browser and turn on **Let tasks use the Psyche profile**.
2. Click **Open the profile in Chrome**. Sign in to the sites you need and install 1Password there if you use it, then close Chrome. (This button is in the desktop app only.)
3. When a task wants real Chrome, it asks you first, every task, on a device-only card that needs Touch ID or a passkey.

While a task uses it, Psyche runs Chrome with that profile and a debugging port on `127.0.0.1` only, and closes it after 15 minutes idle. The agent does not attach while you have the profile open yourself. Google Chrome must be installed.

## What it asks you

- **A new site.** The first time a task wants to act on a site, you see "Let Psyche act on example.com?" (with your agent's name) with **Allow once**, **Always allow** or **Deny**. In chat, the same request is an "Open site" approval card. Always allow saves a site grant, listed in Settings → Permissions under Browser origins.
- **Redirects.** Every redirect and navigation is checked against the sites approved for the task. A redirect to a site you did not approve stops and asks.
- **Sensitive sites always ask**, even to read: banks, government sites, password managers, sign-in pages and webmail.
- **Submitting a form** asks, with the site and the fields on the card.
- **Paying** stops at a device-only "Pay" card with the merchant, the items and the total. See [Credentials and payments](/using/credentials-and-payments).
- **Filling a saved login** asks on a "Fill credential" card. "I'll type it myself", with Take control, is always the first choice.

Pages are untrusted content. Text on a page never becomes an instruction, and after the agent reads a page, sending or writing to something you did not name asks even if a grant would cover it. See [Untrusted content](/security/taint).

## Limits today

- The Browser pane is in the desktop app only. A Gateway on a server has no live browser view in the web client yet.
- Choosing logged-in or logged-out browsing per site is done with Gateway environment variables, not in Settings.
- Recordings of browsing are made only when the Gateway runs with `PSYCHE_BROWSER_RECORD=1`. They are listed in the Library, but there is no replay view in Activity yet, and the "Keep task replays for" setting in Data controls has no effect yet.
- There is no web search tool. The agent looks things up by opening pages in its browser.
- Loopback and private-network addresses are refused, except for an approved dev preview.
- Real Chrome mode's per-task card needs Touch ID or a passkey. Touch ID approvals cannot be approved in the desktop app yet, because nothing registers Psyche Helper's key with the Gateway; a passkey in the web client over https works. The same applies to credential fills and payments.

## Learn more

- [Approvals and tiers](/security/approvals-and-tiers)
- [Untrusted content](/security/taint)
- [Approvals guide](/guides/approvals)
- [Browser pane in the UI design](https://github.com/devmello/psyche/blob/main/docs/06-ui-design.md#35-browser-pane)
- [Browser security in the security design](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#6-browser-security)
- [Browser package](https://github.com/devmello/psyche/tree/main/packages/browser)
