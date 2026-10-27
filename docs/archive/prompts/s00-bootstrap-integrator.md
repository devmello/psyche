# Session S00 — Bootstrap, then Integrator

You are building Psyche, an open-source self-hosted personal AI agent (read `README.md`). You are session **S00 — Bootstrap**. You create the monorepo scaffold, the protocol schemas, the cross-package interfaces and their fakes, and CI, so that fifteen other sessions can start in parallel the moment your PR merges. After that you become the **Integrator** for the rest of the project. Work on branch `ws/s00-bootstrap` in your own worktree.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/09-execution-plan.md` (ownership map, waves, rules)
3. `docs/02-architecture.md` (all; especially §3.1, §4.1, §4.3 tool registry, §7 node protocol, §11 API, §12 storage)
4. `docs/04-data-model.md` (tables, message blocks, event frames)
5. `docs/03-feature-spec.md` rows A1–A5
6. `docs/07-tech-decisions.md` ADR-002, 003, 004, 015, 019

## Mission (bootstrap)
Produce one PR (or a short series) that makes `pnpm i && pnpm -w typecheck && pnpm -w lint && pnpm -r test` green on macOS and Ubuntu CI and gives every other session a place to work.

### 1. Repository scaffold
- pnpm workspaces + Turborepo; TypeScript 5.x strict, ESM only, Node 24 (`.nvmrc`, `engines`); Vitest; Biome (or ESLint + Prettier, pick one and document); changesets; `.editorconfig`; `.gitignore` (node, Electron, Swift build dirs, `.psyche/`, `*.sqlite`, `vault.db`); `LICENSE` (Apache-2.0 per ADR-019, marked "proposed" in README); `CODEOWNERS` mapping every path in `docs/09-execution-plan.md` §2 to its session id as a comment; `.github/pull_request_template.md` with the definition-of-done checklist from `_shared-rules.md`; `docs/plans/.gitkeep`, `docs/status/.gitkeep`, `docs/spikes/.gitkeep`.
- Create every package and app directory from `docs/09-execution-plan.md` §2 with a `package.json` (`@psyche/<name>`, `private: true`), `tsconfig.json` extending a shared base, `src/index.ts` (exports the package's interface implementation placeholder that throws `NotImplemented`), and a `README.md` naming the owning session and linking the relevant feature ids. Swift app `apps/mac-helper` gets a buildable Swift Package / Xcode project skeleton (see §5).

### 2. `packages/protocol` (the contract everyone compiles against)
- TypeBox schemas for the domain types in `docs/04-data-model.md`: Thread, Message, Block (discriminated union of the block types in §9.1), Run, ToolCall, ToolSpec (`name, description, inputSchema, sideEffect: none|read|write|destructive|financial, targetKind, provenanceOut`), Task, TaskAction, InputRequest, ApprovalRequest (§4.1), Grant, Receipt, Notification, CredentialMeta, Connector, Channel, Automation, FeedPost, Idea, Goal, LibraryItem, Artifact, Device, NodeCapability, UsageRecord, Settings.
- WS frame schemas (`req`/`res`/`event` with `seq`, `stateVersion`) and a typed method/event registry for M1: `threads.*`, `chat.*`, `tasks.*`, `approvals.*`, `grants.*`, `memory.*`, `library.*`, `settings.*`, `search.*`, `notifications.*`, `nodes.*`, `devices.*`, `connectors.*`, `channels.*`, `automations.*`, `vault.*` (metadata only), `view.*` (desktop pane control), `browser.*`, `sandbox.*`. Each method has params/result schemas; each event a payload schema. Start minimal but complete in shape; other sessions extend additively.
- Node protocol schemas (§7): `connect`, challenge, `node.invoke`, `node.event`, `node.result`, capability manifest.
- Browser bridge protocol (desktop ↔ gateway CDP bridge) schemas: attach/detach tab, forward CDP command/event, tab lifecycle, take-control state.
- Codegen: `pnpm protocol:gen` writes `generated/schema.json`, TS types, and Swift `Codable` models (use quicktype or a small generator; document the choice). CI fails if generated files are stale.
- `packages/protocol/src/contracts/`: TypeScript interfaces with doc comments pointing at the architecture section: `ModelProvider` (stream a normalized request → events: text delta, tool call, tool result, reasoning (opaque), usage, finish), `AgentLoop`, `PermissionBroker` (`decide(call, ctx) → allow|ask|deny + rule`, `requestApproval`, `recordReceipt`), `CredentialBroker` (`resolve(placeholder, target, approvalId)`, metadata APIs), `MemoryStore`, `TaskEngine`, `Scheduler`, `BrowserDriver`, `SandboxRunner`, `McpHost`, `ChannelAdapter`, `NodeClient`, `Notifier`, `SearchIndex`, `SkillLoader`, `SpeechEngine`, `Viewer` registry types. Keep them small; additive growth is expected.
- `CHANGES.md` describing the protocol-change process.

### 3. `packages/testing`
- One in-memory fake per contract (deterministic, scriptable: for example `FakeModelProvider.script([...turns])`, `FakePermissionBroker.policy({...})`), fixtures (sample threads, a sample Gmail thread, a sample PDF form), a conformance test suite that every real implementation can run (`conformance/<contract>.test.ts` parameterized by factory), and the skeleton of the secret-leak checker (`registerSecret(value)` + `assertNoSecrets(text)`), which S18 completes.

### 4. `packages/db`
- better-sqlite3 (or libsql; justify) + drizzle; WAL; `openDb(path)`; migration runner for timestamped SQL files; schema v0 for `devices`, `nodes`, `pairing_requests`, `threads`, `messages`, `runs`, `tool_calls`, `settings`, `usage` from `docs/04-data-model.md`; tests for migrations and the active-writer guard.

### 5. Minimal apps
- `apps/gateway`: boots, opens the DB, `GET /healthz`, WS `connect` with loopback auto-pairing, `settings.get/set`, event bus with `seq`/`stateVersion`; everything else returns `not_implemented`. S01 takes it from here.
- `apps/desktop`: Electron Forge + Vite + React hello window that connects to the Gateway WS and shows `healthz`; fuses configured per architecture §5; signing config placeholders.
- `apps/web`: Vite React app sharing `packages/ui` placeholder; served by the Gateway at `/` when built.
- `apps/mac-helper`: Swift package that builds on macOS 15+, connects to a Unix socket, sends a `connect` frame as `role: node` with an empty capability list, logs the challenge.

### 6. CI
GitHub Actions on `macos-15` (or newer) and `ubuntu-latest`: pnpm cache, install, typecheck, lint, test, protocol codegen freshness, Swift build on macOS.

## Definition of done (bootstrap)
- All of the above merged to `main`; every package README states its owner; the fakes pass the conformance suite; `docs/status/s00.md` lists what is stubbed.
- A short `CONTRIBUTING.md` that points to `prompts/_shared-rules.md` and explains worktrees, branch names, PR size, protocol PRs and migrations.

## Suggested subagent fan-out
Five subagents in parallel: (a) protocol schemas + codegen, (b) contracts + fakes + conformance suite, (c) db + migrations, (d) tooling + CI + templates, (e) desktop/web/helper skeletons. You integrate, run everything, and write the status file.

## Then: Integrator duties (ongoing)
- Merge order: `protocol:` PRs → `packages/db` → `packages/testing` → libraries → apps. Rebase others after protocol merges.
- Read every `docs/status/*.md` daily; resolve ownership conflicts; open `protocol:` PRs when two sessions need the same interface change.
- Keep `main` green; revert fast; keep `docs/09-execution-plan.md` §4 current.
- When Wave 2 packages land, write `docs/status/integration-readiness.md` listing which INT prompts can start.
