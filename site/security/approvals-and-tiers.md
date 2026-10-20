---
title: Approvals and tiers
---

# Approvals and tiers

When the Permission Broker answers "ask", you get an approval card. The card is a capability, not a chat message: it is bound to the exact action, it expires, and only you can answer it from a surface you own. This page covers what a card must show, which approvals only your own devices can answer, approving from a chat app, expiry, and the per-app tiers that limit computer use. For the step-by-step owner guide, see [Approvals](/guides/approvals).

## The approval card

Cards appear in a dock above the composer, never inside the conversation, so text in the chat cannot imitate one. They also appear in the agent sheet (Approvals, or ⇧⌘P) and, when Psyche Helper is running, as macOS notifications.

Every card must show:

- the kind of action and its side-effect class, for example `Send email · destructive`;
- the full arguments for that kind of action, never truncated: recipients, subject and body for an email; the command, working directory and environment names for a command; the path and diff for a file write; merchant, amount and items for a purchase; the item, the site it is bound to and the current page for a credential fill;
- who asked: your agent, and the task when there is one;
- why it asked: the rule, the mode, the class, and "this turn read untrusted content" when that applies;
- the scopes you may choose, with Deny selected when the card appears;
- a short binding hash. The card is bound to these exact arguments. If the agent changes anything, the card is void and a new one is needed.

Cards are built from the structured arguments of the call, never from text the agent wrote. In chat apps every value is sanitized: line breaks show as `⏎`, hidden characters as `⟨U+XXXX⟩`, and international domain names in punycode.

The Allow buttons arm 400 ms after the card appears, so a stray click cannot approve it. Return never approves.

::: info Screenshot placeholder
An approval card for "Send email · destructive after reading untrusted content", with To, Subject, the Body behind View, the binding hash and the Deny / Allow with scope buttons.
:::

## Approvals only your devices can answer

Some approvals are never sent to a chat app. They can be answered only in the desktop app or the web client of a paired device with the `operator.approvals` scope:

- every destructive action, such as sending an email or submitting a form;
- every financial action and every purchase;
- credential fills;
- running a command directly on the Mac (`exec_host`, which is off by default);
- pairing a device and changing a security setting;
- installing a skill;
- running an AppleScript or JXA script against an app.

Of these, purchases, credential fills, commands on the Mac, pairing, security settings and scripts also need proof that you are present: Touch ID through Psyche Helper, or a passkey in the web client. Deny always works without it.

- **Passkeys.** In the web client at the server's HTTPS address, add one in Settings → Devices & nodes → Passkeys. See [server mode](/guides/server-mode).
- **Touch ID.** The Gateway verifies Touch ID answers signed by the helper's presence key once that key is registered for the helper's device from an admin device (`devices.presenceKey.register`). There is no button for this in the app or the CLI yet.

Without a registered Touch ID key or passkey, approvals for purchases, credential fills, commands on the Mac and scripts are refused rather than accepted unverified, and security settings need only an admin device. Once a verifier is registered, security settings need it too, and losing every verifier makes those calls fail with `presence_required` instead of falling back to admin alone. `psyched presence reset` on the machine clears that state.

## Approving from a chat app

If the agent can reach you on Telegram, cards that are not device-only are sent there too. In practice that means write-class actions such as a calendar change or a draft.

- Only your own owner identity can answer. Someone the agent merely talks to cannot.
- Answers from chat are always "Allow once".
- A card that does not fit in one message says "Open on your Mac to review." and cannot be answered from chat.
- The first answer on any surface wins. Later answers are refused and logged as late or replayed.

Chat is a weaker surface than a device: the platform controls who the sender is, and a stolen phone can answer silently. That is why money, credentials and anything irreversible stay on your devices.

## Expiry and restarts

- A card expires 30 minutes after it is issued. Expiry means deny. The task stays resumable.
- If the Gateway restarts, pending cards become out of date. The Gateway checks the parked action against your policy again and issues a fresh card with new answer tokens. An approved "once" card that had not been used yet is revoked at restart.
- Each surface gets its own single-use answer token. A copied button or a replayed answer does nothing.

## Computer-use tiers

Computer use lets the agent see and drive apps on your Mac through Psyche Helper. It is off until you turn it on in Settings → Computer use. Then each app has a tier:

| Tier | The agent may |
| --- | --- |
| Off | Nothing |
| Read only | Take accessibility snapshots and screenshots |
| Click | Also click, but not type, press keys or use menus |
| Read and interact | Also type, press keys, use menus and drag |

You are asked the first time the agent wants an app. The approved app and tier travel with every action, and both the Gateway and the helper check them against the element or point actually being acted on.

### Fixed caps

Some caps hold whatever you choose, and cannot be raised from chat:

- **Browsers** are read only. The agent's own browser is how it acts on the web.
- **Terminals and IDEs** are click only.
- **Password managers, Keychain Access, banking, trading and payment apps** are off.
- **System Settings, Notification Center, login and authentication dialogs**, and Psyche's own windows are off, so the agent cannot press Approve on its own cards.

### Other limits

- Menu commands need Read and interact, even in a click-only app.
- Return, ⌘Return and similar send keys in Messages and Mail count as a send and get a send card.
- Secure text fields are refused below the model, at the accessibility layer.
- Psyche's windows are hidden from screenshots.
- A global Esc stops computer use, and content cannot dismiss it.
- Only one session drives the computer at a time.
- In messaging and mail apps, an action with no input from you for 5 minutes always gets a card labelled "While you're away", so an unattended task waits for you.
- Scripts run out of process and may only drive their target app.

Your choices are layered over the `apps` section of the permission policy. `psyche security audit` flags any override on banking, password-manager, browser or terminal apps.

::: info Screenshot placeholder
Settings → Computer use with the master switch on, a list of apps with tier pickers, and Terminal shown as "Click only (fixed)".
:::

## Learn more

- [Approvals guide](/guides/approvals)
- [Permissions](/security/permissions)
- [Computer use](/using/computer-use)
- [docs/05 §3.7, approval requests](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#37-approval-requests-delivery-expiry-restart-answers)
- [docs/05 §12, macOS specifics](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#12-macos-specifics)
- [packages/permissions/src/kinds.ts](https://github.com/devmello/psyche/blob/main/packages/permissions/src/kinds.ts)
