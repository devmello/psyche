---
title: Using Psyche
---

# Using Psyche

These pages explain what you can do with Psyche once it is running, and what it asks you before it acts. Each page ends with what does not work yet. Psyche is alpha software: the pages describe the code as it is today, not the design. If you have not installed Psyche yet, start with [Get started](/get-started/).

Every page assumes two things. The agent asks before anything that matters, on an approval card you answer (see [Approvals and tiers](/security/approvals-and-tiers)). And the agent keeps a receipt for everything it does, which you find in Activity.

## Talking to your agent

**[Chat](/using/chat).** One main conversation that never ends, side chats for scoped work, the composer, slash commands, attachments and picking a model.

**[Memory](/using/memory).** The agent's persona and memory are Markdown files you can read and edit: `SOUL.md`, `USER.md`, `AGENTS.md`, `MEMORY.md` and daily notes. How to pause memory, reset it, and what incognito and dreaming do today.

**[Dictation](/using/dictation).** Hold a key and speak into any app on your Mac. Dictated text goes into the app you are typing in, never to the agent.

## Work that keeps going

**[Tasks and automations](/using/tasks-and-automations).** Background Tasks that outlive the window, schedules that run unattended, and the approvals queue where an unattended run leaves what it could not ask you live.

**[Feed, Ideas and Goals](/using/feed-ideas-goals).** The proactive side: a daily brief, suggestions mined from what you do, and goals with check-ins. Nothing is created without your confirmation.

## Files, the web and your accounts

**[Documents and files](/using/documents-and-files).** The Library, the Files pane and its viewers, and converting documents in the sandbox.

**[Browser](/using/browser).** The agent's own browser, which you can watch and take over. Site approvals, logged-in and logged-out browsing, and real Chrome mode.

**[Connectors](/using/connectors).** MCP servers, which you can add today, and Google, other mail and shopping, which you cannot connect yet.

**[Channels](/using/channels).** Talk to the agent from Telegram or iMessage: pairing, the owner identity and groups. Both channels are built, but cannot be created from the app yet.

**[Credentials and payments](/using/credentials-and-payments).** The vault, placeholders the model sees instead of secrets, credential fills, 1Password, and how far Stripe Link payments and travel holds go today.

## Your Mac and your code

**[Computer use](/using/computer-use).** The agent can use apps on your Mac within per-app tiers you set. Press Esc to stop it.

**[VM mode](/using/vm-mode).** Run the agent's work inside a sandbox Mac instead of your own. A preview: the pieces are built, but the sandbox Mac cannot be created from the app yet.

**[Coding](/using/coding).** The coding helper opens a repository in a folder you shared, edits with a diff on the card, runs tests in the sandbox, and pushes only after you approve the exact commit.

**[Skills](/using/skills).** Bundled skills, installing a skill after reviewing it, and the `psyche skills` commands.

## Learn more

- [Get started](/get-started/)
- [Security overview](/security/)
- [Approvals guide](/guides/approvals)
- [Settings reference](/reference/settings)
- [CLI reference](/reference/cli)
- [Release notes](/release-notes/)
- [Feature specification](https://github.com/devmello/psyche/blob/main/docs/03-feature-spec.md)
