---
title: Coding
---

# Coding

The coding helper lets the agent work on a code repository in a folder you shared with it. It can open the repository, search and read it, change files with a diff you see on the card, run commands such as the tests in the sandbox, commit, and push. Every change asks first, and a push asks every time, naming the exact remote, branch and commit. The agent never gets your host shell for this.

## Turn it on

The coding helper is on by default. It needs two things from you:

1. **A shared folder.** Share the repository's folder, or a folder above it, in Settings → File access. Use Read and write if you want the agent to change files or commit. With Read only it can search and read, nothing more. See [Getting started](/guides/getting-started) for how to share a folder.
2. **A sandbox backend, for running commands.** Commands run in a Linux container, never on your Mac directly. On macOS 26 and later Psyche can use Apple's `container`; on macOS 15 it needs Colima or Docker Desktop. On a Linux server it uses Docker. Without a backend the agent can still read, edit and use git, but it cannot run commands, and it says so instead of falling back to your shell.

Then ask in chat, for example: "The date parsing test in ~/Projects/invoices fails. Find out why and fix it."

## What it can do

The agent's coding tools all start with `code.`:

| Tool | What it does | Asks you? |
| --- | --- | --- |
| `code.open` | Opens a repository inside a shared folder for this task or thread | No, if the folder is shared |
| `code.search` | Searches the repository's files (skips `.git`, `node_modules`, binaries and symbolic links) | No |
| `code.read` | Reads a file, or a range of lines | No |
| `code.edit` | Applies a change to one or more files, as a diff | Yes: "Write file" |
| `code.run` | Runs a command in the sandbox, with the repository mounted | Yes: "Run command in sandbox" |
| `code.git` | `status`, `diff` and `log` read; `commit` and `branch` change the repository; `push` sends commits to a remote | Reads: no. Commit and branch: "Change git repository". Push: "Push to git remote" |

How the pieces fit together:

- **Workspaces.** The agent must open a repository with `code.open` before it uses the other tools, and they refuse a repository that is not open in the current task or thread. The path must be a real path inside a folder you shared. A path through a symbolic link is refused.
- **Edits.** A change is a diff. The card shows it, and the receipt keeps it. Files are written only after a check that they did not change since the agent read them. The agent never writes inside `.git/`.
- **Commands.** `code.run` runs in the sandbox with your repository mounted at `/workspace/repo` and its `.git` folder read only, so a command cannot plant git hooks or change your git config. The container has no network by default. If the agent asks for network, for example to install packages, it goes through Psyche's egress proxy, and each new site asks you.
- **Git.** Git runs on your Mac with a fixed set of subcommands and flags, never through a shell. Hooks are off and git never prompts. A push uses your own git credentials; if they need a prompt, the push fails rather than waiting.

## What it asks you

- **Edit a file.** The "Write file" card shows the path and the diff.
- **Run a command.** The "Run command in sandbox" card shows the command, the folder it runs in, the names of any environment variables and the network setting.
- **Commit or create a branch.** The "Change git repository" card shows the repository, the operation, the branch, the commit message and the paths.
- **Push.** The "Push to git remote" card names the remote, the remote's URL, the branch, the exact commit and the repository. It offers only Allow once, so every push asks. A push is never forced.

::: info Screenshot placeholder
A "Push to git remote" approval card showing remote origin, its URL, branch main and a short commit hash, with Allow once and Deny.
:::

Text the agent reads from the repository is untrusted content: a README or a test file cannot give it instructions. If the turn read something that looks like it is steering the agent, the card says "after reading untrusted content". Check the arguments against what you asked for. See [Untrusted content](/security/taint).

## Limits today

- The coding helper is new in 0.3. It passed its acceptance scenario on Anthropic's Haiku model three times out of three. No OpenAI or local model has been tested with it.
- The prompt-injection test corpus has no cases for the coding helper yet. The only injection check is the planted instruction in the coding scenario.
- The container mount has been tested against a fake container runner, not on every backend.
- The desktop app has a Terminal pane, but the Gateway does not open shells for it yet, so it shows as unavailable. You see the agent's commands on their cards and receipts instead.
- Harness plugins (running Claude Code, Codex or another coding agent behind Psyche's approvals) are not built.
- To turn the coding helper off, start the Gateway with `PSYCHE_CODING=off`.

## Learn more

- [Approvals and tiers](/security/approvals-and-tiers)
- [Permissions](/security/permissions)
- [Release notes 0.3](/release-notes/0.3)
- [Coding helper plan](https://github.com/devmello/psyche/blob/main/docs/archive/plans/v10.md)
- [Sandbox and execution in the security design](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#5-sandbox-and-execution)
- [Coding tools source](https://github.com/devmello/psyche/tree/main/packages/agent-core/src/coding)
