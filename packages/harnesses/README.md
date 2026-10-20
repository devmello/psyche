# @psyche/harnesses

Coding-harness adapters (docs/03 C10; docs/02 §4.3 "Harness plugins") behind agent-core's `HarnessPlugin` seam and the `harness.delegate` tool. Every action a harness wants to take is classified and asked of Psyche first (`gate`): the Permission Broker decides with the same cards as a native call, and write+ actions get receipts.

## Claude Code

- `ClaudeCodeHarness` (`claude-code.ts`) runs the `claude` CLI headless with stream-json in and out over a `ClaudeTransport`. It sends the brief, turns the CLI's text into progress lines, answers every `PreToolUse` hook through `gate`, reports finished calls (`actionDone`, `uncertain` when the CLI never reported one), and returns the CLI's final `result` as an untrusted report.
- `classifyClaudeTool` (`classify.ts`): `Read`/`Glob`/`Grep` are reads of the mapped host path; `Edit`/`Write`/`MultiEdit` are `file_write` with the change as a diff; `Bash` is `exec`, except `git push`, which is `git_push` (always asked, `once` only) and `destructive` when forced; `WebFetch` is `new_origin`; a tool Psyche does not know is a `write`.
- `SandboxClaudeTransport` (`sandbox-transport.ts`) is what psyched uses:
  - **Placement:** the CLI runs in a sandbox of its own scope. The owner's folder must be granted read-write; it is mounted at `/workspace/repo` with `.git` read-only.
  - **Network:** only the egress proxy, allowlisted to `api.anthropic.com`.
  - **Key:** the API key comes from the vault for the session (`credential`; the Gateway asks with a `credential_fill` card) and is wiped when the CLI exits.
  - **Gating:** a relay (`RELAY`) runs in the same container over the runner's stdio channel. The CLI's `PreToolUse` hook (`HOOK`, installed with `--settings`) asks it over a Unix socket in `/tmp`. A hook that cannot reach the relay denies, and `--permission-prompts none` denies anything a hook did not allow.
- `stubHarness("codex" | "pi")`: not implemented. Each would adapt its own approval hook to `gate` the same way. They are not registered in the Gateway.

The Gateway registers Claude Code only while the admin setting `harness.claudeCode` is `{enabled: true, credential: "<vault slug>", model?}` and a container backend exists (`apps/gateway/src/compose/harnesses.ts`).

## Not verified

- No real `claude` CLI has run against this adapter, here or in CI. Before relying on it, pin a CLI version and run one session with a test key.
- The CLI's `PreToolUse` hook input is expected to carry `tool_use_id`; without it, results are matched to calls in order per tool.
- `--permission-prompts none` needs CLI 2.1.259 or later.
- The sandbox image does not ship the `claude` CLI: the owner's image must add it (`npm i -g @anthropic-ai/claude-code`), or a session fails to start.
- Subscription login (`CLAUDE_CODE_OAUTH_TOKEN`) is deliberately not used; Anthropic's terms ask third-party products to use API keys.
