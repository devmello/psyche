---
title: Chat
---

# Chat

You talk to your agent in one main conversation that continues across sessions, plus side chats for anything you want to keep apart. Replies stream in as the agent works. Approvals, questions, checklists, receipts and task cards arrive as their own blocks, never buried in prose. The same chat appears in the desktop app and in the web client, because both are windows onto your Gateway.

## Turn it on

Chat works once your Gateway has a model.

- **Desktop app.** Onboarding's "Model & provider" step stores your provider's API key in the vault and sets the primary model when you finish. After that, change models in Settings → Model & providers.
- **From source or on a server.** You can instead start the Gateway with `PSYCHE_MODEL` and the provider's key variable, as in [Getting started](/guides/getting-started). When `PSYCHE_MODEL` is set, the Gateway reads keys only from its environment and will not store one in the vault.

Without a model, every message gets the answer "No model is configured yet. Pick one in Settings → Model & providers."

::: info Screenshot placeholder
The main window: the left rail, the thread list with the main chat and two side chats, a streaming reply with a collapsed tool call, and the composer with the permission-mode and model pills in the header.
:::

## What it can do

### Threads

- **Main chat.** One persistent thread. It cannot be archived.
- **Side chats.** Press ⌘N, or click "New side chat" in the thread list.
- **Thread menu (More).** Rename, Pin or Unpin, Archive or Restore. Archived chats sit in an "Archived (n)" group.
- **Message menu (⋯).** **Reply** quotes a message, and the agent sees the quote. **Continue in a side chat** forks the conversation from that message into a new side chat. **Edit and resend** on your own message sends the edit in a side chat forked from there; the original chat keeps the original.
- **Keyboard.** ⌘K opens the palette, ⌘B shows or hides the thread list, ⌃Tab cycles threads, ⌘/ lists every shortcut.

### The composer

- Return sends. While the agent is working, a new message joins a visible follow-up queue. Each queued message can be sent now to steer the run, sent now interrupting it, retried or removed.
- **Esc stops the run.** So does the Stop button.
- ⌃O cycles how much of the agent's work you see: **Normal** (tools collapsed), **Thinking** (the default) and **Verbose**.
- Hold your push-to-talk key to dictate into the composer. See [Dictation](/using/dictation).

### Models

Each thread can use its own model. Press ⇧⌘I, type `/model`, or choose "/model" in the palette, then enter `provider/model`, for example `anthropic/claude-sonnet-5-5`. Suggestions come from your configured providers.

Settings → Model & providers sets the **Primary** model (the default for new threads) and the **Utility** model (background jobs such as the memory flush).

Supported providers: Anthropic, OpenAI, Google (Gemini), OpenRouter, any OpenAI-compatible or Anthropic-compatible server, and local models through Ollama, llama.cpp and LM Studio. Point the Gateway at a local server with `PSYCHE_OLLAMA_URL`, `PSYCHE_LLAMACPP_URL` or `PSYCHE_LMSTUDIO_URL`. Local models must be good at tool calling to act for you; see [Getting started](/guides/getting-started) for the agent-capable check.

### Permission mode

Each thread has a permission mode: **manual**, **balanced** (the default), **auto** or **plan**. Change it from the shield menu in the chat header, or press ⇧⌘M to cycle. **auto** needs a model on the auto-mode allowlist; pick one with `/model` first. What each mode allows is in [Approvals and tiers](/security/approvals-and-tiers).

### Slash commands

Type `/` at the start of a message. Tab or Return completes a command; Esc closes the menu. Start a message with `//` to send text that begins with a slash.

| Command | What it does |
| --- | --- |
| `/model [provider/model]` | Shows this thread's model, or switches it |
| `/new` | Starts a side chat |
| `/btw <question>` | Asks a question in a new side chat under this one, so the main thread stays on topic |
| `/fork [message]` | Forks from the last message, optionally sends a message there, and opens the fork |
| `/schedule <when and what>` | Asks the agent to set up an automation; it asks you to approve it (see [Tasks and automations](/using/tasks-and-automations)) |
| `/incognito [message]` | Starts an incognito chat: memory-only, deleted after 24 hours |
| `/remember <fact>` | Saves a fact to memory and says where |
| `/forget <subject>` | Shows what would be retracted, then forgets it when you click Forget |
| `/plan [goal]` | Switches the thread to plan mode: read-only until you switch back |
| `/status` | Shows the model, the mode, whether this chat is working, and running tasks |
| `/export [md\|json]` | Downloads this thread as Markdown (the default) or JSON |
| `/stop` | Stops the run in this chat |

## What it asks you

Chat itself asks nothing. When the agent wants to do something with a side effect, an approval card appears in a dock above the composer, and the conversation shows "Waiting for your approval" until you answer. When the agent needs information, it asks a question card with choices. See the [Approvals guide](/guides/approvals).

Switching a thread's model or mode asks nothing, but some changes are refused: `auto` without an allowed model, for example.

## Limits today

- **Attachments are not available.** The composer has no attach button, and dragging or pasting a file into the chat does nothing yet. Share a folder in Settings → File access and ask the agent to read the file from there (see [Documents and files](/using/documents-and-files)).
- You cannot add or replace a provider key in Settings → Model & providers yet. Keys are stored only during onboarding, or set through the Gateway's environment.
- You cannot delete a single thread. Archive it, then use "Delete archived threads" in Settings → Data controls. Deleting a chat does not delete what the agent learned from it.
- The "Export as Markdown / JSON / HTML" menu items do nothing; use `/export`. In the desktop app, whether `/export` saves a file is not confirmed.
- When ⇧⌘M cannot switch to auto, the message wrongly says "Changing the permission mode needs a newer Gateway." The real reason is that the thread's model is not on the auto-mode allowlist.
- The ⌘; "Fork selection" shortcut is listed but does nothing.
- The model pill in the header appears only once a thread has its own model.
- With adaptive thinking on Anthropic models, older versions failed a thread when its mode, model or tools changed between turns. This was fixed in 0.3.

## Learn more

- [Getting started](/guides/getting-started)
- [Approvals guide](/guides/approvals)
- [Settings reference](/reference/settings)
- [Release notes 0.3](/release-notes/0.3)
- [Chat in the UI design](https://github.com/devmello/psyche/blob/main/docs/06-ui-design.md#32-chat-message-anatomy)
- [Threads and chat in the feature spec](https://github.com/devmello/psyche/blob/main/docs/03-feature-spec.md#e-threads-and-chat)
