# Memory and persona

Psyche keeps the agent's persona and memory as plain Markdown files you can read and edit. This guide lists the workspace files, what the agent may write on its own and what always asks, how to edit the persona, and how to pause, reset and export memory. It also says which parts of the design are not available yet.

## The workspace

The files live in `~/.psyche/workspace/` (`$PSYCHE_HOME/workspace/`). On the first start, the Gateway copies them from the repository's `templates/` folder. They are ordinary files: you can open them in Soul & Memory, in any editor, or in Finder.

| File | What it holds |
| --- | --- |
| `SOUL.md` | Core truths, boundaries and personality, written in the first person for you to read |
| `IDENTITY.md` | The agent's name, creature, vibe, tagline, emoji, avatar and voice in a frontmatter block, plus a one-line self-description |
| `AGENTS.md` | Operating instructions: safety, asking versus acting, approvals and receipts, memory, status lines |
| `USER.md` | Stable facts about you and dated directives; the latest directive wins |
| `MEMORY.md` | Curated long-term memory; each bullet ends with the dates it came from |
| `memory/YYYY-MM-DD.md` | Daily notes, one bullet per entry |
| `interests.md` | The Feed's interest ledger: one topic per line with a weight and a reason |
| `BOOTSTRAP.md` | A first-run ritual, copied only into a fresh workspace |
| `DREAMS.md` | The diary of nightly dreaming |

A daily note entry looks like `- HH:MM [tag] text`. The tag says where the entry came from: `owner`, `agent`, `system`, or `untrusted` (with the kind and source of the content). A `USER.md` directive looks like `- YYYY-MM-DD active: …`. When you replace one, the old line stays, marked `superseded by` the new date.

### What the agent sees

Every turn, the agent's prompt includes `SOUL.md`, `IDENTITY.md`, `AGENTS.md` and `USER.md`, plus yesterday's and today's daily notes. Each persona file is cut at 20,000 characters (`USER.md` at 4,000), and all of them together at 60,000. A file that is cut ends with a visible "truncated" marker, and a missing file is replaced by a marker that says it is missing, so the agent knows. The HTML comments in the template files are guidance for you; they count toward the budget, so keep them short.

On main, `MEMORY.md` is not added to the prompt automatically, and neither is `BOOTSTRAP.md`. The agent can open any workspace file with its memory tool.

## What the agent writes without asking

- **Today's daily note.** The agent appends entries to `memory/<today>.md`. It cannot edit or remove existing entries, and it cannot write to another day's note. An entry that claims to be yours or the system's is recorded as the agent's.
- **Other notes.** It can create and edit other Markdown files in the workspace, such as topic notes under `memory/` and `interests.md`.
- **The memory flush.** Before a long conversation is compacted, a short background step with the utility model saves the facts worth keeping to today's daily note.

The agent cannot delete or rename workspace files.

## What always asks

`SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md` and `MEMORY.md` are protected. Any change the agent wants to make to them shows an approval card ("Edit protected memory"), bound to that exact change. See [approvals.md](approvals.md).

In a turn that read untrusted content, such as a web page, an email or a file, the agent cannot change those five files at all, even with your approval. What it writes to the daily note in such a turn is tagged untrusted.

## What never goes in

- Credentials and card numbers are refused in every file, line by line. Keep secrets out of the workspace.
- While memory is paused, nothing from your chats is written. Your own edits still work.

## Editing the persona

### Directly, in Soul & Memory

1. Click the avatar in the chat header to open the agent sheet, then choose Soul & Memory.
2. Pick a file tab: `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` or `AGENTS.md`. The bar next to the name shows how much of the file's budget is used (for example `1.2k / 20k`).
3. Edit the text, then click Save, or Discard to drop your changes.

Recent daily notes are under Daily; click a date to open that note. If a file changed while you had it open, saving says "{file} changed since you opened it. Discard to load the new version."

You can also edit the files in `~/.psyche/workspace/` with any editor. Psyche notices the change, treats it as yours and indexes it again. Do not share the workspace folder with the agent as a granted folder: its file tools would then write there as if they were you.

To change the agent's name, creature or tagline, edit the frontmatter of `IDENTITY.md`. The chat header and cards update from it.

### By asking the agent

Ask in chat, for example "make your tone drier" or "add to USER.md that I don't take meetings before 10". The agent proposes the edit to the protected file and you get an "Edit protected memory" card with the change. Nothing changes until you approve it, unless you chose Always allow for that file on an earlier card.

### Settings → Persona

Settings → Persona shows Identity fields (Name, Vibe or tagline, Emoji), the Avatar creature picker and "Describe a change" (the pencil). On main these are saved as Gateway settings, and neither the agent nor the app reads them yet. "Describe a change" saves your text; it does not redraw the avatar or rewrite `IDENTITY.md`. Edit `IDENTITY.md` instead.

### Tone presets

The repository has three `SOUL.md` presets in `templates/personas/`: `calm-assistant.md`, `dry-wit.md` and `chief-of-staff.md`. They keep the default Core truths and Boundaries word for word and change only the personality and writing style. Picking one in onboarding is not available yet. To use one, copy its text into `SOUL.md` in Soul & Memory and save.

## Nightly dreaming

The memory package has a nightly consolidation job, "dreaming", meant to be the only writer of `MEMORY.md` besides you. On main the Gateway does not schedule it yet, so it does not run. Soul & Memory still says "Dreaming rewrites this file every night." under `MEMORY.md`; that is not true yet. Until it runs, `MEMORY.md` changes only when you edit it or approve an agent edit.

## Searching memory

In Soul & Memory, click the search button and type. Results come from the indexed workspace files and daily notes. Entries that came from untrusted content carry an "untrusted" chip.

## Pausing memory

Soul & Memory shows "Memory: On" or "Paused", with a Pause or Resume button. Settings → Data controls has the same switch (Pause memory). While memory is paused, the agent and the memory flush write nothing from your chats.

## Incognito threads

The Gateway supports incognito threads: nothing from them is written to memory, and they are deleted 24 hours after they start. Starting one from the app is not available yet: there is no button for it, and typing `/incognito` in the composer does not start one.

## Reset

Soul & Memory has "Reset {name}…". It asks you to type `reset {name}` to confirm. It deletes every workspace file and the memory index and copies the templates back in. Receipts and the audit log are kept. Settings → Data controls has the same action. Reset needs a device paired as admin.

Deleting a chat does not delete what the agent learned from it. To forget that too, reset memory.

## Export and "Download your data"

The "Export everything" buttons in Soul & Memory and in Settings → Data controls do not save a file yet: they report the export, but the zip is not written anywhere you can open.

Use the CLI instead. On the Mac that runs the Gateway, from the repository root:

```bash
node apps/cli/src/main.ts export --out ~/psyche-export
```

The folder must be new or empty. The CLI collects:

- every thread, as Markdown and JSON;
- the memory zip (the workspace files);
- receipts and grants;
- Library metadata and files;
- vault references, never values;
- the audit log and `config.json`.

`export.json` in the folder lists anything that was skipped and why. The CLI pairs as its own device the first time; approve its code with `pnpm --filter @psyche/gateway start devices approve <CODE>` and run the command again.

Backups are a separate, encrypted copy of everything, made for restoring rather than reading. See [server-mode.md](server-mode.md#backups-and-restore).

## Git sync

The memory package can sync the workspace with a private git repository, but there is no command for it on main, so it is not available yet. The workspace is a plain folder of Markdown files, so you can keep it under version control yourself. Psyche treats changes that arrive that way as your edits.
