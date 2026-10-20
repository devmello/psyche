---
title: Memory
---

# Memory

Psyche keeps the agent's persona and what it remembers about you as plain Markdown files. You can read them, edit them in the app or in any editor, search them, pause them and reset them. The agent writes to today's daily note on its own, but any change to the files that define who it is and who you are asks you first.

## Turn it on

Memory is on from the first run. The files live in `~/.psyche/workspace/`, copied from Psyche's templates when the Gateway first starts. Onboarding writes the name, creature and tagline you pick into `IDENTITY.md`.

To see and edit them, click the avatar in the chat header to open the agent sheet, then choose **Soul & Memory**.

::: info Screenshot placeholder
Soul & Memory with the SOUL.md tab open, its budget bar reading "1.2k / 20k", the Daily list of recent notes, the Search memory button and "Memory: On" with Pause.
:::

## What it can do

### The files

| File | What it holds |
| --- | --- |
| `SOUL.md` | The agent's core truths, boundaries and personality, in the first person |
| `IDENTITY.md` | Name, creature, vibe, tagline, emoji, avatar and voice |
| `AGENTS.md` | Operating instructions: safety, when to ask and when to act, approvals, memory |
| `USER.md` | Stable facts about you, and dated directives; the latest directive wins |
| `MEMORY.md` | Curated long-term memory, each line ending with the dates it came from |
| `memory/YYYY-MM-DD.md` | Daily notes, one bullet per entry |
| `interests.md` | What the Feed should write about |

Every turn, the agent sees `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `USER.md` and yesterday's and today's daily notes. Each file has a size budget (20,000 characters; 4,000 for `USER.md`), and a file that is cut off says so. The agent opens other workspace files, including `MEMORY.md`, with its memory tool when it needs them.

### Daily notes

Each entry looks like `- 14:05 [owner] Prefers morning meetings`. The tag says where it came from: `owner`, `agent`, `system`, or `untrusted` (with the source). The agent can append to today's note, but it cannot change or delete earlier entries or other days. Before a long conversation is compacted, a short background step saves the facts worth keeping to today's note.

### Editing

- **In Soul & Memory.** Pick a file tab (SOUL, IDENTITY, USER, MEMORY or AGENTS), edit, then **Save** or **Discard**. Recent daily notes are under Daily. If the file changed while you had it open, saving tells you to discard and reload.
- **In any editor.** Edit the files in `~/.psyche/workspace/` directly. Psyche treats the change as yours and indexes it again. Don't share the workspace folder with the agent in Settings → File access.
- **By asking.** "Make your tone drier", or "Add to USER.md that I don't take meetings before 10". The agent proposes the change and you approve it.
- **The agent's name and look.** Edit the front matter of `IDENTITY.md`. The chat header and cards follow it.
- **Tone presets.** Three alternative `SOUL.md` texts ship in Psyche's templates: calm assistant, dry wit and chief of staff. Copy one into `SOUL.md` to use it.

### Remember and forget

- `/remember <fact>` in the composer saves a fact and says which file it went to.
- `/forget <subject>` first shows what would be retracted ("Forgetting … retracts N claims and M indexed notes"), then forgets it when you click **Forget**. The memory index is rebuilt so it does not come back in search.

### Search

Click **Search memory** in Soul & Memory. Results come from the workspace files and daily notes. Entries that came from untrusted content carry an "untrusted" chip. Search in the left rail (⌘K) also covers memory.

### Pause, incognito, reset

- **Pause.** Soul & Memory shows "Memory: On" with **Pause**; Settings → Data controls has "Pause memory". While paused, nothing from your chats is written. Your own edits still work.
- **Incognito.** Type `/incognito`, or choose "New incognito chat (memory-only, 24 h)" in the ⌘K palette. Nothing from it reaches memory or search, other threads cannot see it, and it is deleted 24 hours after it starts. The thread list marks it "Incognito".
- **Reset.** "Reset {name}…" in Soul & Memory, or "Reset memory…" in Settings → Data controls, deletes every workspace file and the memory index and copies the templates back. You type `reset {name}` to confirm. Receipts and the audit log are kept. Reset needs a device paired as admin.

## What it asks you

- **Changing `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md` or `MEMORY.md`.** The agent gets an "Edit protected memory" card with the exact change. Nothing changes until you approve.
- **After reading untrusted content** (a web page, an email, a file), the agent cannot change those five files at all in that turn, even with your approval. What it writes to the daily note in that turn is tagged `untrusted`.
- **Secrets are refused.** Passwords, card numbers and similar values are refused in every memory file.

## Limits today

- **Dreaming does not run.** Nightly consolidation into `MEMORY.md` exists in the code, scheduled for 03:00, but the Gateway does not start it. Soul & Memory still says "Dreaming rewrites this file every night." under `MEMORY.md`; that is not true yet. `MEMORY.md` changes only when you edit it or approve an agent edit.
- `MEMORY.md` is not added to the agent's prompt automatically.
- The agent has no forget or remember tool of its own. Use `/forget` and `/remember`. There is no Forget button in Soul & Memory.
- Settings → Persona (name, tagline, emoji, creature, "Describe a change") is saved but not used. Edit `IDENTITY.md` instead.
- "Export everything" in Soul & Memory and Data controls does not save a file. Use `psyche export --out <folder>` on the Mac that runs the Gateway; see [Backups](/security/backups) for encrypted copies.
- Importing memory from another assistant, picking a tone preset in onboarding, and syncing the workspace to git are not available. You can keep the workspace folder under git yourself.
- Deleting a chat does not delete what the agent learned from it. Use `/forget`, or reset memory.

## Learn more

- [Memory and persona guide](/guides/memory-and-persona)
- [Untrusted content](/security/taint)
- [Backups](/security/backups)
- [Workspace templates](https://github.com/devmello/psyche/tree/main/templates)
- [Memory safety in the security design](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#8-memory-safety)
- [Memory and persona in the feature spec](https://github.com/devmello/psyche/blob/main/docs/03-feature-spec.md#h-memory-and-persona-files)
