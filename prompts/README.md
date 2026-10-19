# Session prompts — how to launch everything

Each file in this folder is a complete prompt for one session. Open a new Claude Code session on this repo (Code tab → New session → this folder, with a worktree), paste the file's contents as the first message, and let it run. Codex prompts work the same way in the Codex app or CLI.

## Order of operations

1. **Init (once, you or this session):** `git init`, commit `docs/`, `prompts/`, `README.md`, create a private GitHub repo, push `main`. Nothing else should start before `main` exists.
2. **Start now, in parallel:**
   - `s00-bootstrap-integrator.md` (the scaffold; everything in Wave 2 waits for its PR)
   - `spike-01-cdp-bridge.md`, `spike-02-apple-container.md`, `spike-03-speechanalyzer.md`, `spike-04-ax-snapshot.md`, `spike-05-local-models.md`, `spike-06-vz-provisioning.md`
   - `s20-content-skills-templates.md`
   - `s18-security-test-harness.md` (corpus and scenario scripts first; code after bootstrap)
   - `codex-c3-adversarial-review.md` (review of the docs now; PR review later)
3. **When the bootstrap PR is merged to `main`, start:** `s01` … `s17` and `codex-c1-sandbox.md`. Each works against fakes, so they do not block each other.
4. **When the packages a scenario needs are merged, start:** `int-1-walking-skeleton.md`, then `int-2-browser-connectors-channels.md`, then `int-3-acceptance.md`, plus `codex-c2-cli-deploy.md` and `s19-node-agent.md`.

Running fewer sessions: see `docs/09-execution-plan.md` §4 for which prompts can be merged.

## Files

| Prompt | Role |
| --- | --- |
| `_shared-rules.md` | Read by every session; not a prompt |
| `s00-bootstrap-integrator.md` | Scaffold, protocol, contracts, fakes, CI; then merge queue |
| `s01-gateway-core.md` | Gateway API, pairing, session controller, persistence |
| `s02-agent-runtime.md` | Agent loop, tools registry, context assembly, plan/checklist, questions |
| `s03-model-router.md` | Provider adapters, router, usage/cost, local-model probe |
| `s04-tasks-scheduler.md` | Durable tasks, leases, automations, heartbeat, watches |
| `s05-permissions-audit.md` | Permission Broker, approvals, grants, binding hashes, audit log |
| `s06-vault.md` | Credential Broker: vault, placeholders, fills, approvals |
| `s07-memory.md` | Workspace files, index, memory tools, flush, dreaming |
| `s08-browser.md` | BrowserDriver, CDP and Playwright drivers, snapshots, origin policy |
| `s09-mcp-connectors.md` | MCP host, Google connector, search/fetch |
| `s10-channels.md` | Channel framework, WebChat, Telegram, pairing/allowlists |
| `s11-desktop-web-shell.md` | Electron shell, panes, browser pane host, terminal, web shell |
| `s12-ui-kit.md` | React components: message blocks, cards, screens, theme |
| `s13-viewers-editor.md` | PDF, sheets, DOCX, code, Markdown editor, artifacts, documents pipeline |
| `s14-mac-helper.md` | Swift helper: AX, screenshots, Apple Events, Keychain, notifications, speech, VM |
| `s15-proactive-notifications.md` | Feed, Ideas, Goals pipelines; notification model |
| `s16-search-skills.md` | Unified search; skills loading and trust |
| `s17-speech.md` | STT/TTS abstractions, whisper.cpp path, voice-note transcoding |
| `s18-security-test-harness.md` | Fakes completeness, injection corpus, secret-leak checker, scenario runner |
| `s19-node-agent.md` | psyche-node for VM guests and remote machines (M2) |
| `s20-content-skills-templates.md` | Bundled SKILL.md files, workspace templates, onboarding copy |
| `spike-01…06-*.md` | Six time-boxed prototypes that de-risk the architecture |
| `int-1-walking-skeleton.md`, `int-2-…`, `int-3-acceptance.md` | Integration sessions |
| `codex-c1-sandbox.md` | Codex: container image and SandboxRunner |
| `codex-c2-cli-deploy.md` | Codex: CLI, Docker, Compose, launchd, release CI |
| `codex-c3-adversarial-review.md` | Codex: red-team review of security design and PRs |

## Tips

- Give each Claude session the highest effort setting and auto permission mode inside its worktree; the prompts tell the session to proceed without waiting.
- Check `docs/status/*.md` once a day; that is where sessions report blockers and requests to each other.
- Keep S00 running as the integrator; it merges `protocol:` PRs first and rebases others.
