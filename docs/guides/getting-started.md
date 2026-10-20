# Getting started

This guide gets the Psyche desktop app running on your Mac from a source checkout. It covers picking a model, the first run and onboarding, giving the app the rights it needs to change settings, sharing folders with the agent, and where Settings live.

## Before you start

There is no signed DMG or other release of Psyche yet. You build and run it from source.

You need:

- a Mac;
- Node.js 24 or later;
- pnpm 12 or later (the repository pins pnpm 12.4.1);
- git;
- a model: an API key for Anthropic or OpenAI, or a local model through Ollama.

Psyche keeps all of its state in `~/.psyche`. Set `PSYCHE_HOME` to use another folder. If you do, set it the same way for every command in these guides.

## 1. Get the code

```bash
git clone https://github.com/devmello/psyche
```

```bash
cd psyche
```

```bash
pnpm install
```

Run every later command from the repository root.

## 2. Choose a model and start the Gateway

The Gateway (`psyched`) is the long-running process that holds your conversations, memory and approvals. The desktop app is a window onto it.

On main, the Gateway reads its model from environment variables when it starts:

- `PSYCHE_MODEL` names the model as `<provider>/<model>`.
- `PSYCHE_UTILITY_MODEL` is optional. It names a second model for background jobs such as the memory flush. It defaults to `PSYCHE_MODEL`.
- Hosted providers read their key from the provider's usual variable.

| Provider | Example `PSYCHE_MODEL` | Key variable |
| --- | --- | --- |
| Anthropic | `anthropic/claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai/gpt-5.2` | `OPENAI_API_KEY` |
| Google | `google/gemini-pro-latest` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| OpenRouter | `openrouter/auto` | `OPENROUTER_API_KEY` |
| Ollama (local) | `ollama/qwen3.5:9b` | none; `PSYCHE_OLLAMA_URL` for a server other than the default |

The model ids are examples: use any id your provider offers.

The key stays inside the Gateway's model router. It is never sent to the model, written to logs or stored in transcripts.

Giving the Gateway a model key through the Psyche vault is not available yet. The Gateway runs the vault, but the model router reads keys only from the environment, and neither the app nor the CLI can set the vault up yet. Onboarding's API key field is disabled, and Settings → Model & providers cannot store a key. The environment is the only way to give the Gateway a key today.

Start the Gateway in its own terminal and leave it running. Pick one of the three commands below.

### Anthropic

```bash
PSYCHE_MODEL=anthropic/claude-sonnet-5-5 ANTHROPIC_API_KEY=<your key> pnpm --filter @psyche/gateway start
```

### OpenAI

```bash
PSYCHE_MODEL=openai/gpt-5.2 OPENAI_API_KEY=<your key> pnpm --filter @psyche/gateway start
```

A key typed on the command line ends up in your shell history. To avoid that, export the variable from a file your shell loads instead.

### A local model with Ollama

1. Install Ollama and make sure it is running (`ollama serve` starts it if it is not).
2. Pull a model. On a 16 GB Mac, `qwen3.5:9b` is the local model Psyche's acceptance runs have used:

   ```bash
   ollama pull qwen3.5:9b
   ```

3. Start the Gateway with it:

   ```bash
   PSYCHE_MODEL=ollama/qwen3.5:9b pnpm --filter @psyche/gateway start
   ```

Run one local model at a time; two at once can exhaust a 16 GB Mac's memory.

Local models need memory. A rough fit by the Mac's unified memory:

| Memory | Model size | Examples |
| --- | --- | --- |
| 16 GB | about 9B | `qwen3.5:9b`, `gemma4:12b`; `gpt-oss:20b` loads but is too slow to use |
| 32 GB | 27 to 31B | `qwen3.8:27b`, `gemma4:31b`, `gemma4:26b` |
| 96 to 128 GB | 120B mixture of experts | `gpt-oss:120b` |

#### The agent-capable check

Not every local model can use tools reliably. Psyche has a six-case check for this. A model that passes at least five cases, including a single tool call, typed arguments and using a tool result, is `agent-capable`. Any other model is `chat-only`: it can chat, but it should not act for you.

On main the Gateway does not run this check by itself, and the "Tool calling: not checked" badge in the app has no button to run it yet. Run it yourself before you rely on a local model:

```bash
PSYCHE_LIVE_TESTS=1 PSYCHE_LIVE_OLLAMA=1 PSYCHE_LIVE_OLLAMA_MODEL=qwen3.5:9b pnpm --filter @psyche/model-router test:live
```

The verdict and each case print to the terminal.

Treat a pass as necessary, not sufficient. In testing, the current check also passed a 0.8B model that cannot run the agent reliably. A stricter check is planned.

### Check that the Gateway is up

```bash
curl http://127.0.0.1:7979/healthz
```

It answers `{"ok":true}`. The Gateway listens on `127.0.0.1:7979` only.

If a key variable is missing, the Gateway refuses to start and names it (for example `ANTHROPIC_API_KEY is not set`). If `PSYCHE_MODEL` is not set, the Gateway starts anyway and answers every message with "No model is configured yet. Pick one in Settings → Model & providers." On main, picking a model in Settings does not change that. Set `PSYCHE_MODEL` and restart the Gateway.

## 3. Start the desktop app

In a second terminal:

```bash
PSYCHE_GATEWAY_MODE=external pnpm --filter @psyche/desktop start
```

`PSYCHE_GATEWAY_MODE=external` tells the app to use the Gateway you started and never start one of its own. Without it, the app attaches to a Gateway that is already running, or starts one from `apps/gateway`. A Gateway the app starts gets only `PATH`, `HOME` and `PSYCHE_HOME` from it, so it has no model.

### Or use the web client

The Gateway also serves a web version of the app at `http://127.0.0.1:7979` once it is built:

```bash
pnpm --filter @psyche/web build
```

A browser is never paired automatically. It shows "Approve this device from a paired device to continue" and a pairing code. Approve it on the Mac:

```bash
pnpm --filter @psyche/gateway start devices approve <CODE>
```

Without a list of scopes after the code, this grants every scope, including admin.

The web client keeps its device key in memory, so every reload of the page is a new device that needs approving again. The desktop app keeps its key on disk.

## 4. First run and onboarding

The app pairs with the Gateway on its own, because both run on the same Mac. It gets the read, write and approvals scopes. It does not get the admin scope (see step 5).

The first time, the app shows onboarding under a "Set up Psyche" title. It has six steps. On main only the first step changes anything:

| Step | What you see | What it saves on main |
| --- | --- | --- |
| Meet your agent | Name (suggestions Juno, Moss, Pip, or Keep "Psyche"), Creature (Pick one, or Describe it in your words), Vibe or tagline, and a preview | The name, creature and tagline, written to `IDENTITY.md` |
| Permissions | Accessibility, Screen Recording and Notifications, each with Allow or Skip | Nothing. The app does not ask macOS from this step yet; Allow marks the item Skipped. |
| Connectors | Account to connect, then Read only or Read and act, then Connect; or Skip for now | Nothing. Use Skip for now. If you click Connect, the step lists the account as connected, but no account is connected. See [connectors.md](connectors.md). |
| Model & provider | How should the agent think? (Cloud API key, Subscription, OpenRouter, Local model), Provider, Model (a short list, or Another model with a Model id), API key, Tool-calling check | Nothing. The API key field is disabled. The Gateway uses `PSYCHE_MODEL`. |
| Where {name} works | This Mac, or A Mac inside Psyche (VM mode) | Nothing. VM mode is not available yet; the agent works on this Mac. |
| Done | A summary of your answers | "Open the main chat" finishes onboarding |

Onboarding runs once per Gateway, not once per device. To change the name, creature or tagline later, edit `IDENTITY.md` (see [memory-and-persona.md](memory-and-persona.md)).

After onboarding you land in the main chat. There is one main thread that continues across sessions. ⌘N opens a side chat.

## 5. Make the app an admin device

Most changes in Settings need the admin scope: sharing folders, revoking grants, approving devices and chat senders, backups. The app pairs without it on purpose. The automatic pairing uses a secret file that any program running as you can read, so it never grants admin.

Without admin, those settings show "Needs approval on this device. Change it from a device paired as admin."

To give the app admin:

1. List the paired devices:

   ```bash
   pnpm --filter @psyche/gateway start devices list
   ```

   Find the line that starts with an id and reads `Psyche Desktop (<your Mac's name>)`. Copy the id.

2. Grant the scopes:

   ```bash
   pnpm --filter @psyche/gateway start devices grant <deviceId> operator.read,operator.write,operator.approvals,operator.admin
   ```

3. Quit the app and start it again. A device picks up new scopes when it reconnects.

These owner commands work on the Gateway's database directly, so run them on the Mac that runs the Gateway.

## 6. Share folders with the agent

The agent reads and writes files only inside folders you share. Anything outside them is refused.

1. Open Settings → File access.
2. Click "Choose a folder…" and pick a folder. It is shared read only.
3. To let the agent save changes there, switch the folder from "Read only" to "Read and write" in the list.
4. To stop sharing a folder, click Remove next to it.

On the web client there is no folder chooser. Type the folder's full path, starting with `/`, and press Return.

Changes apply at once; you do not need to restart anything.

Good to know:

- Read only lets the agent open, list and search files. Read and write also lets it save changes.
- Writing to a read-only folder is refused, as is any path outside every shared folder.
- Use real paths. A path that goes through a symbolic link is refused. On macOS that means `/private/tmp`, not `/tmp`.
- Text the agent reads from a file counts as untrusted content (see [approvals.md](approvals.md#untrusted-content)).

You can also set folders from the CLI. This replaces the whole `permissions.policy` setting, so include every folder you want to keep:

```bash
node apps/cli/src/main.ts config set permissions.policy '{"folders":[{"path":"/Users/you/Notes","mode":"rw"}]}'
```

The CLI pairs as its own device. The first time, it prints a pairing code; approve it with `pnpm --filter @psyche/gateway start devices approve <CODE>` and run the command again.

## 7. Where Settings live

Open Settings from the Menu button at the bottom of the rail (Menu → Settings), or press ⌘K and choose Settings. The sections are: Model & providers, Persona, Connectors, Permissions, Computer use, File access, Devices & nodes, Channels, Credentials, Appearance, Voice & dictation, Data controls, Server & remote access, Usage and About.

Settings are stored in the Gateway, in `~/.psyche/state/psyche.sqlite`, so every paired device sees the same values. The Gateway's own connection settings (`gateway.host`, `gateway.port`, `gateway.allowedOrigins`, `gateway.publicOrigin`, `gateway.trustedProxy`) live in `~/.psyche/config.json` instead. Change those with `node apps/cli/src/main.ts config set <key> <value>` and restart the Gateway. Environment variables override `config.json`.

On main, many sections save values that the Gateway does not act on yet. This is what takes effect today:

| Section | On main |
| --- | --- |
| File access | Works (admin). The broker applies it at once. |
| Permissions | The Grants ledger and Revoke work (admin). "Default mode for new threads" is saved but not applied yet. |
| Devices & nodes | Lists devices and nodes; approve, deny and revoke work (admin). |
| Channels | Manages channels that already exist (admin). |
| Appearance | Works. On the desktop it also has the zoom control. |
| Data controls | Pause memory, deleting archived threads, Reset and the Backups panel work. "Export everything" does not save a file yet. |
| About | The log viewer. It shows lines only when the Gateway writes log files, which a Gateway started in a terminal does not. |
| Model & providers | Saved, not used. The Gateway uses `PSYCHE_MODEL`. |
| Persona | Saved, not used. Edit `IDENTITY.md` instead. |
| Connectors | Lists connectors; nothing can be connected yet. |
| Credentials | The Gateway runs the vault, but nothing can set it up yet, so it stays locked and nothing can be stored. |

## Where your data lives

Everything is under `~/.psyche`:

| Path | What |
| --- | --- |
| `state/psyche.sqlite` | Threads, messages, tasks, approvals, grants, receipts, settings |
| `workspace/` | The agent's persona and memory as Markdown files |
| `audit/` | The hash-chained audit log |
| `vault/` | The encrypted credential vault, once it is set up |
| `library/` | Downloads and attachments (in `library/quarantine/` for now) |
| `browser/profiles/` | The agent browser's profiles |
| `backups/` | Backups the Gateway makes |
| `run/` | Sockets and the per-launch handshake secret |
| `config.json` | The Gateway's connection settings |

## Stopping and restarting

- "Quit Psyche (tasks keep running)" closes the app. A Gateway you started in a terminal keeps running.
- Press Ctrl-C in the Gateway's terminal to stop it. It shuts down cleanly.
- When the Gateway starts again, a turn that was running is marked failed with a note, and a tool call that was in flight is marked uncertain and never repeated. Pending approval cards are issued again.
- On main, the agent's working context for a conversation lives in the Gateway process. After a restart the transcript is still there, but the agent continues the thread without its earlier turns in context.

## Next

- [approvals.md](approvals.md): how approval cards, scopes and grants work.
- [memory-and-persona.md](memory-and-persona.md): the workspace files and how to edit them.
- [connectors.md](connectors.md): Google, mail, Telegram and web search.
- [server-mode.md](server-mode.md): running the Gateway on a server.
